//! Artifacts — the standalone, self-contained things Claude makes for you.
//!
//! On claude.ai an "artifact" is a document, page or diagram that appears in a
//! panel beside the conversation instead of as a wall of code inside it. That is
//! not something the `claude` binary does on its own: the Artifact tool is
//! provided by whatever application is *hosting* Claude Code. A terminal session
//! has no host, so it has no such tool and writes a file instead.
//!
//! Krystal is a host. So it hands the session an artifact tool of its own, over
//! MCP (`--mcp-config`), and the tool shows up in the session's toolset as
//! `mcp__krystal__artifact` exactly like the real thing.
//!
//! Two processes are involved and it's worth being clear about which does what:
//!
//! * **The MCP server** is this same executable, re-launched with `MCP_FLAG` and
//!   speaking JSON-RPC over stdin/stdout. `claude` starts it, not Krystal. It is
//!   the only thing that applies an `update` (an `old_str`/`new_str` patch), and
//!   it writes the resolved artifact to disk under `KRYSTAL_ARTIFACT_DIR`.
//! * **Krystal** never talks to that process. It doesn't need to: the tool call
//!   arrives in the stream-json event feed it already parses (see `claude.rs`),
//!   and the resolved content is on disk by the time the tool's result comes
//!   back. So there is exactly one implementation of the patch logic, and no IPC
//!   bridge to a grandchild process.
//!
//! The artifact's content deliberately never travels back through the tool's
//! *result* — that would push the whole document into Claude's context a second
//! time on every revision. The result is a one-line acknowledgement.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// argv switch that turns this executable into the artifact MCP server.
pub const MCP_FLAG: &str = "--krystal-mcp-artifacts";

/// Env var naming the folder the server writes resolved artifacts into. Set per
/// project in the generated MCP config, so each project keeps its own.
pub const DIR_ENV: &str = "KRYSTAL_ARTIFACT_DIR";

/// The tool's name once the CLI has namespaced it. MCP tools are exposed as
/// `mcp__<server>__<tool>`, so this is what the tool_use events carry.
pub const TOOL_NAME: &str = "mcp__krystal__artifact";

/// Largest artifact we'll accept, so a runaway generation can't fill the disk.
const MAX_BYTES: usize = 4 * 1024 * 1024;

/* ------------------------------ media types ------------------------------ */

/// The artifact kinds Krystal can render. Kept small on purpose: every one of
/// these has a real viewer on the frontend, and a kind we can't show is worse
/// than no artifact at all.
pub const KINDS: &[(&str, &str)] = &[
    ("text/html", "html"),
    ("image/svg+xml", "svg"),
    ("text/markdown", "md"),
    // Mermaid is stored as its SOURCE, because that is what Claude wrote and
    // what an `update` patches. The user never sees the source: Krystal renders
    // it to SVG for the panel, and saves/opens that SVG — so a diagram you send
    // to someone is a few KB that opens anywhere, not a renderer in a trench
    // coat. See `renderMermaid` in src/app/artifacts.js.
    ("application/vnd.ant.mermaid", "mmd"),
];

pub fn ext_for(kind: &str) -> &'static str {
    KINDS.iter().find(|(k, _)| *k == kind).map(|(_, e)| *e).unwrap_or("txt")
}

/// Filesystem-safe form of Claude's chosen artifact id.
pub fn safe_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').replace("--", "-");
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "artifact".into()
    } else {
        s.chars().take(64).collect()
    }
}

/* ------------------------------ tool schema ------------------------------ */

