//! Remote access — reach this Krystal from another device on the network.
//!
//! The window talks to the backend over Tauri IPC, which nothing off this machine
//! can reach. So this module puts a plain HTTP/1.1 server (hyper) in front of the
//! *same* command functions the window calls. Same database, same warm `claude`
//! sessions, same projects — whatever connects is another view of one app, not a
//! second app.
//!
//! Two kinds of client, one backend:
//!   * **A browser** (typically a phone) gets the compact touch UI embedded from
//!     `webui/`, which drives a few hand-written REST routes.
//!   * **Another Krystal** points its own `api` object at `/api/invoke` and
//!     `/api/stream` (see `dispatch`) and drives this machine with its full
//!     desktop UI — which is how you sit at one computer and work on another's
//!     projects.
//!
//! Shape of it:
//!   * Bound to `0.0.0.0:<port>` so anything on the same network can reach it. It
//!     is **off until the user starts it** and dies with the app.
//!   * A 6-digit PIN, freshly generated per start, is shown on the host and traded
//!     for a bearer token (`POST /api/auth`). Everything under `/api/` except that
//!     one route needs the token. Ten wrong PINs and the server stops accepting
//!     any (restart it for a new one) — a LAN is trusted-ish, not trusted.
//!   * A chat turn streams back as Server-Sent Events. `commands::chat` reports
//!     progress through a `tauri::ipc::Channel`, and `Channel::new` lets us build
//!     one whose handler writes into the SSE body instead of into the webview —
//!     so a client sees byte-for-byte the events this window sees, with no second
//!     copy of the streaming logic.

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
/* A connected client and this window are two views of one app, so anything done
 * over there has to reach the window showing the same chat. These carry it;
 * `src/app/remote.js` listens and replays the turn through exactly the same
 * live-turn machinery a locally-typed one goes through. */

/// A turn began on a connected client: `{ threadId, text }`.
const EV_TURN_START: &str = "remote-turn-start";
/// One event of that turn, verbatim: `{ threadId, raw }` (`raw` is the JSON the
/// client receives, unparsed — the window parses it itself).
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

/// The last connection that came in from another device: its address and when.
/// `None` until one does — which is the only way this side can ever tell "the
/// phone is typing the wrong PIN" apart from "the phone's request never arrives".
type LastClient = Arc<Mutex<Option<(String, std::time::Instant)>>>;

struct Running {
    port: u16,
    pin: String,
    /// Sending on this tells the accept loop to stop.
    stop: tokio::sync::watch::Sender<bool>,
    last_client: LastClient,
}

/// The server handle held in `AppState`. Not running until `start` is called.
#[derive(Default)]
pub struct RemoteServer {
    inner: Mutex<Option<Running>>,
}

