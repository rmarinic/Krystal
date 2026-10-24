//! What a tool call looks like on its chip: the short target, the hover detail,
//! the before/after of an edit, and the output it returned.

use super::*;

/// The tools that run a shell command. On Windows Claude reaches for PowerShell
/// as often as Bash, so anything said about "the shell" means both.
pub fn is_shell_tool(name: &str) -> bool {
    name == "Bash" || name == "PowerShell"
}

/// Turn a tool's input into a short on-chip target + a full hover detail.
/// Mirrors `toolDetail` in server.js. Returns (detail, target).
pub(super) fn tool_detail(name: &str, input: &Value) -> (Option<String>, Option<String>) {
    if !input.is_object() {
        return (None, None);
    }
    let str_of = |k: &str| input.get(k).and_then(|v| v.as_str());
    if let Some(path) = str_of("file_path").or_else(|| str_of("path")).or_else(|| str_of("notebook_path")) {
        return (Some(path.to_string()), Some(crate::util::base_name(path)));
    }
    // A shell run is labelled by what it is *for* — Claude's own one-line
    // description of it, when it gave one — and the command itself is the
    // detail. "Run the tests" reads at a glance; `npx vitest run --reporter…`
    // doesn't. Bash and PowerShell are the same thing for this.
    if is_shell_tool(name) {
        if let Some(cmd) = str_of("command") {
            let target = match str_of("description").map(str::trim).filter(|d| !d.is_empty()) {
                Some(d) => take_chars(d, 60),
                None => take_chars(cmd, 36),
            };
            return (Some(cmd.to_string()), Some(target));
        }
    }
    if name == "Grep" || name == "Glob" {
        if let Some(pat) = str_of("pattern") {
            let detail = match str_of("path") {
                Some(p) => format!("{pat} in {p}"),
                None => pat.to_string(),
            };
            return (Some(detail), Some(take_chars(pat, 28)));
        }
    }
    if name == "WebFetch" {
        if let Some(url) = str_of("url") {
            let host = url
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or(url)
                .to_string();
            return (Some(url.to_string()), Some(host));
        }
    }
    if name == "WebSearch" {
        if let Some(q) = str_of("query") {
            return (Some(q.to_string()), Some(take_chars(q, 28)));
        }
    }
    // Delegation. The CLI has shipped this tool under both names — `Agent` is the
    // current one, `Task` the older — so match either.
    if name == "Agent" || name == "Task" {
        if let Some(d) = str_of("description") {
            return (Some(d.to_string()), Some(take_chars(d, 28)));
        }
    }
    if name == "AskUserQuestion" {
        if let Some(first) = input.get("questions").and_then(|v| v.as_array()).and_then(|a| a.first()) {
            let q = first.get("question").and_then(|v| v.as_str()).unwrap_or("");
            let header = first.get("header").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(q);
            return (Some(q.to_string()), Some(take_chars(header, 28)));
        }
    }
    if name == "ExitPlanMode" || name == "exit_plan_mode" {
        if let Some(p) = str_of("plan") {
            return (Some(p.to_string()), None);
        }
    }
    // Loading a deferred tool's schema. `select:A,B` names the tools outright;
    // anything else is a keyword search over them.
    if name == "ToolSearch" {
        if let Some(q) = str_of("query") {
            return (Some(q.to_string()), Some(tool_search_target(q)));
        }
    }
    (None, None)
}

/// The chip label for a ToolSearch query: the tools a `select:` names, by their
/// short name (an MCP tool's `mcp__server__name` reads as just `name`), or the
/// keywords of a search.
fn tool_search_target(query: &str) -> String {
    let Some(list) = query.strip_prefix("select:") else {
        return take_chars(query, 28);
    };
    let names: Vec<&str> = list
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.rsplit("__").next().unwrap_or(n))
        .collect();
    match names.as_slice() {
        [] => take_chars(query, 28),
        [one] => take_chars(one, 28),
        [first, rest @ ..] => format!("{} +{}", take_chars(first, 22), rest.len()),
    }
}