fn tool_def() -> Value {
    json!({
        "name": "artifact",
        "description": concat!(
            "Create or revise an artifact — a self-contained document the user views in a ",
            "panel beside the conversation instead of as a code block inside it. Reach for ",
            "this whenever what you are producing is a THING rather than an explanation: a ",
            "web page, an interactive widget, a diagram, a chart, a poster, a formatted ",
            "report, a game — anything the user would want to look at, keep, or send to ",
            "someone else.\n\n",
            "The artifact must be COMPLETELY self-contained. For text/html that means all ",
            "CSS in a <style> tag and all JavaScript in a <script> tag, in one file, with ",
            "no external requests of any kind — no CDN links, no web fonts, no remote ",
            "images. The user can save the artifact and open it on a machine with no ",
            "internet, or send it to someone else, and it must still work.\n\n",
            "Use `create` for a new artifact, `update` to patch part of an existing one ",
            "(cheapest for small revisions — `old_str` must appear exactly once), and ",
            "`rewrite` to replace one wholesale after a big change. Reuse the same `id` to ",
            "revise an artifact rather than making a near-duplicate; the user gets version ",
            "history for free that way.\n\n",
            "For a diagram whose LAYOUT matters — a flowchart, a sequence diagram, a ",
            "state machine, an org chart — use application/vnd.ant.mermaid and write ",
            "mermaid source; it is laid out for you, and the user still gets a plain SVG ",
            "they can save and send. Reserve image/svg+xml for drawings you want to place ",
            "by hand.

",
            "Don't paste the artifact's content into your reply as well — the user is ",
            "already looking at it. Just say briefly what you made or changed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "enum": ["create", "update", "rewrite"],
                    "description": "create a new artifact, patch an existing one, or replace it wholesale"
                },
                "id": {
                    "type": "string",
                    "description": "stable slug identifying the artifact, e.g. \"budget-dashboard\". Reuse it to revise."
                },
                "type": {
                    "type": "string",
                    "enum": ["text/html", "image/svg+xml", "text/markdown", "application/vnd.ant.mermaid"],
                    "description": "the artifact's media type (required on create/rewrite)"
                },
                "title": {
                    "type": "string",
                    "description": "short human-readable title shown above the artifact"
                },
                "content": {
                    "type": "string",
                    "description": "the artifact's full content (create and rewrite)"
                },
                "old_str": {
                    "type": "string",
                    "description": "update: the exact text to replace; must occur exactly once"
                },
                "new_str": {
                    "type": "string",
                    "description": "update: what to put in its place"
                }
            },
            "required": ["command", "id"]
        }
    })
}

/* ------------------------------- the store ------------------------------- */

/// Where one artifact's resolved content and metadata live.
fn art_paths(dir: &Path, id: &str, ext: &str) -> (PathBuf, PathBuf) {
    let d = dir.join(safe_id(id));
    (d.join(format!("current.{ext}")), d.join("meta.json"))
}

/// Read back the artifact the server most recently resolved. Krystal calls this
/// when the tool's result arrives, to pick up content it never had to carry
/// through the conversation.
pub fn read_current(dir: &Path, id: &str) -> Option<(String, String, String)> {
    let meta_path = dir.join(safe_id(id)).join("meta.json");
    let meta: Value = serde_json::from_str(&std::fs::read_to_string(meta_path).ok()?).ok()?;
    let kind = meta.get("type").and_then(|v| v.as_str()).unwrap_or("text/markdown").to_string();
    let title = meta.get("title").and_then(|v| v.as_str()).unwrap_or(id).to_string();
    let (content_path, _) = art_paths(dir, id, ext_for(&kind));
    let content = std::fs::read_to_string(content_path).ok()?;
    Some((content, title, kind))
}

/* ------------------------------ mcp config ------------------------------- */

/// Write (and return) the `--mcp-config` file for one project.
///
/// The path is stable per project because it is part of the session key: a
/// config file whose name changed from turn to turn would retire the warm
/// `claude` process on every single message (see `session.rs`). The file is only
/// rewritten when its contents actually change, for the same reason.
pub fn ensure_mcp_config(data_dir: &Path, project_key: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let store = store_dir(data_dir, project_key);
    std::fs::create_dir_all(&store).ok()?;

    let cfg_dir = data_dir.join("mcp");
    std::fs::create_dir_all(&cfg_dir).ok()?;
    let cfg_path = cfg_dir.join(format!("{project_key}.json"));

    let cfg = json!({
        "mcpServers": {
            "krystal": {
                "command": exe.to_string_lossy(),
                "args": [MCP_FLAG],
                "env": { DIR_ENV: store.to_string_lossy() }
            }
        }
    });
    let text = serde_json::to_string_pretty(&cfg).ok()?;
    if std::fs::read_to_string(&cfg_path).map(|old| old != text).unwrap_or(true) {
        std::fs::write(&cfg_path, &text).ok()?;
    }
    Some(cfg_path)
}

/// The artifact store folder for a project — where `read_current` looks.
pub fn store_dir(data_dir: &Path, project_key: &str) -> PathBuf {
    data_dir.join("artifacts").join(project_key)
}

/* ---------------------------- the MCP server ----------------------------- */

