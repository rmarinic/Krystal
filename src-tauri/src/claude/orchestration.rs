//! Orchestrator mode: a premium model supervising cheaper worker sub-agents,
//! defined inline via `--agents`.

use super::*;

/// Everything a chat turn needs to run in orchestrator mode: the system-prompt
/// note that steers the orchestrator to delegate, plus the worker definitions
/// that note refers to, ready to hand straight to `claude --agents`.
///
/// The workers used to be `.md` files written into the user's real
/// `~/.claude/agents` and swept away again after the turn (with a pid-tagged
/// name so a crashed Krystal could be cleaned up later). `--agents` takes the
/// same definitions inline as JSON, which removes the whole file dance — and,
/// more importantly, lets the names be *stable*. A name that changed every turn
/// changed the appended system prompt every turn, which invalidated the prompt
/// cache on the very first block and made every orchestrated turn pay full
/// price for its prefix.
pub struct Orchestration {
    /// Appended to the system prompt for this turn. Multi-line is fine: the whole
    /// system prompt is spilled to a file before it reaches the CLI (see
    /// `spill_system_prompt`), so nothing here has to survive shell tokenizing.
    pub note: String,
    /// The `--agents` payload: a JSON object of `name -> {description, prompt, model}`.
    pub agents: String,
}

// NOTE: an earlier version of this mode also hard-blocked the orchestrator's own
// tools via `--disallowedTools`. Reverted: that deny is enforced CLI-wide, and
// Claude Code's built-in generic Task agent types (`general-purpose`, `claude`,
// …) share the parent's permission set — only a fully custom-defined agent (like
// our worker `.md` files) is exempt. The orchestrator doesn't reliably call the
// delegation tool with the exact custom worker name; when it drifted mid-turn,
// that call inherited the deny and came back completely toolless, sometimes
// stalling the whole turn. A silently-broken delegation is worse than the
// token-waste this mode exists to prevent, so enforcement is prompt-only again.

/// Shared prefix of every worker name we define, so a worker can never collide
/// with an agent the user defined themselves. Stable across turns — see the
/// prompt-cache note on `Orchestration`.
const WORKER_PREFIX: &str = "krystal-worker-";

/// Opening of the orchestrator note — how to call a worker at all.
///
/// The delegation tool is `Agent` in current Claude Code and was `Task` in older
/// builds; naming both keeps the note correct either way (see `tool_detail`,
/// which matches the same pair). Naming the wrong one is not harmless: the model
/// is being told to route all its work through a tool that doesn't exist, and
/// spends the turn hunting for it.
const ORCH_HEAD: &str = "\
ORCHESTRATOR MODE — you are the orchestrator for this turn, running on a premium model. You plan and delegate; cheaper worker sub-agents do the heavy lifting.

Delegate with the `Agent` tool (older builds name it `Task`), passing the worker's exact name as `subagent_type`. Never use `general-purpose`, `claude`, `Explore` or any other built-in agent type, and never omit it.";

/// The rest of the orchestrator note: what to keep, what to hand off, how to
/// size and brief a task, and when to stop delegating.
///
/// Deliberately NOT "delegate everything": a sub-agent starts from an empty
/// context, so spawning one for a single Read costs a full agent boot to save a
/// few hundred tokens, and a task needing a dozen look-ups becomes a dozen
/// serial boots — which is what made simple requests crawl. Targeted reads stay
/// with the orchestrator; the context hogs (bulk exploration, build/test output,
/// multi-file edits) are what actually get delegated.
const ORCH_RULES: &str = "\
Do yourself: understand the request, plan, targeted look-ups (Read/Grep/Glob when you already know the file or symbol), review what workers return, write the final answer.

Delegate: every file write or edit, every command/build/test run, every broad search or piece of research, and anything whose output would be long. Never edit a file yourself.

Size the task, don't micro-delegate. One Read or one Grep you already know the target of is faster done yourself — a worker boots into an empty context, so spawning one for a keystroke costs far more than it saves. Delegate work that takes several steps or would flood your context.

