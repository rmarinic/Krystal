//! Phone access — a small HTTP server on the local network.
//!
//! The desktop window talks to the backend over Tauri IPC; there is no way for a
//! phone to reach that. So this module puts a plain HTTP/1.1 server (hyper) in
//! front of the *same* command functions the window calls, and serves a compact
//! touch UI (`webui/`, embedded in the binary) that drives them. Same database,
//! same warm `claude` sessions, same project — the phone is a second window onto
//! one app, not a second app.
//!
//! Shape of it:
//!   * Bound to `0.0.0.0:<port>` so anything on the same Wi-Fi can reach it. It
//!     is **off until the user starts it** and dies with the app.
//!   * A 6-digit PIN, freshly generated per start, is shown on the desktop and
//!     traded for a bearer token by the phone (`POST /api/auth`). Everything under
//!     `/api/` except that one route needs the token. Ten wrong PINs and the
//!     server stops accepting any (restart it for a new one) — a LAN is
//!     trusted-ish, not trusted.
//!   * A chat turn streams back as Server-Sent Events. `commands::chat` reports
//!     progress through a `tauri::ipc::Channel`, and `Channel::new` lets us build
//!     one whose handler writes into the SSE body instead of into the webview —
//!     so the phone sees byte-for-byte the events the desktop sees, with no
//!     second copy of the streaming logic.

use std::collections::HashSet;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::commands::{self, AppState};

/// Default port. High, memorable, unlikely to collide with a dev server.
pub const DEFAULT_PORT: u16 = 7420;

/// Wrong PINs tolerated before the server stops answering `/api/auth`.
const MAX_PIN_ATTEMPTS: u32 = 10;

/* ---------------------- events pushed to the window ---------------------- */
/* The phone and the desktop are two views of one app, so anything done on the
 * phone has to reach the window that is showing the same chat. These carry it;
 * `src/app/phone.js` listens and replays a remote turn through exactly the same
 * live-turn machinery a locally-typed one goes through. */

/// A turn began somewhere else: `{ threadId, text }`.
const EV_TURN_START: &str = "remote-turn-start";
/// One event of that turn, verbatim: `{ threadId, raw }` (`raw` is the JSON the
/// phone receives, unparsed — the window parses it itself).
const EV_TURN: &str = "remote-turn";
/// A chat was created elsewhere: `{ project }`.
const EV_THREADS: &str = "remote-threads-changed";

/* ------------------------------ embedded UI ------------------------------ */

const INDEX_HTML: &str = include_str!("webui/index.html");
const APP_CSS: &str = include_str!("webui/app.css");
const APP_JS: &str = include_str!("webui/app.js");
// The same markdown renderer + sanitizer the desktop uses, so a reply reads
// identically on both. Embedded rather than served off disk: an installed app
// has no `src/` folder next to it.
const MARKED_JS: &str = include_str!("../../src/vendor/marked.min.js");
const PURIFY_JS: &str = include_str!("../../src/vendor/purify.min.js");

/* -------------------------------- state ---------------------------------- */

/// Everything a request handler needs. Cheap to clone (one Arc per field).
///
/// Generic over the Tauri runtime for the same reason a Tauri plugin is: it lets
/// the whole server be stood up against a mock app in `mod tests` and driven over
/// a real socket, instead of the HTTP layer only ever running in production.
struct Ctx<R: Runtime> {
    app: AppHandle<R>,
    gate: Gate,
}

// Hand-written: `derive(Clone)` would demand `R: Clone`, which a runtime is not.
impl<R: Runtime> Clone for Ctx<R> {
    fn clone(&self) -> Self {
        Self { app: self.app.clone(), gate: self.gate.clone() }
    }
}

/// The pairing gate: holds the run's PIN, the tokens it has handed out, and how
/// many wrong guesses have come in. Split out of the HTTP layer so the part that
/// decides who gets in can be tested on its own.
#[derive(Clone)]
struct Gate {
    pin: String,
    tokens: Arc<Mutex<HashSet<String>>>,
    attempts: Arc<Mutex<u32>>,
}

