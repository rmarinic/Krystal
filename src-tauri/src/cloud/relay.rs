//! The relay: someone signed in at app.krystal.rip drives this computer through
//! the live connection `presence` keeps open. The cloud sends a request down
//! the socket; it runs through `crate::remote`, the same commands the window
//! calls, and the answer goes back up the same way.
//!
//! The contract is `../krystal-cloud/PROTOCOL.md`, "Relaying (apiVersion 2)"
//! (cloud end `worker/frames.js`), implemented exactly:
//!
//!   ← `{"type":"call",   "id", "command", "args", "from"}` a plain command
//!   ← `{"type":"stream", "id", "command", "args", "from"}` a chat turn, the RUN button
//!   → `{"type":"result", "id", "ok": true, "value"}`, or `"ok": false` with a
//!     `"code"`: `failed` (the command said why, in `error`), `not-allowed`
//!     (this computer won't run it for anyone elsewhere) or `refused` (a stream
//!     that couldn't start, `error` says why)
//!   → `{"type":"events", "id", "events": […], "end": bool}` a stream's events
//!   ← `{"type":"ack", "id", "frames": n}` n `events` frames reached the browser
//!   ← `{"type":"cancel", "id"}` nobody is listening any more
//!   → `{"type":"part", "id", "data", "last"}` a frame over `maxFrame`, in pieces
//!
//! A call is answered once, with a `result`. A stream is answered with `events`
//! frames, in order, the last one `end: true`. A stream refused before it began
//! (a chat that is busy, a missing argument) gets one `result` with `ok: false`
//! instead. Every frame wakes the cloud and is billed, so a stream's events are
//! batched: a frame goes once its oldest event is `BATCH_AFTER` old, once it
//! holds `BATCH_BYTES`, or when the stream ends. At most `window` `events`
//! frames of one stream go unacknowledged; what arrives meanwhile waits and
//! goes out together in the next frame.
//!
//! A `cancel` only stops the sending. A turn goes on (stopping it is a call of
//! its own, `stop_chat`) and so does a call, whose answer is then dropped.
//! When the socket goes, everything in flight on it goes the same way.
//!
//! `LOCAL_ONLY` is refused here, before `remote` is asked, as well as by
//! `remote` itself: two doors, so neither one alone can let it through.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tokio::sync::mpsc::{self, error::TryRecvError, UnboundedReceiver, UnboundedSender};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{sleep_until, Duration, Instant};

use crate::remote::{is_streaming_command, LOCAL_ONLY};

/// The protocol version the relay arrives with. A welcome below it (a cloud
/// that only does presence) leaves the relay off.
pub const RELAY_VERSION: u64 = 2;

/// `events` frames of one stream that may be unacknowledged, when the welcome
/// doesn't say (the cloud says 16).
const WINDOW: u64 = 16;

/// The largest frame sent whole, when the welcome doesn't say (the cloud says
/// 1 MiB). Anything bigger goes as `part`s.
const MAX_FRAME: usize = 1 << 20;

/// The most the cloud puts back together from `part`s. A call's answer bigger
/// than this is refused (`too-large`) instead of sent to be thrown away.
const MAX_ASSEMBLED: usize = 32 << 20;

/// The smallest `maxFrame` honoured: a part has to leave room for its data.
const MIN_FRAME: usize = 4 << 10;

/// A stream's frame goes once its oldest event has waited this long…
const BATCH_AFTER: Duration = Duration::from_millis(50);

/// …or once it holds this much, whichever comes first.
const BATCH_BYTES: usize = 64 << 10;

/// The most JSON text one `part` carries.
const PART_BYTES: usize = 256 << 10;

/// What a refusal says when this computer won't run the command for anyone
/// elsewhere. The code is what the cloud reads; the words are for a log.
const NOT_ALLOWED: &str = "not-allowed";

/// A stream's events, as the JSON text the window's own Channel would get.
pub type Events = UnboundedReceiver<String>;

/// Whatever runs the commands: `AppHandler` (this app's own `remote` module),
/// or a fake in the tests.
pub trait Handler: Send + Sync + 'static {
    /// A plain command. `None` if it isn't exposed.
    fn call(&self, command: String, args: Value) -> BoxFuture<'static, Option<Result<Value, String>>>;
    /// A streaming command. `None` if it isn't exposed, `Some(Err)` if it was
    /// refused before anything ran.
    fn stream(&self, command: &str, args: Value) -> Option<Result<Events, String>>;
}

/// The commands of this app, run by `remote` on its own state.
pub struct AppHandler<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> Handler for AppHandler<R> {
    fn call(&self, command: String, args: Value) -> BoxFuture<'static, Option<Result<Value, String>>> {
        let app = self.0.clone();
        Box::pin(async move { crate::remote::dispatch(&app, &command, &args).await })
    }

    fn stream(&self, command: &str, args: Value) -> Option<Result<Events, String>> {
        crate::remote::stream(&self.0, command, args)
    }
}

/* ------------------------------- one connection ----------------------------- */

