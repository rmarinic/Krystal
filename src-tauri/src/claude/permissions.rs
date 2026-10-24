//! Permission prompts the CLI hands its host (Ask, Auto and Accept edits
//! modes): which ones Krystal answers itself, and the card the user sees.

use super::*;

/// Is this prompt about Krystal's own plumbing rather than the user's project?
///
/// A few things Claude does in a turn are Krystal's doing, not the user's: it
/// calls the artifact tool Krystal handed it, ticks a line off the task snapshot
/// Krystal asked it to keep current, reads an attachment Krystal saved and told
/// it to Read. All of those live outside the project folder, so the CLI would ask
/// about each one — a question the user can't make sense of ("allow editing
/// `cfcc4acf….md`?") about a file they never chose. Those are answered here.
///
/// Deliberately narrow: only the file tools, only inside the folders in
/// `own_dirs`, and never by way of a `..` hop. Anything else — a shell command
/// that happens to mention one of those paths included — is still asked.
pub fn is_own_business(tool: &str, input: &Value, own_dirs: &[PathBuf]) -> bool {
    if tool == artifacts::TOOL_NAME {
        return true;
    }
    if !matches!(tool, "Read" | "Edit" | "Write" | "MultiEdit") {
        return false;
    }
    let Some(path) = input.get("file_path").and_then(|v| v.as_str()) else {
        return false;
    };
    // Compared as text, not resolved: the file may not exist yet, and Windows
    // paths arrive in either slash and any case.
    let norm = |p: &str| p.replace('\\', "/").to_lowercase();
    let path = norm(path);
    if path.split('/').any(|part| part == "..") {
        return false;
    }
    own_dirs.iter().any(|dir| {
        let dir = norm(&dir.to_string_lossy());
        let dir = dir.trim_end_matches('/');
        !dir.is_empty() && path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
    })
}

/// What "always allow" would do for this prompt, in a shape the UI can put into
/// words. The CLI proposes the rule itself (`permission_suggestions`) — a command
/// prefix to stop asking about, a switch to accepting edits for the session, a
/// folder to trust — and applies it if we hand it back; this is only the
/// description of that, so the button can say what it is agreeing to.
fn permission_always(request: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(list) = request.get("permission_suggestions").and_then(|v| v.as_array()) else {
        return out;
    };
    for s in list {
        let scope = s.get("destination").and_then(|v| v.as_str()).unwrap_or("");
        match s.get("type").and_then(|v| v.as_str()) {
            Some("addRules") => {
                for r in s.get("rules").and_then(|v| v.as_array()).into_iter().flatten() {
                    let tool = r.get("toolName").and_then(|v| v.as_str()).unwrap_or("");
                    let rule = r.get("ruleContent").and_then(|v| v.as_str()).unwrap_or("");
                    out.push(json!({ "kind": "rule", "tool": tool, "text": rule, "scope": scope }));
                }
            }
            Some("setMode") => {
                let mode = s.get("mode").and_then(|v| v.as_str()).unwrap_or("");
                out.push(json!({ "kind": "mode", "text": mode, "scope": scope }));
            }
            Some("addDirectories") => {
                for d in s.get("directories").and_then(|v| v.as_array()).into_iter().flatten() {
                    if let Some(d) = d.as_str() {
                        out.push(json!({ "kind": "dir", "text": d, "scope": scope }));
                    }
                }
            }
            _ => out.push(json!({ "kind": "other", "text": "", "scope": scope })),
        }
    }
    out
}

/// The `permission` event for one `can_use_tool` request: what Claude wants to
/// do, in the same terms its action chip uses (`tool_detail`/`tool_change`), so
/// the prompt can show the command or the diff being agreed to rather than a
/// tool name and a shrug.
fn permission_prompt(request_id: &str, request: &Value) -> Value {
    let tool = request.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
    let empty = json!({});
    let input = request.get("input").unwrap_or(&empty);
    let (detail, target) = tool_detail(tool, input);
    let mut msg = json!({
        "type": "permission",
        "id": request_id,
        "tool": tool,
        "always": permission_always(request),
    });
    if let Some(d) = detail {
        msg["detail"] = json!(cap_text(&d, 4000));
    }
    if let Some(t) = target {
        msg["target"] = json!(t);
    }
    // A shell command's own one-line explanation of itself, when it gave one.
    if is_shell_tool(tool) {
        if let Some(why) = input.get("description").and_then(|v| v.as_str()) {
            msg["why"] = json!(take_chars(why, 300));
        }
    }
    if let Some(rich) = tool_change(tool, input) {
        for (k, v) in rich {
            msg[k] = v;
        }
    }
    // Which tool call in the transcript this is about.
    if let Some(id) = request.get("tool_use_id").and_then(|v| v.as_str()) {
        msg["toolUseId"] = json!(id);
    }
    msg
}

