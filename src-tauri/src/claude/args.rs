//! Building a `claude` invocation: the base flags, the mode, the per-chat and
//! per-session flags, and the command itself (with the system prompt spilled to
//! a file).

use super::*;

/// Shared base flags for every claude invocation. `sys_prompt` must be a single
/// line (see capability_prompt). Mirrors `baseArgs` in server.js.
pub fn base_args(model: &str, sys_prompt: &str) -> Vec<String> {
    let mut args = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--dangerously-skip-permissions".into(),
        "--append-system-prompt".into(),
        sys_prompt.to_string(),
    ];
    // Always honour the caller's exact model selection. `model` reaches the CLI
    // as a real argv entry (never a shell string), so we forward *any* usable id
    // — including dynamic catalogue shapes we never hardcoded (see `catalog.rs`).
    // The only ids we can't pass are empty or whitespace/control-laden ones; if
    // one slips through we log it rather than silently drop `--model` and let the
    // CLI fall back to its own default (which would NOT be what the user picked).
    if is_safe_model_arg(model) {
        args.push("--model".into());
        args.push(model.to_string());
    } else if !model.is_empty() {
        eprintln!("krystal: refusing to forward malformed model id {model:?}; claude will use its default");
    }
    args
}

/// Apply a chat "mode" to freshly-built base args. `auto` keeps full power
/// (the default skip-permissions base). `plan` drops write access and asks
/// Claude to research and propose a plan instead of changing anything.
///
/// `ask` is the terminal's own behaviour: reading is free, and anything that
/// would change a file or run a command stops for a yes or no. In a terminal the
/// CLI draws that prompt itself; headless it has nobody to ask and would simply
/// refuse — unless a *host* answers, which is what `--permission-prompt-tool
/// stdio` sets up: each prompt arrives as a `control_request` on stdout and is
/// answered on stdin (see `permission_prompt` and `session.rs`). The CLI still
/// decides *what* needs asking, so the user's own allow/deny rules in
/// `.claude/settings*.json` apply here exactly as they do in a terminal.
///
/// `default` rather than leaving the mode unset: a `defaultMode` in the user's
/// settings would otherwise decide what a mode called "Ask" means.
///
/// `edits` and `guarded` are the two steps between Ask and full access, and both
/// are Claude Code's own: `acceptEdits` lets file edits through and still asks
/// about the rest; `auto` asks about nothing but has a classifier look at each
/// action first. Either can still end up with a question for the user, so both
/// get the same host-answered prompt Ask does.
pub fn apply_mode(args: &mut Vec<String>, mode: &str) {
    let permission_mode = match mode {
        "plan" => "plan",
        "ask" => "default",
        "edits" => "acceptEdits",
        "guarded" => "auto",
        _ => return,
    };
    args.retain(|a| a != "--dangerously-skip-permissions");
    args.push("--permission-mode".into());
    args.push(permission_mode.into());
    if mode != "plan" {
        args.push("--permission-prompt-tool".into());
        args.push("stdio".into());
    }
}

/// Let a chat reach folders outside the project (`--add-dir`). A project is one
/// folder by default, which is the right default and the wrong limit: assets,
/// notes and a second repo routinely live somewhere else, and without this the
/// only way to include them is to make them the project.
///
/// Order is stable (oldest first, straight from the DB) because these args are
/// part of the session key — a reshuffled list would retire the warm process for
/// no reason. Blank entries are dropped rather than passed on as an empty flag.
pub fn apply_extra_dirs(args: &mut Vec<String>, dirs: &[String]) {
    for dir in dirs.iter().map(|d| d.trim()).filter(|d| !d.is_empty()) {
        args.push("--add-dir".into());
        args.push(dir.to_string());
    }
}

