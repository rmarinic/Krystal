//! Joining a turn that is already running: `watch_turn`.
//!
//! A turn reports to whoever started it, through that caller's `Channel`. A phone
//! that slept through it, or another computer opening a chat a turn is busy in,
//! has nothing to listen to. So every turn is also *recorded* here while it
//! runs: `commands::chat` hands its channel to `Watch::begin`, which gives back
//! one that keeps each event and passes it on unchanged. Whoever asks to watch
//! gets the turn's events so far, then the live ones, then the same full stop a
//! stream ends with (see `stream.rs`), and the record is dropped when the turn
//! ends. Nothing is kept for a finished turn: by then it is in the database.
//!
//! Replay and live hand over under one lock, so a watcher never misses an
//! event or sees one twice. Consecutive `token`s are merged in the record (the
//! replay only needs the text, not how it was cut), which keeps a long answer
//! one event instead of thousands.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use super::stream::closing_frame;

/// The turns in flight, by chat id. Cheap to clone: one shared record.
#[derive(Clone, Default)]
pub struct Watch(Arc<Mutex<HashMap<String, Turn>>>);

/// One running turn: what it has said so far, and who is listening.
struct Turn {
    /// Which `begin` this is, so a turn that ends late can't close the next one.
    id: u64,
    events: Vec<Value>,
    watchers: Vec<UnboundedSender<String>>,
}

static NEXT_TURN: AtomicU64 = AtomicU64::new(1);

impl Watch {
    fn turns(&self) -> MutexGuard<'_, HashMap<String, Turn>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Start recording a chat's turn. Returns the channel the turn should report
    /// through instead of `to` (everything still reaches `to`, unchanged), and
    /// the `Recording` that ends the record: `finish` it with the turn's outcome.
    pub fn begin(&self, thread_id: &str, to: Channel<Value>) -> (Channel<Value>, Recording) {
        let id = NEXT_TURN.fetch_add(1, Ordering::Relaxed);
        // A turn still on record here is one whose end never came; replacing it
        // drops its watchers, whose streams then close.
        self.turns().insert(thread_id.to_string(), Turn { id, events: Vec::new(), watchers: Vec::new() });
        let (watch, thread) = (self.clone(), thread_id.to_string());
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(raw) = body {
                if let Ok(ev) = serde_json::from_str::<Value>(&raw) {
                    watch.record(&thread, id, raw, &ev);
                    let _ = to.send(ev);
                }
            }
            Ok(())
        });
        let rec = Recording { watch: self.clone(), thread: thread_id.to_string(), id, closed: false };
        (channel, rec)
    }

    fn record(&self, thread: &str, id: u64, raw: String, ev: &Value) {
        let mut turns = self.turns();
        let Some(turn) = turns.get_mut(thread).filter(|t| t.id == id) else { return };
        turn.watchers.retain(|w| w.send(raw.clone()).is_ok());
        keep(&mut turn.events, ev.clone());
    }

    /// Watch a chat's turn: its events so far, the live ones, then the full stop.
    /// With no turn running, the stream is only `{"type":"end"}`.
    pub fn watch(&self, thread_id: &str) -> UnboundedReceiver<String> {
        let (tx, rx) = unbounded_channel();
        let mut turns = self.turns();
        match turns.get_mut(thread_id) {
            Some(turn) => {
                for ev in &turn.events {
                    let _ = tx.send(ev.to_string());
                }
                turn.watchers.push(tx);
            }
            None => {
                let _ = tx.send(json!({ "type": "end" }).to_string());
            }
        }
        rx
    }
}

/// A `token` is `{ type, text }` and nothing else; two in a row read the same
/// as one holding both texts.
fn keep(events: &mut Vec<Value>, ev: Value) {
    let is_token = |v: &Value| {
        v.as_object().is_some_and(|o| o.len() == 2 && o.get("type") == Some(&json!("token")))
            && v["text"].is_string()
    };
    if is_token(&ev) {
        if let Some(last) = events.last_mut().filter(|l| is_token(l)) {
            let joined = format!("{}{}", last["text"].as_str().unwrap_or(""), ev["text"].as_str().unwrap_or(""));
            last["text"] = Value::String(joined);
            return;
        }
    }
    events.push(ev);
}

/// A turn on record. Ends it on `finish`, or, if it is dropped unfinished (the
/// turn's future went away), with an error, so no watcher waits forever.
pub struct Recording {
    watch: Watch,
    thread: String,
    id: u64,
    closed: bool,
}

impl Recording {
    /// The turn is over: watchers get the full stop and the record goes.
    pub fn finish(mut self, outcome: &Result<(), String>) {
        self.close(closing_frame(outcome.clone().map(|_| Value::Null)));
    }

