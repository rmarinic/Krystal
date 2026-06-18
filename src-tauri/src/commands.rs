//! Tauri command handlers — the IPC surface the frontend talks to.
//! Each command maps 1:1 to an endpoint in the original server.js router.

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::claude::{self, Caps};
use crate::db;
use crate::models;

/// Shared app state managed by Tauri.
pub struct AppState {
    pub db: std::sync::Mutex<rusqlite::Connection>,
    pub caps: Caps,
    pub claude_bin: String,
}

impl AppState {
    fn sys_prompt(&self) -> String {
        claude::capability_prompt(self.caps)
    }
}

type CmdResult = Result<Value, String>;

/* ------------------------------- config ---------------------------------- */

#[tauri::command]
pub fn get_config() -> Value {
    json!({ "models": models::MODELS, "modes": models::MODES })
}

/* ------------------------------- threads --------------------------------- */

#[tauri::command]
pub fn list_threads(state: State<'_, AppState>, project: Option<String>) -> Value {
    let conn = state.db.lock().unwrap();
    json!({ "threads": db::list_threads(&conn, project.as_deref()) })
}

#[tauri::command]
pub fn get_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    let conn = state.db.lock().unwrap();
    db::get_thread(&conn, &id).ok_or_else(|| "not found".into())
}

#[tauri::command]
pub fn create_thread(state: State<'_, AppState>, cwd: String) -> CmdResult {
    if cwd.is_empty() {
        return Err("cwd required".into());
    }
    let conn = state.db.lock().unwrap();
    let thread = db::create(&conn, &cwd).ok_or("could not create thread")?;
    db::touch_project(&conn, &cwd); // keep the project list ordered by recent use
    Ok(thread)
}

/* ------------------------------- projects -------------------------------- */

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Value {
    let conn = state.db.lock().unwrap();
    json!({ "projects": db::list_projects(&conn) })
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, path: String) -> CmdResult {
    if path.trim().is_empty() {
        return Err("path required".into());
    }
    let conn = state.db.lock().unwrap();
    db::create_project(&conn, &path).ok_or_else(|| "could not create project".into())
}