/// Turn a chat invocation into a *session*: messages arrive as JSON lines on
/// stdin instead of one prompt followed by EOF, so the process serves every turn
/// of the chat rather than exiting after the first (see `session.rs`).
pub fn apply_session_flags(args: &mut Vec<String>) {
    args.push("--input-format".into());
    args.push("stream-json".into());
}

/// Hand the session Krystal's own artifact tool (see `artifacts.rs`). The CLI has
/// no Artifact tool of its own — that is something the *host* application
/// provides — so this is what makes `mcp__krystal__artifact` exist at all.
///
/// Deliberately not `--strict-mcp-config`: that would switch off any MCP servers
/// the user has configured for themselves, and adding a feature is no reason to
/// take theirs away.
pub fn apply_artifact_tool(args: &mut Vec<String>, config: &std::path::Path) {
    args.push("--mcp-config".into());
    args.push(config.to_string_lossy().to_string());
}

/// Flags that only make sense on a live chat turn, layered on top of `base_args`.
/// The internal one-off calls (naming a chat, drafting tasks, the Initialize
/// wizard) deliberately skip these: they are short, single-shot and disposable.
///
/// * `--effort` — reasoning depth (see `models::EFFORTS`). The biggest quality
///   lever after the model itself, and the one terminal Claude Code users have
///   had all along.
/// * `--fallback-model` — an overloaded primary model degrades to the next tier
///   instead of failing the turn outright. Print-mode only, which is all we run.
/// * `--autocompact auto` — let the CLI compact a conversation that outgrows its
///   window, natively and mid-turn. Krystal's own Compact button still exists for
///   when the *user* wants a reset; this is the safety net underneath it.
/// * `--forward-subagent-text` — a sub-agent's own words come through the stream
///   too, not just the tools it reaches for, so the agent inspector can show what
///   a worker is saying rather than only a list of file names.
/// * `--prompt-suggestions` — asks the CLI to predict a sensible next message and
///   emit it as a `prompt_suggestion` event. It only fires once a conversation has
///   some history, and only when the model has a confident guess, so treat it as
///   a bonus rather than something the UI can count on.
pub fn apply_chat_flags(
    args: &mut Vec<String>,
    effort: &str,
    fallback: Option<&str>,
    suggestions: bool,
) {
    if models::is_valid_effort(effort) {
        args.push("--effort".into());
        args.push(effort.into());
    }
    if let Some(chain) = fallback.filter(|c| !c.is_empty()) {
        args.push("--fallback-model".into());
        args.push(chain.into());
    }
    args.push("--autocompact".into());
    args.push("auto".into());
    args.push("--forward-subagent-text".into());
    if suggestions {
        args.push("--prompt-suggestions".into());
    }
}

/// Temp file holding a spilled `--append-system-prompt` value. Removed on drop
/// (i.e. once the claude child has exited and the spawn fn returns).
pub struct SysPromptFile(Option<PathBuf>);

impl Drop for SysPromptFile {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Move an inline `--append-system-prompt <value>` onto disk and switch to
/// `--append-system-prompt-file <path>`.
///
/// Why: on Windows the resolved `claude` is usually a `claude.cmd` shim that
/// forwards its arguments via `%*`, which *re-tokenizes* them. Our system prompt
/// carries embedded quotes (the `krystal-ask` JSON example) and option-like
/// tokens (the pandoc hints `-t markdown` / `-o out.docx`); once re-split, a
/// stray `-t` reaches `claude` as an unknown option and the whole turn fails
/// with `error: unknown option '-t'`. Keeping the prompt off the command line
/// sidesteps the shim's quoting entirely. Falls back to the original args if the
/// file can't be written, so a temp-dir hiccup never blocks a chat.
pub fn spill_system_prompt(args: &[String]) -> (Vec<String>, SysPromptFile) {
    if let Some(i) = args.iter().position(|a| a == "--append-system-prompt") {
        if let Some(value) = args.get(i + 1) {
            // Unique per process + call; avoids Date/random (unavailable here)
            // while staying collision-free across concurrent streams.
            let seq = SYS_PROMPT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("krystal-sysprompt-{}-{}.txt", std::process::id(), seq));
            if std::fs::write(&path, value).is_ok() {
                let mut out = args.to_vec();
                out[i] = "--append-system-prompt-file".into();
                out[i + 1] = path.to_string_lossy().into_owned();
                return (out, SysPromptFile(Some(path)));
            }
        }
    }
    (args.to_vec(), SysPromptFile(None))
}