/// One control message from the CLI, mid-turn. Returns `true` when the event was
/// one of these (and so is not a transcript event for `route_event`).
///
/// * `control_request`/`can_use_tool` — a permission prompt. Krystal's own
///   plumbing is waved through; everything else is parked on the session and
///   shown to the user (`permission`).
/// * `control_cancel_request` — the CLI withdrew a prompt (the turn was stopped).
/// * our own `PERMISSION_ANSWERED` echo — somebody answered; every view watching
///   this turn drops the prompt (`permission_gone`), whichever one it was
///   answered from.
pub(super) async fn handle_control(
    session: &Session,
    ev: &Value,
    own_dirs: &[PathBuf],
    channel: &Channel<Value>,
) -> bool {
    let id = ev.get("request_id").and_then(|v| v.as_str()).unwrap_or("");
    match ev.get("type").and_then(|v| v.as_str()) {
        Some("control_request") => {
            let empty = json!({});
            let request = ev.get("request").unwrap_or(&empty);
            if request.get("subtype").and_then(|v| v.as_str()) != Some("can_use_tool") {
                // Hooks, SDK-side MCP, elicitation: things a host opts into and
                // we never did. Say so rather than leave the CLI waiting.
                let _ = session.refuse_control(id, "not supported by this host").await;
                return true;
            }
            let tool = request.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
            let input = request.get("input").unwrap_or(&empty);
            if is_own_business(tool, input, own_dirs) {
                let _ = session.respond_permission(id, request, Decision::Allow).await;
                return true;
            }
            session.hold_permission(id, request.clone());
            let _ = channel.send(permission_prompt(id, request));
            true
        }
        Some("control_cancel_request") => {
            session.drop_permission(id);
            let _ = channel.send(json!({ "type": "permission_gone", "id": id }));
            true
        }
        Some(session::PERMISSION_ANSWERED) => {
            let mut msg = json!({ "type": "permission_gone", "id": id });
            if let Some(d) = ev.get("decision") {
                msg["decision"] = d.clone();
            }
            let _ = channel.send(msg);
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn krystals_own_files_are_not_put_to_the_user() {
        let own = vec![
            PathBuf::from(r"C:\Users\me\AppData\Roaming\com.krystal.claudecode\task-lists"),
            PathBuf::from(r"C:\Users\me\AppData\Roaming\com.krystal.claudecode\attachments"),
        ];
        let at = |p: &str| json!({ "file_path": p });

        // The task snapshot, in whichever slash and case the model wrote it.
        assert!(is_own_business(
            "Edit",
            &at(r"C:\Users\me\AppData\Roaming\com.krystal.claudecode\task-lists\cfcc.md"),
            &own
        ));
        assert!(is_own_business(
            "Read",
            &at("c:/users/me/appdata/roaming/com.krystal.claudecode/attachments/shot.png"),
            &own
        ));
        // The artifact tool is Krystal's own, whatever it is handed.
        assert!(is_own_business(artifacts::TOOL_NAME, &json!({ "id": "a" }), &own));
    }

    #[test]
    fn everything_else_is_still_asked() {
        let own = vec![PathBuf::from(r"C:\data\krystal\task-lists")];
        let at = |p: &str| json!({ "file_path": p });

        // The user's project is exactly what Ask mode is for.
        assert!(!is_own_business("Edit", &at(r"C:\proj\src\main.rs"), &own));
        // A neighbour of an owned folder is not inside it — the database lives
        // one level up, and a name that merely starts the same is a different folder.
        assert!(!is_own_business("Edit", &at(r"C:\data\krystal\krystal.db"), &own));
        assert!(!is_own_business("Edit", &at(r"C:\data\krystal\task-lists-old\x.md"), &own));
        // No climbing back out through `..`.
        assert!(!is_own_business(
            "Write",
            &at(r"C:\data\krystal\task-lists\..\krystal.db"),
            &own
        ));
        // Only the file tools: a shell command naming the path is still asked.
        assert!(!is_own_business(
            "Bash",
            &json!({ "command": r"del C:\data\krystal\task-lists\x.md" }),
            &own
        ));
        // And with nothing owned, nothing is waved through.
        assert!(!is_own_business("Read", &at(r"C:\data\krystal\task-lists\x.md"), &[]));
    }

    #[test]
    fn a_permission_prompt_says_what_is_being_agreed_to() {
        let request = json!({
            "subtype": "can_use_tool",
            "tool_name": "Bash",
            "input": { "command": "npm install left-pad", "description": "Install left-pad" },
            "permission_suggestions": [
                { "type": "addRules", "behavior": "allow", "destination": "localSettings",
                  "rules": [{ "toolName": "Bash", "ruleContent": "npm install *" }] },
                { "type": "addDirectories", "directories": ["C:\\p"], "destination": "session" }
            ],
            "tool_use_id": "toolu_1",
        });
        let msg = permission_prompt("req-9", &request);
        assert_eq!(msg["type"], "permission");
        assert_eq!(msg["id"], "req-9");
        assert_eq!(msg["tool"], "Bash");
        assert_eq!(msg["detail"], "npm install left-pad");
        assert_eq!(msg["why"], "Install left-pad");
        assert_eq!(msg["toolUseId"], "toolu_1");
        // What "always" would do, flattened for the button to describe.
        let always = msg["always"].as_array().unwrap();
        assert_eq!(always.len(), 2);
        assert_eq!(always[0]["kind"], "rule");
        assert_eq!(always[0]["text"], "npm install *");
        assert_eq!(always[0]["scope"], "localSettings");
        assert_eq!(always[1]["kind"], "dir");
    }

    #[test]
    fn an_edit_prompt_carries_the_diff() {
        let request = json!({
            "tool_name": "Edit",
            "input": { "file_path": "C:/p/a.rs", "old_string": "foo", "new_string": "bar" },
            "permission_suggestions": [
                { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
            ],
        });
        let msg = permission_prompt("req-10", &request);
        assert_eq!(msg["target"], "a.rs");
        assert_eq!(msg["edits"][0]["old"], "foo");
        assert_eq!(msg["edits"][0]["new"], "bar");
        assert_eq!(msg["always"][0]["kind"], "mode");
        assert_eq!(msg["always"][0]["text"], "acceptEdits");
        // No suggestions at all → no "always" on offer, not a broken one.
        let bare = json!({ "tool_name": "WebFetch", "input": { "url": "https://example.com/x" } });
        assert_eq!(permission_prompt("r", &bare)["always"].as_array().unwrap().len(), 0);
    }

    // The real thing the fallback keys off: the CLI's registry pre-check giving
    // up, as opposed to a download or install that actually went wrong.
}