#[tauri::command]
pub fn select_project(state: State<'_, AppState>, id: String) -> CmdResult {
    let conn = state.db.lock().unwrap();
    db::select_project(&conn, &id).ok_or_else(|| "not found".into())
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> Value {
    let conn = state.db.lock().unwrap();
    db::delete_project(&conn, &id);
    json!({ "ok": true })
}

#[tauri::command]
pub fn delete_thread(state: State<'_, AppState>, id: String) -> Value {
    let conn = state.db.lock().unwrap();
    db::remove(&conn, &id);
    json!({ "ok": true })
}

#[tauri::command]
pub fn set_model(state: State<'_, AppState>, id: String, model: String) -> CmdResult {
    if !models::is_valid_model(&model) {
        return Err("unknown model".into());
    }
    let conn = state.db.lock().unwrap();
    db::set_model(&conn, &id, &model);
    Ok(json!({ "model": model }))
}

#[tauri::command]
pub fn set_mode(state: State<'_, AppState>, id: String, mode: String) -> CmdResult {
    if !models::is_valid_mode(&mode) {
        return Err("unknown mode".into());
    }
    let conn = state.db.lock().unwrap();
    db::set_mode(&conn, &id, &mode);
    Ok(json!({ "mode": mode }))
}

#[tauri::command]
pub fn clear_thread(state: State<'_, AppState>, id: String) -> Value {
    let conn = state.db.lock().unwrap();
    db::clear(&conn, &id);
    json!({ "ok": true })
}

/* ------------------------------ search/fav ------------------------------- */

#[tauri::command]
pub fn search_messages(state: State<'_, AppState>, q: String, project: Option<String>) -> Value {
    let q = q.trim();
    let conn = state.db.lock().unwrap();
    let results = if q.is_empty() { vec![] } else { db::search(&conn, q, project.as_deref()) };
    json!({ "results": results })
}

#[tauri::command]
pub fn list_favorites(state: State<'_, AppState>, project: Option<String>) -> Value {
    let conn = state.db.lock().unwrap();
    json!({ "favorites": db::list_favorites(&conn, project.as_deref()) })
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, AppState>, message_id: i64) -> CmdResult {
    let conn = state.db.lock().unwrap();
    db::toggle_favorite(&conn, message_id).ok_or_else(|| "not found".into())
}

/* -------------------------------- chat ----------------------------------- */

#[tauri::command]
pub async fn chat(
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
    files: Option<Vec<String>>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let files = files.unwrap_or_default();

    // Snapshot the thread (owned) so we hold no DB lock across the stream.
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &thread_id)
    }
    .ok_or("unknown thread")?;

    let sys = state.sys_prompt();
    let mut args = claude::base_args(&meta.model, &sys);
    claude::apply_mode(&mut args, &meta.mode);   // Auto = full power; Plan = research only
    if let Some(sid) = &meta.session_id {
        args.push("--resume".into());
        args.push(sid.clone());
    }

    let seed = meta.seed.clone();
    let prompt = claude::build_prompt(&text, &files, seed.as_deref());
    // A one-time compact seed is folded into this prompt, then cleared.
    if seed.is_some() {
        let conn = state.db.lock().unwrap();
        db::set_seed(&conn, &thread_id, None);
    }

    // First-turn auto-naming: kick off a cheap Haiku call to title the chat from
    // the user's opening message, running it alongside the main stream so it adds
    // no perceptible latency. A thread still on its default title needs a name.
    let needs_title = match &meta.title {
        None => true,
        Some(s) => s.trim().is_empty() || s == "New chat",
    };
    let title_task = if needs_title {
        let bin = state.claude_bin.clone();
        let cwd = meta.cwd.clone();
        let opening = text.clone();
        Some(tokio::spawn(async move {
            claude::generate_title(&bin, &cwd, &opening).await
        }))
    } else {
        None
    };

    let res = claude::run_chat_stream(&state.claude_bin, &args, &meta.cwd, &prompt, &on_event).await?;

    // Match server.js: on a hard error with no text, the error event was already
    // emitted — don't record an empty turn.
    if res.final_text.is_empty() && res.is_error {
        return Ok(());
    }

    let session_id = res.session_id.clone().or_else(|| meta.session_id.clone());
    let (usage, fallback_title, assistant_id, updated_at) = {
        let conn = state.db.lock().unwrap();
        db::record_turn(
            &conn,
            &thread_id,
            &text,
            &files,
            &res.final_text,
            &res.segments,
            session_id.as_deref(),
            &res.usage,
            res.cost_usd,
        )
    };

    // Prefer the auto-generated title (already in flight); fall back to the
    // truncated first message that record_turn stored if naming didn't pan out.
    let mut title = fallback_title;
    if let Some(task) = title_task {
        if let Ok(Some(named)) = task.await {
            {
                let conn = state.db.lock().unwrap();
                db::set_title(&conn, &thread_id, &named);
            }
            title = named;
        }
    }

    let _ = on_event.send(json!({
        "type": "done",
        "sessionId": session_id,
        "text": res.final_text,
        "title": title,
        "updatedAt": updated_at,
        "usage": usage,
        "assistantId": assistant_id,
    }));
    Ok(())
}

/* --------------------- per-thread actions (compact/hint) ----------------- */

const COMPACT_PROMPT: &str = "Summarize our entire conversation so far into a tight but complete brief I can use to keep working with no loss of important context. Include: key facts, decisions made, current state of the work, open questions, and next steps. Use short bullet points. Do not greet or add commentary — just the brief.";

#[tauri::command]
pub async fn compact_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let session_id = meta.session_id.clone().ok_or("nothing to compact yet")?;
    let sys = state.sys_prompt();
    let mut args = claude::base_args(&meta.model, &sys);
    args.push("--resume".into());
    args.push(session_id);

    let (text, _usage) = claude::run_claude_text(&state.claude_bin, &args, &meta.cwd, COMPACT_PROMPT).await?;
    {
        let conn = state.db.lock().unwrap();
        db::compact(&conn, &id, &text);
    }
    Ok(json!({ "ok": true, "summary": text }))
}

const HINT_PROMPT: &str = "You are a warm, plain-spoken usage coach for a NON-TECHNICAL person using a Claude chat app. Below is their recent conversation. If — and only if — you notice a SPECIFIC, concrete way they could get better results (e.g. giving a detail or file Claude clearly needed, being clearer about the goal, or splitting a big request), reply with ONE short friendly tip of 1–2 sentences, no jargon. If they are already communicating well, reply with exactly: ALL_GOOD. Never invent problems or nitpick.\n\n--- conversation ---\n";