/// The relay on one open socket. What it has to send goes into the outbox
/// `new` hands back, which the socket's loop drains. Dropping it (the socket
/// closed) stops every stream on it.
pub(super) struct Relay {
    /// `None` while the relay is off: below v2, or nothing to run commands.
    handler: Option<Arc<dyn Handler>>,
    out: UnboundedSender<String>,
    window: u64,
    max_frame: usize,
    requests: HashMap<String, Request>,
}

/// One request in flight.
struct Request {
    task: JoinHandle<()>,
    /// A stream's count of acknowledged frames; `None` for a call.
    acked: Option<watch::Sender<u64>>,
    /// A call whose answer nobody wants any more.
    dropped: Arc<AtomicBool>,
}

impl Request {
    /// Stop sending. A stream's forwarder goes at once; a call runs to its end
    /// (half a command is worse than an unread answer) and keeps its answer.
    fn cancel(&self) {
        self.dropped.store(true, Ordering::SeqCst);
        if self.acked.is_some() {
            self.task.abort();
        }
    }
}

impl Relay {
    /// The relay for a connection, set up from its `welcome`.
    pub(super) fn new(handler: Option<Arc<dyn Handler>>, welcome: &Value) -> (Self, UnboundedReceiver<String>) {
        let (out, outbox) = mpsc::unbounded_channel();
        let on = welcome["apiVersion"].as_u64().is_some_and(|v| v >= RELAY_VERSION);
        let window = welcome["window"].as_u64().unwrap_or(WINDOW).clamp(1, 1024);
        let max_frame = welcome["maxFrame"]
            .as_u64()
            .map_or(MAX_FRAME, |n| usize::try_from(n).unwrap_or(MAX_ASSEMBLED))
            .clamp(MIN_FRAME, MAX_ASSEMBLED);
        let relay = Self { handler: handler.filter(|_| on), out, window, max_frame, requests: HashMap::new() };
        (relay, outbox)
    }

    /// A message from the cloud that isn't presence's. Anything the relay
    /// doesn't know is ignored, as the protocol asks.
    pub(super) fn frame(&mut self, m: &Value) {
        let Some(handler) = self.handler.clone() else { return };
        let Some(id) = m["id"].as_str().map(str::to_string) else { return };
        match m["type"].as_str() {
            Some(kind @ ("call" | "stream")) => {
                // Finished requests leave here, so the map only holds what's in flight.
                self.requests.retain(|_, r| !r.task.is_finished());
                if self.requests.contains_key(&id) {
                    return;
                }
                let command = m["command"].as_str().unwrap_or("").to_string();
                let args = if m["args"].is_object() { m["args"].clone() } else { json!({}) };
                if kind == "call" {
                    self.call(&handler, id, command, args);
                } else {
                    self.stream(&handler, id, command, args);
                }
            }
            Some("ack") => {
                let n = m["frames"].as_u64().unwrap_or(0);
                if let Some(acked) = self.requests.get(&id).and_then(|r| r.acked.as_ref()) {
                    acked.send_if_modified(|a| {
                        let more = n > *a;
                        if more {
                            *a = n;
                        }
                        more
                    });
                }
            }
            Some("cancel") => {
                if let Some(r) = self.requests.remove(&id) {
                    r.cancel();
                }
            }
            _ => {}
        }
    }

    fn call(&mut self, handler: &Arc<dyn Handler>, id: String, command: String, args: Value) {
        let answer = if LOCAL_ONLY.contains(&command.as_str()) {
            Err(NOT_ALLOWED)
        } else if is_streaming_command(&command) {
            // It reports as it goes; through this door its events would be lost.
            Err("stream-only")
        } else {
            Ok(handler.call(command, args))
        };
        let dropped = Arc::new(AtomicBool::new(false));
        let (out, max, flag, rid) = (self.out.clone(), self.max_frame, dropped.clone(), id.clone());
        let task = tokio::spawn(async move {
            let answer = match answer {
                Ok(running) => running.await,
                Err(why) => return send(&out, &rid, not_allowed(&rid, why), max),
            };
            if !flag.load(Ordering::SeqCst) {
                send(&out, &rid, result_frame(&rid, answer), max);
            }
        });
        self.requests.insert(id, Request { task, acked: None, dropped });
    }

    fn stream(&mut self, handler: &Arc<dyn Handler>, id: String, command: String, args: Value) {
        let events = if LOCAL_ONLY.contains(&command.as_str()) { None } else { handler.stream(&command, args) };
        let rx = match events {
            Some(Ok(rx)) => rx,
            None => return send(&self.out, &id, not_allowed(&id, NOT_ALLOWED), self.max_frame),
            Some(Err(e)) => return send(&self.out, &id, refused(&id, &e), self.max_frame),
        };
        let (acked, acks) = watch::channel(0);
        let task = tokio::spawn(forward(id.clone(), rx, acks, self.out.clone(), self.window, self.max_frame));
        self.requests.insert(id, Request { task, acked: Some(acked), dropped: Arc::default() });
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        // The cloud has already ended these for the browser (`device-offline`).
        for r in self.requests.values() {
            r.cancel();
        }
    }
}

