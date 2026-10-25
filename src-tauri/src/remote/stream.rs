//! Streaming commands (a chat turn, the RUN button's output) as a stream of
//! events.
//!
//! Each event is the JSON text the window's own `Channel` would have received —
//! `commands::chat` reports through a `tauri::ipc::Channel`, and `Channel::new`
//! lets us build one whose handler feeds a queue instead of the webview — so a
//! caller from outside sees byte-for-byte the events this window sees, with no
//! second copy of the streaming logic. The last event is always the stream's own
//! full stop: `{"type":"end"}`, or `{"type":"error","message":…}`.

use super::*;

/// One string argument, trimmed (missing reads as empty).
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

/// Start one streaming command. `None` for a command that doesn't stream (or
/// isn't exposed); `Some(Err)` when it was refused before anything ran — a
/// missing argument, or a chat that already has a turn in flight (`"busy"`).
/// Otherwise the receiver yields every event until the command is over, and
/// closes after the full stop.
pub fn stream<R: Runtime>(
    app: &AppHandle<R>,
    cmd: &str,
    args: Value,
) -> Option<Result<mpsc::UnboundedReceiver<String>, String>> {
    match cmd {
        "chat" => Some(chat_stream(app, args)),
        "run_app" => Some(run_app_stream(app, args)),
        _ => None,
    }
}

/// The last event of a stream: the caller's cue that the command is over, however
/// it ended. Without it a caller that only ever sees `token`s would wait forever.
fn closing_frame(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(_) => json!({ "type": "end" }),
        Err(e) => json!({ "type": "error", "message": e }),
    }
}

/// The RUN button, driven from outside: starts the project's app on *this*
/// machine and streams its output back.
fn run_app_stream<R: Runtime>(
    app: &AppHandle<R>,
    args: Value,
) -> Result<mpsc::UnboundedReceiver<String>, String> {
    let project = str_field(&args, "project");
    if project.is_empty() {
        return Err("project required".into());
    }
    let command = args.get("command").and_then(|v| v.as_str()).map(str::to_string);

    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let sink = tx.clone();
    let channel: Channel<Value> = Channel::new(move |payload| {
        if let InvokeResponseBody::Json(raw) = payload {
            let _ = sink.send(raw);
        }
        Ok(())
    });

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let outcome = commands::run_app(state, project, command, channel).await;
        let _ = tx.send(closing_frame(outcome).to_string());
    });

    Ok(rx)
}

/// Run one turn for a caller from outside and stream it back.
///
/// The turn itself is `commands::chat` — the very function the desktop window
/// invokes. It reports through a `Channel`, so we hand it one whose handler
/// pushes each event straight into the caller's queue — and, at the same time,
/// forwards it to the desktop window (see `EV_TURN`), so a chat left open on the
/// computer paints the turn live instead of going quiet until reopened.
fn chat_stream<R: Runtime>(
    app: &AppHandle<R>,
    body: Value,
) -> Result<mpsc::UnboundedReceiver<String>, String> {
    let thread_id = str_field(&body, "threadId");
    let text = str_field(&body, "text");
    if thread_id.is_empty() || text.is_empty() {
        return Err("threadId and text required".into());
    }
    // Attachment paths on this machine, and the chats a composer #-referenced.
    let files = args_of_strings(&body, "files");
    let refs = args_of_strings(&body, "refs");

    // One turn at a time per chat. Without this a caller could open a second
    // turn on a chat the desktop is already streaming, and both would be writing
    // to the same warm session.
    {
        let state: tauri::State<'_, AppState> = app.state();
        if state.running.lock().unwrap().contains_key(&thread_id) {
            return Err("busy".into());
        }
    }

    let (tx, rx) = mpsc::unbounded_channel::<String>();

    // Tell the desktop a turn it did not start is beginning, and with what — it
    // needs the user's message to render the bubble above the reply.
    let turn = uuid::Uuid::new_v4().to_string();
    let _ = app.emit(EV_TURN_START, json!({ "threadId": thread_id, "turn": turn, "text": text }));

    // `Channel::send` serialises to `InvokeResponseBody::Json(String)` — already
    // exactly the JSON the desktop's channel callback receives, so the same text
    // goes to both the caller and the window (as a Tauri event).
    let sink = tx.clone();
    let mirror = app.clone();
    let (mirror_id, mirror_turn) = (thread_id.clone(), turn.clone());
    let channel: Channel<Value> = Channel::new(move |payload| {
        if let InvokeResponseBody::Json(raw) = payload {
            let _ = mirror.emit(EV_TURN, json!({ "threadId": mirror_id, "turn": mirror_turn, "raw": raw }));
            let _ = sink.send(raw);
        }
        Ok(())
    });

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let outcome =
            commands::chat(state, thread_id.clone(), text, Some(files), Some(refs), channel).await;
        // `done` has already gone out through the channel on the happy path;
        // this is the cue that the turn itself is over, either way. Both sides get
        // it, so neither is left with a spinner that never settles.
        let raw = closing_frame(outcome.map(|_| Value::Null)).to_string();
        let _ = app.emit(EV_TURN, json!({ "threadId": thread_id, "turn": turn, "raw": raw }));
        let _ = app.emit(EV_TURN_END, json!({ "threadId": thread_id, "turn": turn }));
        let _ = tx.send(raw);
        // Dropping `tx` ends the stream; the caller sees it close.
    });

    Ok(rx)
}
