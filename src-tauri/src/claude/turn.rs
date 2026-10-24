//! One chat turn on a warm session: what it produced (`ChatResult`), and the
//! loop that drives it to its end.

use super::*;

#[derive(Default)]
pub struct ChatResult {
    pub final_text: String,
    /// Ordered transcript of the turn: text blocks and tool actions, in the
    /// sequence they happened. Each entry is `{type:"text",text}` or
    /// `{type:"tool",name,target?,detail?}`. Persisted so the chat reloads with
    /// the full play-by-play (the "action chips") intact.
    pub segments: Vec<Value>,
    pub session_id: Option<String>,
    pub usage: Option<Value>,
    pub cost_usd: f64,
    pub is_error: bool,
    /// The main/orchestrator model for this turn (from the `init` event). Any
    /// assistant message on a *different* model is a delegated worker.
    pub main_model: Option<String>,
    /// Per-assistant-message token tally, keyed by message id so the duplicate
    /// emissions the CLI makes under `--include-partial-messages` are deduped
    /// (last write wins — the pair is identical). Value is `(model id, billable
    /// tokens)`, where billable = input + output + cache_creation (the cheap
    /// cache *reads* are excluded so the split reflects real work, not the
    /// orchestrator re-reading the resumed conversation). Summed per model into
    /// the orchestrator savings readout at end of turn.
    pub msg_usage: HashMap<String, (String, u64)>,
    /// Artifacts this turn created or revised, latest state per artifact. The
    /// content is read back off disk (the MCP server resolved it), never out of
    /// the conversation — see `artifacts.rs`.
    pub artifacts: Vec<Value>,
}

impl ChatResult {
    /// Append streamed text. Text that arrives after a tool action starts a new
    /// block, so "Let me do X" and "Let me do Y" never fuse into one line.
    pub(super) fn push_text(&mut self, t: &str) {
        self.final_text.push_str(t);
        if let Some(last) = self.segments.last_mut() {
            if last.get("type").and_then(|v| v.as_str()) == Some("text") {
                let cur = last.get("text").and_then(|v| v.as_str()).unwrap_or("");
                last["text"] = json!(format!("{cur}{t}"));
                return;
            }
        }
        self.segments.push(json!({ "type": "text", "text": t }));
    }

    /// Append a tool action (ends the current text block).
    pub(super) fn push_tool(&mut self, seg: Value) {
        self.segments.push(seg);
    }
}

/// How often the half-written answer is flushed to the database mid-turn. Often
/// enough that closing the app loses at most a sentence, rare enough that a long
/// turn costs a handful of small writes rather than one per token.
const PARTIAL_SAVE_MS: u128 = 1200;

/// What one turn is asked to do — the message and everything about the chat it
/// runs in that the turn itself needs to know.
#[derive(Clone, Copy)]
pub struct TurnRequest<'a> {
    /// The assembled message (see `build_prompt`).
    pub prompt: &'a str,
    /// The uuid the message is sent under: the checkpoint a rewind names.
    pub turn_uuid: &'a str,
    /// The chat, for the Activity panel's list of running turns.
    pub thread_id: &'a str,
    /// Orchestrator mode: report the supervisor/worker token split at the end.
    pub orchestrating: bool,
    /// Where the artifact tool writes what it resolved (None: no artifact tool).
    pub artifact_dir: Option<&'a std::path::Path>,
    /// The folders Krystal keeps its own files in; in Ask mode a permission
    /// prompt about one of those is answered here instead of being put to the
    /// user (see `is_own_business`).
    pub own_dirs: &'a [PathBuf],
}

