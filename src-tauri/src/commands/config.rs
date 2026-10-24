//! Settings the frontend pushes down: interface language, the model catalogue,
//! prompt suggestions, and Discord presence.

use super::*;

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Value {
    let models = state.models.lock().unwrap().clone();
    json!({ "models": models, "modes": models::MODES, "efforts": models::EFFORTS })
}

/// Tell the backend which language the app's interface is in. It never forces a
/// reply language — it only breaks the tie for a message too short to identify
/// (see `claude::capability_prompt`) and picks the language Claude drafts
/// generated content in (tasks, a fresh CLAUDE.md).
#[tauri::command]
pub fn set_ui_language(state: State<'_, AppState>, lang: String) -> Value {
    let lang = if lang == "hr" { "hr" } else { "en" };
    *state.ui_lang.lock().unwrap() = lang.to_string();
    json!({ "lang": lang })
}

/// Fetch the live model catalogue from the Anthropic Models API, adopt it into
/// state, and cache it. On any failure (offline, no/expired credentials) the
/// current catalogue is returned unchanged so the picker never empties. The
/// frontend calls this once at boot and swaps in the result if it's newer.
#[tauri::command]
pub async fn refresh_models(state: State<'_, AppState>) -> CmdResult {
    match crate::catalog::fetch_catalog().await {
        Ok(list) => {
            crate::catalog::save_cache(&state.data_dir, &list);
            *state.models.lock().unwrap() = list.clone();
            Ok(json!({ "models": list, "source": "live" }))
        }
        Err(e) => {
            let cached = state.models.lock().unwrap().clone();
            Ok(json!({ "models": cached, "source": "cache", "error": e }))
        }
    }
}

/// Turn the after-turn prompt suggestion on or off (see `AppState::suggestions`).
#[tauri::command]
pub fn set_suggestions(state: State<'_, AppState>, enabled: bool) -> Value {
    *state.suggestions.lock().unwrap() = enabled;
    json!({ "ok": true })
}

/// Turn Discord Rich Presence on or off. Off by default; the frontend persists
/// the user's choice and calls this on boot and whenever the toggle is flipped.
#[tauri::command]
pub fn set_discord_enabled(state: State<'_, AppState>, enabled: bool) -> Value {
    state.discord.set_enabled(enabled);
    json!({ "ok": true })
}

/// Update the project shown on the Discord card (`null` on the picker screen).
/// Only the project name is sent — never chat content or paths.
#[tauri::command]
pub fn discord_set_project(state: State<'_, AppState>, name: Option<String>) -> Value {
    state.discord.set_project(name);
    json!({ "ok": true })
}

/// Choose whether the project NAME is shown on the Discord card. When off,
/// presence still shows but with a generic label instead of the folder name.
#[tauri::command]
pub fn discord_set_share_name(state: State<'_, AppState>, enabled: bool) -> Value {
    state.discord.set_share_name(enabled);
    json!({ "ok": true })
}
