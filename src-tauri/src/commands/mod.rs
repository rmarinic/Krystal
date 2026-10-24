//! Tauri command handlers — the IPC surface the frontend talks to. Every
//! command is also reachable from a phone or another Krystal through
//! `server/bridge.rs`'s `dispatch` (see the four-place rule in CLAUDE.md).
//!
//! One file per concern; each `pub use`s up here, so callers keep writing
//! `commands::foo` and `main.rs`'s `generate_handler!` finds every command where
//! it always did. Helpers one file shares with another are `pub(super)`.

use std::process::Stdio;

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::artifacts;
use crate::claude::{self, Caps};
use crate::db;
use crate::discord;
use crate::models;
use crate::session;
use crate::skills;

mod config;
mod setup;
mod system;
mod attachments;
mod threads;
mod projects;
mod turn;
mod tasks;
mod git;
mod ci;
mod usage;
mod run;
mod wizard;
mod pins;
mod artifact_panel;
mod json;

pub use config::*;
pub use setup::*;
pub use system::*;
pub use attachments::*;
pub use threads::*;
pub use projects::*;
pub use turn::*;
pub use tasks::*;
pub use git::*;
pub use ci::*;
pub use usage::*;
pub use run::*;
pub use wizard::*;
pub use pins::*;
pub use artifact_panel::*;
use json::*;

/// Shared app state managed by Tauri.
pub struct AppState {
    pub db: std::sync::Mutex<rusqlite::Connection>,
    pub caps: Caps,
    /// The resolved `claude` executable. Mutable because onboarding can install
    /// Claude Code at runtime and we then need every command to use the new path
    /// without a restart.
    pub claude_bin: std::sync::Mutex<String>,
    /// The onboarding screen's sign-in, while one is in flight.
    pub login: claude::LoginFlow,
    /// Discord Rich Presence handle (opt-in; off until the user enables it).
    pub discord: discord::Presence,
    /// PIDs of in-flight `claude` chat processes, keyed by thread id, so a
    /// `stop_chat` can interrupt a turn mid-stream.
    pub running: std::sync::Mutex<std::collections::HashMap<String, u32>>,
    /// PIDs of locally-running app processes (the RUN button), keyed by project
    /// folder path, so a `stop_run` can kill the process tree.
    pub run_procs: std::sync::Mutex<std::collections::HashMap<String, u32>>,
    /// App data directory — where the DB lives and where we drop the per-project
    /// task-list snapshots Claude can read on demand.
    pub data_dir: std::path::PathBuf,
    /// The model catalogue shown in the picker — seeded from the cached/static
    /// list at boot and replaced by a live `GET /v1/models` fetch (see
    /// `refresh_models`). Kept here so validation can accept dynamic ids.
    pub models: std::sync::Mutex<Vec<models::ModelInfo>>,
    /// The app's interface language ('en' | 'hr'), pushed down from the frontend
    /// at boot and whenever the user flips the flag. Used ONLY as the tie-break
    /// reply language for text that carries no language signal of its own — a
    /// Croatian UI never turns an English message into a Croatian answer.
    pub ui_lang: std::sync::Mutex<String>,
    /// Whether to ask the CLI for a predicted next message after each chat turn
    /// (`--prompt-suggestions`). Pushed down from the Settings panel; on by
    /// default. Costs a small extra generation per turn, hence the switch.
    pub suggestions: std::sync::Mutex<bool>,
    /// Warm `claude` processes, one per chat (see `session/`).
    pub sessions: session::Pool,
    /// Remote access — the LAN HTTP server (see `server/`). Off until started.
    pub remote: crate::server::RemoteServer,
}

impl AppState {
    /// The database. A command that panicked while holding the lock poisons the
    /// mutex; the connection itself is still fine (SQLite rolled back whatever
    /// was half-done), so carry on with it rather than failing every command
    /// for the rest of the session.
    pub fn db(&self) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn sys_prompt(&self) -> String {
        claude::capability_prompt(self.caps, &self.ui_lang())
    }

    /// Current UI language code (owned clone — never held across an await).
    pub fn ui_lang(&self) -> String {
        self.ui_lang.lock().unwrap().clone()
    }

    /// Whether prompt suggestions are enabled (copied out — never held across an await).
    pub fn suggestions(&self) -> bool {
        *self.suggestions.lock().unwrap()
    }

    /// Current claude executable path (owned clone — never held across an await).
    pub fn claude_bin(&self) -> String {
        self.claude_bin.lock().unwrap().clone()
    }

    /// Is `id` a model we know about — in the current (possibly live-fetched)
    /// catalogue, or the static fallback list?
    pub fn model_known(&self, id: &str) -> bool {
        self.models.lock().unwrap().iter().any(|m| m.id == id) || models::is_valid_model(id)
    }
}

type CmdResult = Result<Value, String>;