impl RemoteServer {
    pub fn status(&self) -> Value {
        match &*self.inner.lock().unwrap() {
            Some(r) => json!({
                "running": true,
                "port": r.port,
                "pin": r.pin,
                "host": lan_ip(),
                "url": lan_ip().map(|ip| format!("http://{ip}:{}", r.port)),
                // `null` until another device has got as far as this machine.
                "lastClient": r.last_client.lock().unwrap().as_ref().map(|(ip, at)| {
                    json!({ "ip": ip, "secsAgo": at.elapsed().as_secs() })
                }),
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

/// What to call this machine in a connected client's UI. Best effort: the
/// computer name if the OS offers one, otherwise the LAN address.
fn machine_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(key) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    lan_ip().unwrap_or_else(|| "Krystal".to_string())
}

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

/// This machine's address on the local network — what a client has to type.
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

/// Did this connection come from another device? One made *on* this machine —
/// to `localhost`, or to its own LAN address — arrives with a peer address that
/// is loopback or the very address it was received on. Those prove nothing about
/// the network, so they must not count as "a device reached us".
fn from_elsewhere(peer: std::net::IpAddr, local: std::net::IpAddr) -> bool {
    !peer.is_loopback() && peer != local
}

/* ---------------------------- Windows Firewall ---------------------------- */
/* The single most common reason "it says it's running but my phone can't open
 * it": Windows Firewall. Loopback is never filtered, so the host sees a perfectly
 * healthy server on `localhost` while every packet from the phone is dropped
 * before it reaches us — nothing on this side ever learns that it happened.
 *
 * Windows normally asks (the "allow access" popup) the first time a program
 * listens, but that only covers the exe that was running at the time: a user who
 * dismissed it once, or who tried remote access in a dev build and now runs the
 * installed one, ends up with a server nothing can reach and no way to tell.
 * So Krystal looks for itself in the inbound rules and, if it isn't there, offers
 * to put itself there. */

/// Name of the rule Krystal creates for itself. Stable, so re-applying replaces
/// the previous one instead of piling duplicates up.
const FIREWALL_RULE: &str = "Krystal Remote";

/// This executable's full path — what a firewall rule is keyed by.
fn exe_path() -> Option<String> {
    std::env::current_exe().ok()?.to_str().map(str::to_string)
}

/// Run a command with no console window and hand back its stdout, or `None` if
/// it could not be run at all (which is different from "it ran and said no").
#[cfg(target_os = "windows")]
fn quiet_output(program: &str, args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new(program)
        .args(args)
        .creation_flags(crate::claude::CREATE_NO_WINDOW)
        .output()
        .ok()?;
    // netsh writes its "no rules match" line to stdout, so both halves matter.
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(text)
}

/// Is this exe named by any enabled inbound rule?
///
/// Asked of `netsh`, whose *labels* are localised but whose *values* — the
/// program paths — are not, so a plain case-insensitive search for our own path
/// works on any Windows language. It cannot tell an allow rule from a block one
/// or read which profiles a rule covers; that is what "Re-apply" is for, since
/// the rule Krystal writes itself covers every profile.
#[cfg(target_os = "windows")]
fn firewall_allows_us() -> Option<bool> {
    let exe = exe_path()?.to_lowercase();
    let dump = quiet_output(
        "netsh",
        &["advfirewall", "firewall", "show", "rule", "name=all", "dir=in", "verbose"],
    )?;
    Some(dump.to_lowercase().contains(&exe))
}

#[cfg(not(target_os = "windows"))]
fn firewall_allows_us() -> Option<bool> {
    None
}

/// What the Remote panel needs to say about the firewall: whether this platform
/// has one Krystal can speak to, and whether it currently lets us in.
pub fn firewall_status() -> Value {
    json!({
        "supported": cfg!(target_os = "windows"),
        // `null` when the check could not run — the UI says nothing rather than
        // accusing a firewall that may be innocent.
        "allowed": firewall_allows_us(),
        "exe": exe_path(),
    })
}

/// Write the elevated half as a script rather than trying to nest quoting three
/// deep through `Start-Process`. UTF-8 **with BOM** because Windows PowerShell
/// reads a `.ps1` as the system codepage otherwise, and an install path can hold
/// non-ASCII (a user folder called `Đorđe`, say).
#[cfg(target_os = "windows")]
fn write_firewall_script(exe: &str) -> Result<std::path::PathBuf, String> {
    // Single-quoted PowerShell strings take no escapes but their own doubled quote.
    let ps_quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let path = std::env::temp_dir().join("krystal-firewall.ps1");
    // No `localport`: the rule is scoped to this program, exactly like the one
    // Windows' own prompt writes, so changing the port later doesn't strand it.
    let script = format!(
        "$ErrorActionPreference = 'Stop'\r\n\
         $name = {name}\r\n\
         $exe  = {exe}\r\n\
         netsh advfirewall firewall delete rule name=$name | Out-Null\r\n\
         netsh advfirewall firewall add rule name=$name dir=in action=allow \
         protocol=TCP program=$exe profile=any enable=yes\r\n\
         exit $LASTEXITCODE\r\n",
        name = ps_quote(FIREWALL_RULE),
        exe = ps_quote(exe),
    );
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(script.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| format!("could not write the helper script: {e}"))?;
    Ok(path)
}

/// Add (or replace) the inbound rule that lets other devices reach this Krystal.
/// Needs administrator rights, so it goes through `Start-Process -Verb RunAs` —
/// the user sees one UAC prompt and nothing else.
#[cfg(target_os = "windows")]
pub fn firewall_allow() -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    let exe = exe_path().ok_or("could not work out where Krystal is installed")?;
    let script = write_firewall_script(&exe)?;
    // Refusing the UAC prompt makes `Start-Process` throw, and what PowerShell
    // then exits with is its own business; catch it and say 1 ourselves.
    let launch = format!(
        "try {{ $p = Start-Process -FilePath 'powershell' -Verb RunAs -WindowStyle Hidden \
         -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}'; \
         exit $p.ExitCode }} catch {{ exit 1 }}",
        script.display().to_string().replace('\'', "''"),
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &launch])
        .creation_flags(crate::claude::CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("could not run the firewall helper: {e}"))?;
    let _ = std::fs::remove_file(&script);
    if !out.status.success() {
        // The overwhelmingly likely one is a declined UAC prompt; say so plainly
        // instead of quoting PowerShell at someone.
        return Err("Windows did not allow the change — the permission prompt was refused."
            .to_string());
    }
    Ok(firewall_status())
}

#[cfg(not(target_os = "windows"))]
pub fn firewall_allow() -> Result<Value, String> {
    Err("Only Windows has a firewall Krystal can set up for you.".to_string())
}

/* ------------------------------ start / stop ----------------------------- */

/// Bring the server up on `port`. Returns the status object the UI renders
/// (address + PIN). Starting an already-running server just reports it.
pub async fn start<R: Runtime>(app: AppHandle<R>, port: u16) -> Result<Value, String> {
    {
        let state = app.state::<AppState>();
        if state.remote.is_running() {
            return Ok(state.remote.status());
        }
    }

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("could not open port {port}: {e}"))?;

    let pin = new_pin();
    let ctx = Ctx { app: app.clone(), gate: Gate::new(pin.clone()) };

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let last_client = LastClient::default();
    let seen = last_client.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, peer)) = accepted else { continue };
                    // Noted at accept, before a byte is read: a browser that got
                    // this far and then asked for `https://` still proves the
                    // network path works, which is the question being answered.
                    if stream.local_addr().is_ok_and(|l| from_elsewhere(peer.ip(), l.ip())) {
                        *seen.lock().unwrap() =
                            Some((peer.ip().to_string(), std::time::Instant::now()));
                    }
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
    *state.remote.inner.lock().unwrap() =
        Some(Running { port, pin, stop: stop_tx, last_client });
    Ok(state.remote.status())
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