/// Serve MCP on stdin/stdout until the parent closes the pipe. Never returns —
/// this is the whole job of the process when it's launched with `MCP_FLAG`.
pub fn run_stdio_server() -> ! {
    let dir = std::env::var(DIR_ENV).map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    std::fs::create_dir_all(&dir).ok();

    // Content of each artifact this session has touched, so an `update` doesn't
    // have to go back to disk. Disk is still the fallback: after a Krystal
    // restart the conversation can be resumed (`--resume`) with Claude still
    // remembering an artifact this process has never seen.
    let mut memory: HashMap<String, String> = HashMap::new();

    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");

        let result = match method {
            "initialize" => Some(json!({
                // Echo the client's protocol version when it names one: the
                // revisions differ only in ways a single tool doesn't touch.
                "protocolVersion": msg.get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("2024-11-05"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "krystal", "version": env!("CARGO_PKG_VERSION") }
            })),
            "tools/list" => Some(json!({ "tools": [tool_def()] })),
            "resources/list" => Some(json!({ "resources": [] })),
            "prompts/list" => Some(json!({ "prompts": [] })),
            "tools/call" => {
                let params = msg.get("params");
                let name = params.and_then(|p| p.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                let args = params
                    .and_then(|p| p.get("arguments"))
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if name != "artifact" {
                    Some(json!({
                        "content": [{ "type": "text", "text": format!("unknown tool: {name}") }],
                        "isError": true
                    }))
                } else {
                    // A refused call comes back as a tool error, not a dead
                    // session: Claude reads the reason and can try again.
                    Some(match apply(&dir, &mut memory, &args) {
                        Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                        Err(e) => json!({
                            "content": [{ "type": "text", "text": format!("artifact not saved: {e}") }],
                            "isError": true
                        }),
                    })
                }
            }
            // A notification carries no id and wants no reply.
            _ if id.is_none() => None,
            _ => {
                let _ = writeln!(
                    out,
                    "{}",
                    json!({ "jsonrpc": "2.0", "id": id,
                            "error": { "code": -32601, "message": format!("no such method: {method}") } })
                );
                let _ = out.flush();
                continue;
            }
        };

        if let (Some(id), Some(result)) = (id, result) {
            let _ = writeln!(out, "{}", json!({ "jsonrpc": "2.0", "id": id, "result": result }));
            let _ = out.flush();
        }
    }
    std::process::exit(0);
}

/// Resolve one tool call into the artifact's new full content and write it out.
/// Returns the acknowledgement Claude sees — short by design (see module docs).
fn apply(dir: &Path, memory: &mut HashMap<String, String>, args: &Value) -> Result<String, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str());
    let art_id = s("id").unwrap_or("").trim();
    if art_id.is_empty() {
        return Err("every artifact needs an id".into());
    }
    let command = s("command").unwrap_or("create");
    let key = safe_id(art_id);
    let stored = read_current(dir, art_id);

    // The kind is fixed at creation; an update inherits whatever the artifact
    // already is rather than having to restate it.
    let kind = s("type")
        .map(|k| k.to_string())
        .or_else(|| stored.as_ref().map(|(_, _, k)| k.clone()))
        .unwrap_or_else(|| "text/markdown".into());
    if !KINDS.iter().any(|(k, _)| *k == kind) {
        return Err(format!("{kind} isn't an artifact type Krystal can show"));
    }

    let content = match command {
        "update" => {
            let old = s("old_str").ok_or("an update needs old_str")?;
            let new = s("new_str").unwrap_or("");
            let prev = memory
                .get(&key)
                .cloned()
                .or_else(|| stored.as_ref().map(|(c, _, _)| c.clone()))
                .ok_or_else(|| format!("there is no artifact \"{art_id}\" to update yet"))?;
            match prev.matches(old).count() {
                0 => return Err("old_str doesn't appear in the artifact".into()),
                1 => prev.replacen(old, new, 1),
                n => {
                    return Err(format!(
                        "old_str appears {n} times — include enough context to make it unique"
                    ))
                }
            }
        }
        _ => s("content").ok_or("a create or rewrite needs content")?.to_string(),
    };

    if content.len() > MAX_BYTES {
        return Err(format!(
            "artifact is too large ({} KB); keep it under {} KB",
            content.len() / 1024,
            MAX_BYTES / 1024
        ));
    }

    let title = s("title")
        .map(|t| t.to_string())
        .or_else(|| stored.as_ref().map(|(_, t, _)| t.clone()))
        .unwrap_or_else(|| art_id.to_string());

    let (content_path, meta_path) = art_paths(dir, art_id, ext_for(&kind));
    if let Some(parent) = content_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&content_path, &content).map_err(|e| e.to_string())?;
    std::fs::write(
        &meta_path,
        serde_json::to_string_pretty(&json!({ "id": art_id, "title": title, "type": kind }))
            .unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    memory.insert(key, content);

    Ok(format!(
        "\"{title}\" is showing in the user's artifact panel. They can see it — don't repeat its content in your reply."
    ))
}