/// What `Gate::pair` decided about one PIN attempt.
enum Pairing {
    /// Correct PIN — here is the bearer token for it.
    Ok(String),
    /// Wrong PIN, with how many guesses are left before the lockout.
    Wrong(u32),
    /// Out of guesses. Only restarting the server issues a new PIN.
    Locked,
}

impl Gate {
    fn new(pin: String) -> Self {
        Self {
            pin,
            tokens: Arc::new(Mutex::new(HashSet::new())),
            attempts: Arc::new(Mutex::new(0)),
        }
    }

    /// Trade a PIN for a token. A correct guess also clears the strike count, so
    /// a legitimate typo on the way in doesn't ratchet the phone towards a lockout.
    fn pair(&self, given: &str) -> Pairing {
        let mut tries = self.attempts.lock().unwrap();
        if *tries >= MAX_PIN_ATTEMPTS {
            return Pairing::Locked;
        }
        if !secret_eq(given, &self.pin) {
            *tries += 1;
            return Pairing::Wrong(MAX_PIN_ATTEMPTS.saturating_sub(*tries));
        }
        *tries = 0;
        drop(tries);
        let token = new_token();
        self.tokens.lock().unwrap().insert(token.clone());
        Pairing::Ok(token)
    }

    fn accepts(&self, token: &str) -> bool {
        self.tokens.lock().unwrap().contains(token)
    }
}

struct Running {
    port: u16,
    pin: String,
    /// Sending on this tells the accept loop to stop.
    stop: tokio::sync::watch::Sender<bool>,
}

/// The server handle held in `AppState`. Not running until `start` is called.
#[derive(Default)]
pub struct WebServer {
    inner: Mutex<Option<Running>>,
}

impl WebServer {
    pub fn status(&self) -> Value {
        match &*self.inner.lock().unwrap() {
            Some(r) => json!({
                "running": true,
                "port": r.port,
                "pin": r.pin,
                "host": lan_ip(),
                "url": lan_ip().map(|ip| format!("http://{ip}:{}", r.port)),
            }),
            None => json!({ "running": false, "port": DEFAULT_PORT, "host": lan_ip() }),
        }
    }

    fn is_running(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    /// Stop the server if it is up. Safe to call when it isn't.
    pub fn shutdown(&self) {
        if let Some(r) = self.inner.lock().unwrap().take() {
            let _ = r.stop.send(true);
        }
    }
}

/* ------------------------------ tiny secrets ----------------------------- */
/* No `rand` in the tree; `uuid` v4 is already here and is CSPRNG-backed
 * (getrandom), so both secrets are cut from fresh v4 bytes. */

fn new_pin() -> String {
    let b = *uuid::Uuid::new_v4().as_bytes();
    let n = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000;
    format!("{n:06}")
}

fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Length-and-content compare that does not bail on the first differing byte, so
/// a wrong PIN leaks no timing signal about how much of it was right.
fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/* -------------------------------- LAN IP --------------------------------- */

/// This machine's address on the local network — what the phone has to type.
///
/// Found by opening a UDP socket "to" a routable address and asking the OS which
/// local interface it picked. No packet is ever sent (a UDP connect only fixes
/// the route) and it needs no extra dependency — but it does need a default
/// route, so a machine with no gateway reports nothing and the UI says so.
pub fn lan_ip() -> Option<String> {
    for probe in ["8.8.8.8:80", "192.168.1.1:80", "10.0.0.1:80"] {
        let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if sock.connect(probe).is_err() {
            continue;
        }
        let Ok(addr) = sock.local_addr() else { continue };
        let ip = addr.ip();
        if !ip.is_loopback() && !ip.is_unspecified() {
            return Some(ip.to_string());
        }
    }
    None
}

/* ------------------------------ start / stop ----------------------------- */

/// Bring the server up on `port`. Returns the status object the UI renders
/// (address + PIN). Starting an already-running server just reports it.
pub async fn start<R: Runtime>(app: AppHandle<R>, port: u16) -> Result<Value, String> {
    {
        let state = app.state::<AppState>();
        if state.web.is_running() {
            return Ok(state.web.status());
        }
    }

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("could not open port {port}: {e}"))?;

