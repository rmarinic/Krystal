//! Persistent per-chat `claude` processes.
//!
//! Krystal used to run every turn as its own headless `claude -p`: spawn, feed
//! the prompt on stdin, read until the process exited, throw it away. Turn two
//! then re-attached with `--resume`, which makes the CLI replay the whole
//! transcript before it can start answering. The cost of that grows with the
//! conversation, and it is paid again on every single message.
//!
//! With `--input-format stream-json` one process serves the whole chat: each user
//! message is a JSON line on its stdin, each turn ends at a `result` event, and
//! the process stays warm in between. The session id, the loaded context and the
//! prompt cache all survive from one turn to the next.
//!
//! What that costs us is flexibility: everything passed as a CLI flag —
//! `--model`, `--effort`, `--permission-mode`, `--agents`, `--resume` — is fixed
//! when the process starts. So the flags form a *key*; when the user changes one
//! mid-chat the old process is retired and a fresh one takes its place (see
//! `key_of`). Anything that legitimately varies from turn to turn, like the
//! task-list note, travels in the user message instead of the system prompt.
//!
//! A session's stdin carries more than messages. In **Ask** mode the CLI stops
//! before anything that needs permission and asks its host — a `control_request`
//! on stdout, answered by a `control_response` on stdin (the same protocol the
//! terminal's own permission prompt sits on). The session parks each request
//! until the user decides; see `hold_permission`/`answer_permission`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, Mutex as TokioMutex};

use crate::claude::{self, SysPromptFile};

/// How many chats may hold a warm process at once. Each one is a real `claude`
/// process sitting in memory, so this is a memory ceiling as much as anything;
/// beyond it the least recently used session is retired (its chat simply resumes
/// on the next message).
const MAX_WARM_SESSIONS: usize = 6;

/// A session nobody has spoken to for this long is retired on the next sweep.
const IDLE_TIMEOUT_SECS: u64 = 30 * 60;

/// Serial number for interrupt control requests, so no two share a request id.
static INTERRUPTS: AtomicU64 = AtomicU64::new(0);

/// The event a session feeds back into its *own* stream when a permission prompt
/// is answered. The answer arrives through a command (the window, the phone or a
/// connected Krystal), not through the turn — but only the turn holds the channel
/// every view is listening on. Looping it through the stream lets `run_turn`
/// announce it there, in order, to all of them at once.
pub const PERMISSION_ANSWERED: &str = "krystal_permission_answered";

/// What the user decided about one permission prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Go ahead, this once.
    Allow,
    /// Go ahead, and stop asking: the CLI's own suggested rule is applied — the
    /// same thing "Yes, and don't ask again" does in the terminal.
    AllowAlways,
    Deny,
}

impl Decision {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Self::Allow),
            "always" => Some(Self::AllowAlways),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::AllowAlways => "always",
            Self::Deny => "deny",
        }
    }
}

/// What Claude is told when the user says no. The wording is the terminal's own:
/// it makes the model stop and wait for direction rather than hunt for another
/// way to do the thing it was just refused.
const DENIED_MESSAGE: &str = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/// Fingerprint of everything fixed when the process starts. Two turns can share a
/// process only if their fingerprints match. The separator is a unit-separator
/// control character, which cannot occur in an argument we build.
pub fn key_of(args: &[String], cwd: &str) -> String {
    let mut key = String::from(cwd);
    for a in args {
        key.push('\u{1f}');
        key.push_str(a);
    }
    key
}

/// A warm `claude` process serving one chat. Cheap to clone — every field is a
/// handle, so the pool lock can be released while a turn runs.
#[derive(Clone)]
pub struct Session {
    /// Kept alive (and `kill_on_drop`) purely so the process dies with us.
    _child: Arc<TokioMutex<Child>>,
    stdin: Arc<TokioMutex<ChildStdin>>,
    /// Parsed stream-json events, in order. One consumer: the turn in flight.
    events: Arc<TokioMutex<mpsc::UnboundedReceiver<Value>>>,
    /// Whatever the process wrote to stderr, for reporting a crash.
    stderr: Arc<StdMutex<String>>,
    /// Set when stdout closes — i.e. the process is gone.
    exited: Arc<AtomicBool>,
    /// The spilled system-prompt file, held for the process's whole life.
    _sys_file: Arc<SysPromptFile>,
    pub pid: u32,
    pub key: String,
    last_used: Arc<StdMutex<Instant>>,
    /// Permission prompts the CLI is waiting on: request id -> the request it
    /// sent. Kept because the answer has to echo parts of it back (the tool's
    /// input, the rule the CLI suggested).
    permissions: Arc<StdMutex<HashMap<String, Value>>>,
    /// A way to put an event of our own into `events`. Weak on purpose: the
    /// stream must still *close* when the process dies, and a second strong
    /// sender held here would keep it open forever.
    loopback: mpsc::WeakUnboundedSender<Value>,
    /// Sub-agents alive in this process: task id -> launched in the background.
    /// Watched by the stdout reader rather than by the turn, because a background
    /// agent outlives the turn that launched it — an interrupt ends the turn and
    /// leaves the agent working (see `has_agents`).
    agents: Arc<StdMutex<HashMap<String, bool>>>,
}

