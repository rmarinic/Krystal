//! Settings → Remote → "People you share this computer with": what a guest may
//! do here (`remote::GuestAccess`, enforced by `remote/access.rs`). Both
//! commands are local-only: the owner sets this at the computer itself.

use super::*;

use crate::remote::GuestAccess;

#[tauri::command]
pub fn get_guest_access(state: State<'_, AppState>) -> Value {
    serde_json::to_value(GuestAccess::load(&state.data_dir)).unwrap_or(Value::Null)
}

/// Save the owner's choice and hand back what was kept (unknown modes dropped).
#[tauri::command]
pub fn set_guest_access(state: State<'_, AppState>, access: Value) -> CmdResult {
    let access: GuestAccess = serde_json::from_value(access).map_err(|e| e.to_string())?;
    let access = access.tidy();
    access.save(&state.data_dir)?;
    serde_json::to_value(access).map_err(|e| e.to_string())
}