/// A JSON array of strings, with anything non-string dropped rather than the
/// whole list being refused.
fn args_of_strings(body: &Value, key: &str) -> Vec<String> {
    body.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
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
            ok_json(json!({
                "ok": true,
                "version": commands::app_version(),
                // What to call this machine in the connected client's UI.
                "name": machine_name(),
            }))
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
            // Same escalation as the window: press stop twice and the second one
            // kills the process instead of politely asking it again.
            let force = body.get("force").and_then(|v| v.as_bool());
            let state = ctx.app.state::<AppState>();
            match commands::stop_chat(state, thread_id, force).await {
                Ok(v) => ok_json(v),
                Err(e) => err_json(StatusCode::BAD_REQUEST, &e),
            }
        }

        (&Method::POST, "/api/chat") => {
            let body = read_json(req).await;
            chat_stream(ctx, body).await
        }

        /* ---- the command bridge another Krystal drives this one through ---- */
        (&Method::POST, "/api/invoke") => {
            let body = read_json(req).await;
            let cmd = str_field(&body, "cmd");
            let args = body.get("args").cloned().unwrap_or_else(|| json!({}));
            if is_streaming_command(&cmd) {
                // Calling one of these here would return only once it finished,
                // with every event thrown away. Point the caller at the door it
                // actually wants rather than silently doing the wrong thing.
                return err_json(StatusCode::BAD_REQUEST, "use /api/stream for this command");
            }
            match dispatch(&ctx.app, &cmd, &args).await {
                Some(Ok(value)) => ok_json(json!({ "value": value })),
                Some(Err(e)) => err_json(StatusCode::BAD_REQUEST, &e),
                None => err_json(StatusCode::NOT_FOUND, "command not available remotely"),
            }
        }

        (&Method::POST, "/api/stream") => {
            let body = read_json(req).await;
            let cmd = str_field(&body, "cmd");
            let args = body.get("args").cloned().unwrap_or_else(|| json!({}));
            match cmd.as_str() {
                "chat" => chat_stream(ctx, args).await,
                "run_app" => run_app_stream(ctx, args).await,
                _ => err_json(StatusCode::NOT_FOUND, "command not available remotely"),
            }
        }

        _ => err_json(StatusCode::NOT_FOUND, "not found"),
    }
}

