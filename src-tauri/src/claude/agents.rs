//! Sub-agents: the background ones that hold a turn open until Claude has
//! reported on them, and what each one is doing, forwarded to the agent
//! inspector.

use super::*;

/// Sub-agents the CLI launched **in the background** during this turn.
///
/// A background agent turns one turn into several as far as the CLI is concerned.
/// The call that launches it returns at once ("Async agent launched…"), Claude
/// says it will report back, and the CLI emits a `result` — while the agent is
/// still working. When the agent finishes, the CLI wakes itself up, tells Claude,
/// and a second answer follows with a `result` of its own. Ending at the first
/// `result` cuts all of that off: the agent appears to finish the instant it
/// starts, its report is never seen, and the answer the user was waiting for is
/// thrown away with the tail of the stream.
///
/// So the turn is held open for as long as this says there is more to come.
///
/// A **background shell** (`run_in_background`) works the same way: when it
/// exits, the CLI wakes Claude with a `task_notification` and a second answer
/// follows (checked against CLI 2.1.318). So it holds the turn too — otherwise
/// that answer lands with nobody reading, or worse, in the middle of the chat's
/// next turn, whose `result` it would steal. The one shell that never ends, a dev
/// server, is the system prompt's business: it tells Claude not to leave one
/// running in the background (see `capability_prompt`), and Stop still ends it.
#[derive(Default)]
pub(super) struct BackgroundAgents {
    /// Still working: task id -> the `tool_use` id of the call that launched it.
    pub(super) running: HashMap<String, String>,
    /// Every call that launched one, by `tool_use` id — its immediate tool result
    /// is launch paperwork, not the agent's report.
    pub(super) launched: std::collections::HashSet<String>,
    /// The launches among those that were shells, not agents: their report is
    /// the command's output, and they are no agent for the inspector to show.
    pub(super) shells: std::collections::HashSet<String>,
    /// An agent reported in and the CLI hasn't started the answer about it yet.
    pub(super) unreported: bool,
    /// What the window is shown while the reply waits on them (jobs.rs).
    pub(super) jobs: Jobs,
    /// The call each sub-agent task runs under *now*. A worker resumed with
    /// SendMessage starts again under the SendMessage call, but its own steps
    /// still name the call that first launched it, perhaps turns ago; they also
    /// carry its task id (`agent_id`), and this says where they belong today.
    tool_of_task: HashMap<String, String>,
    /// Every task this turn saw start, background or not.
    seen_tasks: std::collections::HashSet<String>,
    /// Notices about tasks this turn never saw start. A session resumed after
    /// its process was killed finds the background jobs that died with it and
    /// reports each one (`task_notification`, status `stopped`), then closes
    /// that report with a `result` of its own, empty and `num_turns: 0`, before
    /// it answers the message. That `result` is not this turn's end.
    stray_notices: u32,
    /// A job was stopped that nobody will answer about (a shell; see
    /// `finished`). Once nothing else holds the reply, it is over. Cleared
    /// when the next answer starts.
    pub(super) quiet_stop: bool,
}

/// Is this task (a `task_started` event, or an entry of `background_tasks_changed`)
/// a sub-agent? Background *shells* are tasks too, and not agents.
pub fn is_agent_task(task: &Value) -> bool {
    task.get("task_type").and_then(|v| v.as_str()).map_or(true, |t| t == "local_agent")
}

/// Is this task a shell command (`task_type: local_bash`)?
pub fn is_shell_task(task: &Value) -> bool {
    task.get("task_type").and_then(|v| v.as_str()) == Some("local_bash")
}

/// Does this task, once in the background, owe Claude a second answer when it
/// ends? Agents and shells both do; whatever else the CLI may run as a task
/// (a monitor that never ends) does not hold a turn.
pub fn is_background_work(task: &Value) -> bool {
    is_agent_task(task) || is_shell_task(task)
}

impl BackgroundAgents {
    pub(super) fn started(&mut self, ev: &Value) {
        let task = ev.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
        let tool = ev.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
        if task.is_empty() {
            return;
        }
        self.seen_tasks.insert(task.to_string());
        if is_agent_task(ev) && !tool.is_empty() {
            self.tool_of_task.insert(task.to_string(), tool.to_string());
        }
        if !ev.get("is_backgrounded").and_then(|v| v.as_bool()).unwrap_or(false) || !is_background_work(ev) {
            return;
        }
        self.jobs.started(ev);
        // A worker's own background shell is the worker's business: when it ends
        // the CLI tells the worker, not Claude (and if the worker has finished by
        // then, nobody; checked on CLI 2.1.321). It must not hold the reply open,
        // or the reply waits for a notice that never comes.
        if is_owned(ev) {
            return;
        }
        self.running.insert(task.to_string(), tool.to_string());
        if !tool.is_empty() {
            self.launched.insert(tool.to_string());
            if is_shell_task(ev) {
                self.shells.insert(tool.to_string());
            }
        }
    }

