//! The turns in flight: stopping one, answering its permission prompts, and
//! listing or stopping every chat at once.

use super::*;


/// Stop the in-flight chat turn for `thread_id`, if any. Two levels:
///
/// - the default is an **interrupt** — the CLI abandons the turn, answers with an
///   errored `result` (which settles the turn the same way a finished one does)
///   and waits for the next message, so the chat keeps its warm process, its
///   context and its session id instead of paying to resume;
/// - `force` **kills the process tree**. The interrupt is only a request, and a
///   turn wedged deep in a tool run or a sub-agent tree can be slow to honour it
///   or never honour it at all — which is what "stop does nothing no matter how
///   often I press it" looks like. The frontend escalates to this on the second
///   press, and on its own if the polite stop hasn't landed (see stream.js).
///
/// Either way the stream ends on its own; any text already produced is still
/// persisted by the `chat` handler.
///
/// Stopping a chat stops the **sub-agents** it sent out, too. An interrupt only
/// ends the turn: a background agent lives on in the warm process and keeps
/// working after the chat says it stopped. So a chat with an agent still alive
/// goes straight to the kill — the agents live inside the process, so that ends
/// them, and the chat resumes its session on the next message (see
/// `Session::has_agents` for why stopping them one by one isn't enough).
#[tauri::command]
pub async fn stop_chat(
    state: State<'_, AppState>,
    thread_id: String,
    force: Option<bool>,
) -> Result<Value, String> {
    let sess = state.sessions.get(&thread_id).await;
    if !force.unwrap_or(false) {
        if let Some(sess) = sess.as_ref().filter(|s| !s.has_agents()) {
            if sess.interrupt().await.is_ok() {
                return Ok(json!({ "ok": true, "killed": false }));
            }
        }
        // Stdin is gone — the process is past asking — or an agent is still out
        // that an interrupt wouldn't reach; fall through and kill it.
    }
    // Retire first: the process is about to die, and the chat must not be handed a
    // corpse on its next message (it starts a fresh session instead).
    let pid = match sess {
        Some(sess) => {
            state.sessions.retire(&thread_id).await;
            Some(sess.pid).filter(|p| *p != 0)
        }
        None => None,
    }
    .or_else(|| state.running.lock().unwrap().get(&thread_id).copied());
    if let Some(pid) = pid {
        // Kill off the main thread: `taskkill /T /F` on the claude → node tree can
        // take a moment, and a synchronous command blocks the window message loop
        // — which is what makes the app intermittently freeze ("Not responding")
        // when interrupting a turn. spawn_blocking keeps the UI responsive.
        let _ = tokio::task::spawn_blocking(move || claude::kill_process_tree(pid)).await;
    }
    Ok(json!({ "ok": pid.is_some(), "killed": pid.is_some() }))
}

/// Answer a permission prompt a turn is waiting on (Ask mode): `allow` this
/// once, `always` (allow, and apply the rule the CLI suggested so it stops
/// asking), or `deny`.
///
/// `ok: false` means the prompt was already gone — answered from another view,
/// withdrawn because the turn was stopped, or the turn ended. That is a late
/// click, not a failure, so it is reported rather than raised. The turn itself
/// tells every view the prompt is settled (a `permission_gone` event), so the
/// window and whoever is driving the turn from outside drop the card together.
#[tauri::command]
pub async fn answer_permission(
    state: State<'_, AppState>,
    thread_id: String,
    request_id: String,
    decision: String,
) -> Result<Value, String> {
    let decision = session::Decision::parse(&decision).ok_or("unknown decision")?;
    let Some(sess) = state.sessions.get(&thread_id).await else {
        return Ok(json!({ "ok": false }));
    };
    let ok = sess.answer_permission(&request_id, decision).await?;
    Ok(json!({ "ok": ok }))
}

/// List the chat turns the app currently thinks are running, each verified
/// against the OS so the UI can flag any whose process has already died (stale).
/// Returns `[{ threadId, pid, alive }]`. Liveness checks run off the main thread.
#[tauri::command]
pub async fn active_runs(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let entries: Vec<(String, u32)> = {
        let map = state.running.lock().unwrap();
        map.iter().map(|(k, v)| (k.clone(), *v)).collect()
    };
    let mut out = Vec::with_capacity(entries.len());
    for (thread_id, pid) in entries {
        let alive = tokio::task::spawn_blocking(move || claude::pid_alive(pid))
            .await
            .unwrap_or(false);
        out.push(json!({ "threadId": thread_id, "pid": pid, "alive": alive }));
    }
    Ok(out)
}

/// Interrupt every tracked chat turn at once: clear the registry, then kill each
/// process tree off the main thread. Returns how many were stopped. Each stream
/// ends on its own once its process dies (any partial text is still persisted).
#[tauri::command]
pub async fn stop_all_chats(state: State<'_, AppState>) -> Result<Value, String> {
    let pids: Vec<u32> = {
        let mut map = state.running.lock().unwrap();
        let pids = map.values().copied().collect();
        map.clear();
        pids
    };
    // The warm processes are about to be killed, so no chat may keep a handle to
    // one; each starts a fresh session on its next message.
    state.sessions.retire_all().await;
    let n = pids.len();
    if !pids.is_empty() {
        let _ = tokio::task::spawn_blocking(move || {
            for pid in pids {
                claude::kill_process_tree(pid);
            }
        })
        .await;
    }
    Ok(json!({ "stopped": n }))
}
