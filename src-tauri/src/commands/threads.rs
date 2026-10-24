//! Chats: listing, creating, branching, per-chat settings, search and favourites,
//! and compacting a long conversation.

use super::*;

#[tauri::command]
pub fn list_threads(state: State<'_, AppState>, project: Option<String>) -> Value {
    let conn = state.db();
    json!({ "threads": db::list_threads(&conn, project.as_deref()) })
}

#[tauri::command]
pub fn get_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    // Clone the catalogue out first so we never hold the models lock across the
    // DB work below.
    let catalog = state.models.lock().unwrap().clone();
    let conn = state.db();
    let mut thread = db::get_thread(&conn, &id).ok_or("not found")?;
    // Self-heal a stored model id that has dropped out of the live catalogue, so
    // the picker never shows a dead id and future sends never target a vanished
    // model. Persist the correction so the DB, picker and sends all agree.
    if let Some(stored) = thread.get("model").and_then(|m| m.as_str()).map(str::to_string) {
        let effective = models::effective_id(&catalog, &stored);
        if effective != stored {
            db::set_model(&conn, &id, &effective);
            thread["model"] = Value::String(effective);
        }
    }
    Ok(thread)
}

#[tauri::command]
pub fn create_thread(state: State<'_, AppState>, cwd: String) -> CmdResult {
    if cwd.is_empty() {
        return Err("cwd required".into());
    }
    // Default a new chat to the live catalogue's preferred model (not a hardcoded
    // id), so a fresh chat never opens pointing at a superseded model.
    let default_model = models::default_id(&state.models.lock().unwrap());
    let conn = state.db();
    let thread = db::create(&conn, &cwd, &default_model).ok_or("could not create thread")?;
    db::touch_project(&conn, &cwd); // keep the project list ordered by recent use
    Ok(thread)
}

/// Branch a conversation: fork the given thread into a new one in the same
/// project that starts as an exact copy (settings + transcript) but with its own
/// fresh Claude session and the prior conversation folded into its seed for
/// context. The original is left untouched. Returns the new thread.
#[tauri::command]
pub fn branch_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    let conn = state.db();
    let thread = db::branch(&conn, &id).ok_or("could not branch this chat")?;
    if let Some(cwd) = thread.get("cwd").and_then(|c| c.as_str()) {
        db::touch_project(&conn, cwd); // keep the project list ordered by recent use
    }
    Ok(thread)
}