    let pin = new_pin();
    let ctx = Ctx { app: app.clone(), gate: Gate::new(pin.clone()) };

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _peer)) = accepted else { continue };
                    let ctx = ctx.clone();
                    tokio::spawn(async move {
                        let io = TokioIo::new(stream);
                        let svc = service_fn(move |req| handle(ctx.clone(), req));
                        // A phone that walks out of Wi-Fi range drops the
                        // connection; that is routine, not an error worth logging.
                        let _ = hyper::server::conn::http1::Builder::new()
                            .keep_alive(true)
                            .serve_connection(io, svc)
                            .await;
                    });
                }
            }
        }
    });

    let state = app.state::<AppState>();
    *state.web.inner.lock().unwrap() = Some(Running { port, pin, stop: stop_tx });
    Ok(state.web.status())
}

/* ------------------------------- responses ------------------------------- */

type Body = BoxBody<Bytes, Infallible>;

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).boxed()
}

fn text_response(status: StatusCode, mime: &str, body: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        // One person over one LAN: caching would only ever serve a stale UI
        // after an app update.
        .header("cache-control", "no-store")
        .body(full(body.to_owned()))
        .unwrap()
}

fn json_response(status: StatusCode, value: &Value) -> Response<Body> {
    text_response(status, "application/json; charset=utf-8", &value.to_string())
}

fn ok_json(value: Value) -> Response<Body> {
    json_response(StatusCode::OK, &value)
}

fn err_json(status: StatusCode, message: &str) -> Response<Body> {
    json_response(status, &json!({ "error": message }))
}

/* ---------------------------- the SSE body ------------------------------- */

/// A response body fed from a channel: every `Bytes` pushed in becomes one frame
/// on the wire, and closing the sender ends the response. That is all an SSE
/// stream needs, and it keeps a futures/stream dependency out of the tree.
struct EventBody(mpsc::UnboundedReceiver<Bytes>);

impl hyper::body::Body for EventBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        self.0.poll_recv(cx).map(|opt| opt.map(|b| Ok(Frame::data(b))))
    }
}

/// One SSE frame. `event:` is left implicit — the payload's own `type` field is
/// the discriminator, exactly as it is on the desktop side.
fn sse_frame(payload: &str) -> Bytes {
    Bytes::from(format!("data: {payload}\n\n"))
}

/* -------------------------------- routing -------------------------------- */

/// Split `/api/threads?project=x` into its path and its raw query.
fn split_query(uri: &str) -> (&str, &str) {
    match uri.split_once('?') {
        Some((p, q)) => (p, q),
        None => (uri, ""),
    }
}

/// Percent-decode one query-string value (`+` is a space, `%XX` a byte). A stray
/// `%` that isn't a valid escape is left as itself rather than eaten.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) if hex.chars().all(|c| c.is_ascii_hexdigit()) => {
                        out.push(b);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Look one parameter up in a raw query string.
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

/// The embedded UI, as a (mime, body) pair — or `None` if the path isn't one of
/// ours. Everything here is public: the shell is the PIN prompt.
fn static_asset(method: &Method, path: &str) -> Option<(&'static str, &'static str)> {
    if method != Method::GET {
        return None;
    }
    match path {
        "/" | "/index.html" => Some(("text/html; charset=utf-8", INDEX_HTML)),
        "/app.css" => Some(("text/css; charset=utf-8", APP_CSS)),
        "/app.js" => Some(("text/javascript; charset=utf-8", APP_JS)),
        "/vendor/marked.js" => Some(("text/javascript; charset=utf-8", MARKED_JS)),
        "/vendor/purify.js" => Some(("text/javascript; charset=utf-8", PURIFY_JS)),
        _ => None,
    }
}

fn bearer(req: &Request<Incoming>) -> Option<String> {
    let raw = req.headers().get("authorization")?.to_str().ok()?;
    raw.strip_prefix("Bearer ").map(|s| s.trim().to_string())
}