/* ----------------------------- command bridge ---------------------------- *
 * What turns this from "a phone page" into "another Krystal you can drive": a
 * connected client can call the backend commands by name, so the desktop app can
 * point its own `api` object at this machine and behave exactly as it does
 * locally (see `remote.active` in src/app/core.js).
 *
 * An explicit allowlist, not a blanket proxy over everything the window can
 * invoke. Two reasons. The pairing code is the only thing between the LAN and
 * this dispatcher, so the surface should be a decision rather than a side
 * effect. And a handful of commands are about *the machine you are sitting at* —
 * opening a link, this copy's Discord presence, installing Claude Code, starting
 * remote access itself — which would fire on the wrong computer if proxied. The
 * frontend keeps a matching local-only list; this side is what enforces it. */

/// A required string argument (missing reads as empty, which the commands then
/// reject themselves — the same as a bad call from the window).
fn arg_str(a: &Value, key: &str) -> String {
    a.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// An optional string argument. Absent and `null` both mean `None`.
fn arg_opt_str(a: &Value, key: &str) -> Option<String> {
    a.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn arg_i64(a: &Value, key: &str) -> i64 {
    a.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn arg_opt_i64(a: &Value, key: &str) -> Option<i64> {
    a.get(key).and_then(|v| v.as_i64())
}

fn arg_bool(a: &Value, key: &str) -> bool {
    a.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn arg_opt_bool(a: &Value, key: &str) -> Option<bool> {
    a.get(key).and_then(|v| v.as_bool())
}

fn arg_list(a: &Value, key: &str) -> Vec<Value> {
    a.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default()
}

/// Wrap a command's return value as JSON. Commands hand back `Value`, `Vec<Value>`
/// or `&str`; the client only ever sees JSON either way.
fn as_json<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// Run one allowlisted command. `Err` for a command that failed; `Ok(None)` for
/// one this machine does not expose (which the caller turns into a 404, so a
/// client can tell "refused" apart from "went wrong").
async fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    let st = || -> tauri::State<'_, AppState> { app.state() };
    let out = match cmd {
        /* ---- config & catalogue ---- */
        "get_config" => as_json(commands::get_config(st())),
        "set_ui_language" => as_json(commands::set_ui_language(st(), arg_str(a, "lang"))),
        "refresh_models" => commands::refresh_models(st()).await,
        "preflight" => as_json(commands::preflight(st())),

        /* ---- projects ---- */
        "list_projects" => as_json(commands::list_projects(st())),
        "create_project" => commands::create_project(st(), arg_str(a, "path")),
        "select_project" => commands::select_project(st(), arg_str(a, "id")),
        "move_project" => commands::move_project(st(), arg_str(a, "id"), arg_str(a, "path")).await,
        "delete_project" => as_json(commands::delete_project(st(), arg_str(a, "id"))),

        /* ---- chats ---- */
        "list_threads" => as_json(commands::list_threads(st(), arg_opt_str(a, "project"))),
        "get_thread" => commands::get_thread(st(), arg_str(a, "id")),
        "create_thread" => commands::create_thread(st(), arg_str(a, "cwd")),
        "branch_thread" => commands::branch_thread(st(), arg_str(a, "id")),
        "delete_thread" => commands::delete_thread(st(), arg_str(a, "id")).await,
        "rename_thread" => commands::rename_thread(st(), arg_str(a, "id"), arg_str(a, "title")),
        "clear_thread" => commands::clear_thread(st(), arg_str(a, "id")).await,
        "compact_thread" => commands::compact_thread(st(), arg_str(a, "id")).await,
        "hint_thread" => commands::hint_thread(st(), arg_str(a, "id")).await,

        /* ---- per-chat settings ---- */
        "set_model" => commands::set_model(st(), arg_str(a, "id"), arg_str(a, "model")),
        "set_mode" => commands::set_mode(st(), arg_str(a, "id"), arg_str(a, "mode")),
        "set_effort" => commands::set_effort(st(), arg_str(a, "id"), arg_str(a, "effort")),
        "set_suggestions" => as_json(commands::set_suggestions(st(), arg_bool(a, "enabled"))),
        "set_orchestration" => commands::set_orchestration(
            st(),
            arg_str(a, "id"),
            arg_bool(a, "enabled"),
            arg_str(a, "subModel"),
        ),

        /* ---- turns in flight ---- */
        "stop_chat" => commands::stop_chat(st(), arg_str(a, "threadId"), arg_opt_bool(a, "force")).await,
        "active_runs" => commands::active_runs(st()).await.and_then(as_json),
        "stop_all_chats" => commands::stop_all_chats(st()).await,

        /* ---- search & favourites ---- */
        "search_messages" => as_json(commands::search_messages(
            st(),
            arg_str(a, "q"),
            arg_opt_str(a, "project"),
        )),
        "list_favorites" => as_json(commands::list_favorites(st(), arg_opt_str(a, "project"))),
        "toggle_favorite" => commands::toggle_favorite(st(), arg_i64(a, "messageId")),
        "delete_message" => commands::delete_message(st(), arg_i64(a, "messageId")),

        /* ---- tasks ---- */
        "list_tasks" => as_json(commands::list_tasks(st(), arg_str(a, "project"))),
        "add_task" => commands::add_task(
            st(),
            arg_str(a, "project"),
            arg_str(a, "title"),
            arg_opt_str(a, "note"),
        ),
        "update_task" => commands::update_task(
            st(),
            arg_i64(a, "id"),
            arg_opt_str(a, "title"),
            arg_opt_bool(a, "done"),
        ),
        "delete_task" => as_json(commands::delete_task(st(), arg_i64(a, "id"))),
        "clear_done_tasks" => as_json(commands::clear_done_tasks(st(), arg_str(a, "project"))),
        "task_count" => as_json(commands::task_count(st(), arg_str(a, "project"))),
        "generate_tasks" => commands::generate_tasks(
            st(),
            arg_str(a, "cwd"),
            arg_str(a, "brief"),
            Some(arg_list(a, "answers")),
        )
        .await,

        /* ---- the project's own files & folders ---- */
        "list_pins" => as_json(commands::list_pins(st(), arg_str(a, "project"))),
        "add_pin" => commands::add_pin(st(), arg_str(a, "project"), arg_str(a, "path")),
        "remove_pin" => as_json(commands::remove_pin(st(), arg_str(a, "project"), arg_i64(a, "id"))),
        "read_pinned_file" => as_json(commands::read_pinned_file(arg_str(a, "path"))),
        // Artifacts. `open_artifact_externally` is deliberately absent: it opens a
        // browser window, which would appear on the host's screen rather than
        // the screen of whoever asked (the frontend blocks it before it gets
        // here — see `remoteBlocks` in artifacts.js).
        "list_artifacts" => as_json(commands::list_artifacts(st(), arg_str(a, "project"))),
        "get_artifact" => commands::get_artifact(
            st(),
            arg_str(a, "project"),
            arg_str(a, "artId"),
            arg_opt_i64(a, "version"),
        ),
        "delete_artifact" => as_json(commands::delete_artifact(
            st(),
            arg_str(a, "project"),
            arg_str(a, "artId"),
        )),
        "list_project_dirs" => as_json(commands::list_project_dirs(st(), arg_str(a, "project"))),
        "add_project_dir" => {
            commands::add_project_dir(st(), arg_str(a, "project"), arg_str(a, "path"))
        }
        "remove_project_dir" => as_json(commands::remove_project_dir(
            st(),
            arg_str(a, "project"),
            arg_i64(a, "id"),
        )),
        "list_skills" => as_json(commands::list_skills(arg_opt_str(a, "project"))),
        "read_image" => as_json(commands::read_image(arg_str(a, "path"))),
        "save_attachment" => commands::save_attachment(
            st(),
            arg_str(a, "name"),
            arg_str(a, "dataBase64"),
        ),

        /* ---- CLAUDE.md / the Initialize wizard ---- */
        "read_claude_md" => commands::read_claude_md(st(), arg_str(a, "id")),
        "claude_md_exists" => as_json(commands::claude_md_exists(arg_str(a, "cwd"))),
        "init_analyze" => {
            commands::init_analyze(st(), arg_str(a, "id"), arg_opt_str(a, "brief")).await
        }
        "init_draft" => commands::init_draft(
            st(),
            arg_str(a, "id"),
            arg_opt_str(a, "summary"),
            arg_list(a, "answers"),
            arg_opt_str(a, "brief"),
        )
        .await,
        "init_save" => commands::init_save(st(), arg_str(a, "id"), arg_str(a, "markdown")),

        /* ---- running the project ---- */
        "run_shell" => {
            commands::run_shell(st(), arg_str(a, "threadId"), arg_str(a, "command")).await
        }
        "get_run_config" => as_json(commands::get_run_config(st(), arg_str(a, "project"))),
        "set_run_config" => as_json(commands::set_run_config(
            st(),
            arg_str(a, "project"),
            arg_str(a, "command"),
        )),
        "detect_run_command" => commands::detect_run_command(st(), arg_str(a, "project")).await,
        "stop_run" => commands::stop_run(st(), arg_str(a, "project")).await,

        /* ---- git ---- */
        "git_status" => as_json(commands::git_status(arg_str(a, "cwd"))),
        "git_branches" => as_json(commands::git_branches(arg_str(a, "cwd"))),
        "git_checkout" => as_json(commands::git_checkout(arg_str(a, "cwd"), arg_str(a, "branch"))),
        "git_create_branch" => {
            as_json(commands::git_create_branch(arg_str(a, "cwd"), arg_str(a, "name")))
        }
        "git_fetch" => as_json(commands::git_fetch(arg_str(a, "cwd"))),
        "git_pull" => as_json(commands::git_pull(arg_str(a, "cwd"))),
        "git_push" => as_json(commands::git_push(arg_str(a, "cwd"))),

        /* ---- usage ---- */
        "claude_usage" => as_json(commands::claude_usage(
            a.get("weeklyReset").and_then(|v| v.as_f64()),
        )),

        // Not exposed. `chat` and `run_app` stream, so they go through
        // `/api/stream`; everything else here is deliberately local-only.
        _ => return None,
    };
    Some(out)
}

/// Commands reachable over `/api/stream` (they report progress through a
/// `Channel` rather than returning once).
fn is_streaming_command(cmd: &str) -> bool {
    matches!(cmd, "chat" | "run_app")
}

/* --------------------------------- chat ---------------------------------- */

/// Run one turn for the phone and stream it back as SSE.
///
/// The turn itself is `commands::chat` — the very function the desktop window
/// invokes. It reports through a `Channel`, so we hand it one whose handler
/// pushes each event straight into this response's body — and, at the same time,
/// forwards it to the desktop window (see `EV_TURN`), so a chat left open on the
/// computer paints the phone's turn live instead of going quiet until reopened.
/// The response half of a streamed command: SSE headers over a body fed by `rx`.
fn sse_response(rx: mpsc::UnboundedReceiver<Bytes>) -> Response<Body> {
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

/// The last frame of a stream: the client's cue that the command is over, however
/// it ended. Without it a client that only ever sees `token`s would wait forever.
fn closing_frame(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(_) => json!({ "type": "end" }),
        Err(e) => json!({ "type": "error", "message": e }),
    }
}

/// The RUN button, driven from a connected client: starts the project's app on
/// *this* machine and streams its output back.
async fn run_app_stream<R: Runtime>(ctx: Ctx<R>, args: Value) -> Response<Body> {
    let project = str_field(&args, "project");
    if project.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "project required");
    }
    let command = args.get("command").and_then(|v| v.as_str()).map(str::to_string);

    let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
    let sink = tx.clone();
    let channel: Channel<Value> = Channel::new(move |payload| {
        if let InvokeResponseBody::Json(raw) = payload {
            let _ = sink.send(sse_frame(&raw));
        }
        Ok(())
    });

    let app = ctx.app.clone();
    tokio::spawn(async move {
        let state = app.state::<AppState>();
        let outcome = commands::run_app(state, project, command, channel).await;
        let _ = tx.send(sse_frame(&closing_frame(outcome).to_string()));
    });

    sse_response(rx)
}

async fn chat_stream<R: Runtime>(ctx: Ctx<R>, body: Value) -> Response<Body> {
    let thread_id = str_field(&body, "threadId");
    let text = str_field(&body, "text");
    if thread_id.is_empty() || text.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "threadId and text required");
    }
    // The phone sends neither; another Krystal sends both (attachment paths on
    // this machine, and the chats its composer #-referenced).
    let files = args_of_strings(&body, "files");
    let refs = args_of_strings(&body, "refs");

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
        let outcome =
            commands::chat(state, thread_id.clone(), text, Some(files), Some(refs), channel).await;
        // `done` has already gone out through the channel on the happy path;
        // this is the cue that the turn itself is over, either way. Both sides get
        // it, so neither is left with a spinner that never settles.
        let raw = closing_frame(outcome.map(|_| Value::Null)).to_string();
        let _ = tx.send(sse_frame(&raw));
        let _ = app.emit(EV_TURN, json!({ "threadId": thread_id, "raw": raw }));
        // Dropping `tx` ends the body; the client sees a clean close.
    });

    sse_response(rx)
}

