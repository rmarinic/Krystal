//! Claude subscription usage — the plan's real limits, as Claude's usage
//! settings show them. The work is in `claude::limits`; this is its command.

use super::*;

/// Where the 5-hour session and the weekly limits stand right now (see
/// `claude::fetch_limits` for the shape). Turns keep it current in between,
/// through their `rate_limit` events.
#[tauri::command]
pub async fn claude_usage() -> Value {
    claude::fetch_limits().await
}
