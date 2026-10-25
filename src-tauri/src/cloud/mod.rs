//! Krystal Cloud (app.krystal.rip) — the desktop's half: linking this computer
//! to an account (`link`), over the HTTP layer in `api`, with the device token
//! kept in Windows Credential Manager (`vault`); and, while linked and the
//! "Reachable from krystal.rip" switch is on, the live connection that keeps it
//! online on the dashboard (`presence`, over `wire` to `wss://…/device`). The
//! relay that lets someone signed in there drive this computer rides that same
//! socket (`relay`, which hands each request to `crate::remote`).
//!
//! The window drives it through the `cloud_*` commands below and hears about
//! changes it didn't ask for on two events: `cloud-link` (a poll landing, a link
//! found gone) carries `Link::status()`, `cloud-presence` carries
//! `Presence::status()`. Neither ever carries the token.

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::commands::AppState;

mod api;
#[cfg(test)]
mod fakes;
mod link;
#[cfg(test)]
mod live;
mod presence;
mod relay;
mod vault;
mod wire;

/// The link this app runs with: the real network, the real credential store.
pub type CloudLink = link::Link<api::HttpNet, vault::Keyring>;

/// The live connection this app runs with: that link, over a real WebSocket.
pub type CloudPresence = presence::Presence<CloudLink, wire::WsWire>;

/// The window's event for a status change it didn't ask for.
const EV_LINK: &str = "cloud-link";

/// The window's event for a change in the live connection.
const EV_PRESENCE: &str = "cloud-presence";

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

/// The live connection for `link`, against the same cloud, with the switch as
/// it was left (`dir` is the app data folder).
pub fn new_presence(link: &Arc<CloudLink>, dir: &Path) -> Arc<CloudPresence> {
    presence::Presence::new(
        link.clone(),
        wire::WsWire::new(&api::base_url()),
        presence::load_reachable(dir),
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

/// A live connection that never dials (its switch is off), for the same.
#[cfg(test)]
pub fn presence_for_tests(link: &Arc<CloudLink>) -> Arc<CloudPresence> {
    presence::Presence::new(link.clone(), wire::WsWire::new("http://127.0.0.1:9"), false, "0.0.0".into())
}

/// Forward every status change the window didn't ask for as `cloud-link`.
pub fn wire_events(app: &AppHandle, link: &CloudLink) {
    let app = app.clone();
    link.on_change(move |status| {
        let _ = app.emit(EV_LINK, status);
    });
}

/// Forward the live connection's changes as `cloud-presence`, hand the relay
/// this app's commands, and start it: from here on it follows the link and
/// the switch by itself.
pub fn start_presence(app: &AppHandle, presence: &Arc<CloudPresence>) {
    presence.serve(Arc::new(relay::AppHandler(app.clone())));
    let app = app.clone();
    presence.on_change(move |status| {
        let _ = app.emit(EV_PRESENCE, status);
    });
    tauri::async_runtime::spawn(presence.clone().run());
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

/// The live connection: `{ reachable, conn }`.
#[tauri::command]
pub fn cloud_presence(state: tauri::State<'_, AppState>) -> Value {
    state.presence.status()
}

/// "Reachable from krystal.rip": remembered, then followed at once.
#[tauri::command]
pub fn cloud_set_reachable(state: tauri::State<'_, AppState>, on: bool) -> Value {
    presence::save_reachable(&state.data_dir, on);
    state.presence.set_reachable(on)
}