/// Curated rich detail for change-making tools: the before/after of an edit, or
/// the content of a write, so the action chip can reveal exactly what changed.
/// Returns `(key, value)` pairs to merge into the streamed/persisted segment.
/// Strings are capped so a big write can't bloat the transcript.
pub(super) fn tool_change(name: &str, input: &Value) -> Option<Vec<(&'static str, Value)>> {
    const CAP: usize = 4000;
    let str_of = |k: &str| input.get(k).and_then(|v| v.as_str());
    match name {
        "Edit" => {
            let (o, n) = (str_of("old_string")?, str_of("new_string")?);
            Some(vec![(
                "edits",
                json!([{ "old": cap_text(o, CAP), "new": cap_text(n, CAP) }]),
            )])
        }
        "MultiEdit" => {
            let arr = input.get("edits").and_then(|v| v.as_array())?;
            let edits: Vec<Value> = arr
                .iter()
                .filter_map(|e| {
                    let o = e.get("old_string").and_then(|v| v.as_str())?;
                    let n = e.get("new_string").and_then(|v| v.as_str())?;
                    Some(json!({ "old": cap_text(o, CAP), "new": cap_text(n, CAP) }))
                })
                .collect();
            if edits.is_empty() {
                None
            } else {
                Some(vec![("edits", json!(edits))])
            }
        }
        "Write" => Some(vec![("content", json!(cap_text(str_of("content")?, CAP)))]),
        "NotebookEdit" => Some(vec![("content", json!(cap_text(str_of("new_source")?, CAP)))]),
        _ => None,
    }
}

/// Flatten a tool_result's `content` (a string, or an array of text blocks)
/// into plain text — the shell/sub-agent output we surface in the Activity panel.
/// ToolSearch answers with `tool_reference` blocks instead of text; each becomes
/// a line naming the tool it loaded, so its chip says what was found.
pub(super) fn tool_result_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => {
            let mut out = String::new();
            let mut tools = Vec::new();
            for b in a {
                if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                    out.push_str(t);
                } else if let Some(t) = b.get("tool_name").and_then(|v| v.as_str()) {
                    tools.push(t);
                }
            }
            if !tools.is_empty() {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&tools.join("\n"));
            }
            out
        }
        _ => String::new(),
    }
}

/// Cap a string to `cap` characters, appending a truncation marker if it had to
/// be cut, so a chatty tool can't bloat the saved transcript.
pub(super) fn cap_text(s: &str, cap: usize) -> String {
    if s.chars().count() > cap {
        let mut t: String = s.chars().take(cap).collect();
        t.push_str("\n… (truncated)");
        t
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_chip_says_what_the_command_is_for() {
        let input = json!({ "command": "Get-ChildItem -Recurse -Filter *.md | Measure-Object", "description": "Count markdown files" });
        let (detail, target) = tool_detail("PowerShell", &input);
        assert_eq!(detail.as_deref(), Some("Get-ChildItem -Recurse -Filter *.md | Measure-Object"));
        assert_eq!(target.as_deref(), Some("Count markdown files"));
        // No description: the start of the command will have to do.
        let (_, target) = tool_detail("Bash", &json!({ "command": "npm test" }));
        assert_eq!(target.as_deref(), Some("npm test"));
        let (_, target) = tool_detail("Bash", &json!({ "command": "npm test", "description": "  " }));
        assert_eq!(target.as_deref(), Some("npm test"));
    }

    #[test]
    fn a_tool_search_chip_names_the_tools_it_loaded() {
        // The call: `select:` names the tools, MCP ones by their short name.
        let (detail, target) = tool_detail("ToolSearch", &json!({ "query": "select:WebFetch", "max_results": 1 }));
        assert_eq!(detail.as_deref(), Some("select:WebFetch"));
        assert_eq!(target.as_deref(), Some("WebFetch"));
        let q = "select:mcp__claude_ai_Atlassian_MCP__getJiraIssue,mcp__claude_ai_Atlassian_MCP__createJiraIssue,TaskStop";
        let (_, target) = tool_detail("ToolSearch", &json!({ "query": q }));
        assert_eq!(target.as_deref(), Some("getJiraIssue +2"));
        let (_, target) = tool_detail("ToolSearch", &json!({ "query": "notebook jupyter" }));
        assert_eq!(target.as_deref(), Some("notebook jupyter"));
        // The result: tool_reference blocks, not text — one line per tool.
        let content = json!([
            { "type": "tool_reference", "tool_name": "WebFetch" },
            { "type": "tool_reference", "tool_name": "WebSearch" },
        ]);
        assert_eq!(tool_result_text(Some(&content)), "WebFetch\nWebSearch");
        // Plain text results are untouched.
        let content = json!([{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }]);
        assert_eq!(tool_result_text(Some(&content)), "ab");
    }
}