impl Session {
    /// Start a process for one chat. `args` must already carry
    /// `--input-format stream-json` (see `claude::apply_session_flags`).
    pub fn spawn(
        bin: &str,
        args: &[String],
        cwd: &str,
        orchestrating: bool,
    ) -> Result<Self, String> {
        let (spilled, sys_file) = claude::spill_system_prompt(args);
        let mut cmd = claude::claude_command(bin, &spilled, cwd);
        if orchestrating {
            // Guardrails the prompt can't enforce on its own: Claude Code lets a
            // sub-agent spawn sub-agents of its own and run twenty at once, which
            // is how an orchestrated turn quietly grows into an hour-long tree.
            // Env vars rather than flags on purpose — an unknown flag aborts the
            // turn, an unknown env var is simply ignored by an older CLI.
            cmd.env("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "1")
                .env("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "5");
        }
        // Have the CLI keep a copy of every file it is about to edit, filed under
        // the message that asked for the edit — which is what lets a turn's
        // changes be undone later (see `rewind_files`). Headless sessions don't
        // do this unless asked.
        cmd.env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1");
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("failed to start claude: {e}"))?;

        let pid = child.id().unwrap_or(0);
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr = child.stderr.take().ok_or("no stderr")?;

        let (tx, rx) = mpsc::unbounded_channel();
        let loopback = tx.downgrade();
        let exited = Arc::new(AtomicBool::new(false));

        // One reader for the life of the process, not the life of a turn: it keeps
        // draining stdout between turns, so nothing is lost in the gap and a
        // process that dies while idle is noticed before the next message.
        let exited_r = exited.clone();
        let agents = Arc::new(StdMutex::new(HashMap::new()));
        let agents_r = agents.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    if let Ok(mut map) = agents_r.lock() {
                        track_agents(&mut map, &v);
                    }
                    if tx.send(v).is_err() {
                        break; // nobody left to receive
                    }
                }
            }
            exited_r.store(true, Ordering::Relaxed);
        });

        let errbuf = Arc::new(StdMutex::new(String::new()));
        let errbuf_w = errbuf.clone();
        tokio::spawn(async move {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s).await;
            if let Ok(mut b) = errbuf_w.lock() {
                b.push_str(&s);
            }
        });

        // Keyed on the args we were *given*, never on `spilled` — that one carries a
        // freshly-named temp file for the system prompt, so keying on it would make
        // every session unique and no process would ever be reused.
        let key = key_of(args, cwd);
        Ok(Session {
            _child: Arc::new(TokioMutex::new(child)),
            stdin: Arc::new(TokioMutex::new(stdin)),
            events: Arc::new(TokioMutex::new(rx)),
            stderr: errbuf,
            exited,
            _sys_file: Arc::new(sys_file),
            pid,
            key,
            last_used: Arc::new(StdMutex::new(Instant::now())),
            permissions: Arc::new(StdMutex::new(HashMap::new())),
            loopback,
            agents,
        })
    }

    pub fn alive(&self) -> bool {
        !self.exited.load(Ordering::Relaxed)
    }

    pub fn stderr_text(&self) -> String {
        self.stderr.lock().map(|s| s.trim().to_string()).unwrap_or_default()
    }

    fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }

    fn idle_secs(&self) -> u64 {
        self.last_used.lock().map(|t| t.elapsed().as_secs()).unwrap_or(0)
    }

    /// Write one JSON line to the process's stdin.
    async fn write_line(&self, v: &Value) -> Result<(), String> {
        let mut line = v.to_string();
        line.push('\n');
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }

    /// Hand the process the next user message and take the event stream for the
    /// turn. Anything still buffered from before is dropped first: a turn must
    /// never be handed the tail of the previous one.
    ///
    /// `uuid` names the message. The CLI files its checkpoint of the project
    /// under that name, so it is the handle `rewind_files` is later given.
    pub async fn begin_turn(
        &self,
        prompt: &str,
        uuid: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<mpsc::UnboundedReceiver<Value>>, String> {
        if !self.alive() {
            return Err("the claude session has stopped".into());
        }
        self.touch();
        let mut rx = self.events.clone().lock_owned().await;
        while rx.try_recv().is_ok() {}
        let mut msg = json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] }
        });
        if !uuid.is_empty() {
            msg["uuid"] = json!(uuid);
        }
        self.write_line(&msg).await?;
        Ok(rx)
    }

    /// Put the project's files back to how they were before the message named
    /// `message_id` was answered — or, with `dry_run`, only say what that would
    /// touch. Returns the CLI's own answer: `canRewind`, and on a dry run
    /// `filesChanged`/`insertions`/`deletions`.
    ///
    /// Only between turns: the reply comes back on the same stream a turn reads,
    /// and files changing underneath a turn in flight would be worse than waiting.
    pub async fn rewind_files(&self, message_id: &str, dry_run: bool) -> Result<Value, String> {
        if !self.alive() {
            return Err("the claude session has stopped".into());
        }
        let Ok(mut rx) = self.events.clone().try_lock_owned() else {
            return Err("busy".into());
        };
        self.touch();
        while rx.try_recv().is_ok() {}
        let request_id = format!("krystal-rewind-{}", INTERRUPTS.fetch_add(1, Ordering::Relaxed));
        self.write_line(&rewind_request(&request_id, message_id, dry_run)).await?;

        let wait = async {
            while let Some(ev) = rx.recv().await {
                if let Some(answer) = control_answer(&ev, &request_id) {
                    return answer;
                }
            }
            Err("the claude session ended before it answered".to_string())
        };
        tokio::time::timeout(std::time::Duration::from_secs(REWIND_TIMEOUT_SECS), wait)
            .await
            .unwrap_or_else(|_| Err("claude did not answer in time".into()))
    }

    /// Ask the CLI to abandon the turn in flight. Unlike killing the process this
    /// leaves the session usable: the CLI answers with a `result` marked as an
    /// error and then waits for the next message as normal.
    ///
    /// It is a *request*, though — the CLI honours it when it next comes up for
    /// air, which a turn wedged in a long tool run or a sub-agent tree may not do
    /// for a while (or at all). Whoever asks must be ready to escalate to a kill;
    /// `commands::stop_chat` does, on the second press.
    pub async fn interrupt(&self) -> Result<(), String> {
        self.write_line(&interrupt_request()).await
    }

    /// Is a sub-agent still alive in this process? If so an interrupt is not
    /// enough to stop the chat: it ends the *turn*, and a background agent isn't
    /// part of the turn any more — it carries on working (editing files, spending
    /// tokens) in a session that looks stopped. Stopping it on its own
    /// (`stop_task`) doesn't help either: the CLI then wakes Claude to answer
    /// about the stopped agent, with nobody reading, and that stray answer would
    /// end the chat's next turn early. So `commands::stop_chat` ends the process.
    pub fn has_agents(&self) -> bool {
        self.agents.lock().map(|m| !m.is_empty()).unwrap_or(false)
    }

    /// Park a permission prompt until somebody answers it. `request` is the
    /// `request` object of the CLI's `can_use_tool` control request.
    pub fn hold_permission(&self, request_id: &str, request: Value) {
        if let Ok(mut map) = self.permissions.lock() {
            map.insert(request_id.to_string(), request);
        }
    }

    /// The CLI withdrew a prompt (the turn was stopped, or it no longer matters).
    pub fn drop_permission(&self, request_id: &str) {
        if let Ok(mut map) = self.permissions.lock() {
            map.remove(request_id);
        }
    }

    /// Is a turn on this session stopped on a permission prompt? Such a session
    /// is not idle, however long its user takes: retiring it would leave a
    /// question on screen that nothing could answer any more (see `evict`).
    fn awaiting_permission(&self) -> bool {
        self.permissions.lock().map(|m| !m.is_empty()).unwrap_or(false)
    }

    /// The turn is over: nothing it asked can still be answered.
    pub fn clear_permissions(&self) {
        if let Ok(mut map) = self.permissions.lock() {
            map.clear();
        }
    }

    /// Answer a prompt directly, without parking it — for the requests Krystal
    /// settles itself (see `claude::is_own_business`).
    pub async fn respond_permission(
        &self,
        request_id: &str,
        request: &Value,
        decision: Decision,
    ) -> Result<(), String> {
        self.write_line(&permission_response(request_id, request, decision)).await
    }

    /// Answer a parked prompt with the user's decision. `Ok(false)` when there is
    /// no such prompt any more — already answered from another view, withdrawn
    /// by the CLI, or its turn has ended — which is not an error, just late.
    pub async fn answer_permission(
        &self,
        request_id: &str,
        decision: Decision,
    ) -> Result<bool, String> {
        let request = self.permissions.lock().ok().and_then(|mut m| m.remove(request_id));
        let Some(request) = request else {
            return Ok(false);
        };
        self.respond_permission(request_id, &request, decision).await?;
        // Thinking it over is not idling: don't let the pool retire a session
        // for having waited on its user.
        self.touch();
        if let Some(tx) = self.loopback.upgrade() {
            let _ = tx.send(json!({
                "type": PERMISSION_ANSWERED,
                "request_id": request_id,
                "decision": decision.as_str(),
            }));
        }
        Ok(true)
    }

    /// Turn down a control request we have no answer for. Leaving one hanging
    /// would leave the CLI waiting on it for the rest of the turn.
    pub async fn refuse_control(&self, request_id: &str, why: &str) -> Result<(), String> {
        self.write_line(&json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": request_id, "error": why }
        }))
        .await
    }
}