    /// `background_tasks_changed` lists everything still in the background, so it
    /// settles any agent whose own ending we never saw.
    pub(super) fn sync(&mut self, ev: &Value) {
        let Some(tasks) = ev.get("tasks").and_then(|v| v.as_array()) else {
            return;
        };
        let live: std::collections::HashSet<&str> = tasks
            .iter()
            .filter(|t| is_background_work(t))
            .filter_map(|t| t.get("task_id").and_then(|v| v.as_str()))
            .collect();
        self.running.retain(|id, _| live.contains(id.as_str()));
        self.jobs.retain(&live);
    }

    /// An agent finished. `true` when it was one of ours running in the background.
    pub(super) fn finished(&mut self, ev: &Value) -> bool {
        let task = ev.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
        let tool = ev.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
        if !task.is_empty() && !self.seen_tasks.contains(task) && !self.launched.contains(tool) {
            self.stray_notices += 1;
            return false;
        }
        self.jobs.remove(task);
        let ours = self.running.remove(task).is_some() || self.launched.contains(tool);
        // A stopped agent still gets Claude woken to answer about it; a stopped
        // *shell* doesn't (CLI 2.1.321), so there is no answer to wait for.
        let stopped = matches!(ev.get("status").and_then(|v| v.as_str()), Some("stopped" | "killed"));
        if ours && stopped && self.shells.contains(tool) {
            self.quiet_stop = true;
        } else if ours {
            self.unreported = true;
        }
        ours
    }

    pub(super) fn holds_turn(&self) -> bool {
        !self.running.is_empty() || self.unreported
    }

    /// The call a sub-agent's message belongs to: the one its task runs under
    /// now, or failing that the one the message names.
    pub(super) fn worker_parent<'a>(&'a self, ev: &'a Value) -> Option<&'a str> {
        let named = ev.get("parent_tool_use_id").and_then(|v| v.as_str()).filter(|p| !p.is_empty());
        let task = ev.get("agent_id").and_then(|v| v.as_str());
        named.map(|n| task.and_then(|t| self.tool_of_task.get(t)).map_or(n, |s| s.as_str()))
    }

    /// Is this `result` the close of a report about a job this turn never saw
    /// start, rather than the end of the turn? (See `stray_notices`.)
    pub(super) fn take_stray_result(&mut self, ev: &Value) -> bool {
        let empty = ev.get("result").and_then(|v| v.as_str()).map_or(true, |r| r.trim().is_empty());
        let no_turns = ev.get("num_turns").and_then(|v| v.as_u64()) == Some(0);
        if self.stray_notices == 0 || !empty || !no_turns || ev.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
            return false;
        }
        self.stray_notices -= 1;
        true
    }
}

/// Was this task started by a sub-agent rather than by Claude?
fn is_owned(task: &Value) -> bool {
    task.get("owned_by_subagent").and_then(|v| v.as_bool()).unwrap_or(false)
        || task.get("parent_task_id").and_then(|v| v.as_str()).is_some_and(|p| !p.is_empty())
}

/// How much of a finished background command's output its chip is given: the
/// *end* of it, where a build or a test run says how it went.
const SHELL_TAIL_CHARS: usize = 3500;

/// What a background shell's `task_notification` reports, for its chip: the end
/// of the command's output (the CLI writes it to `output_file`; the notification
/// itself only carries a one-line summary), and whether it failed — a `failed`
/// status, or a non-zero exit code in the output or the summary.
pub(super) fn background_shell_report(ev: &Value) -> (String, bool) {
    let summary = ev.get("summary").and_then(|v| v.as_str()).unwrap_or("");
    let output = ev
        .get("output_file")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .and_then(|p| read_tail(std::path::Path::new(p), SHELL_TAIL_CHARS));
    let code = output.as_deref().and_then(exit_code).or_else(|| exit_code(summary));
    let failed = ev.get("status").and_then(|v| v.as_str()) == Some("failed") || code.is_some_and(|c| c != 0);
    (output.filter(|o| !o.trim().is_empty()).unwrap_or_else(|| summary.to_string()), failed)
}

