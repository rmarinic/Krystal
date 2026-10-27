//! The hub: this computer reaching the account's other computers through
//! Krystal Cloud, with its own device token. The cloud end is
//! `../krystal-cloud/worker/devices.js` (`GET /api/device/computers`) and the
//! relay a browser uses (`POST /api/device/computers/<id>/call` and `/stream`,
//! README "Linking a computer"); the far computer runs each request through its
//! own `remote::dispatch` / `remote::stream` and its own rule for who may do
//! what, exactly as for a browser.
//!
//! So the far computer's commands come back here in the window's own terms: a
//! call answers with the command's JSON or its error string, and a stream
//! hands the command's events, one by one, to a `Channel`, the same events
//! that computer's window would get. That is what lets the window drive
//! another computer with the code it drives this one with (hub phase C).
//!
//! All four commands are `LOCAL_ONLY`: they act with this computer's token,
//! which is the account's reach, so nobody from outside may borrow them (and a
//! request can't bounce from one computer through a second to a third).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

use crate::commands::AppState;

/// How long dialling the cloud may take before it counts as unreachable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// A call's whole answer. The cloud gives up after 5 minutes (PROTOCOL.md);
/// this only catches a cloud that never answers at all.
const CALL_TIMEOUT: Duration = Duration::from_secs(6 * 60);
/// A stream has no deadline (a turn can run for an hour) but it is never
/// silent that long: the cloud sends a blank line every 20 s.
const STREAM_QUIET: Duration = Duration::from_secs(90);

/// The hub's HTTP side and its streams in flight (so the window can drop one).
pub struct Hub {
    client: reqwest::Client,
    base: String,
    streams: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl Hub {
    pub fn new(base: String) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(format!("Krystal/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Hub { client, base, streams: Mutex::default() }
    }

    fn streams(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<()>>> {
        self.streams.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The computers this one's account may reach, with who is online.
    pub async fn computers(&self, token: &str) -> Result<Value, String> {
        let res = self
            .client
            .get(format!("{}/api/device/computers", self.base))
            .bearer_auth(token)
            .timeout(CALL_TIMEOUT)
            .send()
            .await
            .map_err(|_| "offline".to_string())?;
        answer(res).await
    }

    /// Run `command` on computer `id` and return what it returned.
    pub async fn call(&self, token: &str, id: &str, command: &str, args: Value) -> Result<Value, String> {
        let res = self.post(token, id, "call", command, args, Some(CALL_TIMEOUT)).await?;
        let body = answer(res).await?;
        Ok(body.get("value").cloned().unwrap_or(Value::Null))
    }

    /// Run a streaming `command` on computer `id`, handing each of its events to
    /// `on` as it arrives. Ends with how the stream ended: `end` or `error` (the
    /// command's own last word, already handed on), `dropped` (the line went
    /// first), or `cancelled` (`cancel` was called with `stream_id`).
    pub async fn stream(
        &self,
        token: &str,
        call: HubStream,
        mut on: impl FnMut(Value),
    ) -> Result<&'static str, String> {
        let (stop, mut stopped) = oneshot::channel();
        if let Some(sid) = &call.stream_id {
            self.streams().insert(sid.clone(), stop);
        }
        let _forget = Forget { hub: self, id: call.stream_id.clone() };
        let mut res = self.post(token, &call.device_id, "stream", &call.command, call.args, None).await?;
        if !res.status().is_success() {
            return Err(failure(res.status().as_u16(), &res.json::<Value>().await.unwrap_or(Value::Null)));
        }
        let mut lines = Lines::default();
        let mut last = None;
        loop {
            let chunk = tokio::select! {
                _ = &mut stopped => return Ok("cancelled"),
                c = tokio::time::timeout(STREAM_QUIET, res.chunk()) => c,
            };
            let Ok(Ok(Some(bytes))) = chunk else { break };
            for ev in lines.push(&bytes) {
                last = ev["type"].as_str().map(str::to_string);
                on(ev);
            }
        }
        for ev in lines.finish() {
            last = ev["type"].as_str().map(str::to_string);
            on(ev);
        }
        Ok(match last.as_deref() {
            Some("end") => "end",
            Some("error") => "error",
            _ => "dropped",
        })
    }

    /// Stop handing on a stream's events. Like a browser going away: the far
    /// computer stops sending, but the turn itself goes on there.
    pub fn cancel(&self, stream_id: &str) -> bool {
        self.streams().remove(stream_id).map(|s| s.send(())).is_some()
    }

    async fn post(
        &self,
        token: &str,
        id: &str,
        kind: &str,
        command: &str,
        args: Value,
        timeout: Option<Duration>,
    ) -> Result<reqwest::Response, String> {
        if !is_device_id(id) {
            return Err("no-such-device".into());
        }
        let mut req = self
            .client
            .post(format!("{}/api/device/computers/{id}/{kind}", self.base))
            .bearer_auth(token)
            .json(&json!({ "command": command, "args": args }));
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        // No detail in the error: a reqwest error can quote the request.
        req.send().await.map_err(|_| "offline".to_string())
    }
}

/// What `hub_stream` runs.
pub struct HubStream {
    pub device_id: String,
    pub command: String,
    pub args: Value,
    /// Named, so `hub_stream_cancel` can drop it.
    pub stream_id: Option<String>,
}

/// A stream leaves the registry however it ends.
struct Forget<'a> {
    hub: &'a Hub,
    id: Option<String>,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            self.hub.streams().remove(id);
        }
    }
}