/// The `control_response` that settles one `can_use_tool` request.
///
/// Allowing echoes the tool's input back as `updatedInput` — the host is allowed
/// to rewrite it, and we don't, but the field is what says "run it as asked".
/// *Always* additionally hands the CLI its own `permission_suggestions` back as
/// `updatedPermissions`: the CLI wrote the rule (and decided where it is saved),
/// we only say yes to it, so "always" means exactly what it means in a terminal.
fn permission_response(request_id: &str, request: &Value, decision: Decision) -> Value {
    let response = match decision {
        Decision::Deny => json!({ "behavior": "deny", "message": DENIED_MESSAGE }),
        Decision::Allow | Decision::AllowAlways => {
            let mut r = json!({
                "behavior": "allow",
                "updatedInput": request.get("input").cloned().unwrap_or_else(|| json!({})),
            });
            if decision == Decision::AllowAlways {
                if let Some(rules) = request.get("permission_suggestions").filter(|s| s.is_array()) {
                    r["updatedPermissions"] = rules.clone();
                }
            }
            r
        }
    };
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response }
    })
}

/// How long a rewind may take before we stop waiting on it. A freshly resumed
/// session has to load its transcript first, so this is not a tight bound.
const REWIND_TIMEOUT_SECS: u64 = 45;

