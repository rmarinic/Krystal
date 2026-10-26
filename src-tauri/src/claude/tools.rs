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
    // Someone's MCP server: no detail line (its arguments ride along as `args`,
    // see `tool_change`), only a target guessed from them.
    if is_mcp_tool(name) {
        return (None, mcp_target(input));
    }
    (None, None)
}

/// A tool from an MCP server (`mcp__<server>__<tool>`). Krystal's own artifact
/// tool is one too, but it has a card of its own and is left out.
pub(super) fn is_mcp_tool(name: &str) -> bool {
    name.starts_with("mcp__") && name != artifacts::TOOL_NAME
}

/// The chip target for an MCP call. Its tools are anyone's, so nothing says
/// what each argument means; a few names mean the same nearly everywhere (a
/// query, a url, an issue key), and failing those the first short line of text
/// will do. Tools that take code (Cloudflare's `execute` and `search`) are
/// labelled by the request the code makes.
fn mcp_target(input: &Value) -> Option<String> {
    const KEYS: &[&str] = &[
        "query", "q", "url", "issueIdOrKey", "issueKey", "key", "jql", "cql", "title",
        "name", "subject", "path", "file_path", "pageId", "id", "prompt",
    ];
    let obj = input.as_object()?;
    let short = |v: &Value| -> Option<String> {
        let s = match v {
            Value::String(s) => s.trim().to_string(),
            Value::Number(n) => n.to_string(),
            _ => return None,
        };
        (!s.is_empty() && !s.contains('\n') && s.chars().count() <= 120).then_some(s)
    };
    if let Some(s) = KEYS.iter().find_map(|k| obj.get(*k).and_then(short)) {
        return Some(take_chars(&s, 40));
    }
    if let Some(t) = obj.get("code").and_then(|v| v.as_str()).and_then(code_target) {
        return Some(take_chars(&t, 48));
    }
    obj.values().find_map(short).map(|s| take_chars(&s, 40))
}

/// What a piece of API-calling code does, in a line: the first request it makes
/// (`method: "GET", path: "/zones/…"`), else the first spec path it looks up
/// (`spec.paths['/accounts/…']`), else its first comment. `${…}` holes read `…`.
fn code_target(code: &str) -> Option<String> {
    if let Some(path) = code_field(code, "path") {
        let path = fill_holes(&path);
        return Some(match code_field(code, "method") {
            Some(m) => format!("{} {path}", m.to_uppercase()),
            None => path,
        });
    }
    if let Some(i) = code.find("paths[") {
        if let Some(p) = quoted_at(&code[i + "paths[".len()..]) {
            return Some(fill_holes(&p));
        }
    }
    code.lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("//").map(str::trim).filter(|c| !c.is_empty()))
        .map(str::to_string)
}

/// The quoted value of `key: "…"` in code, where `key` stands alone (so `path`
/// doesn't match inside `file_path`).
fn code_field(code: &str, key: &str) -> Option<String> {
    code.match_indices(key).find_map(|(i, _)| {
        let before = code[..i].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$') {
            return None;
        }
        let rest = code[i + key.len()..].trim_start().strip_prefix(':')?;
        quoted_at(rest)
    })
}

/// The string literal that `s` opens with (after any spaces), if it opens with one.
fn quoted_at(s: &str) -> Option<String> {
    let s = s.trim_start();
    let q = s.chars().next().filter(|c| matches!(c, '"' | '\'' | '`'))?;
    let body = &s[1..];
    body.find(q).map(|end| body[..end].to_string()).filter(|v| !v.is_empty())
}

/// `/accounts/${accountId}/workers` → `/accounts/…/workers`.
fn fill_holes(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        match rest[i..].find('}') {
            Some(j) => {
                out.push('…');
                rest = &rest[i + j + 1..];
            }
            None => {
                rest = &rest[i..];
                break;
            }
        }
    }
    out.push_str(rest);
    out
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
        // An MCP call's arguments, as `[name, value]` pairs: its chip lists them,
        // since nothing else says what the call was asked to do.
        _ if is_mcp_tool(name) => {
            let args: Vec<Value> = input
                .as_object()?
                .iter()
                .map(|(k, v)| {
                    let text = match v {
                        Value::String(s) => s.clone(),
                        other => serde_json::to_string_pretty(other).unwrap_or_default(),
                    };
                    json!([k, cap_text(&text, CAP)])
                })
                .collect();
            (!args.is_empty()).then(|| vec![("args", json!(args))])
        }
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

    #[test]
    fn an_mcp_chip_says_what_the_call_is_about() {
        let target = |name: &str, input: Value| tool_detail(name, &input).1;
        // A well-known argument wins over whatever else is there.
        assert_eq!(target("mcp__cloudflare-api__docs", json!({ "query": "email sending" })).as_deref(), Some("email sending"));
        assert_eq!(
            target("mcp__claude_ai_Atlassian_MCP__getJiraIssue", json!({ "cloudId": "abc-123", "issueIdOrKey": "AVATARS-44" })).as_deref(),
            Some("AVATARS-44")
        );
        // Code: the request it makes, holes filled in.
        let code = "async () => {\n  const r = await cloudflare.request({ method: 'get', path: `/accounts/${accountId}/workers/scripts` });\n  return r;\n}";
        assert_eq!(target("mcp__cloudflare-api__execute", json!({ "code": code })).as_deref(), Some("GET /accounts/…/workers/scripts"));
        // …or the spec path it looks up, or its first comment.
        let code = "async () => spec.paths['/accounts/{account_id}/email/sending']?.post";
        assert_eq!(target("mcp__cloudflare-api__search", json!({ "code": code })).as_deref(), Some("/accounts/{account_id}/email/sending"));
        let code = "async () => {\n  // find the email endpoints\n  return Object.keys(spec.x);\n}";
        assert_eq!(target("mcp__cloudflare-api__search", json!({ "code": code })).as_deref(), Some("find the email endpoints"));
        // `file_path:` is not `path:`.
        assert_eq!(code_field("{ file_path: 'a' }", "path"), None);
        // Nothing short to say: no target, and nothing made up.
        assert_eq!(target("mcp__cloudflare-api__whoami", json!({})), None);
        assert_eq!(target("mcp__x__y", json!({ "body": "line one\nline two" })), None);
        // Some other short text, failing the known names.
        assert_eq!(target("mcp__x__y", json!({ "channel": "general" })).as_deref(), Some("general"));
        // The artifact tool keeps its own card.
        assert!(!is_mcp_tool(artifacts::TOOL_NAME));
    }

    #[test]
    fn an_mcp_chip_carries_its_arguments() {
        let rich = tool_change("mcp__x__y", &json!({ "query": "hi", "limit": 5 })).unwrap();
        assert_eq!(rich[0].0, "args");
        assert_eq!(rich[0].1, json!([["limit", "5"], ["query", "hi"]]));
        assert!(tool_change("mcp__x__y", &json!({})).is_none());
        assert!(tool_change(artifacts::TOOL_NAME, &json!({ "id": "a", "content": "big" })).is_none());
    }
}