static SYS_PROMPT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn claude_command(bin: &str, args: &[String], cwd: &str) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // Stream a sub-agent's own prose, not just its tool calls, so the Activity
        // panel and the agent inspector can show what a worker is *doing* instead
        // of sitting blank while it thinks (see `emit_agent_activity`). The env
        // form of `--forward-subagent-text`: older CLIs ignore it, where an
        // unknown flag would kill the turn.
        .env("CLAUDE_CODE_FORWARD_SUBAGENT_TEXT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Don't flash a console window for the claude.cmd child on Windows.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode_args(mode: &str) -> Vec<String> {
        let mut args = base_args("claude-opus-5-5", "sys");
        apply_mode(&mut args, mode);
        args
    }

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn auto_mode_keeps_full_power() {
        let args = mode_args("auto");
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(!args.iter().any(|a| a == "--permission-prompt-tool"));
    }

    #[test]
    fn ask_mode_asks_and_routes_the_question_to_the_host() {
        let args = mode_args("ask");
        // Skipping permissions and asking for them cannot both be on.
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(has_pair(&args, "--permission-mode", "default"));
        // Without this the CLI has nobody to ask and refuses everything instead.
        assert!(has_pair(&args, "--permission-prompt-tool", "stdio"));
    }

    #[test]
    fn the_in_between_modes_are_claude_codes_own_and_can_still_ask() {
        for (mode, flag) in [("edits", "acceptEdits"), ("guarded", "auto")] {
            let args = mode_args(mode);
            assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"), "{mode}");
            assert!(has_pair(&args, "--permission-mode", flag), "{mode}");
            // Whatever they don't wave through still needs somebody to ask.
            assert!(has_pair(&args, "--permission-prompt-tool", "stdio"), "{mode}");
        }
    }

    #[test]
    fn plan_mode_has_no_prompt_to_answer() {
        let args = mode_args("plan");
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(has_pair(&args, "--permission-mode", "plan"));
        assert!(!args.iter().any(|a| a == "--permission-prompt-tool"));
    }

    #[test]
    fn spill_moves_system_prompt_to_a_file() {
        let sys = "help {\"q\":\"x\"} pandoc 'f.docx' -t markdown -o out.docx";
        let args = base_args("claude-haiku-4-5-20251001", sys);
        let (out, guard) = spill_system_prompt(&args);

        // The inline flag is gone; the file variant carries a real path.
        assert!(!out.iter().any(|a| a == "--append-system-prompt"));
        let i = out
            .iter()
            .position(|a| a == "--append-system-prompt-file")
            .expect("file flag present");
        let path = &out[i + 1];
        // No option-like token (e.g. the pandoc `-t`) is left on the command line.
        assert!(!out.iter().any(|a| a == "-t"));
        // The prompt round-trips verbatim through the file.
        assert_eq!(std::fs::read_to_string(path).unwrap(), sys);

        let owned = path.clone();
        drop(guard);
        assert!(!std::path::Path::new(&owned).exists(), "file cleaned up on drop");
    }

    #[test]
    fn spill_is_a_noop_without_a_system_prompt() {
        let args = vec!["-p".to_string(), "--verbose".to_string()];
        let (out, _guard) = spill_system_prompt(&args);
        assert_eq!(out, args);
    }

    #[test]
    fn base_args_forwards_the_selected_model_verbatim() {
        // The exact id the user picked must ride through as `--model <id>`.
        let args = base_args("claude-opus-4-8", "sys");
        let i = args.iter().position(|a| a == "--model").expect("--model present");
        assert_eq!(args[i + 1], "claude-opus-4-8");

        // A dynamic id we never hardcoded is still forwarded (no prefix gating).
        let args = base_args("some-future-model-9", "sys");
        let i = args.iter().position(|a| a == "--model").expect("--model present");
        assert_eq!(args[i + 1], "some-future-model-9");

        // Only an un-forwardable id is dropped — never a real selection.
        let args = base_args("bad id", "sys");
        assert!(!args.iter().any(|a| a == "--model"));
    }

    #[test]
    fn session_flags_make_the_process_reusable() {
        let mut args = base_args("claude-opus-5", "sys");
        apply_session_flags(&mut args);
        let i = args
            .iter()
            .position(|a| a == "--input-format")
            .expect("--input-format present");
        assert_eq!(args[i + 1], "stream-json");
    }

    #[test]
    fn extra_dirs_become_add_dir_flags_in_order() {
        let mut args = base_args("claude-opus-5", "sys");
        apply_extra_dirs(
            &mut args,
            &["/shared/assets".into(), "  ".into(), "/notes".into()],
        );
        let flags: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(i, _)| *i > 0 && args[i - 1] == "--add-dir")
            .map(|(_, a)| a)
            .collect();
        assert_eq!(flags, ["/shared/assets", "/notes"], "blank entries dropped");
        assert_eq!(args.iter().filter(|a| *a == "--add-dir").count(), 2);
    }

    #[test]
    fn no_extra_dirs_adds_nothing() {
        let mut args = base_args("claude-opus-5", "sys");
        let before = args.len();
        apply_extra_dirs(&mut args, &[]);
        assert_eq!(args.len(), before);
    }

    #[test]
    fn chat_flags_carry_effort_fallback_and_autocompact() {
        let mut args = base_args("claude-opus-5", "sys");
        apply_chat_flags(&mut args, "xhigh", Some("claude-sonnet-5"), true);
        let at = |flag: &str| args.iter().position(|a| a == flag);
        assert_eq!(args[at("--effort").expect("--effort present") + 1], "xhigh");
        assert_eq!(
            args[at("--fallback-model").expect("--fallback-model present") + 1],
            "claude-sonnet-5"
        );
        assert_eq!(args[at("--autocompact").expect("--autocompact present") + 1], "auto");
        assert!(at("--prompt-suggestions").is_some());
    }

    #[test]
    fn chat_flags_skip_what_they_have_no_value_for() {
        // An unknown effort must not reach the CLI as `--effort <garbage>` (that
        // fails the whole turn); no fallback and no suggestions simply add nothing.
        let mut args = base_args("claude-opus-5", "sys");
        apply_chat_flags(&mut args, "turbo", None, false);
        assert!(!args.iter().any(|a| a == "--effort"));
        assert!(!args.iter().any(|a| a == "--fallback-model"));
        assert!(!args.iter().any(|a| a == "--prompt-suggestions"));
    }

    #[test]
    fn the_system_prompt_survives_being_multi_line() {
        // The single-line rule is gone because the prompt is spilled to a file.
        // Guard the mechanism that made that safe, not the old constraint.
        let sys = capability_prompt(Caps { pandoc: true, python_docx: true }, "hr");
        assert!(sys.contains('\n'), "written as sections, not one run-on line");
        assert!(sys.contains("## Reply language"));
        let args = base_args("claude-opus-5", &sys);
        let (out, _guard) = spill_system_prompt(&args);
        assert!(!out.iter().any(|a| a == "--append-system-prompt"));
        let i = out
            .iter()
            .position(|a| a == "--append-system-prompt-file")
            .expect("spilled to a file");
        assert_eq!(std::fs::read_to_string(&out[i + 1]).unwrap(), sys);
    }
}
