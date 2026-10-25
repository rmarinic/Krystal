//! Commands reachable from outside this window — the half of remote access that
//! outlived the LAN server.
//!
//! The window talks to the backend over Tauri IPC, which nothing off this machine
//! can reach. Whatever carries a call in from elsewhere (the Krystal Cloud relay,
//! phase 4) hands it to this module as a command name plus JSON arguments, and
//! gets JSON back — or, for a turn, a stream of events. Same command functions
//! the window calls, same database, same warm `claude` sessions: whatever drives
//! this machine from outside is another view of one app, not a second app.
//!
//!   * `bridge` — `dispatch`: the allowlist of commands that may be called from
//!     outside, and `LOCAL_ONLY`, the ones that never may.
//!   * `stream` — a chat turn (and the RUN button) as a stream of events, which
//!     are also mirrored to the window so an open chat paints the turn live.
//!
//! No transport lives here: no sockets, no HTTP types. The carrier is somebody
//! else's concern.

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::mpsc;

use crate::commands::{self, AppState};

/* ---------------------- events pushed to the window ---------------------- */
/* Whoever drives this machine from outside and this window are two views of
 * one app, so anything done over there has to reach the window showing the same
 * chat. These carry it; `src/app/mirror.js` listens and replays the turn through
 * exactly the same live-turn machinery a locally-typed one goes through. */

/// A turn began from outside: `{ threadId, text }`.
const EV_TURN_START: &str = "remote-turn-start";
/// One event of that turn, verbatim: `{ threadId, raw }` (`raw` is the JSON the
/// caller receives, unparsed — the window parses it itself).
const EV_TURN: &str = "remote-turn";
/// A chat was created from outside: `{ project }`.
const EV_THREADS: &str = "remote-threads-changed";

mod bridge;
mod stream;

pub use bridge::{dispatch, is_streaming_command, LOCAL_ONLY};
pub use stream::stream;

#[cfg(test)]
mod tests {
    use super::*;