fn rewind_request(request_id: &str, message_id: &str, dry_run: bool) -> Value {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "rewind_files", "user_message_id": message_id, "dry_run": dry_run }
    })
}

/// If `ev` is the CLI's reply to our control request `request_id`: what it said.
fn control_answer(ev: &Value, request_id: &str) -> Option<Result<Value, String>> {
    if ev.get("type").and_then(|v| v.as_str()) != Some("control_response") {
        return None;
    }
    let r = ev.get("response")?;
    if r.get("request_id").and_then(|v| v.as_str()) != Some(request_id) {
        return None;
    }
    Some(if r.get("subtype").and_then(|v| v.as_str()) == Some("success") {
        Ok(r.get("response").cloned().unwrap_or_else(|| json!({})))
    } else {
        Err(r.get("error").and_then(|v| v.as_str()).unwrap_or("claude refused the request").to_string())
    })
}

/// One `interrupt` control request, with an id of its own. A fresh id per
/// interrupt matters: repeats of a single fixed request id are exactly what a CLI
/// would dedupe away, and a repeat is precisely what a user sends when the first
/// stop doesn't seem to land.
fn interrupt_request() -> Value {
    let n = INTERRUPTS.fetch_add(1, Ordering::Relaxed);
    json!({
        "type": "control_request",
        "request_id": format!("krystal-interrupt-{n}"),
        "request": { "subtype": "interrupt" }
    })
}

