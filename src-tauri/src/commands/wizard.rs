//! The Initialize wizard (analyze, questions, draft, save) and the CLAUDE.md
//! editor.

use super::*;

// The analyze prompt is built per-run so we can fold in the user's short
// description of the project (the "brief"), entered before any exploration.
// It is deliberately domain-agnostic: the project could be writing, research,
// code, data, design, admin — anything. Claude infers the type and language
// from the folder and the brief rather than us assuming them.
fn analyze_prompt(brief: &str, ui_lang: &str) -> String {
    let fallback_lang = claude::lang_label(ui_lang);
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
- Detect the project's main language from the documents and the description, and write every question and option in THAT language. If it is genuinely unclear, use {fallback_lang}.
- Do NOT assume the project type — adapt the questions to whatever you actually find.
- Ask 6 to 9 DEEP, project-SPECIFIC questions whose answers would make the CLAUDE.md genuinely useful. Pick whichever of these fit THIS project: the precise goal/scope, the kind of end result and its audience, the language Claude should reply in, the tone/voice, conventions to follow (citation style, code style, formatting…), how sources/inputs/files should be handled, key terminology or names to keep consistent, the current status and next steps, and any do/don't rules. Tailor them to what you actually saw — reference real files where useful.
- Give each question 3-5 realistic premade options grounded in what you found, and set "allowCustom": true so the user can type their own.
- Use "multi": true only for questions where several answers can sensibly apply together.
- Write neutrally: do not assume anything about the person (gender, profession, technical level) beyond what the folder and description actually show.
- If a CLAUDE.md already exists, take it into account and aim to improve it.
Return ONLY the JSON object."#
    )
}

fn draft_prompt(findings: &str, answers: &[Value], brief: &str, ui_lang: &str) -> String {
    let fallback_lang = claude::lang_label(ui_lang);
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
- Write it in the project's main language (match the documents and answers; if that is genuinely unclear, use {fallback_lang}). If it is Croatian, keep č/ć/ž/š/đ in UTF-8.
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
        let conn = state.db();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let sys = state.sys_prompt();
    let schema = json!({
        "type": "object",
        "properties": {
            "title":     { "type": "string" },
            "summary":   { "type": "string" },
            "questions": question_schema()
        },
        "required": ["summary", "questions"]
    });
    let args = with_json_schema(&claude::base_args(&meta.model, &sys), schema);
    let prompt = analyze_prompt(brief.as_deref().unwrap_or(""), &state.ui_lang());
    let (text, _usage) = claude::run_claude_text(&state.claude_bin(), &args, &meta.cwd, &prompt).await?;

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
        let conn = state.db();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let sys = state.sys_prompt();
    let args = claude::base_args(&meta.model, &sys);
    let prompt = draft_prompt(summary.as_deref().unwrap_or(""), &answers, brief.as_deref().unwrap_or(""), &state.ui_lang());
    let (text, _usage) = claude::run_claude_text(&state.claude_bin(), &args, &meta.cwd, &prompt).await?;

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
        let conn = state.db();
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
        let conn = state.db();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let target = std::path::Path::new(&meta.cwd).join("CLAUDE.md");
    let markdown = std::fs::read_to_string(&target).unwrap_or_default();
    let body = markdown.strip_prefix('\u{feff}').unwrap_or(&markdown);
    Ok(json!({ "markdown": body.replace("\r\n", "\n"), "exists": target.exists() }))
}
