//! Static model catalogue — mirrors the MODELS list from the original server.js.
//! ids must match the Claude CLI `--model` values.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Copy)]
pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub blurb: &'static str,
    pub ctx: u64,
}

/// An owned model entry — the dynamic counterpart of `Model`. The picker is
/// built from these; they come either from the live Models API (see `catalog`)
/// or from `seed_models()` (the static list) when the API is unavailable.
#[derive(Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub blurb: String,
    /// Context window (max input tokens) — drives the conversation-size meter.
    pub ctx: u64,
    /// Family/tier word (opus/sonnet/haiku/fable/…), for grouping & blurbs.
    pub tier: String,
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

/// Whether `id` is safe to forward verbatim as a `claude --model` argument.
///
/// We must honour the user's exact selection, so this is deliberately permissive:
/// it accepts *any* non-empty id — including future id shapes the live catalogue
/// might surface that we never hardcoded — and rejects only ids that can't be a
/// real model id anyway (empty, or containing whitespace/control chars). Because
/// args are passed as a real argv entry (never through a shell), there is no
/// injection surface to guard against beyond that. Requiring a `claude-` prefix
/// here would risk silently dropping `--model` and falling back to the CLI's
/// default — the one thing we never want.
pub fn is_safe_model_arg(id: &str) -> bool {
    !id.is_empty() && !id.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The static list as owned `ModelInfo`s — the seed/fallback for the catalogue.
pub fn seed_models() -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|m| ModelInfo {
            id: m.id.to_string(),
            name: m.name.to_string(),
            blurb: m.blurb.to_string(),
            ctx: m.ctx,
            tier: tier_of(m.id, m.name),
        })
        .collect()
}

/// Derive the family/tier word from a model's name or id (e.g. "Claude Opus
/// 4.8" / "claude-opus-4-8" → "opus"). Lowercased; empty if it can't be read.
pub fn tier_of(id: &str, name: &str) -> String {
    // Prefer the display name's second word ("Claude <Tier> …").
    let from_name = name.split_whitespace().nth(1).map(str::to_ascii_lowercase);
    let word = from_name.filter(|w| w.chars().all(|c| c.is_ascii_alphabetic()) && !w.is_empty());
    if let Some(w) = word {
        return w;
    }
    // Fall back to the id's second dash-segment ("claude-<tier>-…").
    id.split('-')
        .nth(1)
        .filter(|w| w.chars().all(|c| c.is_ascii_alphabetic()))
        .unwrap_or("")
        .to_string()
}

/// A short editorial blurb for a tier (Krystal's own copy — the Models API
/// doesn't provide one). Localized on the frontend via `modeltier.<tier>`.
pub fn blurb_for_tier(tier: &str) -> &'static str {
    match tier {
        "opus" => "Smartest",
        "fable" | "mythos" => "Most capable",
        "sonnet" => "Balanced & fast",
        "haiku" => "Quick & cheap",
        _ => "",
    }
}

/// Display order rank for a tier (smaller sorts first), so the picker keeps a
/// sensible Opus → Fable → Sonnet → Haiku ordering regardless of release dates.
pub fn tier_rank(tier: &str) -> u8 {
    match tier {
        "opus" => 0,
        "fable" | "mythos" => 1,
        "sonnet" => 2,
        "haiku" => 3,
        _ => 4,
    }
}

/// Human-readable name for a model id (falls back to the id itself).
pub fn model_name(id: &str) -> &str {
    MODELS.iter().find(|m| m.id == id).map(|m| m.name).unwrap_or(id)
}

/* ----------------------------- orchestrator ------------------------------ */
/// Orchestrator mode runs a premium model as a supervisor that delegates the
/// heavy lifting to cheaper "worker" sub-agents (via the Task tool), keeping the
/// expensive model's tokens for planning and synthesis. The sub-agent model is
/// either a concrete id or `auto`, in which case the orchestrator picks the
/// cheapest sufficient tier per task.

/// Sentinel: let the orchestrator choose a worker tier automatically.
pub const SUB_MODEL_AUTO: &str = "auto";

/// The three tiers the orchestrator's `auto` sub-agent mode falls back to when
/// a tier is missing from the live catalogue (see `claude::prepare_orchestration`).
pub const ORCH_FAST_MODEL: &str = "claude-haiku-4-5-20251001";
pub const ORCH_BALANCED_MODEL: &str = "claude-sonnet-4-6";
pub const ORCH_DEEP_MODEL: &str = "claude-opus-4-8";

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orchestrator_tier_models_are_real() {
        assert!(is_valid_model(ORCH_FAST_MODEL));
        assert!(is_valid_model(ORCH_BALANCED_MODEL));
        assert!(is_valid_model(ORCH_DEEP_MODEL));
    }

    #[test]
    fn model_name_falls_back_to_id() {
        assert_eq!(model_name("claude-fable-5"), "Fable 5");
        assert_eq!(model_name("unknown-id"), "unknown-id");
    }

    #[test]
    fn tier_derives_from_name_or_id() {
        assert_eq!(tier_of("claude-opus-4-8", "Claude Opus 4.8"), "opus");
        assert_eq!(tier_of("claude-sonnet-5", "Claude Sonnet 5"), "sonnet");
        assert_eq!(tier_of("claude-fable-5", "Claude Fable 5"), "fable");
        // Dated snapshot id, empty display name → fall back to the id segment.
        assert_eq!(tier_of("claude-haiku-4-5-20251001", ""), "haiku");
    }

    #[test]
    fn tier_rank_orders_opus_before_haiku() {
        assert!(tier_rank("opus") < tier_rank("sonnet"));
        assert!(tier_rank("sonnet") < tier_rank("haiku"));
        assert!(tier_rank("haiku") < tier_rank("something-new"));
    }

    #[test]
    fn is_safe_model_arg_forwards_any_reasonable_id() {
        // Real ids — and any future shape — must be forwarded verbatim.
        assert!(is_safe_model_arg("claude-opus-4-8"));
        assert!(is_safe_model_arg("claude-haiku-4-5-20251001"));
        assert!(is_safe_model_arg("claude-opus-4-5@20251101"));
        assert!(is_safe_model_arg("some-future-model-9")); // no claude- prefix required
        // Only genuinely un-forwardable ids are refused.
        assert!(!is_safe_model_arg(""));
        assert!(!is_safe_model_arg("claude opus")); // whitespace
        assert!(!is_safe_model_arg("claude\n4"));   // control char
    }

    #[test]
    fn seed_models_are_tiered() {
        let seeded = seed_models();
        assert!(seeded.iter().any(|m| m.tier == "opus"));
        assert!(seeded.iter().all(|m| !m.tier.is_empty()));
    }
}