/// Keep `agents` (task id -> backgrounded) in step with one event off stdout.
///
/// A foreground agent is part of its turn, so it is gone once the turn's
/// `result` goes by. A background one ends with its own `task_notification`
/// (or a terminal `task_updated`), and `background_tasks_changed` lists every
/// one still out — which also catches a foreground agent moved to the
/// background, and settles any whose ending we never saw.
fn track_agents(agents: &mut HashMap<String, bool>, ev: &Value) {
    let str_of = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    match ev.get("type").and_then(|v| v.as_str()) {
        Some("result") => agents.retain(|_, bg| *bg),
        Some("system") => match ev.get("subtype").and_then(|v| v.as_str()) {
            Some("task_started") if claude::is_agent_task(ev) => {
                if let Some(id) = str_of(ev, "task_id").filter(|s| !s.is_empty()) {
                    let bg = ev.get("is_backgrounded").and_then(|v| v.as_bool()).unwrap_or(false);
                    agents.insert(id, bg);
                }
            }
            Some("task_notification") => {
                if let Some(id) = str_of(ev, "task_id") {
                    agents.remove(&id);
                }
            }
            Some("task_updated") => {
                let Some(id) = str_of(ev, "task_id") else { return };
                let patch = ev.get("patch");
                let status = patch.and_then(|p| p.get("status")).and_then(|v| v.as_str());
                if matches!(status, Some("completed" | "failed" | "killed")) {
                    agents.remove(&id);
                } else if patch.and_then(|p| p.get("is_backgrounded")).and_then(|v| v.as_bool()) == Some(true) {
                    if let Some(bg) = agents.get_mut(&id) {
                        *bg = true;
                    }
                }
            }
            Some("background_tasks_changed") => {
                let Some(tasks) = ev.get("tasks").and_then(|v| v.as_array()) else {
                    return;
                };
                let live: std::collections::HashSet<String> = tasks
                    .iter()
                    .filter(|t| claude::is_agent_task(t))
                    .filter_map(|t| str_of(t, "task_id"))
                    .collect();
                agents.retain(|id, bg| !*bg || live.contains(id));
                for id in live {
                    agents.insert(id, true);
                }
            }
            _ => {}
        },
        _ => {}
    }
}

/// The warm sessions, one per chat. Held behind an async lock so the map can be
/// consulted from a command handler without blocking the window's message loop.
#[derive(Default)]
pub struct Pool(TokioMutex<HashMap<String, Session>>, StdMutex<HashMap<String, String>>);

impl Pool {
    /// The session for `thread_id`, started if there isn't a usable one. A session
    /// whose key no longer matches (the user changed model, mode, effort or the
    /// orchestrator) or whose process has died is retired and replaced.
    pub async fn acquire(
        &self,
        thread_id: &str,
        bin: &str,
        args: &[String],
        cwd: &str,
        orchestrating: bool,
    ) -> Result<Session, String> {
        let want = key_of(args, cwd);
        let mut map = self.0.lock().await;
        if let Some(s) = map.get(thread_id) {
            if s.key == want && s.alive() {
                let s = s.clone();
                s.touch();
                return Ok(s);
            }
            map.remove(thread_id);
        }
        let s = Session::spawn(bin, args, cwd, orchestrating)?;
        map.insert(thread_id.to_string(), s.clone());
        evict(&mut map);
        Ok(s)
    }

    pub async fn get(&self, thread_id: &str) -> Option<Session> {
        self.0.lock().await.get(thread_id).cloned()
    }

    /// Retire a chat's session — after clearing or compacting it, or when the chat
    /// goes away. The next message simply starts a fresh one.
    pub async fn retire(&self, thread_id: &str) {
        self.0.lock().await.remove(thread_id);
    }

    /// Leave a note for a chat's next message — something that happened to the
    /// project between turns that Claude has no way of knowing (its files were
    /// rewound). It rides on the user message like any per-turn context, and is
    /// kept here rather than on the `Session` because the session may well be
    /// retired before that message is sent.
    pub fn leave_note(&self, thread_id: &str, note: String) {
        if let Ok(mut notes) = self.1.lock() {
            notes.insert(thread_id.to_string(), note);
        }
    }

    /// Take (and forget) the note left for this chat, if any.
    pub fn take_note(&self, thread_id: &str) -> Option<String> {
        self.1.lock().ok().and_then(|mut notes| notes.remove(thread_id))
    }