/// The last `max` characters of a file, starting on a whole line when it had to
/// be cut. Reads only the end of the file: a build log can be large.
pub(super) fn read_tail(path: &std::path::Path, max: usize) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let window = (max as u64) * 4; // a char is at most four bytes
    if len > window {
        f.seek(SeekFrom::Start(len - window)).ok()?;
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    Some(crate::util::tail_chars(&String::from_utf8_lossy(&bytes), max))
}

/// The exit code the CLI wrote into a background command's output
/// (`[exited with code 1]`) or its summary (`… completed (exit code 1)`).
fn exit_code(text: &str) -> Option<i64> {
    ["exited with code ", "exit code "].iter().find_map(|pat| {
        let at = text.rfind(pat)? + pat.len();
        let digits: String = text[at..]
            .chars()
            .enumerate()
            .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && *c == '-'))
            .map(|(_, c)| c)
            .collect();
        digits.parse().ok()
    })
}

pub(super) fn emit_agent_progress(ev: &Value, channel: &Channel<Value>) {
    let id = ev.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return;
    }
    let phase = match ev.get("subtype").and_then(|v| v.as_str()) {
        Some("task_started") => "started",
        _ => "progress",
    };
    let usage = ev.get("usage");
    let u = |k: &str| usage.and_then(|x| x.get(k)).and_then(|v| v.as_u64());
    let mut msg = json!({ "type": "agent_progress", "id": id, "phase": phase });
    if let Some(s) = ev.get("subagent_type").and_then(|v| v.as_str()) {
        msg["subagent"] = json!(s);
    }
    if let Some(d) = ev.get("description").and_then(|v| v.as_str()) {
        msg["description"] = json!(d);
    }
    if let Some(t) = ev.get("last_tool_name").and_then(|v| v.as_str()) {
        msg["lastTool"] = json!(t);
    }
    if let Some(n) = u("tool_uses") {
        msg["toolUses"] = json!(n);
    }
    if let Some(n) = u("total_tokens") {
        msg["tokens"] = json!(n);
    }
    if let Some(n) = u("duration_ms") {
        msg["durationMs"] = json!(n);
    }
    let _ = channel.send(msg);
}

/// How much of one sub-agent step the inspector is sent: what it ran, and what
/// came back. Generous on the first — a command cut off mid-flag tells you
/// nothing — and bounded on the second, which can be a whole file.
const AGENT_DETAIL_CAP: usize = 2000;
const AGENT_OUTPUT_CAP: usize = 1500;

/// What one of a sub-agent's own tools returned, as an `agent_activity` line for
/// the step that ran it (`toolId`). The worker's tool results come back through
/// the stream tagged with the parent Task's id, like its messages do.
pub(super) fn emit_agent_tool_results(parent: &str, ev: &Value, channel: &Channel<Value>) {
    let Some(blocks) = ev.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
            continue;
        }
        let Some(tool_id) = block.get("tool_use_id").and_then(|v| v.as_str()) else {
            continue;
        };
        let output = tool_result_text(block.get("content"));
        let _ = channel.send(json!({
            "type": "agent_activity", "id": parent,
            "kind": "result", "toolId": tool_id,
            "text": cap_text(output.trim(), AGENT_OUTPUT_CAP),
            "isError": block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false),
        }));
    }
}