#[tauri::command]
pub async fn delete_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    state.sessions.retire(&id).await;
    {
        let conn = state.db();
        db::remove(&conn, &id);
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn set_model(state: State<'_, AppState>, id: String, model: String) -> CmdResult {
    if !state.model_known(&model) {
        return Err("unknown model".into());
    }
    let conn = state.db();
    db::set_model(&conn, &id, &model);
    Ok(json!({ "model": model }))
}

#[tauri::command]
pub fn set_mode(state: State<'_, AppState>, id: String, mode: String) -> CmdResult {
    if !models::is_valid_mode(&mode) {
        return Err("unknown mode".into());
    }
    let conn = state.db();
    db::set_mode(&conn, &id, &mode);
    Ok(json!({ "mode": mode }))
}

/// How hard Claude thinks before answering on this thread's turns
/// (`claude --effort`). Persisted per chat, like the model and the mode, so a
/// thread that needs deep reasoning keeps it without re-picking every time.
#[tauri::command]
pub fn set_effort(state: State<'_, AppState>, id: String, effort: String) -> CmdResult {
    if !models::is_valid_effort(&effort) {
        return Err("unknown effort".into());
    }
    let conn = state.db();
    db::set_effort(&conn, &id, &effort);
    Ok(json!({ "effort": effort }))
}

/// Toggle orchestrator mode for a thread and set its worker sub-agent model
/// (`auto` = let the orchestrator choose per task). The thread's own `model`
/// stays the orchestrator model; only chat turns honour this (internal one-off
/// calls always run plainly).
#[tauri::command]
pub fn set_orchestration(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
    sub_model: String,
) -> CmdResult {
    if sub_model != models::SUB_MODEL_AUTO && !state.model_known(&sub_model) {
        return Err("unknown sub-agent model".into());
    }
    let conn = state.db();
    db::set_orchestration(&conn, &id, enabled, &sub_model);
    Ok(json!({ "orch": enabled, "orchSub": sub_model }))
}

#[tauri::command]
pub async fn clear_thread(state: State<'_, AppState>, id: String) -> CmdResult {
    // `db::clear` drops the chat's session id; the warm process still holds the
    // conversation we just threw away, so it goes too. The next message starts
    // a genuinely fresh one.
    state.sessions.retire(&id).await;
    {
        let conn = state.db();
        db::clear(&conn, &id);
    }
    Ok(json!({ "ok": true }))
}

/// Rename a chat. Trims the title and caps its length; an empty title is
/// rejected so a chat never loses its name to a blank.
#[tauri::command]
pub fn rename_thread(state: State<'_, AppState>, id: String, title: String) -> CmdResult {
    let title = title.trim();
    if title.is_empty() {
        return Err("empty title".into());
    }
    let title: String = title.chars().take(120).collect();
    let conn = state.db();
    db::set_title(&conn, &id, &title);
    Ok(json!({ "title": title }))
}

#[tauri::command]
pub fn search_messages(state: State<'_, AppState>, q: String, project: Option<String>) -> Value {
    let q = q.trim();
    let conn = state.db();
    let results = if q.is_empty() { vec![] } else { db::search(&conn, q, project.as_deref()) };
    json!({ "results": results })
}

#[tauri::command]
pub fn list_favorites(state: State<'_, AppState>, project: Option<String>) -> Value {
    let conn = state.db();
    json!({ "favorites": db::list_favorites(&conn, project.as_deref()) })
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, AppState>, message_id: i64) -> CmdResult {
    let conn = state.db();
    db::toggle_favorite(&conn, message_id).ok_or_else(|| "not found".into())
}

/// Drop one message from a thread's saved transcript. Only the app's copy is
/// affected — the resumed `claude` session still remembers it — so the UI frames
/// this as tidying the transcript, not as erasing context.
#[tauri::command]
pub fn delete_message(state: State<'_, AppState>, message_id: i64) -> CmdResult {
    let conn = state.db();
    let thread_id = db::delete_message(&conn, message_id).ok_or("not found")?;
    Ok(json!({ "ok": true, "threadId": thread_id }))
}

const COMPACT_PROMPT: &str = "Summarize our entire conversation so far into a tight but complete brief I can use to keep working with no loss of important context. Include: key facts, decisions made, current state of the work, open questions, and next steps. Use short bullet points. Do not greet or add commentary — just the brief.";

#[tauri::command]
pub async fn compact_thread(
    state: State<'_, AppState>,
    id: String,
    on_event: Channel<Value>,
) -> CmdResult {
    let meta = {
        let conn = state.db();
        db::get_meta(&conn, &id)
    }
    .ok_or("not found")?;

    let session_id = meta.session_id.clone().ok_or("nothing to compact yet")?;
    let sys = state.sys_prompt();
    let mut args = claude::base_args(&meta.model, &sys);
    args.push("--resume".into());
    args.push(session_id);

    // Retire the chat's warm process first: compaction resumes the very session
    // that process is holding open, and afterwards the conversation is replaced by
    // a summary and the session id is dropped — so it must not still be running,
    // and it must not serve another turn.
    state.sessions.retire(&id).await;

    // The summary's progress goes to the overlay as it is written, so the wait
    // moves with the work (controls.js `doCompact`).
    let (text, _usage) =
        claude::run_claude_text_live(&state.claude_bin(), &args, &meta.cwd, COMPACT_PROMPT, Some(&on_event))
            .await?;
    {
        let conn = state.db();
        db::compact(&conn, &id, &text);
    }
    Ok(json!({ "ok": true, "summary": text }))
}