Every brief is a contract. State the objective, the files/paths and facts you already know (the worker is blind to this conversation), what \"done\" looks like, and the exact shape of the answer you want back. Thin briefs are the main way this mode fails.

Run 2–4 workers in parallel when the pieces are genuinely independent — one Agent call per piece, all in the same message. Never more than 5 at once, and never give two workers the same file: one file, one worker.

Keep coupled work whole. A single coherent change belongs to one worker; splitting it across a chain of workers loses information at every handoff.

Verify once per coherent change, not after every worker: one worker builds/compiles, runs the relevant tests, and reports failures verbatim.

Stop conditions. If a worker comes back blocked or wrong, re-dispatch at most once with a sharper brief, then do the rest yourself with your own tools. If the Agent tool errors or a worker returns nothing usable, do not retry in a loop — finish the job yourself. Delivering the user's result always outranks staying in delegation.";

/// Appended to the orchestrator note when the turn also runs in Plan mode.
///
/// Plan mode drops `--dangerously-skip-permissions` (see `apply_mode`), and a
/// sub-agent inherits its parent's permission context — so a worker told to edit
/// would stall on a permission prompt that nothing in a `-p` run can answer.
/// Keeping the workers read-only removes that dead end.
pub const ORCH_PLAN_NOTE: &str = "\
This turn also runs in Plan mode: nothing may be created, edited or deleted. Delegate reading, searching and research only, and say explicitly in every brief that the worker must not write anything — a worker that tries to write will stall waiting for a permission prompt nobody can answer. Finish by presenting the plan yourself.";

/// The worker brief. A sub-agent starts with a *fresh, isolated context* — it
/// cannot see the conversation — so the brief spells out how to work from the
/// delegation message alone, forbids delegating further (Claude Code lets
/// sub-agents nest by default, which turns one task into a tree), and gives it a
/// hard stop condition so a stuck worker returns instead of grinding.
const WORKER_BODY: &str = "\
You are a worker sub-agent. An orchestrator delegated exactly one task to you.

You start blind: you cannot see the user's conversation or anything the orchestrator has read. Work from your brief plus the project itself, and look things up rather than asking.

Do the whole task yourself with your full toolset. Do NOT delegate any part of it to another sub-agent.

If you changed anything, verify it before returning — build/compile it, run the relevant tests, or re-read what you edited — and report what you checked and what it said.

Stop condition: if the same approach fails twice, stop. Return what you learned, what you tried, and the exact error. Never grind on a failing loop, and never hand the task back as a question unless you are genuinely blocked.

Return a tight, self-contained report the orchestrator can act on directly: what you did, which files (and roughly which lines) you touched, what you verified, and anything it must know. No preamble, no restating the brief.";

/// One worker definition for the `--agents` payload. `model` pins the sub-agent's
/// model; the prompt is its (deliberately generic, full-tool) brief — we never
/// restrict a worker's toolset, so `tools` is left off and the worker inherits
/// everything.
fn worker_def(description: &str, model: &str) -> Value {
    json!({ "description": description, "prompt": WORKER_BODY, "model": model })
}

