//! The control protocol on a session's stdin/stdout: the `control_request`s we
//! write (permission answers, rewinds, interrupts), reading their answers back,
//! and tracking which sub-agents are still out.

use super::*;


/// The `control_response` that settles one `can_use_tool` request.
///
/// Allowing echoes the tool's input back as `updatedInput` — the host is allowed
/// to rewrite it, and we don't, but the field is what says "run it as asked".
/// *Always* additionally hands the CLI its own `permission_suggestions` back as
/// `updatedPermissions`: the CLI wrote the rule (and decided where it is saved),
/// we only say yes to it, so "always" means exactly what it means in a terminal.
pub(super) fn permission_response(request_id: &str, request: &Value, decision: Decision) -> Value {
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
pub(super) const REWIND_TIMEOUT_SECS: u64 = 45;

pub(super) fn rewind_request(request_id: &str, message_id: &str, dry_run: bool) -> Value {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "rewind_files", "user_message_id": message_id, "dry_run": dry_run }
    })
}

/// If `ev` is the CLI's reply to our control request `request_id`: what it said.
pub(super) fn control_answer(ev: &Value, request_id: &str) -> Option<Result<Value, String>> {
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
pub(super) fn interrupt_request() -> Value {
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
pub(super) fn track_agents(agents: &mut HashMap<String, bool>, ev: &Value) {
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