/// The cloud's ids, as its routes accept them (`[\w-]{1,64}`); anything else
/// never reaches a URL.
fn is_device_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A JSON answer, or what went wrong with it.
async fn answer(res: reqwest::Response) -> Result<Value, String> {
    let status = res.status().as_u16();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    if (200..300).contains(&status) && body.get("error").is_none() {
        Ok(body)
    } else {
        Err(failure(status, &body))
    }
}

/// An error answer in the window's terms: the command's own message when it
/// ran and failed (as a local call would say it), else the cloud's code
/// (`device-offline`, `no-such-device`, `device-revoked`, …), which the window
/// puts into words.
fn failure(status: u16, body: &Value) -> String {
    let message = body["message"].as_str().filter(|m| !m.is_empty());
    let code = body["error"].as_str();
    match (message, code) {
        (Some(m), _) => m.to_string(),
        (None, Some(c)) => c.to_string(),
        (None, None) => format!("http-{status}"),
    }
}

/// NDJSON as it arrives, in pieces cut anywhere: complete lines become events;
/// blank lines (the cloud's keepalive) and anything not JSON are skipped.
#[derive(Default)]
struct Lines {
    buf: Vec<u8>,
}

impl Lines {
    fn push(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            out.extend(parse(&line));
        }
        out
    }

    /// Whatever is left once the body ends (a last line without its newline).
    fn finish(&mut self) -> Vec<Value> {
        let rest = std::mem::take(&mut self.buf);
        parse(&rest).into_iter().collect()
    }
}

fn parse(line: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(line).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(text).ok().filter(Value::is_object)
}

/* -------------------------------- commands -------------------------------- */

/// This computer's token, or why there is none.
fn token(state: &AppState) -> Result<String, String> {
    state.cloud.key().borrow().clone().ok_or_else(|| "not-linked".to_string())
}

/// A 401 is the same news `cloud_check` would bring: this computer was
/// unlinked at app.krystal.rip. Forget the token, as it does.
fn heard<T>(state: &AppState, token: &str, out: Result<T, String>) -> Result<T, String> {
    if matches!(&out, Err(e) if e == "device-revoked") {
        state.cloud.revoked(token);
    }
    out
}

#[tauri::command]
pub async fn hub_computers(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let token = token(&state)?;
    let out = state.hub.computers(&token).await;
    heard(&state, &token, out)
}

#[tauri::command]
pub async fn hub_call(
    state: tauri::State<'_, AppState>,
    device_id: String,
    command: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let token = token(&state)?;
    let out = state.hub.call(&token, &device_id, &command, args.unwrap_or_else(|| json!({}))).await;
    heard(&state, &token, out)
}

#[tauri::command]
pub async fn hub_stream(
    state: tauri::State<'_, AppState>,
    device_id: String,
    command: String,
    args: Option<Value>,
    stream_id: Option<String>,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let token = token(&state)?;
    let call = HubStream { device_id, command, args: args.unwrap_or_else(|| json!({})), stream_id };
    let out = state.hub.stream(&token, call, |ev| { let _ = on_event.send(ev); }).await;
    heard(&state, &token, out).map(|how| json!({ "ended": how }))
}

