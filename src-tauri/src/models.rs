//! Static model catalogue — mirrors the MODELS list from the original server.js.
//! ids must match the Claude CLI `--model` values.

use serde::Serialize;

#[derive(Serialize, Clone, Copy)]
pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub blurb: &'static str,
    pub ctx: u64,
}

pub const DEFAULT_MODEL: &str = "claude-opus-4-8";

/// The cheapest/fastest model — used for tiny background chores like naming a
/// chat from its first message, where smarts don't matter but cost does.
pub const TITLE_MODEL: &str = "claude-haiku-4-5-20251001";

pub const MODELS: &[Model] = &[
    Model { id: "claude-opus-4-8",           name: "Opus 4.8",   blurb: "Smartest",        ctx: 1_000_000 },
    Model { id: "claude-sonnet-4-6",         name: "Sonnet 4.6", blurb: "Balanced & fast", ctx: 1_000_000 },
    Model { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5",  blurb: "Quick & cheap",   ctx:   200_000 },
    Model { id: "claude-fable-5",            name: "Fable 5",    blurb: "Creative",        ctx: 1_000_000 },
];

/// Whether the given id is one of the offered models.
pub fn is_valid_model(id: &str) -> bool {
    MODELS.iter().any(|m| m.id == id)
}

/* --------------------------------- modes --------------------------------- */
/// How much latitude Claude has on a chat turn. Only the live `chat` turns honour
/// this; internal one-off calls (compact/hint/init) always run at full power.

#[derive(Serialize, Clone, Copy)]
pub struct Mode {
    pub id: &'static str,
    pub name: &'static str,
    pub blurb: &'static str,
}

pub const DEFAULT_MODE: &str = "auto";

pub const MODES: &[Mode] = &[
    Mode { id: "auto", name: "Auto", blurb: "Reads, writes & runs on its own" },
    Mode { id: "plan", name: "Plan", blurb: "Researches & proposes — no changes" },
];

/// Whether the given id is one of the offered modes.
pub fn is_valid_mode(id: &str) -> bool {
    MODES.iter().any(|m| m.id == id)
}
