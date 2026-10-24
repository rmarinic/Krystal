//! Routing the CLI's stream-json events into the turn's result and the UI.
//!
//! A turn's events all land on one `TurnState` (`route`), which hands each to a
//! handler for its kind. Everything the turn learns as they go by — the answer,
//! half-streamed tool calls, sub-agents still out, artifacts waiting on their
//! result — lives on that one value, so a handler takes `&mut self` and nothing
//! else.

use super::*;

/// A tool call whose input is still streaming in, by its content-block index.
struct ToolBlock {
    name: String,
    /// The input JSON so far — complete once its block stops.
    input: String,
    /// The `tool_use` id: what the Activity panel and the result match it by.
    id: String,
}

/// Everything one turn accumulates from its events.
pub(super) struct TurnState {
    /// What the turn produced — the answer, its transcript, its usage.
    pub(super) result: ChatResult,
    /// The ask-block parser the turn's text streams through.
    pub(super) ask: AskParser,
    /// Sub-agents the CLI launched in the background, still out or unreported.
    pub(super) background: BackgroundAgents,
    tool_blocks: HashMap<i64, ToolBlock>,
    /// Sub-agent message ids already forwarded as live activity (dedupes the
    /// repeats `--include-partial-messages` produces).
    seen_agent_msgs: std::collections::HashSet<String>,
    /// Artifact tool calls waiting on their result: tool_use id -> artifact id.
    /// The content isn't in the call we watch go by — it's what the MCP server
    /// resolved and wrote to disk — so we pick it up when the result lands.
    pending_artifacts: HashMap<String, String>,
    /// Where the artifact MCP server writes what it resolved (None: no tool).
    artifact_dir: Option<PathBuf>,
    channel: Channel<Value>,
}

impl TurnState {
    pub(super) fn new(channel: Channel<Value>, artifact_dir: Option<&std::path::Path>) -> Self {
        TurnState {
            result: ChatResult::default(),
            ask: AskParser::default(),
            background: BackgroundAgents::default(),
            tool_blocks: HashMap::new(),
            seen_agent_msgs: std::collections::HashSet::new(),
            pending_artifacts: HashMap::new(),
            artifact_dir: artifact_dir.map(PathBuf::from),
            channel,
        }
    }

    /// One event of the turn, whatever its kind.
    pub(super) fn route(&mut self, ev: &Value) {
        let ty = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ty {
            "system" => self.on_system(ev),
            "prompt_suggestion" => self.on_suggestion(ev),
            "assistant" => self.on_assistant(ev),
            "stream_event" => self.on_stream_event(ev),
            "user" => self.on_tool_results(ev),
            "result" => self.on_result(ev),
            "rate_limit_event" => self.on_rate_limit(ev),
            _ => {}
        }
    }

    fn on_system(&mut self, ev: &Value) {
        match ev.get("subtype").and_then(|v| v.as_str()).unwrap_or("") {
            "init" => self.on_init(ev),
            // Live sub-agent progress: while a Task runs, the CLI streams what the
            // worker is doing (its evolving description, the tool it last used, and a
            // running step/token/duration tally), keyed by the Task's `tool_use_id` —
            // the same id our Activity chip carries. Forwarded so the panel can show
            // it live instead of a blank "Running…".
            sub @ ("task_started" | "task_progress" | "task_updated") => {
                if sub == "task_started" {
                    self.background.started(ev);
                }
                // Every shell command is a "task" too now (`task_type: local_bash`),
                // under its own tool_use id. Passing that on as agent progress made
                // the window treat each shell chip as a sub-agent it had missed.
                if is_agent_task(ev) {
                    emit_agent_progress(ev, &self.channel);
                }
            }
            "background_tasks_changed" => self.background.sync(ev),
            "task_notification" => self.on_agent_report(ev),
            _ => {}
        }
    }