    /* These stand the bridge up against a mock Tauri app holding a throwaway
     * AppState, and call it the way a carrier would: a name and JSON in, JSON
     * (or a stream of events) out. */

    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::Listener;

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
            cloud: crate::cloud::for_tests(),
        });
        app
    }

    /// A scratch directory that cleans itself up.
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("krystal-remote-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Everything a stream sent, parsed, up to the moment it closed.
    async fn drain(mut rx: mpsc::UnboundedReceiver<String>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Some(raw) = rx.recv().await {
            out.push(serde_json::from_str(&raw).expect("every event is JSON"));
        }
        out
    }

    /* --------------------------- command bridge -------------------------- */

    #[tokio::test]
    async fn a_caller_from_outside_drives_this_machine_through_dispatch() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let project = dir.0.join("a project").to_string_lossy().to_string();
        {
            let state = app.state::<AppState>();
            let conn = state.db();
            crate::db::create_project(&conn, &project).expect("seed a project");
        }
        let h = app.handle();

        // A plain read.
        let listed = dispatch(h, "list_projects", &json!({})).await.unwrap().unwrap();
        assert_eq!(listed["projects"][0]["path"], json!(project));

        // A write, then a read that proves it landed: the whole point is that
        // this machine's database is the one that changed.
        let created = dispatch(h, "create_thread", &json!({ "cwd": project })).await.unwrap().unwrap();
        let id = created["id"].as_str().expect("a thread id").to_string();
        dispatch(h, "rename_thread", &json!({ "id": id, "title": "From the phone" }))
            .await
            .unwrap()
            .expect("rename");
        let thread = dispatch(h, "get_thread", &json!({ "id": id })).await.unwrap().unwrap();
        assert_eq!(thread["title"], json!("From the phone"));

        // A command that failed says so with the backend's own message, rather
        // than succeeding with a null.
        let missing = dispatch(h, "get_thread", &json!({ "id": "nope" })).await.unwrap();
        assert!(missing.is_err());
    }

    #[tokio::test]
    async fn a_chat_created_from_outside_shows_up_in_the_window() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let project = dir.0.join("p").to_string_lossy().to_string();
        {
            let state = app.state::<AppState>();
            crate::db::create_project(&state.db(), &project).expect("seed a project");
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        app.listen(EV_THREADS, move |e| {
            let _ = tx.send(e.payload().to_string());
        });

        dispatch(app.handle(), "create_thread", &json!({ "cwd": project })).await.unwrap().unwrap();
        let payload: Value = serde_json::from_str(&rx.recv().await.expect("an event")).unwrap();
        assert_eq!(payload["project"], json!(project));
    }

    #[tokio::test]
    async fn dispatch_refuses_everything_that_is_local_only() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        // Commands that act on the machine you are sitting at are never run for
        // someone elsewhere, however well-formed the request is.
        for cmd in LOCAL_ONLY {
            let args = json!({ "url": "https://example.com" });
            assert!(dispatch(app.handle(), cmd, &args).await.is_none(), "{cmd} is reachable from outside");
            assert!(stream(app.handle(), cmd, args).is_none(), "{cmd} streams to outside");
        }
        // A streaming command through the plain door is refused rather than run
        // with its events dropped on the floor, and an unknown name is nothing.
        assert!(dispatch(app.handle(), "chat", &json!({ "threadId": "x", "text": "hi" })).await.is_none());
        assert!(dispatch(app.handle(), "no_such_command", &json!({})).await.is_none());
    }

    #[test]
    fn streaming_commands_are_the_two_that_report_through_a_channel() {
        assert!(is_streaming_command("chat"));
        assert!(is_streaming_command("run_app"));
        assert!(!is_streaming_command("list_projects"));
        assert!(!is_streaming_command("update_claude"));
    }

    /* ------------------------------ streams ------------------------------ */

    #[tokio::test]
    async fn a_failed_turn_still_arrives_as_an_event() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);

        // An unknown thread fails inside `commands::chat` — before any `claude`
        // process is spawned — which is the path worth exercising here: by the
        // time a turn can fail the caller is already reading the stream, so the
        // error has to arrive as an event in it, not as a refusal up front.
        let rx = stream(app.handle(), "chat", json!({ "threadId": "no-such-thread", "text": "hello" }))
            .expect("chat streams")
            .expect("the stream opens");
        let events = drain(rx).await;
        let last = events.last().expect("at least the closing event");
        assert_eq!(last["type"], json!("error"));
        assert_eq!(last["message"], json!("unknown thread"));
    }

    #[tokio::test]
    async fn the_window_sees_a_turn_from_outside_begin_and_end() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, String)>();
        for ev in [EV_TURN_START, EV_TURN] {
            let tx = tx.clone();
            app.listen(ev, move |e| {
                let _ = tx.send((ev.to_string(), e.payload().to_string()));
            });
        }

        let events = stream(app.handle(), "chat", json!({ "threadId": "t1", "text": "hi" }))
            .unwrap()
            .unwrap();
        drain(events).await;

        let (first, start) = rx.recv().await.unwrap();
        assert_eq!(first, EV_TURN_START);
        let start: Value = serde_json::from_str(&start).unwrap();
        assert_eq!(start, json!({ "threadId": "t1", "text": "hi" }));
        let (second, turn) = rx.recv().await.unwrap();
        assert_eq!(second, EV_TURN);
        let turn: Value = serde_json::from_str(&turn).unwrap();
        let raw: Value = serde_json::from_str(turn["raw"].as_str().unwrap()).unwrap();
        assert_eq!(raw["type"], json!("error"));
    }

    #[tokio::test]
    async fn a_missing_field_is_refused_before_anything_is_streamed() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let refused = stream(app.handle(), "chat", json!({ "threadId": "abc" })).expect("chat streams");
        assert!(refused.is_err());
        let refused = stream(app.handle(), "run_app", json!({})).expect("run_app streams");
        assert!(refused.is_err());
    }

    #[tokio::test]
    async fn a_chat_already_streaming_here_is_busy() {
        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        app.state::<AppState>().running.lock().unwrap().insert("t1".into(), 1);
        let refused = stream(app.handle(), "chat", json!({ "threadId": "t1", "text": "hi" })).unwrap();
        assert_eq!(refused.err().as_deref(), Some("busy"));
    }
}