    fn close(&mut self, last: Value) {
        if std::mem::replace(&mut self.closed, true) {
            return;
        }
        let mut turns = self.watch.turns();
        if turns.get(&self.thread).is_some_and(|t| t.id == self.id) {
            if let Some(turn) = turns.remove(&self.thread) {
                let raw = last.to_string();
                for w in turn.watchers {
                    let _ = w.send(raw.clone());
                }
            }
        }
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.close(json!({ "type": "error", "message": "the turn ended unexpectedly" }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A channel standing in for the window's: everything it was sent, as JSON.
    fn window() -> (Channel<Value>, Arc<Mutex<Vec<Value>>>) {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let ch = Channel::new(move |body| {
            if let InvokeResponseBody::Json(raw) = body {
                sink.lock().unwrap().push(serde_json::from_str(&raw).unwrap());
            }
            Ok(())
        });
        (ch, got)
    }

    /// What a watcher has received so far, without waiting.
    fn so_far(rx: &mut UnboundedReceiver<String>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(raw) = rx.try_recv() {
            out.push(serde_json::from_str(&raw).unwrap());
        }
        out
    }

    fn token(t: &str) -> Value {
        json!({ "type": "token", "text": t })
    }

    #[test]
    fn watching_a_chat_with_nothing_running_is_just_the_end() {
        let w = Watch::default();
        let mut rx = w.watch("t1");
        assert_eq!(so_far(&mut rx), vec![json!({ "type": "end" })]);
        assert!(rx.try_recv().is_err(), "and then it closes");
    }

    #[test]
    fn a_watcher_who_joins_late_gets_the_turn_so_far_then_live_then_the_end() {
        let w = Watch::default();
        let (to, window_got) = window();
        let (ch, rec) = w.begin("t1", to);
        ch.send(json!({ "type": "saved", "userId": 4, "ckpt": "c" })).unwrap();
        ch.send(token("Hel")).unwrap();
        ch.send(token("lo")).unwrap();

        let mut rx = w.watch("t1");
        assert_eq!(
            so_far(&mut rx),
            vec![json!({ "type": "saved", "userId": 4, "ckpt": "c" }), token("Hello")],
            "the replay, with the tokens joined"
        );
        ch.send(token(" there")).unwrap();
        ch.send(json!({ "type": "done", "text": "Hello there" })).unwrap();
        assert_eq!(so_far(&mut rx), vec![token(" there"), json!({ "type": "done", "text": "Hello there" })]);

        rec.finish(&Ok(()));
        assert_eq!(so_far(&mut rx), vec![json!({ "type": "end" })]);
        assert!(matches!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)));
        // The window saw every event as sent, nothing merged and no full stop of ours.
        assert_eq!(window_got.lock().unwrap().len(), 5);
        // And the record is gone: watching again is just the end.
        assert_eq!(so_far(&mut w.watch("t1")), vec![json!({ "type": "end" })]);
    }

    #[test]
    fn two_watchers_each_get_every_event_and_a_failed_turn_ends_with_its_error() {
        let w = Watch::default();
        let (to, _) = window();
        let (ch, rec) = w.begin("t1", to);
        let mut a = w.watch("t1");
        ch.send(token("x")).unwrap();
        let mut b = w.watch("t1");
        ch.send(json!({ "type": "tool", "id": "u1" })).unwrap();
        rec.finish(&Err("session died".into()));
        let end = json!({ "type": "error", "message": "session died" });
        assert_eq!(so_far(&mut a), vec![token("x"), json!({ "type": "tool", "id": "u1" }), end.clone()]);
        assert_eq!(so_far(&mut b), vec![token("x"), json!({ "type": "tool", "id": "u1" }), end]);
    }

    #[test]
    fn only_adjacent_bare_tokens_merge() {
        let mut ev = Vec::new();
        keep(&mut ev, token("a"));
        keep(&mut ev, json!({ "type": "tool", "id": "u1" }));
        keep(&mut ev, token("b"));
        keep(&mut ev, token("c"));
        keep(&mut ev, json!({ "type": "token", "text": "d", "extra": 1 }));
        assert_eq!(ev, vec![token("a"), json!({ "type": "tool", "id": "u1" }), token("bc"), json!({ "type": "token", "text": "d", "extra": 1 })]);
    }

    #[test]
    fn a_recording_dropped_unfinished_still_ends_its_watchers() {
        let w = Watch::default();
        let (to, _) = window();
        let (_ch, rec) = w.begin("t1", to);
        let mut rx = w.watch("t1");
        drop(rec);
        assert_eq!(so_far(&mut rx)[0]["type"], "error");
    }

    #[test]
    fn an_old_turn_ending_late_does_not_close_the_next_one() {
        let w = Watch::default();
        let (to1, _) = window();
        let (_ch1, old) = w.begin("t1", to1);
        let (to2, _) = window();
        let (ch2, new) = w.begin("t1", to2);
        let mut rx = w.watch("t1");
        old.finish(&Ok(()));
        ch2.send(token("still here")).unwrap();
        assert_eq!(so_far(&mut rx), vec![token("still here")]);
        new.finish(&Ok(()));
        assert_eq!(so_far(&mut rx), vec![json!({ "type": "end" })]);
    }
}