async fn read_json(req: Request<Incoming>) -> Value {
    match req.into_body().collect().await {
        Ok(collected) => serde_json::from_slice(&collected.to_bytes()).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

fn str_field(body: &Value, key: &str) -> String {
    body.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

async fn handle<R: Runtime>(
    ctx: Ctx<R>,
    req: Request<Incoming>,
) -> Result<Response<Body>, Infallible> {
    let method = req.method().clone();
    let uri = req.uri().to_string();
    let (path, query) = split_query(&uri);
    let (path, query) = (path.to_string(), query.to_string());

    // Static half: the app shell. No token needed — the shell IS the PIN prompt,
    // and it holds nothing but markup until a token has been traded for.
    if let Some((mime, body)) = static_asset(&method, &path) {
        return Ok(text_response(StatusCode::OK, mime, body));
    }
    if method == Method::GET && path == "/favicon.ico" {
        return Ok(Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(full(Bytes::new()))
            .unwrap());
    }

    // Trade the PIN for a token. Rate-limited: a six-digit secret on a LAN is
    // only a secret if you aren't allowed to guess forever.
    if method == Method::POST && path == "/api/auth" {
        let body = read_json(req).await;
        return Ok(match ctx.gate.pair(&str_field(&body, "pin")) {
            Pairing::Ok(token) => ok_json(json!({ "token": token })),
            Pairing::Wrong(left) => json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": "bad-pin", "attemptsLeft": left }),
            ),
            Pairing::Locked => err_json(StatusCode::TOO_MANY_REQUESTS, "locked"),
        });
    }

    if !path.starts_with("/api/") {
        return Ok(err_json(StatusCode::NOT_FOUND, "not found"));
    }

    // Everything past here is the authenticated API.
    if !bearer(&req).map(|t| ctx.gate.accepts(&t)).unwrap_or(false) {
        return Ok(err_json(StatusCode::UNAUTHORIZED, "unauthorized"));
    }

    Ok(api(ctx, method, &path, &query, req).await)
}

async fn api<R: Runtime>(
    ctx: Ctx<R>,
    method: Method,
    path: &str,
    query: &str,
    req: Request<Incoming>,
) -> Response<Body> {
    match (&method, path) {
        (&Method::GET, "/api/hello") => {
            ok_json(json!({ "ok": true, "version": commands::app_version() }))
        }

        (&Method::GET, "/api/projects") => {
            let state = ctx.app.state::<AppState>();
            ok_json(commands::list_projects(state))
        }

        (&Method::GET, "/api/threads") => {
            let project = query_param(query, "project");
            let state = ctx.app.state::<AppState>();
            ok_json(commands::list_threads(state, project))
        }

        (&Method::GET, "/api/thread") => {
            let Some(id) = query_param(query, "id") else {
                return err_json(StatusCode::BAD_REQUEST, "id required");
            };
            let state = ctx.app.state::<AppState>();
            match commands::get_thread(state, id) {
                Ok(v) => ok_json(v),
                Err(e) => err_json(StatusCode::NOT_FOUND, &e),
            }
        }

        (&Method::POST, "/api/threads") => {
            let body = read_json(req).await;
            let cwd = str_field(&body, "project");
            let created = {
                let state = ctx.app.state::<AppState>();
                commands::create_thread(state, cwd.clone())
            };
            match created {
                Ok(v) => {
                    // Nudge the desktop's sidebar so a chat started on the phone
                    // shows up there without a manual refresh.
                    let _ = ctx.app.emit(EV_THREADS, json!({ "project": cwd }));
                    ok_json(v)
                }
                Err(e) => err_json(StatusCode::BAD_REQUEST, &e),
            }
        }

        (&Method::POST, "/api/stop") => {
            let body = read_json(req).await;
            let thread_id = str_field(&body, "threadId");
            let state = ctx.app.state::<AppState>();
            match commands::stop_chat(state, thread_id).await {
                Ok(v) => ok_json(v),
                Err(e) => err_json(StatusCode::BAD_REQUEST, &e),
            }
        }

        (&Method::POST, "/api/chat") => {
            let body = read_json(req).await;
            chat_stream(ctx, body).await
        }

        _ => err_json(StatusCode::NOT_FOUND, "not found"),
    }
}

/* --------------------------------- chat ---------------------------------- */

/// Run one turn for the phone and stream it back as SSE.
///
/// The turn itself is `commands::chat` — the very function the desktop window
/// invokes. It reports through a `Channel`, so we hand it one whose handler
/// pushes each event straight into this response's body — and, at the same time,
/// forwards it to the desktop window (see `EV_TURN`), so a chat left open on the
/// computer paints the phone's turn live instead of going quiet until reopened.
async fn chat_stream<R: Runtime>(ctx: Ctx<R>, body: Value) -> Response<Body> {
    let thread_id = str_field(&body, "threadId");
    let text = str_field(&body, "text");
    if thread_id.is_empty() || text.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "threadId and text required");
    }

    // One turn at a time per chat. Without this the phone could open a second
    // turn on a chat the desktop is already streaming, and both would be writing
    // to the same warm session.
    {
        let state: tauri::State<'_, AppState> = ctx.app.state();
        if state.running.lock().unwrap().contains_key(&thread_id) {
            return err_json(StatusCode::CONFLICT, "busy");
        }
    }

    let (tx, rx) = mpsc::unbounded_channel::<Bytes>();

    // Tell the desktop a turn it did not start is beginning, and with what — it
    // needs the user's message to render the bubble above the reply.
    let _ = ctx.app.emit(
        EV_TURN_START,
        json!({ "threadId": thread_id, "text": text }),
    );

    // `Channel::send` serialises to `InvokeResponseBody::Json(String)` — already
    // exactly the JSON the desktop's channel callback receives, so the same bytes
    // go to both the phone (as an SSE frame) and the window (as a Tauri event).
    let sink = tx.clone();
    let mirror = ctx.app.clone();
    let mirror_id = thread_id.clone();
    let channel: Channel<Value> = Channel::new(move |payload| {
        if let InvokeResponseBody::Json(raw) = payload {
            let _ = sink.send(sse_frame(&raw));
            let _ = mirror.emit(EV_TURN, json!({ "threadId": mirror_id, "raw": raw }));
        }
        Ok(())
    });

    let app = ctx.app.clone();
    tokio::spawn(async move {
        let state = app.state::<AppState>();
        let outcome = commands::chat(state, thread_id.clone(), text, None, None, channel).await;
        // `done` has already gone out through the channel on the happy path;
        // this is the cue that the turn itself is over, either way. Both sides get
        // it, so neither is left with a spinner that never settles.
        let closing = match outcome {
            Ok(()) => json!({ "type": "end" }),
            Err(e) => json!({ "type": "error", "message": e }),
        };
        let raw = closing.to_string();
        let _ = tx.send(sse_frame(&raw));
        let _ = app.emit(EV_TURN, json!({ "threadId": thread_id, "raw": raw }));
        // Dropping `tx` ends the body; the phone sees a clean close.
    });

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-store")
        .header("connection", "keep-alive")
        // Streaming is only end-to-end if nothing in between buffers it.
        .header("x-accel-buffering", "no")
        .body(EventBody(rx).boxed())
        .unwrap()
}