    /// Retire everything (app shutdown). `kill_on_drop` does the rest.
    pub async fn retire_all(&self) {
        self.0.lock().await.clear();
    }
}

/// Drop dead and long-idle sessions, then trim to `MAX_WARM_SESSIONS`, most
/// stale first. A session waiting on a permission prompt is exempt from both:
/// it looks idle precisely because it is waiting for its user.
fn evict(map: &mut HashMap<String, Session>) {
    map.retain(|_, s| {
        s.alive() && (s.awaiting_permission() || s.idle_secs() < IDLE_TIMEOUT_SECS)
    });
    while map.len() > MAX_WARM_SESSIONS {
        let Some(stalest) = map
            .iter()
            .filter(|(_, s)| !s.awaiting_permission())
            .max_by_key(|(_, s)| s.idle_secs())
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        map.remove(&stalest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_changes_with_any_spawn_flag() {
        let base = vec!["--model".to_string(), "claude-opus-5".to_string()];
        let same = key_of(&base, "C:/p");
        assert_eq!(same, key_of(&base, "C:/p"), "identical config reuses a session");

        // A different model, a different folder, or an extra flag must not reuse it.
        let other_model = vec!["--model".to_string(), "claude-sonnet-5".to_string()];
        assert_ne!(same, key_of(&other_model, "C:/p"));
        assert_ne!(same, key_of(&base, "C:/other"));
        let mut extra = base.clone();
        extra.push("--effort".into());
        extra.push("max".into());
        assert_ne!(same, key_of(&extra, "C:/p"));
    }

    #[test]
    fn the_key_cannot_be_forged_by_resplitting_arguments() {
        // Joining on a separator that can't occur in an argument keeps
        // ["ab","c"] and ["a","bc"] distinct.
        assert_ne!(
            key_of(&["ab".to_string(), "c".to_string()], "/p"),
            key_of(&["a".to_string(), "bc".to_string()], "/p")
        );
    }

    #[test]
    fn a_rewind_reply_is_matched_to_its_own_request() {
        let req = rewind_request("rw-1", "msg-uuid", true);
        assert_eq!(req["request"]["subtype"], "rewind_files");
        assert_eq!(req["request"]["user_message_id"], "msg-uuid");
        assert_eq!(req["request"]["dry_run"], true);

        let ok = json!({ "type": "control_response", "response": {
            "subtype": "success", "request_id": "rw-1",
            "response": { "canRewind": true, "filesChanged": ["a.txt"] } } });
        assert_eq!(control_answer(&ok, "rw-1").unwrap().unwrap()["filesChanged"][0], "a.txt");
        // Somebody else's reply (an interrupt's, say) is not ours to take.
        assert!(control_answer(&ok, "rw-2").is_none());
        assert!(control_answer(&json!({ "type": "assistant" }), "rw-1").is_none());

        let refused = json!({ "type": "control_response", "response": {
            "subtype": "error", "request_id": "rw-1", "error": "no checkpoint" } });
        assert_eq!(control_answer(&refused, "rw-1").unwrap().unwrap_err(), "no checkpoint");
    }

    #[test]
    fn a_note_left_for_a_chat_is_handed_over_once() {
        let pool = Pool::default();
        pool.leave_note("t1", "files were rewound".into());
        assert_eq!(pool.take_note("t2"), None);
        assert_eq!(pool.take_note("t1").as_deref(), Some("files were rewound"));
        assert_eq!(pool.take_note("t1"), None);
    }

    fn sys(subtype: &str, extra: Value) -> Value {
        let mut ev = json!({ "type": "system", "subtype": subtype });
        for (k, v) in extra.as_object().unwrap() {
            ev[k] = v.clone();
        }
        ev
    }

    #[test]
    fn a_background_agent_is_tracked_past_the_end_of_its_turn() {
        let mut agents = HashMap::new();
        track_agents(&mut agents, &sys("task_started", json!({
            "task_id": "bg", "is_backgrounded": true, "task_type": "local_agent" })));
        track_agents(&mut agents, &sys("task_started", json!({
            "task_id": "fg", "is_backgrounded": false, "task_type": "local_agent" })));
        // A dev server is a task too, but not ours to stop.
        track_agents(&mut agents, &sys("task_started", json!({
            "task_id": "sh", "is_backgrounded": true, "task_type": "local_bash" })));
        assert_eq!(agents.len(), 2);

        // The turn ends (an interrupt, say): the foreground agent went with it,
        // the background one is still out — which is what a stop must reach.
        track_agents(&mut agents, &json!({ "type": "result", "is_error": true }));
        assert_eq!(agents.keys().collect::<Vec<_>>(), vec!["bg"]);

        track_agents(&mut agents, &sys("task_notification", json!({ "task_id": "bg", "status": "stopped" })));
        assert!(agents.is_empty());
    }

    #[test]
    fn an_agent_moved_to_the_background_outlives_the_turn() {
        let mut agents = HashMap::new();
        track_agents(&mut agents, &sys("task_started", json!({ "task_id": "a", "is_backgrounded": false })));
        track_agents(&mut agents, &sys("task_updated", json!({ "task_id": "a", "patch": { "is_backgrounded": true } })));
        track_agents(&mut agents, &json!({ "type": "result" }));
        assert!(agents.contains_key("a"));
        track_agents(&mut agents, &sys("task_updated", json!({ "task_id": "a", "patch": { "status": "killed" } })));
        assert!(agents.is_empty());
    }

    #[test]
    fn the_background_list_settles_agents_whose_end_we_missed() {
        let mut agents = HashMap::new();
        for id in ["a", "b"] {
            track_agents(&mut agents, &sys("task_started", json!({ "task_id": id, "is_backgrounded": true })));
        }
        track_agents(&mut agents, &sys("background_tasks_changed", json!({ "tasks": [
            { "task_id": "b", "task_type": "local_agent" },
            { "task_id": "c", "task_type": "local_agent" },
            { "task_id": "dev", "task_type": "local_bash" },
        ] })));
        let mut ids: Vec<_> = agents.keys().cloned().collect();
        ids.sort();
        assert_eq!(ids, vec!["b", "c"]);
    }

    #[test]
    fn every_interrupt_carries_a_fresh_request_id() {
        let a = interrupt_request();
        let b = interrupt_request();
        assert_eq!(a["type"], "control_request");
        assert_eq!(a["request"]["subtype"], "interrupt");
        // Pressing stop twice must read as two requests, not one repeated.
        assert_ne!(a["request_id"], b["request_id"]);
    }

    /// A `can_use_tool` request as the CLI sends it (trimmed to what we read).
    fn write_request() -> Value {
        json!({
            "subtype": "can_use_tool",
            "tool_name": "Write",
            "input": { "file_path": "C:/p/a.txt", "content": "x" },
            "permission_suggestions": [
                { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
            ],
        })
    }

    #[test]
    fn allowing_runs_the_tool_exactly_as_it_was_asked() {
        let r = permission_response("req-1", &write_request(), Decision::Allow);
        assert_eq!(r["type"], "control_response");
        assert_eq!(r["response"]["subtype"], "success");
        assert_eq!(r["response"]["request_id"], "req-1");
        let inner = &r["response"]["response"];
        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["updatedInput"]["file_path"], "C:/p/a.txt");
        // Once means once: no rule may ride along.
        assert!(inner.get("updatedPermissions").is_none());
    }

    #[test]
    fn always_hands_the_cli_its_own_suggested_rule_back() {
        let r = permission_response("req-2", &write_request(), Decision::AllowAlways);
        let inner = &r["response"]["response"];
        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["updatedPermissions"][0]["mode"], "acceptEdits");

        // Nothing suggested → nothing to make permanent; it is a plain allow.
        let bare = json!({ "tool_name": "Bash", "input": { "command": "ls" } });
        let r = permission_response("req-3", &bare, Decision::AllowAlways);
        assert!(r["response"]["response"].get("updatedPermissions").is_none());
    }

    #[test]
    fn denying_tells_claude_to_stop_and_wait() {
        let r = permission_response("req-4", &write_request(), Decision::Deny);
        let inner = &r["response"]["response"];
        assert_eq!(inner["behavior"], "deny");
        assert!(inner["message"].as_str().unwrap().contains("STOP"));
        assert!(inner.get("updatedInput").is_none());
    }

    #[test]
    fn only_the_three_decisions_parse() {
        for d in [Decision::Allow, Decision::AllowAlways, Decision::Deny] {
            assert_eq!(Decision::parse(d.as_str()), Some(d));
        }
        // Anything else must be refused, never read as a yes.
        assert_eq!(Decision::parse("yes"), None);
        assert_eq!(Decision::parse(""), None);
    }
}