/// One stream, from its first event to its last: batched into `events`
/// frames, never more than `window` of them unacknowledged.
async fn forward(
    id: String,
    mut rx: Events,
    mut acks: watch::Receiver<u64>,
    out: UnboundedSender<String>,
    window: u64,
    max_frame: usize,
) {
    let cap = BATCH_BYTES.min(max_frame);
    let mut waiting: VecDeque<String> = VecDeque::new();
    let mut bytes = 0;
    // When the oldest event still waiting arrived. Left over from a full
    // frame, it is already old enough: those go as soon as the window lets them.
    let mut oldest = Instant::now();
    let mut over = false;
    let mut sent: u64 = 0;
    loop {
        if waiting.is_empty() && !over {
            match rx.recv().await {
                Some(ev) => {
                    oldest = Instant::now();
                    bytes = ev.len();
                    waiting.push_back(ev);
                }
                None => over = true,
            }
        }
        // Gather until the oldest is `BATCH_AFTER` old, the batch is full, or
        // the stream is over.
        let due = oldest + BATCH_AFTER;
        while !over && bytes < cap {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Some(ev) => {
                        bytes += ev.len();
                        waiting.push_back(ev);
                    }
                    None => over = true,
                },
                _ = sleep_until(due) => break,
            }
        }
        // Room in the window; whatever arrived meanwhile goes in the same frame.
        if acks.wait_for(|acked| sent < acked + window).await.is_err() {
            return;
        }
        loop {
            match rx.try_recv() {
                Ok(ev) => waiting.push_back(ev),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    over = true;
                    break;
                }
            }
        }
        let (frame, end) = events_frame(&id, &mut waiting, over, cap);
        bytes = waiting.iter().map(String::len).sum();
        for text in pieces(frame, &id, max_frame) {
            if out.send(text).is_err() {
                return;
            }
        }
        sent += 1;
        if end {
            return;
        }
    }
}

/* ---------------------------------- frames ---------------------------------- */

/// This computer won't run that for anyone elsewhere; `why` is for a log.
fn not_allowed(id: &str, why: &str) -> String {
    json!({ "type": "result", "id": id, "ok": false, "code": NOT_ALLOWED, "error": why }).to_string()
}

/// A stream that couldn't start: busy, a missing argument.
fn refused(id: &str, error: &str) -> String {
    json!({ "type": "result", "id": id, "ok": false, "code": "refused", "error": error }).to_string()
}

/// A command that ran and said why it couldn't do it.
fn failed(id: &str, error: &str) -> String {
    json!({ "type": "result", "id": id, "ok": false, "code": "failed", "error": error }).to_string()
}

/// A call's answer. `None` is a command this computer doesn't expose.
fn result_frame(id: &str, answer: Option<Result<Value, String>>) -> String {
    match answer {
        None => not_allowed(id, NOT_ALLOWED),
        Some(Err(e)) => failed(id, &e),
        Some(Ok(value)) => {
            let text = json!({ "type": "result", "id": id, "ok": true, "value": value }).to_string();
            if text.len() > MAX_ASSEMBLED { failed(id, "too-large") } else { text }
        }
    }
}

