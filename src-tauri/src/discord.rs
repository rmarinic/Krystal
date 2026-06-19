//! Discord Rich Presence — shows a "Playing Krystal" card with the active
//! project on the user's Discord profile.
//!
//! Entirely local: we talk to the *running Discord desktop client* over its IPC
//! pipe; Krystal never calls Discord's servers. If Discord isn't running we
//! silently no-op and retry on the next update.
//!
//! Privacy-conscious by design: this is **opt-in** (off by default) and only the
//! project NAME is ever sent — never message content, file paths, or chat text.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{
    activity::{Activity, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURE ME — Discord application identity
//
//  1. Go to https://discord.com/developers/applications  →  "New Application".
//     Name it "Krystal" (this name is what shows after "Playing …").
//  2. Copy its Application ID (General Information) into DISCORD_APP_ID below.
//  3. Under "Rich Presence → Art Assets", upload a logo and name its asset key
//     to match LARGE_IMAGE_KEY. SMALL_IMAGE_KEY is an optional corner overlay —
//     leave it "" to skip.
//
//  Until DISCORD_APP_ID is filled in, presence stays inert at runtime (the
//  toggle still works, it just won't connect).
// ─────────────────────────────────────────────────────────────────────────────
const DISCORD_APP_ID: &str = "1517285517035831446";
const LARGE_IMAGE_KEY: &str = "krystal";
const SMALL_IMAGE_KEY: &str = "";

struct Inner {
    enabled: bool,
    /// Lazily-created IPC client; `Some` only while a connection is live.
    client: Option<DiscordIpcClient>,
    /// Unix seconds when the presence session started (drives the elapsed timer).
    /// 0 means "not started yet".
    started_at: i64,
    /// Active project name, or `None` on the project picker screen.
    project: Option<String>,
    /// Whether the project NAME may appear on the card. Off → a generic label so
    /// presence still shows, but the folder name stays private.
    share_name: bool,
}

/// Thread-safe presence handle stored in `AppState`. All methods are best-effort
/// and never panic on IPC failure.
pub struct Presence(Mutex<Inner>);

impl Presence {
    pub fn new() -> Self {
        Presence(Mutex::new(Inner {
            enabled: false,
            client: None,
            started_at: 0,
            project: None,
            share_name: true,
        }))
    }

    /// Turn presence on or off. Enabling connects (if Discord is up) and pushes
    /// the current activity; disabling clears it and drops the connection.
    pub fn set_enabled(&self, on: bool) {
        let mut g = self.0.lock().unwrap();
        if g.enabled == on {
            return;
        }
        g.enabled = on;
        if on {
            apply(&mut g);
        } else {
            teardown(&mut g);
        }
    }

    /// Update the active project (`None` when back on the picker) and re-push if
    /// presence is currently enabled.
    pub fn set_project(&self, project: Option<String>) {
        let mut g = self.0.lock().unwrap();
        g.project = project;
        if g.enabled {
            apply(&mut g);
        }
    }

    /// Choose whether the project name may appear on the card; re-push if live.
    pub fn set_share_name(&self, on: bool) {
        let mut g = self.0.lock().unwrap();
        g.share_name = on;
        if g.enabled {
            apply(&mut g);
        }
    }
}

impl Default for Presence {
    fn default() -> Self {
        Self::new()
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Ensure a connection exists and push the current activity. Best-effort: any
/// IPC error (most commonly "Discord not running") just drops the client so the
/// next call reconnects cleanly.
fn apply(inner: &mut Inner) {
    if DISCORD_APP_ID.is_empty() {
        return; // not configured yet — nothing to do
    }
    if inner.started_at == 0 {
        inner.started_at = now_secs();
    }

    // (Re)connect if needed. A failed connect just means Discord isn't up.
    if inner.client.is_none() {
        match DiscordIpcClient::new(DISCORD_APP_ID) {
            Ok(mut c) => {
                if c.connect().is_err() {
                    return;
                }
                inner.client = Some(c);
            }
            Err(_) => return,
        }
    }

    let details = match (&inner.project, inner.share_name) {
        (Some(name), true) => format!("Working on {name}"),
        (Some(_), false) => "Working on a project".to_string(),
        (None, _) => "Choosing a project".to_string(),
    };
    let started = inner.started_at;

    let mut assets = Assets::new()
        .large_image(LARGE_IMAGE_KEY)
        .large_text("Krystal");
    if !SMALL_IMAGE_KEY.is_empty() {
        assets = assets.small_image(SMALL_IMAGE_KEY);
    }

    let result = {
        let client = inner.client.as_mut().unwrap();
        let activity = Activity::new()
            .details(&details)
            .state("via Krystal")
            .assets(assets)
            .timestamps(Timestamps::new().start(started));
        client.set_activity(activity)
    };

    // On failure, drop the client so the next update reconnects.
    if result.is_err() {
        if let Some(mut c) = inner.client.take() {
            let _ = c.close();
        }
    }
}

/// Clear the presence card and close the connection.
fn teardown(inner: &mut Inner) {
    if let Some(mut c) = inner.client.take() {
        let _ = c.clear_activity();
        let _ = c.close();
    }
    inner.started_at = 0;
}