    /// A background agent finished. Its report arrives here rather than as the
    /// result of the call that launched it (that returned long ago), so this is
    /// where the Task's chip gets its output — and its final tally.
    fn on_agent_report(&mut self, ev: &Value) {
        if !self.background.finished(ev) {
            return;
        }
        emit_agent_progress(ev, &self.channel);
        let id = ev.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
        let summary = ev.get("summary").and_then(|v| v.as_str()).unwrap_or("");
        let failed = ev.get("status").and_then(|v| v.as_str()) == Some("failed");
        attach_output(&mut self.result, id, summary, failed, &self.channel);
    }

    fn on_init(&mut self, ev: &Value) {
        if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
            self.result.session_id = Some(sid.to_string());
        }
        // The turn's main model — the orchestrator when that mode is on.
        if let Some(m) = ev.get("model").and_then(|v| v.as_str()) {
            self.result.main_model = Some(m.to_string());
        }
        // A new answer is starting: whatever an agent reported is in it.
        self.background.unreported = false;
        // The authoritative list of `/skill-name` commands this session can
        // run — including the ones built into the CLI binary, which exist
        // nowhere on disk for `skills::scan` to find. Forwarded so the
        // composer's `/` picker can learn them (see src/app/skills.js).
        let skills = ev
            .get("skills")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let _ = self.channel.send(json!({
            "type": "start",
            "sessionId": self.result.session_id,
            "skills": skills,
        }));
    }

    /// A predicted next message for the user (`--prompt-suggestions`). The CLI
    /// only offers one once a conversation has some history, and only when it
    /// has a confident guess, so this arrives on some turns and not others —
    /// the UI treats it as a bonus chip, never as something it waits for.
    fn on_suggestion(&mut self, ev: &Value) {
        if let Some(t) = ev.get("suggestion").and_then(|v| v.as_str()) {
            let t = t.trim();
            if !t.is_empty() {
                let _ = self.channel.send(json!({ "type": "suggestion", "text": t }));
            }
        }
    }

    /// Where the plan's limits stand, straight from the server — the CLI sends
    /// one with each API call. Forwarded for the usage chip (src/app/usage.js),
    /// which would otherwise only know what the usage endpoint last said.
    fn on_rate_limit(&mut self, ev: &Value) {
        let windows = limits::event_windows(ev);
        if !windows.is_empty() {
            let _ = self.channel.send(json!({ "type": "rate_limit", "windows": windows }));
        }
    }

    /// Consolidated assistant message: carries `model` + `usage`. Worker
    /// sub-agents surface here tagged with their own (cheaper) model, so this
    /// is where we attribute tokens for the orchestrator savings readout.
    fn on_assistant(&mut self, ev: &Value) {
        // A delegated worker's messages carry the parent Task's tool_use id —
        // stream them on as live activity for that Task's chip.
        if let Some(parent) = ev.get("parent_tool_use_id").and_then(|v| v.as_str()) {
            if !parent.is_empty() {
                emit_agent_activity(parent, ev, &mut self.seen_agent_msgs, &self.channel);
            }
        }
        if let Some(msg) = ev.get("message") {
            let model = msg.get("model").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(u) = msg.get("usage") {
                let tok = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                let billable = tok("input_tokens")
                    + tok("output_tokens")
                    + tok("cache_creation_input_tokens");
                if !model.is_empty() && billable > 0 {
                    // Dedupe by message id (duplicated under partial-messages);
                    // fall back to a positional key if the id is ever missing.
                    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let key = if id.is_empty() {
                        format!("_{}", self.result.msg_usage.len())
                    } else {
                        id.to_string()
                    };
                    self.result.msg_usage.insert(key, (model.to_string(), billable));
                }
            }
        }
    }

    /// The live stream of the answer being written: text, thinking, and tool
    /// calls whose input arrives a fragment at a time.
    fn on_stream_event(&mut self, ev: &Value) {
        let Some(e) = ev.get("event") else { return };
        let index = e.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
        match e.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "content_block_start"
                if e.get("content_block").and_then(|c| c.get("type")).and_then(|v| v.as_str())
                    == Some("tool_use") =>
            {
                self.on_tool_start(index, e)
            }
            "content_block_delta" => self.on_delta(index, e),
            "content_block_stop" => self.on_block_stop(index),
            _ => {}
        }
    }

    fn on_tool_start(&mut self, index: i64, e: &Value) {
        let cb = e.get("content_block");
        let field = |k: &str| {
            cb.and_then(|c| c.get(k)).and_then(|v| v.as_str()).unwrap_or("").to_string()
        };
        let (name, id) = (field("name"), field("id"));
        let _ = self.channel.send(json!({ "type": "tool", "name": name, "id": id }));
        self.tool_blocks.insert(index, ToolBlock { name, input: String::new(), id });
    }

    fn on_delta(&mut self, index: i64, e: &Value) {
        let delta = e.get("delta");
        let field = |k: &str| delta.and_then(|d| d.get(k)).and_then(|v| v.as_str());
        match field("type").unwrap_or("") {
            "input_json_delta" => {
                if let (Some(tb), Some(pj)) = (self.tool_blocks.get_mut(&index), field("partial_json")) {
                    tb.input.push_str(pj);
                }
            }
            "text_delta" => {
                if let Some(t) = field("text") {
                    // Run text through the ask-block parser: plain prose
                    // streams straight through; a ```krystal-ask block is
                    // captured and turned into a choice card instead.
                    self.ask.feed(t, &mut self.result, &self.channel);
                }
            }
            "thinking_delta" => {
                if let Some(t) = field("thinking") {
                    let _ = self.channel.send(json!({ "type": "thinking", "text": t }));
                }
            }
            _ => {}
        }
    }

    fn on_block_stop(&mut self, index: i64) {
        let Some(ToolBlock { name, input: jsonbuf, id }) = self.tool_blocks.remove(&index) else {
            // A text (non-tool) block ended: release any tail the
            // ask-block parser was holding back.
            self.ask.flush(&mut self.result, &self.channel);
            return;
        };
        let input: Value = serde_json::from_str(if jsonbuf.is_empty() { "{}" } else { &jsonbuf })
            .unwrap_or_else(|_| json!({}));
        let (detail, target) = tool_detail(&name, &input);
        let mut msg = json!({ "type": "tool", "name": name });
        if !id.is_empty() {
            // carried so the Activity panel can match the tool's
            // later output (tool_result) back to this action.
            msg["id"] = json!(id);
        }
        if let Some(d) = detail {
            msg["detail"] = json!(d);
        }
        if let Some(t) = target {
            msg["target"] = json!(t);
        }
        // AskUserQuestion: carry the full questions/options structure
        // so the frontend can render an interactive choice card.
        if name == "AskUserQuestion" {
            if let Some(q) = input.get("questions") {
                if q.is_array() {
                    msg["questions"] = q.clone();
                }
            }
        }
        // An artifact call: remember which artifact it touches so
        // the result can be picked up off disk, and label the chip
        // with the artifact rather than the raw MCP tool name.
        if name == artifacts::TOOL_NAME {
            if let Some(aid) = input.get("id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    self.pending_artifacts.insert(id.clone(), aid.to_string());
                }
                msg["artifact"] = json!(aid);
            }
            if let Some(t) = input.get("title").and_then(|v| v.as_str()) {
                msg["target"] = json!(t);
            }
            // `detail` would otherwise be the whole document.
            msg.as_object_mut().map(|o| o.remove("detail"));
        }
        // ExitPlanMode (Plan mode): carry the proposed plan so the
        // frontend can render it as a readable plan card.
        if name == "ExitPlanMode" || name == "exit_plan_mode" {
            if let Some(p) = input.get("plan") {
                if p.is_string() {
                    msg["plan"] = p.clone();
                }
            }
        }
        // Edits & writes: carry the actual change so the chip can
        // be expanded into a readable diff / the written content.
        if let Some(rich) = tool_change(&name, &input) {
            for (k, v) in rich {
                msg[k] = v;
            }
        }
        // Record the completed action as a persisted segment, then
        // stream the same payload to the live view.
        self.result.push_tool(msg.clone());
        let _ = self.channel.send(msg);
    }

    /// The CLI reports each tool's output back as a `user` message carrying
    /// tool_result blocks. We mine those for the shell/sub-agent output shown
    /// in the Activity panel (the live deltas above never include it).
    fn on_tool_results(&mut self, ev: &Value) {
        // A sub-agent's own tool results: none of them belong to a chip in
        // this transcript — they go to that agent's timeline.
        if let Some(parent) = ev.get("parent_tool_use_id").and_then(|v| v.as_str()) {
            if !parent.is_empty() {
                emit_agent_tool_results(parent, ev, &self.channel);
                return;
            }
        }
        let Some(arr) = ev
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            return;
        };
        for block in arr {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                continue;
            }
            let id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            // Launching a background agent "returns" at once with a note
            // that it is running. That is not its report: the chip stays
            // live until the agent itself reports in.
            if self.background.launched.contains(id) {
                continue;
            }
            let is_error = block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            let output = tool_result_text(block.get("content"));
            attach_output(&mut self.result, id, &output, is_error, &self.channel);
            // An artifact finished resolving: the MCP server has written
            // it out, so read the whole thing back and hand it to the UI.
            if let Some(art_id) = self.pending_artifacts.remove(id) {
                if !is_error {
                    if let Some(dir) = &self.artifact_dir {
                        publish_artifact(&mut self.result, dir, &art_id, &self.channel);
                    }
                }
            }
        }
    }

    fn on_result(&mut self, ev: &Value) {
        let result = &mut self.result;
        if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
            result.session_id = Some(sid.to_string());
        }
        if let Some(r) = ev.get("result").and_then(|v| v.as_str()) {
            if !r.trim().is_empty() {
                // Drop any ```krystal-ask block — it's rendered as a card, not text.
                result.final_text = strip_ask_blocks(r);
            }
        }
        if let Some(u) = ev.get("usage") {
            if !u.is_null() {
                result.usage = Some(u.clone());
            }
        }
        if let Some(c) = ev.get("total_cost_usd").and_then(|v| v.as_f64()) {
            result.cost_usd = c;
        }
        if ev.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
            result.is_error = true;
            let m = ev
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("Claude reported an error");
            let _ = self.channel.send(json!({ "type": "error", "message": m }));
        }
    }
}

