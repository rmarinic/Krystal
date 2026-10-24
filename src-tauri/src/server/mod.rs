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

const INDEX_HTML: &str = include_str!("../webui/index.html");
const APP_CSS: &str = include_str!("../webui/app.css");
const APP_JS: &str = include_str!("../webui/app.js");
// The same markdown renderer + sanitizer the desktop uses, so a reply reads
// identically on both. Embedded rather than served off disk: an installed app
// has no `src/` folder next to it.
const MARKED_JS: &str = include_str!("../../../src/vendor/marked.min.js");
const PURIFY_JS: &str = include_str!("../../../src/vendor/purify.min.js");

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

mod bridge;
mod firewall;
mod http;
mod identity;
mod stream;

use bridge::*;
use firewall::*;
use http::*;
use identity::*;
use stream::*;
pub use identity::lan_ip;

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
            login: Default::default(),
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
            let conn = state.db();
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
            let conn = state.db();
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
        for cmd in ["open_external", "reveal_path", "open_path", "discord_set_project", "remote_start", "exe_path"] {
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