/// Run one turn on a warm session (see `session.rs`).
///
/// The old shape of this function was "spawn a process, read until it exits".
/// A session outlives the turn, so the loop now ends where the *turn* ends — at
/// the `result` event — and everything else about the process (its stdout reader,
/// its context, its session id) carries on to the next message.
///
/// A turn can therefore end three ways: the `result` arrives (normal, including a
/// turn the user interrupted, which the CLI reports as an errored result), the
/// event stream closes (the process died under us), or the caller drops us.
///
/// `on_partial` is handed the answer so far (text + transcript segments) on that
/// throttle, so an interrupted turn leaves something behind to come back to.
pub async fn run_turn(
    session: &Session,
    req: &TurnRequest<'_>,
    channel: &Channel<Value>,
    running: &std::sync::Mutex<HashMap<String, u32>>,
    on_partial: &mut (dyn FnMut(&str, &[Value]) + Send),
) -> Result<ChatResult, String> {
    let TurnRequest { prompt, turn_uuid, thread_id, orchestrating, artifact_dir, own_dirs } = *req;
    let mut events = session.begin_turn(prompt, turn_uuid).await?;

    // Register the PID for the Activity panel's "running turns" list; `stop_chat`
    // interrupts through the session rather than killing this.
    running.lock().unwrap().insert(thread_id.to_string(), session.pid);

    let mut turn = TurnState::new(channel.clone(), artifact_dir);
    // The text of the answers already given this turn, when it runs to more than
    // one (see `BackgroundAgents`): a later `result` carries only its own.
    let mut carried = String::new();
    // Between a `result` that didn't end the turn and the CLI picking it back up.
    let mut between_answers = false;
    let mut got_result = false;
    let mut last_save = std::time::Instant::now();
    let mut saved_len = 0usize;

    loop {
        // Waiting on the CLI to come back with what a finished agent reported is
        // the one place a turn waits on a promise rather than on work, so it is
        // the one place it gives up: no follow-up within `FOLLOW_UP_WAIT_MS` means
        // the report was already folded into the answer we have.
        let next = if between_answers && turn.background.running.is_empty() {
            match tokio::time::timeout(
                std::time::Duration::from_millis(FOLLOW_UP_WAIT_MS),
                events.recv(),
            )
            .await
            {
                Ok(ev) => ev,
                Err(_) => break,
            }
        } else {
            events.recv().await
        };
        let Some(ev) = next else { break };
        // Ask mode: the CLI stopping to ask permission (or taking the question
        // back). Not part of the transcript — the turn just waits here, still
        // reading, until `answer_permission` writes the reply on stdin.
        if handle_control(session, &ev, own_dirs, channel).await {
            continue;
        }
        let ty = ev.get("type").and_then(|v| v.as_str());
        let is_result = ty == Some("result");
        if ty == Some("system") && ev.get("subtype").and_then(|v| v.as_str()) == Some("init") {
            between_answers = false;
        }
        turn.route(&ev);
        let result = &mut turn.result;
        if is_result {
            got_result = true;
            // A later answer's `result` names only its own text; put the earlier
            // ones back in front of it.
            if !carried.is_empty() && !result.final_text.starts_with(&carried) {
                result.final_text = format!("{carried}\n\n{}", result.final_text);
            }
            if result.is_error || !turn.background.holds_turn() {
                break;
            }
            // Agents are still out, or one came back and Claude hasn't said what
            // it found: the turn isn't over, whatever the CLI calls it. Keep
            // reading, and keep the next answer from fusing onto this one.
            between_answers = true;
            turn.ask.flush(result, channel);
            carried = result.final_text.trim_end().to_string();
            ask_emit_text(result, channel, "\n\n");
            continue;
        }
        // Keep the half-written answer on disk. Only when it actually grew, and
        // never more than once per `PARTIAL_SAVE_MS`.
        if result.final_text.len() != saved_len && last_save.elapsed().as_millis() >= PARTIAL_SAVE_MS
        {
            saved_len = result.final_text.len();
            last_save = std::time::Instant::now();
            on_partial(&result.final_text, &result.segments);
        }
    }
    running.lock().unwrap().remove(thread_id);
    // Whatever the turn was still asking, it can no longer be answered.
    session.clear_permissions();

    // Release anything the ask-block parser is still holding (e.g. a turn that
    // ended without a trailing text block to trigger the per-block flush).
    let TurnState { mut result, mut ask, .. } = turn;
    ask.flush(&mut result, channel);

    // Orchestrator turns: surface how the turn's tokens split between the premium
    // supervisor and the cheaper workers it delegated to.
    if orchestrating {
        emit_orchestration_summary(&mut result, channel);
    }

    // If the answer arrived only via the final `result` event (no streamed text
    // deltas), still expose it as one text segment so the transcript isn't empty.
    if result.segments.is_empty() && !result.final_text.trim().is_empty() {
        result.segments.push(json!({ "type": "text", "text": result.final_text.clone() }));
    }

    // No `result` means the stream ended early — the process died mid-turn. Say so
    // with whatever it wrote to stderr, the same way the old per-turn spawn did.
    if !got_result && result.final_text.is_empty() && !result.is_error {
        result.is_error = true;
        let errout = session.stderr_text();
        let msg = if errout.is_empty() {
            "the claude session ended unexpectedly".to_string()
        } else {
            errout
        };
        let _ = channel.send(json!({ "type": "error", "message": msg }));
    }
    Ok(result)
}

/// How long a turn waits for the CLI to pick itself back up after a background
/// agent reported in. It normally does within a second or two.
const FOLLOW_UP_WAIT_MS: u64 = 8000;