/// Forward what a sub-agent is *saying and doing* right now as `agent_activity`
/// lines, keyed by the parent Task's `tool_use_id` so the Task's action chip can
/// show a live log instead of sitting blank until the worker returns.
///
/// A delegated worker's own assistant messages come back through the same stream
/// tagged with `parent_tool_use_id`; each content block becomes one line (its
/// prose, or the tool it just reached for). Live-only — nothing here is
/// persisted; the Task's final output still lands via its `tool_result`.
pub(super) fn emit_agent_activity(
    parent: &str,
    ev: &Value,
    seen: &mut std::collections::HashSet<String>,
    channel: &Channel<Value>,
) {
    let msg = match ev.get("message") {
        Some(m) => m,
        None => return,
    };
    // The CLI sends a message one content block per event, every one of them
    // under the message's id — so the id alone can't tell a repeat from the next
    // block (keying on it dropped every step a worker took after thinking first).
    // A block is a repeat only if that same block was seen: a tool call by its
    // own id, a line of text by what it says.
    let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let blocks = match msg.get("content").and_then(|c| c.as_array()) {
        Some(a) => a,
        None => return,
    };
    for block in blocks {
        let key = match block.get("type").and_then(|v| v.as_str()) {
            Some("tool_use") => block.get("id").and_then(|v| v.as_str()).map(|id| format!("{parent}:t:{id}")),
            Some("text") => block
                .get("text")
                .and_then(|v| v.as_str())
                .map(|t| format!("{parent}:x:{msg_id}:{}", t.trim())),
            Some("thinking" | "redacted_thinking") => Some(format!("{parent}:k:{msg_id}")),
            _ => None,
        };
        if let Some(k) = key {
            if !seen.insert(k) {
                continue;
            }
        }
        match block.get("type").and_then(|v| v.as_str()) {
            // A worker's thoughts never reach us as text (the CLI leaves them out),
            // but the block landing marks *when* it finished thinking — which is
            // what tells a long silence apart: so much of it was thinking, the
            // rest was writing the step that followed.
            Some("thinking" | "redacted_thinking") => {
                let _ = channel.send(json!({ "type": "agent_activity", "id": parent, "kind": "thinking" }));
            }
            Some("text") => {
                let t = block.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
                if t.is_empty() {
                    continue;
                }
                let _ = channel.send(json!({
                    "type": "agent_activity", "id": parent,
                    "kind": "text", "text": take_chars(t, AGENT_DETAIL_CAP),
                }));
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                let (detail, target) = tool_detail(name, &input);
                // How much the worker wrote into the call: a sub-agent's tool input
                // isn't streamed, so a 120 KB file arrives whole after minutes of
                // quiet, and its size is what explains them.
                let chars = serde_json::to_string(&input).map(|s| s.len()).unwrap_or(0);
                let mut line = json!({
                    "type": "agent_activity", "id": parent,
                    "kind": "tool", "tool": name, "chars": chars,
                });
                if let Some(id) = block.get("id").and_then(|v| v.as_str()) {
                    line["toolId"] = json!(id);
                }
                if let Some(t) = target {
                    line["target"] = json!(t);
                }
                if let Some(d) = detail {
                    line["detail"] = json!(take_chars(&d, AGENT_DETAIL_CAP));
                }
                let _ = channel.send(line);
            }
            _ => {}
        }
    }
}

/// Build the orchestrator savings readout from the per-model token tally and
/// both persist it (as an `orchestration` segment, replayed into the Activity
/// panel on reload) and stream it live. No-op unless the turn actually delegated
/// — i.e. some tokens ran on a model other than the orchestrator's.
pub(super) fn emit_orchestration_summary(result: &mut ChatResult, channel: &Channel<Value>) {
    let main = match &result.main_model {
        Some(m) => m.clone(),
        None => return,
    };
    // Fold the per-message tally into a per-model total.
    let mut per_model: HashMap<String, u64> = HashMap::new();
    for (model, toks) in result.msg_usage.values() {
        *per_model.entry(model.clone()).or_insert(0) += toks;
    }
    let orch_tokens = per_model.get(&main).copied().unwrap_or(0);
    let mut workers: Vec<(String, u64)> = per_model
        .iter()
        .filter(|(m, _)| **m != main)
        .map(|(m, t)| (m.clone(), *t))
        .collect();
    let worker_tokens: u64 = workers.iter().map(|(_, t)| t).sum();
    // Nothing was delegated (or every worker shared the orchestrator's model):
    // there's no split worth showing.
    if worker_tokens == 0 {
        return;
    }
    workers.sort_by_key(|w| std::cmp::Reverse(w.1)); // heaviest worker first
    let total = orch_tokens + worker_tokens;
    let worker_pct = ((worker_tokens as f64 / total as f64) * 100.0).round() as u64;

    let summary = json!({
        "type": "orchestration",
        "orchestrator": { "model": main, "name": model_name(&main), "tokens": orch_tokens },
        "workers": workers
            .iter()
            .map(|(m, t)| json!({ "model": m, "name": model_name(m), "tokens": t }))
            .collect::<Vec<_>>(),
        "orchestratorTokens": orch_tokens,
        "workerTokens": worker_tokens,
        "totalTokens": total,
        "workerPct": worker_pct,
    });
    // Persist with the turn so it rebuilds on reload; renderSegments ignores the
    // unknown type, so it never leaks into the transcript.
    result.push_tool(summary.clone());
    let _ = channel.send(summary);
}
