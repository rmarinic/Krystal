//! Krystal Cloud (app.krystal.rip) — the desktop's half: linking this computer
//! to an account (`link`), over the HTTP layer in `api`, with the device token
//! kept in Windows Credential Manager (`vault`).
//!
//! Presence and the relay that lets a phone reach this computer through the
//! cloud come later; they will use the same token, over
//! `wss://app.krystal.rip/device`.
//!
//! The window drives it through the `cloud_*` commands below and hears about
//! changes it didn't ask for (a poll landing, a link found gone) on the
//! `cloud-link` event. Both only ever carry `Link::status()`.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::commands::AppState;

mod api;
mod link;
#[cfg(test)]
mod live;
mod vault;

/// The link this app runs with: the real network, the real credential store.
pub type CloudLink = link::Link<api::HttpNet, vault::Keyring>;

/// The window's event for a status change it didn't ask for.
const EV_LINK: &str = "cloud-link";

/// What to call this computer on the dashboard: the computer name if the OS
/// offers one. Best effort; the dashboard can rename it.
pub fn machine_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(key) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "Krystal".to_string()
}

/// The link for this run, against `KRYSTAL_CLOUD_URL` or app.krystal.rip.
pub fn new_link() -> Arc<CloudLink> {
    let base = api::base_url();
    link::Link::new(
        api::HttpNet::new(base.clone()),
        vault::Keyring::new(&base),
        machine_name(),
        crate::commands::app_version().to_string(),
    )
}

/// A link that can never reach anything, for tests that need an `AppState`.
#[cfg(test)]
pub fn for_tests() -> Arc<CloudLink> {
    let base = "http://127.0.0.1:9/krystal-tests";
    link::Link::new(
        api::HttpNet::new(base.into()),
        vault::Keyring::new(base),
        "TEST-PC".into(),
        "0.0.0".into(),
    )
}

/// Forward every status change the window didn't ask for as `cloud-link`.
pub fn wire_events(app: &AppHandle, link: &CloudLink) {
    let app = app.clone();
    link.on_change(move |status| {
        let _ = app.emit(EV_LINK, status);
    });
}

/* -------------------------------- commands -------------------------------- */
/* Async ones return `Result` because Tauri insists on it for an async command
 * that borrows `State`; none of them fails — a problem is part of the status. */

#[tauri::command]
pub fn cloud_status(state: tauri::State<'_, AppState>) -> Value {
    state.cloud.status()
}

/// Ask for a code, open app.krystal.rip in the browser and start waiting.
#[tauri::command]
pub async fn cloud_link_start(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let link = state.cloud.clone();
    Ok(link.start().await)
}

/// "Open again": the confirm page, if a link is waiting on it.
#[tauri::command]
pub fn cloud_link_open(state: tauri::State<'_, AppState>) {
    state.cloud.open_again();
}

#[tauri::command]
pub fn cloud_link_cancel(state: tauri::State<'_, AppState>) -> Value {
    state.cloud.cancel()
}

/// The quiet check on launch and when the panel opens (`GET /api/device`).
#[tauri::command]
pub async fn cloud_check(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let link = state.cloud.clone();
    Ok(link.check().await)
}

#[tauri::command]
pub async fn cloud_unlink(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let link = state.cloud.clone();
    Ok(link.unlink().await)
}