#[tauri::command]
pub async fn hint_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let recent = {
        let conn = state.db.lock().unwrap();
        db::recent_messages(&conn, &id, 8)
    };
    let joined = recent
        .iter()
        .map(|(role, text)| {
            let who = if role == "user" { "User" } else { "Claude" };
            format!("{who}: {text}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    if joined.trim().is_empty() {
        return Ok(json!({ "tip": "", "allGood": true }));
    }

    let sys = state.sys_prompt();
    let args = claude::base_args(&meta.model, &sys); // fresh session — won't pollute the chat
    let prompt = format!("{HINT_PROMPT}{joined}");
    let (text, _usage) = claude::run_claude_text(&state.claude_bin, &args, &meta.cwd, &prompt).await?;

    let all_good = text.to_uppercase().contains("ALL_GOOD") || text.trim().is_empty();
    Ok(json!({
        "tip": if all_good { String::new() } else { text.trim().to_string() },
        "allGood": all_good,
    }))
}

/* --------------------------- Initialize wizard --------------------------- */

// The analyze prompt is built per-run so we can fold in the user's short
// description of the project (the "brief"), entered before any exploration.
// It is deliberately domain-agnostic: the project could be writing, research,
// code, data, design, admin — anything. Claude infers the type and language
// from the folder and the brief rather than us assuming them.
fn analyze_prompt(brief: &str) -> String {
    let intro = if brief.trim().is_empty() {
        String::new()
    } else {
        format!(
            "The person who works here described the project in their own words:\n\"\"\"\n{}\n\"\"\"\nUse this as your starting point, but verify and enrich it against what is actually in the folder.\n\n",
            brief.trim()
        )
    };
    format!(
        r#"You are setting up a project memory file (CLAUDE.md) for whoever works in this folder. CLAUDE.md is loaded automatically at the start of every future chat here, so it should capture whatever a helper needs to be useful from the first message.

{intro}First, EXPLORE this folder thoroughly with your tools: list files, read the most informative ones, and notice what KIND of project this is (writing, research, code, data, design, admin, mixed…), the language(s) used, the apparent goal, what already exists, and what is still missing. Do not change any files.

Then return a SINGLE JSON object (no prose, no code fence) shaped exactly like:
{{
  "title": "<short project title you inferred>",
  "summary": "<2-4 sentence plain-language description of what you found: type of project, languages, file types, how far along the work is>",
  "questions": [
    {{
      "id": "<short-kebab-id>",
      "question": "<one clear question>",
      "why": "<short reason this matters for the project>",
      "multi": false,
      "options": ["<premade answer 1>", "<premade answer 2>", "<premade answer 3>"],
      "allowCustom": true
    }}
  ]
}}

Rules:
- Detect the project's main language from the documents and the description, and write every question and option in THAT language. If it is genuinely unclear, default to Croatian.
- Do NOT assume the project type — adapt the questions to whatever you actually find.
- Ask 6 to 9 DEEP, project-SPECIFIC questions whose answers would make the CLAUDE.md genuinely useful. Pick whichever of these fit THIS project: the precise goal/scope, the kind of end result and its audience, the language Claude should reply in, the tone/voice, conventions to follow (citation style, code style, formatting…), how sources/inputs/files should be handled, key terminology or names to keep consistent, the current status and next steps, and any do/don't rules. Tailor them to what you actually saw — reference real files where useful.
- Give each question 3-5 realistic premade options grounded in what you found, and set "allowCustom": true so the user can type their own.
- Use "multi": true only for questions where several answers can sensibly apply together.
- Write neutrally: do not assume anything about the person (gender, profession, technical level) beyond what the folder and description actually show.
- If a CLAUDE.md already exists, take it into account and aim to improve it.
Return ONLY the JSON object."#
    )
}

fn draft_prompt(findings: &str, answers: &[Value], brief: &str) -> String {
    let qa = answers
        .iter()
        .map(|a| {
            let q = a.get("question").and_then(|v| v.as_str()).unwrap_or("");
            let ans = match a.get("answer") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join("; "),
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            format!("Q: {q}\nA: {ans}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let findings = if findings.trim().is_empty() { "(no summary)" } else { findings };
    let brief_block = if brief.trim().is_empty() {
        String::new()
    } else {
        format!("How the project was described:\n\"\"\"\n{}\n\"\"\"\n\n", brief.trim())
    };

    format!(
        r###"Write a CLAUDE.md project-memory file for whoever works in this folder, based on what you found and the answers below.

{brief_block}What you found earlier:
{findings}

Answers:
{qa}

Produce the CLAUDE.md CONTENT ONLY (GitHub-flavoured markdown, no surrounding code fence, no commentary before or after). Make it a practical brief that a helper reads at the start of every future chat in this folder. Guidelines:
- Write it in the project's main language (match the documents and answers; if it is Croatian, keep č/ć/ž/š/đ in UTF-8).
- Lead with a short overview section: what the project is, the kind of end result, and the audience/goal.
- Add focused sections that reflect the answers — only the ones that apply, e.g.: language & style, tone/voice, conventions (citations, code style, formatting), how sources/inputs are handled, structure, current status & next steps, terminology/glossary, and clear "do this / avoid this" rules.
- If Word (.docx) documents are in play, include a short note that Claude can read and write .docx (via pandoc / python-docx) and should preserve formatting.
- Be specific and concise — bullet points over paragraphs. Do not invent facts that were not given; where something is unknown, say it plainly or leave a clear TODO.
- Write neutrally: do not assume the person's gender or profession.
Return ONLY the markdown content."###
    )
}

#[tauri::command]
pub async fn init_analyze(state: State<'_, AppState>, id: String, brief: Option<String>) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let sys = state.sys_prompt();
    let args = claude::base_args(&meta.model, &sys);
    let prompt = analyze_prompt(brief.as_deref().unwrap_or(""));
    let (text, _usage) = claude::run_claude_text(&state.claude_bin, &args, &meta.cwd, &prompt).await?;

    match extract_json(&text) {
        Some(data) if data.get("questions").map(|q| q.is_array()).unwrap_or(false) => Ok(data),
        _ => Ok(json!({ "error": "Could not read the project. Please try again." })),
    }
}

#[tauri::command]
pub async fn init_draft(
    state: State<'_, AppState>,
    id: String,
    summary: Option<String>,
    answers: Vec<Value>,
    brief: Option<String>,
) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let sys = state.sys_prompt();
    let args = claude::base_args(&meta.model, &sys);
    let prompt = draft_prompt(summary.as_deref().unwrap_or(""), &answers, brief.as_deref().unwrap_or(""));
    let (text, _usage) = claude::run_claude_text(&state.claude_bin, &args, &meta.cwd, &prompt).await?;

    let md = strip_md_fence(text.trim());
    if md.trim().is_empty() {
        Ok(json!({ "error": "Draft came back empty. Please try again." }))
    } else {
        Ok(json!({ "markdown": md }))
    }
}

#[tauri::command]
pub fn init_save(state: State<'_, AppState>, id: String, markdown: String) -> CmdResult {
    if markdown.trim().is_empty() {
        return Err("nothing to save".into());
    }
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let target = std::path::Path::new(&meta.cwd).join("CLAUDE.md");
    if target.exists() {
        let _ = std::fs::copy(&target, target.with_file_name("CLAUDE.md.bak"));
    }
    let body = markdown.strip_prefix('\u{feff}').unwrap_or(&markdown);
    let clean = body.replace("\r\n", "\n").replace('\n', "\r\n");
    std::fs::write(&target, clean.as_bytes()).map_err(|e| e.to_string())?;

    Ok(json!({ "ok": true, "path": target.to_string_lossy() }))
}

/// Read the project's current CLAUDE.md so the editor can load it. Missing file
/// is not an error — it just returns empty text (the editor can create it).
#[tauri::command]
pub fn read_claude_md(state: State<'_, AppState>, id: String) -> CmdResult {
    let meta = {
        let conn = state.db.lock().unwrap();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let target = std::path::Path::new(&meta.cwd).join("CLAUDE.md");
    let markdown = std::fs::read_to_string(&target).unwrap_or_default();
    let body = markdown.strip_prefix('\u{feff}').unwrap_or(&markdown);
    Ok(json!({ "markdown": body.replace("\r\n", "\n"), "exists": target.exists() }))
}

/* ------------------------------- helpers --------------------------------- */

/// Strip a leading/trailing ```markdown fence around a draft, if present.
fn strip_md_fence(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // drop an optional language tag on the first line
        let rest = match rest.find('\n') {
            Some(nl) => &rest[nl + 1..],
            None => rest,
        };
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    t.to_string()
}

/// Pull the first balanced JSON object/array out of a model reply (tolerates
/// ```json fences or a stray sentence before/after). Mirrors `extractJson`.
fn extract_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    let s = strip_code_fence(trimmed);
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&c| c == b'{' || c == b'[')?;
    let open = bytes[start];
    let close = if open == b'{' { b'}' } else { b']' };
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return serde_json::from_str(&s[start..=i]).ok();
            }
        }
        i += 1;
    }
    None
}

fn strip_code_fence(s: &str) -> &str {
    if let Some(a) = s.find("```") {
        let after = &s[a + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        let after = after.trim_start();
        if let Some(b) = after.find("```") {
            return after[..b].trim();
        }
    }
    s
}