#[tauri::command]
pub fn hub_stream_cancel(state: tauri::State<'_, AppState>, stream_id: String) -> Value {
    json!({ "cancelled": state.hub.cancel(&stream_id) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn ndjson_cut_anywhere_comes_out_whole() {
        let mut l = Lines::default();
        assert!(l.push(br#"{"type":"tok"#).is_empty());
        assert_eq!(l.push(b"en\",\"text\":\"a\"}\n\n{\"ty"), vec![json!({ "type": "token", "text": "a" })]);
        assert_eq!(l.push(b"pe\":\"end\"}\nnot json\n"), vec![json!({ "type": "end" })]);
        assert_eq!(l.push("{\"type\":\"token\",\"text\":\"ž\"}".as_bytes()), Vec::<Value>::new());
        assert_eq!(l.finish(), vec![json!({ "type": "token", "text": "ž" })], "a last line without its newline");
    }

    #[test]
    fn an_error_reads_as_the_command_would_say_it_else_as_the_clouds_code() {
        assert_eq!(failure(200, &json!({ "error": "command-failed", "message": "unknown thread" })), "unknown thread");
        assert_eq!(failure(503, &json!({ "error": "device-offline" })), "device-offline");
        assert_eq!(failure(502, &Value::Null), "http-502");
    }

    #[test]
    fn only_a_cloud_shaped_id_reaches_a_url() {
        assert!(is_device_id("6f1c-ab_9"));
        for bad in ["", "../api/me", "a/b", "a?b", &"x".repeat(65)] {
            assert!(!is_device_id(bad), "{bad}");
        }
    }

    /// A one-request HTTP server: records what it was asked and answers with
    /// `status` and the body in `parts`, a short pause between each.
    async fn server(status: u16, parts: Vec<&'static str>) -> (String, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let asked = Arc::new(Mutex::new(String::new()));
        let seen = asked.clone();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            // Read the head, then the body its content-length promises.
            loop {
                let n = s.read(&mut buf).await.unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if req.len() >= end + 4 + len || n == 0 {
                        break;
                    }
                }
            }
            *seen.lock().unwrap() = String::from_utf8_lossy(&req).to_string();
            let head = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n");
            s.write_all(head.as_bytes()).await.unwrap();
            for p in parts {
                s.write_all(p.as_bytes()).await.unwrap();
                s.flush().await.unwrap();
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        (base, asked)
    }

    fn stream_of(id: &str, sid: Option<&str>) -> HubStream {
        HubStream { device_id: id.into(), command: "chat".into(), args: json!({ "threadId": "t1", "text": "hi" }), stream_id: sid.map(str::to_string) }
    }

    #[tokio::test]
    async fn a_call_goes_up_with_the_token_and_brings_back_the_value() {
        let (base, asked) = server(200, vec![r#"{"value":{"projects":[]}}"#]).await;
        let hub = Hub::new(base);
        let v = hub.call("tok-123", "dev-1", "list_projects", json!({ "x": 1 })).await.unwrap();
        assert_eq!(v, json!({ "projects": [] }));
        let req = asked.lock().unwrap().clone();
        assert!(req.starts_with("POST /api/device/computers/dev-1/call "), "{req}");
        assert!(req.to_ascii_lowercase().contains("authorization: bearer tok-123"), "{req}");
        assert!(!req.to_ascii_lowercase().contains("origin:"), "a computer sends no Origin");
        assert!(req.ends_with(r#"{"args":{"x":1},"command":"list_projects"}"#), "{req}");
    }

    #[tokio::test]
    async fn a_call_that_failed_there_fails_here_with_its_message() {
        let (base, _) = server(200, vec![r#"{"error":"command-failed","message":"unknown thread"}"#]).await;
        assert_eq!(Hub::new(base).call("t", "d", "get_thread", json!({})).await, Err("unknown thread".into()));
        let (base, _) = server(401, vec![r#"{"error":"device-revoked"}"#]).await;
        assert_eq!(Hub::new(base).computers("t").await, Err("device-revoked".into()));
    }

    #[tokio::test]
    async fn a_stream_hands_on_each_event_as_it_comes_and_says_how_it_ended() {
        let (base, _) = server(200, vec!["{\"type\":\"saved\",\"userId\":1}\n{\"type\":\"tok", "en\",\"text\":\"hi\"}\n\n", "{\"type\":\"end\"}\n"]).await;
        let mut got = Vec::new();
        let how = Hub::new(base).stream("t", stream_of("d", None), |e| got.push(e)).await.unwrap();
        assert_eq!(how, "end");
        assert_eq!(got, vec![json!({ "type": "saved", "userId": 1 }), json!({ "type": "token", "text": "hi" }), json!({ "type": "end" })]);

        let (base, _) = server(200, vec!["{\"type\":\"token\",\"text\":\"a\"}\n"]).await;
        let how = Hub::new(base).stream("t", stream_of("d", None), |_| {}).await.unwrap();
        assert_eq!(how, "dropped", "the line went before the full stop");

        let (base, _) = server(503, vec![r#"{"error":"device-offline"}"#]).await;
        assert_eq!(Hub::new(base).stream("t", stream_of("d", None), |_| {}).await, Err("device-offline".into()));
    }

    #[tokio::test]
    async fn a_named_stream_can_be_dropped_and_leaves_the_registry_either_way() {
        let (base, _) = server(200, vec!["{\"type\":\"token\",\"text\":\"a\"}\n"; 50]).await;
        let hub = Arc::new(Hub::new(base));
        let h = hub.clone();
        let run = tokio::spawn(async move { h.stream("t", stream_of("d", Some("s1")), |_| {}).await });
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(hub.cancel("s1"));
        assert_eq!(run.await.unwrap(), Ok("cancelled"));
        assert!(!hub.cancel("s1"), "gone once it ended");
    }

    #[tokio::test]
    async fn a_bad_device_id_never_leaves_the_computer() {
        let hub = Hub::new("http://127.0.0.1:9".into());
        assert_eq!(hub.call("t", "../me", "x", json!({})).await, Err("no-such-device".into()));
    }
}