/// Delete worker `.md` files left in `~/.claude/agents` by a Krystal old enough
/// to have written them there (pre-`--agents`), including ones a crash left
/// behind. Called once at startup; the app never writes to that directory now,
/// so anything carrying our prefix is certainly ours and certainly stale.
pub fn sweep_legacy_worker_agents() {
    let Some(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok() else { return };
    let dir = PathBuf::from(home).join(".claude").join("agents");
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(WORKER_PREFIX) && name.ends_with(".md") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Resolve a model id's display name against the live catalogue, falling back
/// to the static name table (then the id itself) for anything not in the list.
fn resolve_model_name(catalog: &[ModelInfo], id: &str) -> String {
    catalog
        .iter()
        .find(|m| m.id == id)
        .map(|m| m.name.clone())
        .unwrap_or_else(|| model_name(id).to_string())
}

/// Pick the newest model of `tier` from the live catalogue (id + display name),
/// falling back to the given static id when the tier isn't present. This keeps
/// the orchestrator's Auto worker tiers in step with the dynamic model list
/// rather than pinning hardcoded ids.
fn pick_tier(catalog: &[ModelInfo], tier: &str, fallback: &str) -> (String, String) {
    match catalog.iter().find(|m| m.tier == tier) {
        Some(m) => (m.id.clone(), m.name.clone()),
        None => (fallback.to_string(), model_name(fallback).to_string()),
    }
}

/// Build the worker sub-agents for one orchestrator turn and the note that
/// steers the orchestrator to delegate to them. `sub_model` is a concrete model
/// id, or `auto` to offer a fast/balanced/deep trio (drawn from the live
/// `catalog`) the orchestrator picks from per task.
///
/// Nothing is written to disk and nothing can fail: the definitions ride along
/// on the turn's `--agents` flag and disappear with the process.
pub fn prepare_orchestration(sub_model: &str, catalog: &[ModelInfo]) -> Orchestration {
    let mut defs = serde_json::Map::new();

    let note = if sub_model == SUB_MODEL_AUTO {
        // Tiers track the live catalogue; the ORCH_* ids are only fallbacks.
        let (fast_id, fast_m) = pick_tier(catalog, "haiku", ORCH_FAST_MODEL);
        let (bal_id, bal_m) = pick_tier(catalog, "sonnet", ORCH_BALANCED_MODEL);
        let (deep_id, deep_m) = pick_tier(catalog, "opus", ORCH_DEEP_MODEL);
        let fast = format!("{WORKER_PREFIX}fast");
        let bal = format!("{WORKER_PREFIX}balanced");
        let deep = format!("{WORKER_PREFIX}deep");
        defs.insert(fast.clone(), worker_def("Fast, cheap worker for simple or mechanical delegated tasks.", &fast_id));
        defs.insert(bal.clone(), worker_def("Balanced worker for typical coding, analysis and writing tasks.", &bal_id));
        defs.insert(deep.clone(), worker_def("Most-capable worker, for genuinely hard reasoning tasks.", &deep_id));
        format!(
            "{ORCH_HEAD}

Your workers for this turn — pick the cheapest one that can do the job well:
             - `{fast}` ({fast_m}) — mechanical, fully-specified work.
             - `{bal}` ({bal_m}) — normal coding, analysis and writing. Your default.
             - `{deep}` ({deep_m}) — genuinely hard reasoning only.

{ORCH_RULES}",
        )
    } else {
        let name = format!("{WORKER_PREFIX}main");
        defs.insert(
            name.clone(),
            worker_def("Worker sub-agent for delegated tasks; runs on a cheaper model to conserve budget.", sub_model),
        );
        format!(
            "{ORCH_HEAD}

You have one worker for this turn: `{name}` (runs on {mname}). Every delegated task goes to it.

{ORCH_RULES}",
            mname = resolve_model_name(catalog, sub_model),
        )
    };

    Orchestration { note, agents: Value::Object(defs).to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_definition_pins_its_model_and_keeps_the_fixed_brief() {
        let def = worker_def("A worker", "claude-sonnet-4-6");
        assert_eq!(def.get("description").and_then(|v| v.as_str()), Some("A worker"));
        assert_eq!(def.get("model").and_then(|v| v.as_str()), Some("claude-sonnet-4-6"));
        assert!(def.get("prompt").and_then(|v| v.as_str()).unwrap().contains("worker sub-agent"));
    }

    #[test]
    fn orchestrator_note_names_the_exact_worker_and_forbids_generic_types() {
        // Enforcement is prompt-only (see the NOTE above `Orchestration`): a CLI-level
        // --disallowedTools deny was tried and reverted, since Claude Code's built-in
        // generic agent types (general-purpose, claude, …) share the parent's
        // permission set and would silently inherit the deny if the model drifted to
        // one instead of the pinned custom worker. So the note must both name the
        // exact worker and explicitly forbid the generic fallbacks.
        let o = prepare_orchestration("claude-haiku-4-5-20251001", &[]);
        assert!(o.note.contains("ORCHESTRATOR MODE"));
        assert!(o.note.contains("general-purpose"));
        assert!(o.note.contains(WORKER_PREFIX));
    }

    #[test]
    fn orchestrator_note_names_the_current_delegation_tool() {
        // The delegation tool is `Agent` today and was `Task` before. Pointing the
        // orchestrator at a tool that no longer exists, while telling it to route
        // all work through that tool, is exactly how a turn hangs — so the note has
        // to name the current one (and may mention the legacy alias).
        let o = prepare_orchestration(SUB_MODEL_AUTO, &[]);
        assert!(o.note.contains("`Agent` tool"));
        assert!(o.note.contains("subagent_type"));
    }

    #[test]
    fn orchestrator_note_keeps_targeted_reads_and_caps_parallelism() {
        // The mode used to demand delegating *every* action, including a single
        // Read — a fresh-context agent boot per look-up, which is what made simple
        // requests crawl. The note must keep targeted reads with the orchestrator
        // and bound how many workers run at once.
        let o = prepare_orchestration(SUB_MODEL_AUTO, &[]);
        assert!(o.note.contains("Read/Grep/Glob"));
        assert!(o.note.contains("2–4 workers in parallel"));
        assert!(o.note.contains("Stop conditions"));
        // …and it must not go back to the all-or-nothing rule.
        assert!(!o.note.contains("NEVER use tools yourself"));
    }

    #[test]
    fn worker_brief_forbids_nesting_and_sets_a_stop_condition() {
        // A worker that delegates further turns one task into a tree; a worker with
        // no stop condition grinds on a failing loop. Both are turn-length bugs.
        assert!(WORKER_BODY.contains("Do NOT delegate"));
        assert!(WORKER_BODY.contains("fails twice"));
    }

    #[test]
    fn orchestration_defines_its_workers_inline_with_stable_names() {
        // The definitions ride on `--agents`, so nothing is written to the user's
        // ~/.claude/agents any more — and the names must not vary from turn to
        // turn, or the appended system prompt (and with it the prompt cache
        // prefix) changes on every single orchestrated turn.
        let a = prepare_orchestration(SUB_MODEL_AUTO, &[]);
        let b = prepare_orchestration(SUB_MODEL_AUTO, &[]);
        assert_eq!(a.agents, b.agents, "worker definitions are stable across turns");
        assert_eq!(a.note, b.note, "so is the note that names them");

        let defs: Value = serde_json::from_str(&a.agents).expect("valid --agents JSON");
        let obj = defs.as_object().expect("an object of name -> definition");
        assert_eq!(obj.len(), 3, "auto offers a fast/balanced/deep trio");
        for (name, def) in obj {
            assert!(name.starts_with(WORKER_PREFIX), "{name} is namespaced to us");
            assert!(a.note.contains(name.as_str()), "the note names {name}");
            assert!(def.get("description").and_then(|v| v.as_str()).is_some());
            assert!(def.get("model").and_then(|v| v.as_str()).is_some());
            assert_eq!(def.get("prompt").and_then(|v| v.as_str()), Some(WORKER_BODY));
            // Full tool freedom is a project rule: a worker inherits everything.
            assert!(def.get("tools").is_none(), "we never restrict a worker's toolset");
        }
    }

    #[test]
    fn a_pinned_sub_model_gets_one_worker_on_that_model() {
        let o = prepare_orchestration("claude-haiku-4-5-20251001", &[]);
        let defs: Value = serde_json::from_str(&o.agents).unwrap();
        let obj = defs.as_object().unwrap();
        assert_eq!(obj.len(), 1);
        let (name, def) = obj.iter().next().unwrap();
        assert!(o.note.contains(name.as_str()));
        assert_eq!(def.get("model").and_then(|v| v.as_str()), Some("claude-haiku-4-5-20251001"));
    }
}