/* --------------------------------- tests --------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("krystal-art-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn create_then_update_patches_the_previous_content() {
        let dir = tmp("update");
        let mut mem = HashMap::new();
        apply(
            &dir,
            &mut mem,
            &json!({ "command": "create", "id": "page", "type": "text/html",
                     "title": "Page", "content": "<h1>hello</h1>" }),
        )
        .expect("create");

        apply(
            &dir,
            &mut mem,
            &json!({ "command": "update", "id": "page", "old_str": "hello", "new_str": "goodbye" }),
        )
        .expect("update");

        let (content, title, kind) = read_current(&dir, "page").expect("stored");
        assert_eq!(content, "<h1>goodbye</h1>");
        assert_eq!(title, "Page", "an update keeps the existing title");
        assert_eq!(kind, "text/html", "an update keeps the existing type");
    }

    #[test]
    fn an_update_can_resume_from_disk_with_a_cold_server() {
        let dir = tmp("cold");
        apply(
            &dir,
            &mut HashMap::new(),
            &json!({ "command": "create", "id": "doc", "type": "text/markdown", "content": "# one" }),
        )
        .expect("create");
        // A brand-new process (empty memory) — as after a Krystal restart with
        // the conversation resumed.
        apply(
            &dir,
            &mut HashMap::new(),
            &json!({ "command": "update", "id": "doc", "old_str": "one", "new_str": "two" }),
        )
        .expect("update from disk");
        assert_eq!(read_current(&dir, "doc").unwrap().0, "# two");
    }

    #[test]
    fn an_ambiguous_or_missing_patch_is_refused() {
        let dir = tmp("ambiguous");
        let mut mem = HashMap::new();
        apply(
            &dir,
            &mut mem,
            &json!({ "command": "create", "id": "a", "type": "text/markdown", "content": "x x" }),
        )
        .unwrap();
        assert!(apply(
            &dir,
            &mut mem,
            &json!({ "command": "update", "id": "a", "old_str": "x", "new_str": "y" })
        )
        .unwrap_err()
        .contains("appears 2 times"));
        assert!(apply(
            &dir,
            &mut mem,
            &json!({ "command": "update", "id": "a", "old_str": "zzz", "new_str": "y" })
        )
        .unwrap_err()
        .contains("doesn't appear"));
        assert_eq!(
            read_current(&dir, "a").unwrap().0,
            "x x",
            "a refused patch changes nothing"
        );
    }

    #[test]
    fn mermaid_is_stored_as_its_source_so_patches_still_apply() {
        let dir = tmp("mermaid");
        let mut mem = HashMap::new();
        apply(
            &dir,
            &mut mem,
            &json!({ "command": "create", "id": "flow", "type": "application/vnd.ant.mermaid",
                     "title": "Flow", "content": "graph TD
  A-->B" }),
        )
        .expect("create");
        apply(
            &dir,
            &mut mem,
            &json!({ "command": "update", "id": "flow", "old_str": "A-->B", "new_str": "A-->C" }),
        )
        .expect("patch the source, not a rendering of it");
        let (content, _, kind) = read_current(&dir, "flow").unwrap();
        assert_eq!(content, "graph TD
  A-->C");
        assert_eq!(kind, "application/vnd.ant.mermaid");
        assert_eq!(ext_for(&kind), "mmd");
    }

    #[test]
    fn an_unknown_kind_is_refused_rather_than_stored_unrenderable() {
        let dir = tmp("kind");
        assert!(apply(
            &dir,
            &mut HashMap::new(),
            &json!({ "command": "create", "id": "x", "type": "application/pdf", "content": "%PDF" })
        )
        .is_err());
    }

    #[test]
    fn ids_are_made_filesystem_safe_without_collapsing_to_nothing() {
        assert_eq!(safe_id("budget-dashboard"), "budget-dashboard");
        assert_eq!(safe_id("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_id("///"), "artifact");
    }
}