/// Attach a tool's captured output to its segment (so it persists) and stream a
/// `tool_result` event to the live view. Applied to every tool so its action
/// chip can be expanded to reveal what it did; capped to keep transcripts lean.
fn attach_output(
    result: &mut ChatResult,
    id: &str,
    output: &str,
    is_error: bool,
    channel: &Channel<Value>,
) {
    let capped = cap_text(output, 4000);
    let mut matched = false;
    for seg in result.segments.iter_mut() {
        if seg.get("id").and_then(|v| v.as_str()) == Some(id) {
            seg["output"] = json!(capped.clone());
            if is_error {
                seg["isError"] = json!(true);
            }
            matched = true;
            break;
        }
    }
    if matched {
        let _ = channel.send(
            json!({ "type": "tool_result", "id": id, "output": capped, "isError": is_error }),
        );
    }
}

/// Read a just-resolved artifact off disk, remember it on the turn (so the
/// caller can persist it) and stream it to the panel. Called once per artifact
/// tool result — a turn that patches one ten times publishes ten times, each
/// carrying the whole document, which is what makes the panel update live.
fn publish_artifact(
    result: &mut ChatResult,
    dir: &std::path::Path,
    art_id: &str,
    channel: &Channel<Value>,
) {
    let Some((content, title, kind)) = artifacts::read_current(dir, art_id) else {
        return;
    };
    let payload = json!({
        "type": "artifact",
        "artId": art_id,
        "title": title,
        "kind": kind,
        "content": content,
    });
    // One entry per artifact, holding its latest state: a turn's tenth patch
    // replaces the ninth rather than queueing behind it.
    match result
        .artifacts
        .iter_mut()
        .find(|a| a.get("artId").and_then(|v| v.as_str()) == Some(art_id))
    {
        Some(slot) => *slot = payload.clone(),
        None => result.artifacts.push(payload.clone()),
    }
    let _ = channel.send(payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A channel that keeps what was sent on it, for the tests below.
    fn recording_channel() -> (Channel<Value>, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel = Channel::new(move |payload| {
            if let tauri::ipc::InvokeResponseBody::Json(raw) = payload {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    sink.lock().unwrap().push(v);
                }
            }
            Ok(())
        });
        (channel, seen)
    }

    /// Feed a run of stream events through a turn, as `run_turn` would.
    fn route_all(events: &[Value], turn: &mut TurnState) {
        for ev in events {
            turn.route(ev);
        }
    }

    #[test]
    fn a_background_agent_holds_the_turn_until_claude_has_reported_on_it() {
        let (channel, seen) = recording_channel();
        let mut turn = TurnState::new(channel, None);
        turn.result.push_tool(json!({ "type": "tool", "name": "Agent", "id": "toolu_1" }));

        // Launched: the call "returns" at once, and the CLI ends its turn.
        route_all(
            &[
                json!({ "type": "system", "subtype": "task_started", "task_id": "t1", "tool_use_id": "toolu_1",
                        "is_backgrounded": true, "task_type": "local_agent", "description": "Read the notes" }),
                json!({ "type": "user", "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_1", "content": "Async agent launched successfully." }
                ] } }),
                json!({ "type": "result", "result": "I'll report back." }),
            ],
            &mut turn,
        );
        assert!(turn.background.holds_turn(), "the agent is still out");
        // The launch note is paperwork — it must not pass for the agent's report.
        assert!(turn.result.segments[0].get("output").is_none());
        assert!(!seen.lock().unwrap().iter().any(|e| e["type"] == "tool_result"));

        // It finishes: the report lands on the chip, and the turn is still owed
        // the answer Claude gives about it.
        route_all(
            &[
                json!({ "type": "system", "subtype": "task_notification", "task_id": "t1", "tool_use_id": "toolu_1",
                        "status": "completed", "summary": "The notes say hello.",
                        "usage": { "total_tokens": 900, "tool_uses": 2, "duration_ms": 4000 } }),
                json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [] }),
            ],
            &mut turn,
        );
        assert_eq!(turn.result.segments[0]["output"], "The notes say hello.");
        assert!(turn.background.running.is_empty());
        assert!(turn.background.holds_turn(), "Claude hasn't said what the agent found yet");

        route_all(&[json!({ "type": "system", "subtype": "init", "session_id": "s" })], &mut turn);
        assert!(!turn.background.holds_turn(), "the follow-up answer has started; its result ends the turn");

        let seen = seen.lock().unwrap();
        let done = seen.iter().find(|e| e["type"] == "tool_result").expect("the report is streamed");
        assert_eq!(done["id"], "toolu_1");
        assert_eq!(done["output"], "The notes say hello.");
        // …and the final tally came with it.
        assert!(seen.iter().any(|e| e["type"] == "agent_progress" && e["toolUses"] == 2));
    }

    #[test]
    fn foreground_agents_and_background_shells_do_not_hold_a_turn() {
        let (channel, _seen) = recording_channel();
        let mut turn = TurnState::new(channel, None);
        route_all(
            &[
                json!({ "type": "system", "subtype": "task_started", "task_id": "a", "tool_use_id": "toolu_a",
                        "is_backgrounded": false, "task_type": "local_agent" }),
                // A dev server left running never finishes; it must not pin the turn open.
                json!({ "type": "system", "subtype": "task_started", "task_id": "b", "tool_use_id": "toolu_b",
                        "is_backgrounded": true, "task_type": "local_bash" }),
            ],
            &mut turn,
        );
        assert!(!turn.background.holds_turn());
    }

    #[test]
    fn a_sub_agents_tool_output_goes_to_its_timeline_not_the_transcript() {
        let (channel, seen) = recording_channel();
        let mut turn = TurnState::new(channel, None);
        route_all(
            &[json!({ "type": "user", "parent_tool_use_id": "toolu_1", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_sub", "content": "1\thello" }
            ] } })],
            &mut turn,
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["type"], "agent_activity");
        assert_eq!(seen[0]["id"], "toolu_1");
        assert_eq!(seen[0]["kind"], "result");
        assert_eq!(seen[0]["toolId"], "toolu_sub");
        assert!(turn.result.segments.is_empty());
    }

    #[test]
    fn a_shell_command_is_not_mistaken_for_a_sub_agent() {
        // As the CLI sends it: every foreground shell run is a task of its own.
        let (channel, seen) = recording_channel();
        let mut turn = TurnState::new(channel, None);
        turn.result.push_tool(json!({ "type": "tool", "name": "PowerShell", "id": "toolu_sh" }));
        route_all(
            &[
                json!({ "type": "system", "subtype": "task_started", "task_id": "b1", "tool_use_id": "toolu_sh",
                        "description": "Print six ticks", "is_backgrounded": false, "task_type": "local_bash" }),
                json!({ "type": "system", "subtype": "task_notification", "task_id": "b1", "tool_use_id": "toolu_sh",
                        "status": "completed", "output_file": "", "summary": "Print six ticks" }),
                json!({ "type": "user", "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_sh", "content": "tick 1\ntick 2" }
                ] } }),
            ],
            &mut turn,
        );
        let sent = seen.lock().unwrap();
        assert!(!sent.iter().any(|e| e["type"] == "agent_progress"), "a shell is not an agent: {sent:?}");
        // …and its chip still gets its real output, not the task's summary.
        assert_eq!(turn.result.segments[0]["output"], json!("tick 1\ntick 2"));
        assert!(!turn.background.holds_turn());
    }

    #[test]
    fn an_agents_own_progress_still_comes_through() {
        let (channel, seen) = recording_channel();
        let mut turn = TurnState::new(channel, None);
        route_all(
            &[
                json!({ "type": "system", "subtype": "task_started", "task_id": "a1", "tool_use_id": "toolu_ag",
                        "description": "Look around", "is_backgrounded": false, "task_type": "local_agent",
                        "subagent_type": "general-purpose" }),
                // task_progress carries no task_type — it is an agent's by nature.
                json!({ "type": "system", "subtype": "task_progress", "task_id": "a1", "tool_use_id": "toolu_ag",
                        "description": "Reading README.txt", "last_tool_name": "Read",
                        "usage": { "total_tokens": 24875, "tool_uses": 3, "duration_ms": 7309 } }),
            ],
            &mut turn,
        );
        let sent = seen.lock().unwrap();
        let progress: Vec<_> = sent.iter().filter(|e| e["type"] == "agent_progress").collect();
        assert_eq!(progress.len(), 2);
        assert_eq!(progress[1]["durationMs"], json!(7309));
        assert_eq!(progress[1]["lastTool"], json!("Read"));
    }

    #[test]
    fn a_workers_step_after_thinking_reaches_the_timeline() {
        // One message, sent as one event per block, all under the message's id.
        let (channel, seen) = recording_channel();
        let mut turn = TurnState::new(channel, None);
        let block = |content: Value| json!({
            "type": "assistant", "parent_tool_use_id": "toolu_ag",
            "message": { "id": "msg_1", "content": [content] },
        });
        let tool = block(json!({ "type": "tool_use", "id": "toolu_ls", "name": "Bash",
                                 "input": { "command": "ls", "description": "List files" } }));
        route_all(
            &[
                block(json!({ "type": "thinking", "thinking": "Let me look." })),
                tool.clone(),
                tool, // a genuine repeat of the same block is still dropped
                block(json!({ "type": "text", "text": "Found three files." })),
            ],
            &mut turn,
        );
        let sent = seen.lock().unwrap();
        let lines: Vec<_> = sent.iter().filter(|e| e["type"] == "agent_activity").collect();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0]["kind"], json!("tool"));
        assert_eq!(lines[0]["toolId"], json!("toolu_ls"));
        assert_eq!(lines[0]["target"], json!("List files"));
        assert_eq!(lines[1]["text"], json!("Found three files."));
    }

    /// One answer as the CLI streams it: text in pieces, a thought, a tool call
    /// whose input arrives a fragment at a time, its result, then the `result`.
    #[test]
    fn a_streamed_answer_becomes_text_and_one_chip_per_tool() {
        let (channel, seen) = recording_channel();
        let mut turn = TurnState::new(channel, None);
        let se = |event: Value| json!({ "type": "stream_event", "event": event });
        route_all(
            &[
                json!({ "type": "system", "subtype": "init", "session_id": "s1", "model": "m", "skills": ["run"] }),
                se(json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text" } })),
                se(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Let me read " } })),
                se(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "the notes." } })),
                se(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "hm" } })),
                se(json!({ "type": "content_block_stop", "index": 0 })),
                se(json!({ "type": "content_block_start", "index": 1,
                           "content_block": { "type": "tool_use", "name": "Read", "id": "toolu_r" } })),
                se(json!({ "type": "content_block_delta", "index": 1,
                           "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":" } })),
                se(json!({ "type": "content_block_delta", "index": 1,
                           "delta": { "type": "input_json_delta", "partial_json": "\"C:\\\\work\\\\notes.md\"}" } })),
                se(json!({ "type": "content_block_stop", "index": 1 })),
                json!({ "type": "user", "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_r", "content": "hello" }
                ] } }),
                json!({ "type": "prompt_suggestion", "suggestion": "  Now summarise it  " }),
                json!({ "type": "result", "session_id": "s1", "result": "Let me read the notes.",
                        "total_cost_usd": 0.5, "usage": { "input_tokens": 3 } }),
            ],
            &mut turn,
        );
        let r = &turn.result;
        assert_eq!(r.session_id.as_deref(), Some("s1"));
        assert_eq!(r.main_model.as_deref(), Some("m"));
        assert_eq!(r.final_text, "Let me read the notes.");
        assert_eq!(r.cost_usd, 0.5);
        assert!(!r.is_error);
        assert_eq!(r.segments.len(), 2, "{:?}", r.segments);
        assert_eq!(r.segments[0], json!({ "type": "text", "text": "Let me read the notes." }));
        let chip = &r.segments[1];
        assert_eq!(chip["name"], "Read");
        assert_eq!(chip["id"], "toolu_r");
        assert_eq!(chip["detail"], r"C:\work\notes.md");
        assert_eq!(chip["target"], "notes.md");
        assert_eq!(chip["output"], "hello");

        let sent = seen.lock().unwrap();
        let kinds: Vec<&str> = sent.iter().filter_map(|e| e["type"].as_str()).collect();
        assert_eq!(kinds.first(), Some(&"start"));
        assert_eq!(sent[0]["skills"], json!(["run"]));
        assert!(sent.iter().any(|e| e["type"] == "thinking" && e["text"] == "hm"));
        // The chip is announced as the call starts, then again complete.
        assert_eq!(sent.iter().filter(|e| e["type"] == "tool" && e["id"] == "toolu_r").count(), 2);
        assert!(sent.iter().any(|e| e["type"] == "tool_result" && e["output"] == "hello"));
        assert!(sent.iter().any(|e| e["type"] == "suggestion" && e["text"] == "Now summarise it"));
        assert!(!kinds.contains(&"error"));
    }

    #[test]
    fn an_errored_result_is_reported_once() {
        let (channel, seen) = recording_channel();
        let mut turn = TurnState::new(channel, None);
        route_all(&[json!({ "type": "result", "is_error": true, "result": "Overloaded" })], &mut turn);
        assert!(turn.result.is_error);
        let sent = seen.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0], json!({ "type": "error", "message": "Overloaded" }));
    }
}
