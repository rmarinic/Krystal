//! Streaming commands (a chat turn, the RUN button's output) as SSE.

use super::*;

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
pub(super) async fn run_app_stream<R: Runtime>(ctx: Ctx<R>, args: Value) -> Response<Body> {
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

pub(super) async fn chat_stream<R: Runtime>(ctx: Ctx<R>, body: Value) -> Response<Body> {
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