/// The next `events` frame: as many waiting events as fit in `cap` (always at
/// least one), and whether it is the stream's last.
fn events_frame(id: &str, waiting: &mut VecDeque<String>, over: bool, cap: usize) -> (String, bool) {
    const TAIL: &str = r#"],"end":false}"#;
    let mut text = format!(r#"{{"type":"events","id":{},"events":["#, Value::from(id));
    let mut n = 0;
    while let Some(ev) = waiting.front() {
        if n > 0 && text.len() + 1 + ev.len() + TAIL.len() > cap {
            break;
        }
        if n > 0 {
            text.push(',');
        }
        // Each event is already JSON (what a Channel sends), so it goes in as is.
        text.push_str(ev);
        waiting.pop_front();
        n += 1;
    }
    let end = over && waiting.is_empty();
    text.push_str(if end { r#"],"end":true}"# } else { TAIL });
    (text, end)
}

/// A frame as it goes on the wire: whole, or as `part`s of at most `PART_BYTES`
/// of its text, cut on character boundaries, none over `max_frame` once its
/// data is escaped.
fn pieces(frame: String, id: &str, max_frame: usize) -> Vec<String> {
    if frame.len() <= max_frame {
        return vec![frame];
    }
    let overhead = json!({ "type": "part", "id": id, "data": "", "last": false }).to_string().len();
    let budget = max_frame.saturating_sub(overhead).max(64);
    let mut cuts = Vec::new();
    let (mut start, mut size) = (0, 0);
    for (i, c) in frame.char_indices() {
        let w = escaped_len(c);
        if size + w > budget || i + c.len_utf8() - start > PART_BYTES {
            cuts.push(&frame[start..i]);
            (start, size) = (i, 0);
        }
        size += w;
    }
    cuts.push(&frame[start..]);
    let last = cuts.len() - 1;
    cuts.iter()
        .enumerate()
        .map(|(k, data)| json!({ "type": "part", "id": id, "data": data, "last": k == last }).to_string())
        .collect()
}

/// How long `c` is inside a JSON string, as serde_json writes it.
fn escaped_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

/// Put a frame in the outbox, in pieces if it must be. A closed outbox is a
/// socket that has gone, and the cloud has already told the browser.
fn send(out: &UnboundedSender<String>, id: &str, frame: String, max_frame: usize) {
    for text in pieces(frame, id, max_frame) {
        let _ = out.send(text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    use super::super::fakes::*;
    use super::super::presence::{read, PING};
    use tokio::time::sleep;

    /* The relay through the real connection loop: `Rig` is presence on a fake
     * socket in paused tokio time, the test plays the cloud at the far end, and
     * `FakeHandler` stands in for the app's commands — so what's under test is
     * the framing, the window, cancelling and the doors. The last test swaps in
     * the app itself (a mock Tauri app on a scratch database). */

    /// Commands the way the tests want them. A call runs anything it's asked
    /// (so only the relay's own door keeps `LOCAL_ONLY` out) except the few
    /// names below; a stream hands out a turn the test plays itself.
    #[derive(Default)]
    struct FakeHandler {
        asked: Mutex<Vec<String>>,
        /// The near end of the last stream handed out: the turn, as the test plays it.
        turn: Mutex<Option<UnboundedSender<String>>>,
    }

    impl FakeHandler {
        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
        /// The turn of the last stream, handed over: when the test drops it,
        /// the turn is over.
        fn turn(&self) -> UnboundedSender<String> {
            self.turn.lock().unwrap().take().expect("a stream was opened")
        }
    }

    impl Handler for FakeHandler {
        fn call(&self, command: String, args: Value) -> BoxFuture<'static, Option<Result<Value, String>>> {
            self.asked.lock().unwrap().push(command.clone());
            Box::pin(async move {
                match command.as_str() {
                    "nothing_here" => None,
                    "boom" => Some(Err("it broke".into())),
                    "slow" => {
                        sleep(Duration::from_secs(5)).await;
                        Some(Ok(json!("late")))
                    }
                    "big" => Some(Ok(json!(BIG.repeat(args["n"].as_u64().unwrap() as usize)))),
                    _ => Some(Ok(json!({ "ran": command, "args": args }))),
                }
            })
        }

        fn stream(&self, command: &str, _args: Value) -> Option<Result<Events, String>> {
            self.asked.lock().unwrap().push(command.to_string());
            match command {
                "busy_chat" => Some(Err("busy".into())),
                "nothing_here" => None,
                _ => {
                    let (tx, rx) = mpsc::unbounded_channel();
                    *self.turn.lock().unwrap() = Some(tx);
                    Some(Ok(rx))
                }
            }
        }
    }

    /// Quotes, a newline and a control character grow when escaped; ž is two bytes.
    const BIG: &str = "\"x\"\n\u{1}ž";

    /// Presence on a fake socket, welcomed at `api` with `window`, serving `handler`.
    async fn connected(handler: Arc<dyn Handler>, api: u64, window: u64) -> (Rig, Cloud) {
        let mut rig = Rig::new();
        rig.p.serve(handler);
        let mut cloud = rig.wire.socket();
        rig.start();
        let Sent::Text(hello) = cloud.heard().await else { panic!("expected a hello") };
        assert_eq!(read(&hello)["apiVersion"], RELAY_VERSION, "the desktop speaks the relay");
        cloud.say(json!({
            "type": "welcome", "deviceId": "dev-1", "name": "MARIN-PC",
            "account": { "email": "you@example.com" }, "apiVersion": api, "heartbeat": 300,
            "window": window, "maxFrame": MIN_FRAME,
        }));
        rig.until("online").await;
        (rig, cloud)
    }

    fn request(kind: &str, id: &str, command: &str, args: Value) -> Value {
        json!({
            "type": kind, "id": id, "command": command, "args": args,
            "from": { "email": "you@example.com", "owner": true },
        })
    }

    /// The next frame the desktop sent that isn't a heartbeat (answered, so
    /// the connection stays up however long the test waits).
    async fn next(cloud: &mut Cloud) -> Value {
        loop {
            match cloud.heard().await {
                Sent::Text(t) if t == PING => cloud.say(json!({ "type": "pong" })),
                Sent::Text(t) => return read(&t),
                Sent::Close(c) => panic!("closed with {c}"),
            }
        }
    }

    /// Whatever the desktop has sent by now, heartbeats aside.
    fn sent_so_far(cloud: &mut Cloud) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(s) = cloud.rx.try_recv() {
            if let Sent::Text(t) = s {
                if t != PING {
                    out.push(read(&t));
                }
            }
        }
        out
    }

    /// The next whole frame, `part`s put back together as the cloud does.
    async fn whole(cloud: &mut Cloud) -> Value {
        let mut data = String::new();
        loop {
            let m = next(cloud).await;
            if m["type"] != "part" {
                assert!(data.is_empty(), "a part's frame interrupted: {m}");
                return m;
            }
            data.push_str(m["data"].as_str().unwrap());
            if m["last"] == true {
                return read(&data);
            }
        }
    }

    /* ---------------------------------- calls --------------------------------- */

    #[tokio::test(start_paused = true)]
    async fn a_call_is_answered_once_with_its_result() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 16).await;
        cloud.say(request("call", "r1", "list_projects", json!({ "q": 1 })));
        assert_eq!(
            next(&mut cloud).await,
            json!({ "type": "result", "id": "r1", "ok": true, "value": { "ran": "list_projects", "args": { "q": 1 } } })
        );
        cloud.say(request("call", "r2", "boom", json!({})));
        assert_eq!(
            next(&mut cloud).await,
            json!({ "type": "result", "id": "r2", "ok": false, "code": "failed", "error": "it broke" })
        );
        cloud.say(request("call", "r3", "nothing_here", json!({})));
        let m = next(&mut cloud).await;
        assert_eq!((m["id"].as_str(), m["ok"].as_bool(), m["code"].as_str()), (Some("r3"), Some(false), Some("not-allowed")));
        // Arguments that aren't an object arrive as none at all.
        cloud.say(json!({ "type": "call", "id": "r4", "command": "list_projects", "args": [1] }));
        assert_eq!(next(&mut cloud).await["value"]["args"], json!({}));
        sleep(Duration::from_secs(1)).await;
        assert!(sent_so_far(&mut cloud).is_empty(), "one answer each");
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_local_only_is_ever_run_from_outside() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 16).await;
        // The fake would run anything; only the relay's own door stands here.
        for (n, cmd) in LOCAL_ONLY.iter().enumerate() {
            for kind in ["call", "stream"] {
                let id = format!("{kind}-{n}");
                cloud.say(request(kind, &id, cmd, json!({ "url": "https://example.com", "on": true })));
                let m = next(&mut cloud).await;
                assert_eq!(m["type"], "result", "{kind} {cmd}: {m}");
                assert_eq!((m["id"].as_str(), m["ok"].as_bool()), (Some(id.as_str()), Some(false)), "{kind} {cmd}");
                assert_eq!(m["code"], "not-allowed", "{kind} {cmd}");
            }
        }
        assert!(h.asked().is_empty(), "asked to run {:?}", h.asked());
    }

    #[tokio::test(start_paused = true)]
    async fn a_streaming_command_through_the_call_door_is_refused_not_run() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 16).await;
        for cmd in ["chat", "run_app"] {
            cloud.say(request("call", cmd, cmd, json!({ "threadId": "t1", "text": "hi" })));
            let m = next(&mut cloud).await;
            assert_eq!((m["ok"].as_bool(), m["code"].as_str()), (Some(false), Some("not-allowed")), "{m}");
        }
        assert!(h.asked().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_call_finishes_but_its_answer_is_dropped() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 16).await;
        cloud.say(request("call", "r1", "slow", json!({})));
        sleep(Duration::from_secs(1)).await;
        cloud.say(json!({ "type": "cancel", "id": "r1" }));
        sleep(Duration::from_secs(10)).await;
        assert_eq!(h.asked(), ["slow"]);
        assert!(sent_so_far(&mut cloud).is_empty());
        // The next one is answered as usual.
        cloud.say(request("call", "r2", "slow", json!({})));
        assert_eq!(next(&mut cloud).await["value"], "late");
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_over_max_frame_goes_in_parts_that_add_back_up() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 16).await;
        cloud.say(request("call", "big", "big", json!({ "n": 3000 })));
        let mut data = String::new();
        let mut parts = 0;
        loop {
            let Sent::Text(t) = cloud.heard().await else { panic!("closed") };
            assert!(t.len() <= MIN_FRAME, "a part of {} bytes", t.len());
            let m = read(&t);
            assert_eq!((m["type"].as_str(), m["id"].as_str()), (Some("part"), Some("big")));
            data.push_str(m["data"].as_str().unwrap());
            parts += 1;
            if m["last"] == true {
                break;
            }
        }
        assert!(parts > 5, "{parts} parts");
        let m = read(&data);
        assert_eq!((m["type"].as_str(), m["ok"].as_bool()), (Some("result"), Some(true)));
        assert_eq!(m["value"], json!(BIG.repeat(3000)));
    }

    /* --------------------------------- streams -------------------------------- */

    #[tokio::test(start_paused = true)]
    async fn a_stream_sends_its_events_in_order_and_says_when_it_is_over() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 16).await;
        cloud.say(request("stream", "s1", "chat", json!({ "threadId": "t1", "text": "hi" })));
        sleep(Duration::from_millis(1)).await;
        let turn = h.turn();
        turn.send(json!({ "type": "token", "text": "Hel" }).to_string()).unwrap();
        assert_eq!(
            next(&mut cloud).await,
            json!({ "type": "events", "id": "s1", "events": [{ "type": "token", "text": "Hel" }], "end": false })
        );
        for ev in [json!({ "type": "token", "text": "lo" }), json!({ "type": "done", "text": "Hello" }), json!({ "type": "end" })] {
            turn.send(ev.to_string()).unwrap();
        }
        drop(turn);
        // Whatever was waiting goes together; the last frame says it's the end.
        let mut kinds = Vec::new();
        loop {
            let m = next(&mut cloud).await;
            assert_eq!((m["type"].as_str(), m["id"].as_str()), (Some("events"), Some("s1")));
            kinds.extend(m["events"].as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap().to_string()));
            if m["end"] == true {
                break;
            }
        }
        assert_eq!(kinds, ["token", "done", "end"]);
        sleep(Duration::from_secs(1)).await;
        assert!(sent_so_far(&mut cloud).is_empty(), "nothing after the end");
    }

    #[tokio::test(start_paused = true)]
    async fn no_more_than_the_window_goes_unacknowledged() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 2).await;
        cloud.say(request("stream", "s1", "chat", json!({})));
        sleep(Duration::from_millis(1)).await;
        let turn = h.turn();
        let token = |n: u32| json!({ "type": "token", "text": n.to_string() }).to_string();
        // One event at a time, each given the time to go alone.
        for n in 1..=6 {
            turn.send(token(n)).unwrap();
            sleep(Duration::from_millis(100)).await;
        }
        let frames = sent_so_far(&mut cloud);
        assert_eq!(frames.len(), 2, "the window is 2: {frames:?}");
        // The browser took one: one more frame, holding everything that waited.
        cloud.say(json!({ "type": "ack", "id": "s1", "frames": 1 }));
        sleep(Duration::from_millis(1)).await;
        let frames = sent_so_far(&mut cloud);
        assert_eq!(frames.len(), 1, "held events have waited long enough: they go at once");
        let texts: Vec<_> = frames[0]["events"].as_array().unwrap().iter().map(|e| e["text"].clone()).collect();
        assert_eq!(texts, ["3", "4", "5", "6"]);
        // An old or repeated ack opens nothing; a newer one does.
        turn.send(token(7)).unwrap();
        cloud.say(json!({ "type": "ack", "id": "s1", "frames": 1 }));
        sleep(Duration::from_millis(100)).await;
        assert!(sent_so_far(&mut cloud).is_empty());
        cloud.say(json!({ "type": "ack", "id": "s1", "frames": 3 }));
        sleep(Duration::from_millis(100)).await;
        assert_eq!(sent_so_far(&mut cloud)[0]["events"][0]["text"], "7");
    }

    #[tokio::test(start_paused = true)]
    async fn events_are_batched_until_the_oldest_is_50_ms_old_or_the_batch_is_full() {
        let h = Arc::new(FakeHandler::default());
        // A window wide enough never to hold anything: this is about batching.
        let (_rig, mut cloud) = connected(h.clone(), 2, 1024).await;
        cloud.say(request("stream", "s1", "chat", json!({})));
        sleep(Duration::from_millis(1)).await;
        let turn = h.turn();
        // Tokens 10 ms apart: one frame per 50 ms, not one per token.
        let began = Instant::now();
        for n in 0..20 {
            turn.send(json!({ "type": "token", "text": n.to_string() }).to_string()).unwrap();
            sleep(Duration::from_millis(10)).await;
        }
        sleep(Duration::from_millis(100)).await;   // the last batch falls due
        let frames = sent_so_far(&mut cloud);
        assert!((4..=5).contains(&frames.len()), "{} frames for 20 tokens", frames.len());
        // The first 50 ms: tokens 0..4, and 5 when it lands on the 50th ms itself.
        let first = frames[0]["events"].as_array().unwrap().len();
        assert!((5..=6).contains(&first), "the first 50 ms: {}", frames[0]);
        let texts: Vec<_> = frames.iter().flat_map(|f| f["events"].as_array().unwrap().clone()).collect();
        assert_eq!(texts.len(), 20, "none lost or merged");
        assert!(began.elapsed() >= Duration::from_millis(200));

        // A full batch doesn't wait for the clock.
        let big = json!({ "type": "token", "text": "x".repeat(1000) }).to_string();
        for _ in 0..200 {
            turn.send(big.clone()).unwrap();
        }
        sleep(Duration::from_millis(1)).await;
        let frames = sent_so_far(&mut cloud);
        assert!(!frames.is_empty(), "nothing went before 50 ms had passed");
        // `maxFrame` is 4 KiB here, so the batch is that; at the cloud's 1 MiB it is 64 KiB.
        assert!(frames.iter().all(|f| f.to_string().len() <= MIN_FRAME), "frames within the batch size");
        drop(turn);
        sleep(Duration::from_secs(1)).await;
        let rest = sent_so_far(&mut cloud);
        assert_eq!(rest.last().unwrap()["end"], true);
        let n: usize = frames.iter().chain(&rest).map(|f| f["events"].as_array().unwrap().len()).sum();
        assert_eq!(n, 200);
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_stops_the_sending_and_leaves_the_turn_running() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 16).await;
        cloud.say(request("stream", "s1", "chat", json!({})));
        sleep(Duration::from_millis(1)).await;
        let turn = h.turn();
        turn.send(json!({ "type": "token", "text": "a" }).to_string()).unwrap();
        assert_eq!(next(&mut cloud).await["type"], "events");
        cloud.say(json!({ "type": "cancel", "id": "s1" }));
        sleep(Duration::from_millis(10)).await;
        // Nothing stops the turn (its sink ignores a closed queue, as
        // `remote::stream`'s does); it just has nobody to tell.
        let _ = turn.send(json!({ "type": "token", "text": "b" }).to_string());
        sleep(Duration::from_secs(1)).await;
        assert!(sent_so_far(&mut cloud).is_empty());
        assert!(turn.is_closed(), "the relay let go of the stream");
        assert_eq!(h.asked(), ["chat"], "a cancel isn't a stop_chat");
    }

    #[tokio::test(start_paused = true)]
    async fn a_stream_refused_before_it_began_is_one_result() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 2, 16).await;
        cloud.say(request("stream", "s1", "busy_chat", json!({})));
        assert_eq!(
            next(&mut cloud).await,
            json!({ "type": "result", "id": "s1", "ok": false, "code": "refused", "error": "busy" })
        );
        cloud.say(request("stream", "s2", "nothing_here", json!({})));
        assert_eq!(next(&mut cloud).await["code"], "not-allowed");
    }

    #[tokio::test(start_paused = true)]
    async fn the_heartbeat_carries_on_through_a_stream_and_a_dropped_socket_lets_go_of_it() {
        let h = Arc::new(FakeHandler::default());
        let (mut rig, mut cloud) = connected(h.clone(), 2, 16).await;
        cloud.say(request("stream", "s1", "chat", json!({})));
        sleep(Duration::from_millis(1)).await;
        let turn = h.turn();
        // A turn that talks the whole time doesn't hold up the ping.
        let (mut pinged, mut taken) = (false, 0);
        for n in 0..400 {
            turn.send(json!({ "type": "token", "text": n.to_string() }).to_string()).unwrap();
            sleep(Duration::from_secs(1)).await;
            while let Ok(Sent::Text(t)) = cloud.rx.try_recv() {
                if t == PING {
                    pinged = true;
                    cloud.say(json!({ "type": "pong" }));
                } else {
                    taken += 1;
                    cloud.say(json!({ "type": "ack", "id": "s1", "frames": taken }));
                }
            }
        }
        assert!(pinged, "a ping went out while the stream ran");
        assert!(taken > 100, "{taken} frames");
        assert_eq!(rig.wire.dials(), 1);

        let mut again = rig.wire.socket();
        cloud.close(1012);
        rig.until("connecting").await;
        sleep(Duration::from_millis(10)).await;
        assert!(turn.is_closed(), "the stream went with its socket");
        again.accept(300).await;
        rig.until("online").await;
    }

    #[tokio::test(start_paused = true)]
    async fn below_v2_the_relay_stays_off() {
        let h = Arc::new(FakeHandler::default());
        let (_rig, mut cloud) = connected(h.clone(), 1, 16).await;
        cloud.say(request("call", "r1", "list_projects", json!({})));
        cloud.say(request("stream", "s1", "chat", json!({})));
        sleep(Duration::from_secs(1)).await;
        assert!(sent_so_far(&mut cloud).is_empty());
        assert!(h.asked().is_empty());
    }

    /* ---------------------------------- frames -------------------------------- */

    #[test]
    fn an_events_frame_takes_what_fits_and_at_least_one() {
        let ev = |n: usize| json!({ "type": "token", "text": "x".repeat(n) }).to_string();
        let mut waiting: VecDeque<String> = [ev(10), ev(10), ev(5000), ev(10)].into_iter().collect();
        let (f, end) = events_frame("s", &mut waiting, true, MIN_FRAME);
        assert!(!end);
        assert_eq!(read(&f)["events"].as_array().unwrap().len(), 2, "the big one waits for a frame of its own");
        let (f, end) = events_frame("s", &mut waiting, true, MIN_FRAME);
        assert!(!end);
        assert!(f.len() > MIN_FRAME, "one event too big for a frame still goes (as parts)");
        assert_eq!(read(&f)["events"].as_array().unwrap().len(), 1);
        let (f, end) = events_frame("s", &mut waiting, true, MIN_FRAME);
        assert!(end, "the last of a stream that's over");
        assert_eq!(read(&f)["end"], true);
        let (f, end) = events_frame("s", &mut VecDeque::new(), true, MIN_FRAME);
        assert_eq!((read(&f), end), (json!({ "type": "events", "id": "s", "events": [], "end": true }), true));
    }

    #[test]
    fn parts_never_exceed_max_frame_and_add_back_up_to_the_frame() {
        for text in ["plain ".repeat(3000), "\"\\\n\u{0}\u{1f}".repeat(2000), "žđ😀".repeat(2000)] {
            let frame = json!({ "type": "result", "id": "r", "ok": true, "value": text }).to_string();
            let parts = pieces(frame.clone(), "r", MIN_FRAME);
            assert!(parts.len() > 1);
            let mut data = String::new();
            for (k, p) in parts.iter().enumerate() {
                assert!(p.len() <= MIN_FRAME, "{} bytes", p.len());
                let m = read(p);
                assert_eq!(m["last"], k == parts.len() - 1);
                data.push_str(m["data"].as_str().unwrap());
            }
            assert_eq!(data, frame);
        }
        assert_eq!(pieces("{}".into(), "r", MIN_FRAME), ["{}"], "a small frame goes whole");

        // At the cloud's 1 MiB, a part still carries at most 256 KiB of the text.
        let frame = json!({ "type": "result", "id": "r", "ok": true, "value": "žx".repeat(800_000) }).to_string();
        let parts = pieces(frame.clone(), "r", MAX_FRAME);
        let data: Vec<String> = parts.iter().map(|p| read(p)["data"].as_str().unwrap().to_string()).collect();
        assert!(data.iter().all(|d| d.len() <= PART_BYTES), "{:?}", data.iter().map(String::len).collect::<Vec<_>>());
        assert!(parts.iter().all(|p| p.len() <= MAX_FRAME));
        assert_eq!(data.concat(), frame);
    }

    #[test]
    fn the_welcome_sets_the_limits_within_reason() {
        let (r, _outbox) = Relay::new(None, &json!({ "apiVersion": 2 }));
        assert_eq!((r.window, r.max_frame), (WINDOW, MAX_FRAME), "the defaults are the cloud's");
        let (r, _outbox) = Relay::new(None, &json!({ "apiVersion": 2, "window": 0, "maxFrame": 10 }));
        assert_eq!((r.window, r.max_frame), (1, MIN_FRAME));
    }

    /* ------------------------------- the app itself ----------------------------- */

    #[tokio::test]
    async fn the_app_itself_answers_through_the_socket_and_paints_the_turn_in_the_window() {
        use crate::commands::AppState;
        use crate::remote::tests::{mock_app, TempDir};
        use tauri::{Listener, Manager};

        let dir = TempDir::new();
        let app = mock_app(&dir.0);
        let project = dir.0.join("a project").to_string_lossy().to_string();
        crate::db::create_project(&app.state::<AppState>().db(), &project).expect("seed a project");
        let (tx, mut window) = mpsc::unbounded_channel::<(String, Value)>();
        for ev in ["remote-turn-start", "remote-turn", "remote-turn-end"] {
            let tx = tx.clone();
            app.listen(ev, move |e| {
                let _ = tx.send((ev.to_string(), read(e.payload())));
            });
        }
        let (_rig, mut cloud) = connected(Arc::new(AppHandler(app.handle().clone())), 2, 16).await;

        // A plain command, answered from this machine's own database.
        cloud.say(request("call", "r1", "list_projects", json!({})));
        let m = whole(&mut cloud).await;
        assert_eq!(m["ok"], true, "{m}");
        assert_eq!(m["value"]["projects"][0]["path"], json!(project));

        // The second door: past the relay's own, `remote` has no arm for
        // anything local-only either.
        for cmd in LOCAL_ONLY {
            assert!(crate::remote::dispatch(app.handle(), cmd, &json!({})).await.is_none(), "{cmd}");
        }

        // A turn: its events come up the socket, ending with the stream's full
        // stop, and the window hears the same turn from start to end.
        cloud.say(request("stream", "s1", "chat", json!({ "threadId": "no-such-thread", "text": "hello" })));
        let mut events = Vec::new();
        loop {
            let m = whole(&mut cloud).await;
            assert_eq!((m["type"].as_str(), m["id"].as_str()), (Some("events"), Some("s1")), "{m}");
            events.extend(m["events"].as_array().unwrap().iter().cloned());
            if m["end"] == true {
                break;
            }
        }
        assert_eq!(events.last().unwrap(), &json!({ "type": "error", "message": "unknown thread" }));

        let (name, start) = window.recv().await.unwrap();
        assert_eq!(name, "remote-turn-start");
        assert_eq!((&start["threadId"], &start["text"]), (&json!("no-such-thread"), &json!("hello")));
        let mut mirrored = Vec::new();
        loop {
            let (name, p) = window.recv().await.unwrap();
            assert_eq!(p["turn"], start["turn"]);
            if name == "remote-turn-end" {
                break;
            }
            mirrored.push(read(p["raw"].as_str().unwrap()));
        }
        assert_eq!(mirrored, events, "the window sees exactly what the browser does");
    }
}