/* ------------------------------- commands -------------------------------- */

/// Start phone access. `port` is optional; `DEFAULT_PORT` when omitted.
#[tauri::command]
pub async fn web_start(app: AppHandle, port: Option<u16>) -> Result<Value, String> {
    start(app, port.unwrap_or(DEFAULT_PORT)).await
}

#[tauri::command]
pub fn web_stop(state: tauri::State<'_, AppState>) -> Value {
    state.web.shutdown();
    state.web.status()
}

#[tauri::command]
pub fn web_status(state: tauri::State<'_, AppState>) -> Value {
    state.web.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ------------------------- a server, for real ------------------------- *
     * These tests stand the whole thing up — hyper on a real socket, a mock
     * Tauri app holding a throwaway AppState — and talk to it over HTTP. That
     * covers what the unit tests below can't reach: that it binds, that the
     * shell is served, that the gate actually gates, and that a turn comes back
     * as a well-formed SSE stream. */

    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    /// A mock app carrying a real (temporary, on-disk) AppState.
    fn mock_app(dir: &std::path::Path) -> tauri::App<MockRuntime> {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("build the mock app");
        let conn = crate::db::open(&dir.join("krystal.db")).expect("open the test db");
        app.manage(AppState {
            db: std::sync::Mutex::new(conn),
            caps: crate::claude::Caps { pandoc: false, python_docx: false },
            claude_bin: std::sync::Mutex::new("claude".into()),
            discord: crate::discord::Presence::new(),
            running: std::sync::Mutex::new(std::collections::HashMap::new()),
            run_procs: std::sync::Mutex::new(std::collections::HashMap::new()),
            data_dir: dir.to_path_buf(),
            models: std::sync::Mutex::new(crate::models::seed_models()),
            ui_lang: std::sync::Mutex::new("en".into()),
            suggestions: std::sync::Mutex::new(false),
            sessions: Default::default(),
            web: Default::default(),
        });
        app
    }

    /// A scratch directory that cleans itself up.
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("krystal-web-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Start the server on an OS-assigned free port so tests running in parallel
    /// can't collide, and hand back its base URL plus the PIN it minted.
    async fn serve(app: &tauri::App<MockRuntime>) -> (String, String) {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let status = start(app.handle().clone(), port).await.expect("start the server");
        assert_eq!(status["running"], json!(true));
        let pin = status["pin"].as_str().unwrap().to_string();
        (format!("http://127.0.0.1:{port}"), pin)
    }

    // `no_proxy`: a machine with HTTP_PROXY set would otherwise send loopback
    // traffic through it and the tests would fail for reasons of their own.
    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    async fn pair(http: &reqwest::Client, base: &str, pin: &str) -> String {
        let body: Value = http
            .post(format!("{base}/api/auth"))
            .json(&json!({ "pin": pin }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        body["token"].as_str().expect("a token").to_string()
    }

    #[tokio::test]
    async fn the_shell_is_public_but_the_api_is_not() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (base, _pin) = serve(&app).await;
        let http = client();

        let page = http.get(&base).send().await.unwrap();
        assert!(page.status().is_success());
        assert!(page.text().await.unwrap().contains("pin-input"));

        // No token, and a made-up token, are both turned away.
        for req in [
            http.get(format!("{base}/api/projects")),
            http.get(format!("{base}/api/projects")).bearer_auth("guessed"),
        ] {
            assert_eq!(req.send().await.unwrap().status(), 401);
        }

        app.state::<AppState>().web.shutdown();
    }

    #[tokio::test]
    async fn the_pin_opens_the_api_and_a_wrong_one_does_not() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (base, pin) = serve(&app).await;
        let http = client();

        let bad = http
            .post(format!("{base}/api/auth"))
            .json(&json!({ "pin": "000000" }))
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), 401);
        assert_eq!(
            bad.json::<Value>().await.unwrap()["attemptsLeft"],
            json!(MAX_PIN_ATTEMPTS - 1)
        );

        let token = pair(&http, &base, &pin).await;
        let projects = http
            .get(format!("{base}/api/projects"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert!(projects.status().is_success());
        assert!(projects.json::<Value>().await.unwrap()["projects"].is_array());

        app.state::<AppState>().web.shutdown();
    }

    #[tokio::test]
    async fn the_phone_can_walk_from_a_project_to_a_new_chat() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        // A project the desktop made earlier — the phone only ever picks from
        // these, it never creates one.
        let project = dir.0.join("a project").to_string_lossy().to_string();
        {
            let state = app.state::<AppState>();
            let conn = state.db.lock().unwrap();
            crate::db::create_project(&conn, &project).expect("seed a project");
        }

        let (base, pin) = serve(&app).await;
        let http = client();
        let token = pair(&http, &base, &pin).await;
        let get = |path: String| http.get(path).bearer_auth(token.clone()).send();

        let listed: Value = get(format!("{base}/api/projects")).await.unwrap().json().await.unwrap();
        assert_eq!(listed["projects"][0]["path"], json!(project));

        // A path with a space in it has to survive the round trip through the
        // query string — Windows project folders are full of them.
        let created: Value = http
            .post(format!("{base}/api/threads"))
            .bearer_auth(&token)
            .json(&json!({ "project": project }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = created["id"].as_str().expect("a thread id").to_string();

        let threads: Value =
            get(format!("{base}/api/threads?project={}", urlencode(&project)))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
        assert_eq!(threads["threads"].as_array().unwrap().len(), 1);
        assert_eq!(threads["threads"][0]["id"], json!(id));

        let thread: Value = get(format!("{base}/api/thread?id={id}"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(thread["cwd"], json!(project));
        assert!(thread["messages"].as_array().unwrap().is_empty());

        // A chat that doesn't exist is a 404, not an empty transcript.
        assert_eq!(
            get(format!("{base}/api/thread?id=nope")).await.unwrap().status(),
            404
        );

        app.state::<AppState>().web.shutdown();
    }

    /// Minimal percent-encoder, so the test encodes the query the way the phone
    /// does rather than trusting `percent_decode` to undo its own mistakes.
    fn urlencode(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn a_failed_turn_still_reaches_the_phone_through_the_sse_body() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (base, pin) = serve(&app).await;
        let http = client();
        let token = pair(&http, &base, &pin).await;

        // An unknown thread fails inside `commands::chat` — before any `claude`
        // process is spawned — which is the path worth exercising here: by the
        // time a turn can fail the response headers are long gone, so the error
        // has to arrive as an event in the body, not as an HTTP status.
        let res = http
            .post(format!("{base}/api/chat"))
            .bearer_auth(&token)
            .json(&json!({ "threadId": "no-such-thread", "text": "hello" }))
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success());
        assert_eq!(res.headers()["content-type"], "text/event-stream");

        let body = res.text().await.unwrap();
        assert!(body.starts_with("data: "), "not an SSE frame: {body:?}");
        assert!(body.ends_with("\n\n"), "frame is not terminated: {body:?}");
        let payload: Value =
            serde_json::from_str(body.trim_start_matches("data: ").trim()).unwrap();
        assert_eq!(payload["type"], json!("error"));
        assert_eq!(payload["message"], json!("unknown thread"));

        app.state::<AppState>().web.shutdown();
    }

    #[tokio::test]
    async fn a_missing_field_is_rejected_before_anything_is_streamed() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (base, pin) = serve(&app).await;
        let http = client();
        let token = pair(&http, &base, &pin).await;

        let res = http
            .post(format!("{base}/api/chat"))
            .bearer_auth(&token)
            .json(&json!({ "threadId": "abc" }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);

        app.state::<AppState>().web.shutdown();
    }

    #[tokio::test]
    async fn stopping_the_server_frees_the_port() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (base, _pin) = serve(&app).await;
        let http = client();
        assert!(http.get(&base).send().await.unwrap().status().is_success());

        let state = app.state::<AppState>();
        state.web.shutdown();
        assert_eq!(state.web.status()["running"], json!(false));

        // The accept loop wakes on the stop signal; once it has, the port must be
        // re-bindable — otherwise starting phone access again would fail.
        let port: u16 = base.rsplit(':').next().unwrap().parse().unwrap();
        for _ in 0..100 {
            if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("port {port} was still held two seconds after shutdown");
    }

    /* ------------------------------ the pieces ---------------------------- */

    #[test]
    fn pin_is_always_six_digits() {
        for _ in 0..200 {
            let pin = new_pin();
            assert_eq!(pin.len(), 6, "pin {pin} is not six characters");
            assert!(pin.chars().all(|c| c.is_ascii_digit()), "pin {pin} is not numeric");
        }
    }

    #[test]
    fn tokens_are_unique_and_long() {
        let a = new_token();
        let b = new_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn secret_compare_matches_only_the_same_string() {
        assert!(secret_eq("012345", "012345"));
        assert!(!secret_eq("012345", "012346"));
        assert!(!secret_eq("012345", "01234"));
        assert!(!secret_eq("", "0"));
        assert!(secret_eq("", ""));
    }

    #[test]
    fn query_params_are_split_and_decoded() {
        let (path, query) = split_query("/api/threads?project=G%3A%5CProjects%5Cmy+app&x=1");
        assert_eq!(path, "/api/threads");
        assert_eq!(
            query_param(query, "project").as_deref(),
            Some("G:\\Projects\\my app")
        );
        assert_eq!(query_param(query, "x").as_deref(), Some("1"));
        assert_eq!(query_param(query, "missing"), None);
    }

    #[test]
    fn query_split_handles_a_bare_path() {
        let (path, query) = split_query("/api/projects");
        assert_eq!(path, "/api/projects");
        assert_eq!(query, "");
        assert_eq!(query_param(query, "project"), None);
    }

    #[test]
    fn percent_decode_leaves_stray_escapes_alone() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("%C4%8Devrljati"), "čevrljati");
    }

    /* ------------------------------ the gate ----------------------------- */

    fn matching(gate: &Gate) -> String {
        gate.pin.clone()
    }

    #[test]
    fn the_right_pin_buys_a_token_that_the_gate_then_accepts() {
        let gate = Gate::new(new_pin());
        let Pairing::Ok(token) = gate.pair(&matching(&gate)) else {
            panic!("the correct pin was refused");
        };
        assert!(gate.accepts(&token));
        assert!(!gate.accepts("not-a-token"));
        assert!(!gate.accepts(""));
    }

    #[test]
    fn every_phone_gets_its_own_token_and_both_keep_working() {
        let gate = Gate::new("123456".into());
        let (Pairing::Ok(a), Pairing::Ok(b)) = (gate.pair("123456"), gate.pair("123456")) else {
            panic!("a second pairing was refused");
        };
        assert_ne!(a, b);
        assert!(gate.accepts(&a) && gate.accepts(&b));
    }

    #[test]
    fn wrong_pins_count_down_and_then_lock_the_gate() {
        let gate = Gate::new("123456".into());
        for expected in (0..MAX_PIN_ATTEMPTS).rev() {
            match gate.pair("000000") {
                Pairing::Wrong(left) => assert_eq!(left, expected),
                _ => panic!("a wrong pin was accepted"),
            }
        }
        // Out of guesses — and the lockout holds even for the RIGHT pin, so a
        // guesser can't wait out the counter by stumbling onto it.
        assert!(matches!(gate.pair("000000"), Pairing::Locked));
        assert!(matches!(gate.pair("123456"), Pairing::Locked));
    }

    #[test]
    fn a_successful_pairing_clears_earlier_strikes() {
        let gate = Gate::new("123456".into());
        assert!(matches!(gate.pair("999999"), Pairing::Wrong(_)));
        assert!(matches!(gate.pair("999999"), Pairing::Wrong(_)));
        assert!(matches!(gate.pair("123456"), Pairing::Ok(_)));
        // Back to a full allowance rather than two strikes down.
        match gate.pair("999999") {
            Pairing::Wrong(left) => assert_eq!(left, MAX_PIN_ATTEMPTS - 1),
            _ => panic!("expected a wrong-pin verdict"),
        }
    }

    /* ---------------------------- static assets --------------------------- */

    #[test]
    fn the_ui_is_served_and_nothing_else_is() {
        let (mime, body) = static_asset(&Method::GET, "/").expect("index");
        assert!(mime.starts_with("text/html"));
        assert!(body.contains("pin-input"), "the shell should carry the PIN gate");

        assert!(static_asset(&Method::GET, "/app.css").is_some());
        assert!(static_asset(&Method::GET, "/app.js").is_some());
        assert!(static_asset(&Method::GET, "/vendor/marked.js").is_some());

        // Not ours, and not reachable by walking out of the table.
        assert!(static_asset(&Method::GET, "/api/projects").is_none());
        assert!(static_asset(&Method::GET, "/../../krystal.db").is_none());
        assert!(static_asset(&Method::GET, "/vendor/../app.js").is_none());
        // Only GET serves the shell; a POST to `/` must fall through to routing.
        assert!(static_asset(&Method::POST, "/").is_none());
    }

    #[test]
    fn sse_frames_end_with_a_blank_line() {
        let frame = sse_frame(r#"{"type":"token","text":"hi"}"#);
        assert_eq!(&frame[..], b"data: {\"type\":\"token\",\"text\":\"hi\"}\n\n");
    }
}