/* ------------------------------- commands -------------------------------- */

/// Start remote access. `port` is optional; `DEFAULT_PORT` when omitted.
#[tauri::command]
pub async fn remote_start(app: AppHandle, port: Option<u16>) -> Result<Value, String> {
    start(app, port.unwrap_or(DEFAULT_PORT)).await
}

#[tauri::command]
pub fn remote_stop(state: tauri::State<'_, AppState>) -> Value {
    state.remote.shutdown();
    state.remote.status()
}

#[tauri::command]
pub fn remote_status(state: tauri::State<'_, AppState>) -> Value {
    state.remote.status()
}

/// Whether Windows Firewall currently lets other devices reach this Krystal.
/// Shells out to `netsh`, so it runs off the UI thread rather than blocking the
/// window for the second or so that takes.
#[tauri::command]
pub async fn remote_firewall_status() -> Value {
    tauri::async_runtime::spawn_blocking(firewall_status)
        .await
        .unwrap_or_else(|_| json!({ "supported": false, "allowed": Value::Null }))
}

/// Put this Krystal in the firewall's inbound allow list (one UAC prompt).
#[tauri::command]
pub async fn remote_firewall_allow() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(firewall_allow)
        .await
        .map_err(|e| e.to_string())?
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
            remote: Default::default(),
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

        app.state::<AppState>().remote.shutdown();
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

        app.state::<AppState>().remote.shutdown();
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

        app.state::<AppState>().remote.shutdown();
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

    /* --------------------------- command bridge -------------------------- */

    #[tokio::test]
    async fn another_krystal_can_drive_this_one_through_the_command_bridge() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let project = dir.0.join("a project").to_string_lossy().to_string();
        {
            let state = app.state::<AppState>();
            let conn = state.db.lock().unwrap();
            crate::db::create_project(&conn, &project).expect("seed a project");
        }

        let (base, pin) = serve(&app).await;
        let http = client();
        let token = pair(&http, &base, &pin).await;

        let call = |cmd: &'static str, args: Value| {
            let (http, base, token) = (http.clone(), base.clone(), token.clone());
            async move {
                http.post(format!("{base}/api/invoke"))
                    .bearer_auth(token)
                    .json(&json!({ "cmd": cmd, "args": args }))
                    .send()
                    .await
                    .unwrap()
            }
        };

        // A plain read.
        let res = call("list_projects", json!({})).await;
        assert!(res.status().is_success());
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["value"]["projects"][0]["path"], json!(project));

        // A write, then a read that proves it landed: the whole point is that
        // the far machine's database is the one that changed.
        let created: Value = call("create_thread", json!({ "cwd": project }))
            .await
            .json()
            .await
            .unwrap();
        let id = created["value"]["id"].as_str().expect("a thread id").to_string();
        let renamed = call("rename_thread", json!({ "id": id, "title": "From the other PC" })).await;
        assert!(renamed.status().is_success());
        let thread: Value = call("get_thread", json!({ "id": id })).await.json().await.unwrap();
        assert_eq!(thread["value"]["title"], json!("From the other PC"));

        // A command that failed says so as a 400 with the backend's own message,
        // not as a success carrying a null.
        let missing = call("get_thread", json!({ "id": "nope" })).await;
        assert_eq!(missing.status(), 400);
        assert!(missing.json::<Value>().await.unwrap()["error"].is_string());

        app.state::<AppState>().remote.shutdown();
    }

    #[tokio::test]
    async fn the_bridge_refuses_what_is_not_on_the_allowlist() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (base, pin) = serve(&app).await;
        let http = client();
        let token = pair(&http, &base, &pin).await;

        // Commands that act on the machine you are sitting at are not proxied,
        // however well-formed the request is.
        for cmd in ["open_external", "discord_set_project", "remote_start", "exe_path"] {
            let res = http
                .post(format!("{base}/api/invoke"))
                .bearer_auth(&token)
                .json(&json!({ "cmd": cmd, "args": { "url": "https://example.com" } }))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 404, "{cmd} should not be reachable over the network");
        }

        // A streaming command through the wrong door is refused rather than run
        // with its events dropped on the floor.
        let res = http
            .post(format!("{base}/api/invoke"))
            .bearer_auth(&token)
            .json(&json!({ "cmd": "chat", "args": { "threadId": "x", "text": "hi" } }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);

        // And the bridge is behind the same gate as everything else.
        let res = http
            .post(format!("{base}/api/invoke"))
            .json(&json!({ "cmd": "list_projects", "args": {} }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 401);

        app.state::<AppState>().remote.shutdown();
    }

    #[test]
    fn streaming_commands_are_the_two_that_report_through_a_channel() {
        assert!(is_streaming_command("chat"));
        assert!(is_streaming_command("run_app"));
        assert!(!is_streaming_command("list_projects"));
        assert!(!is_streaming_command("update_claude"));
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

        app.state::<AppState>().remote.shutdown();
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

        app.state::<AppState>().remote.shutdown();
    }

    #[tokio::test]
    async fn stopping_the_server_frees_the_port() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (base, _pin) = serve(&app).await;
        let http = client();
        assert!(http.get(&base).send().await.unwrap().status().is_success());

        let state = app.state::<AppState>();
        state.remote.shutdown();
        assert_eq!(state.remote.status()["running"], json!(false));

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

    /* ------------------------------ who got in ---------------------------- */

    #[test]
    fn only_another_device_counts_as_a_client() {
        let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
        // The phone, arriving on this machine's LAN address.
        assert!(from_elsewhere(ip("192.168.1.66"), ip("192.168.1.63")));
        // This machine opening its own page — by `localhost`, or by the very
        // address it shows the user — says nothing about the network.
        assert!(!from_elsewhere(ip("127.0.0.1"), ip("127.0.0.1")));
        assert!(!from_elsewhere(ip("192.168.1.63"), ip("192.168.1.63")));
        assert!(!from_elsewhere(ip("::1"), ip("::1")));
    }

    #[tokio::test]
    async fn opening_the_page_on_the_host_is_not_a_device_reaching_it() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (base, _pin) = serve(&app).await;

        let state = app.state::<AppState>();
        assert!(state.remote.status()["lastClient"].is_null());
        assert!(client().get(&base).send().await.unwrap().status().is_success());
        // Served — and still nothing to report: a loopback request would have
        // worked with every other device on the network locked out.
        assert!(state.remote.status()["lastClient"].is_null());

        state.remote.shutdown();
    }

    /* ------------------------------ firewall ------------------------------ */

    #[test]
    fn firewall_status_is_always_answerable() {
        let s = firewall_status();
        assert_eq!(s["supported"], json!(cfg!(target_os = "windows")));
        // Either a verdict or an honest `null` — never missing, since the panel
        // branches on it.
        assert!(s["allowed"].is_boolean() || s["allowed"].is_null());
    }

    /// The helper script carries an install path straight into PowerShell, so a
    /// path holding a quote must not be able to end the string it sits in.
    #[cfg(target_os = "windows")]
    #[test]
    fn firewall_script_quotes_a_hostile_path() {
        let path = write_firewall_script(r"C:\o'brien\krystal.exe").unwrap();
        let raw = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        // Written for Windows PowerShell 5.1, which needs the BOM to read the
        // file as UTF-8 rather than as the system codepage.
        assert_eq!(&raw[..3], &[0xEF, 0xBB, 0xBF]);
        let text = String::from_utf8(raw[3..].to_vec()).unwrap();
        assert!(text.contains(r"$exe  = 'C:\o''brien\krystal.exe'"), "{text}");
        assert!(text.contains("$name = 'Krystal Remote'"), "{text}");
        // Program-scoped, every profile: the port can change and a laptop can
        // move between a "public" cafe and a "private" home network.
        assert!(text.contains("profile=any"), "{text}");
        assert!(!text.contains("localport"), "{text}");
    }
}
