//! What Claude is told: the system prompt appended to every chat, and the
//! message assembled for each turn.

use super::*;

/// English name of a UI language code — used only as the *fallback* reply
/// language for a message too short to identify, never as an override.
pub fn lang_label(code: &str) -> &'static str {
    match code {
        "hr" => "Croatian (hrvatski)",
        _ => "English",
    }
}

/// System prompt appended on every turn.
///
/// This used to be forced onto a SINGLE line, because it was passed as a literal
/// command-line argument and Rust refuses to escape newlines into the Windows
/// `claude.cmd` batch shim. That constraint is gone: `spill_system_prompt` writes
/// the whole thing to a file and switches the flag to `--append-system-prompt-file`
/// before it ever reaches the CLI. So it is written the way instructions are
/// actually best read — short sections under headings, one rule per line.
///
/// `ui_lang` is the app's interface language ('en' | 'hr'); it only decides the
/// tie-break for messages that carry no language signal of their own.
pub fn capability_prompt(caps: Caps, ui_lang: &str) -> String {
    let mut p = String::new();

    p.push_str(
        "You are helping the user with the files and work in the current project folder.
         Read CLAUDE.md (if present) for what this project is about.

",
    );

    // The reply language used to be one clause tacked onto the CLAUDE.md line,
    // which lost every time the project's own files were written in another
    // language — an English opener could still come back in Croatian. It is now
    // its own section with a stated tie-break.
    p.push_str(&format!(
        "## Reply language
         Decide this before you write anything: reply in the SAME language as the user's LATEST message, judged from that message alone.
         The language of CLAUDE.md, of the project's files, folder names, earlier chats, or of the app's interface NEVER decides your reply language — if the user writes in English you answer in English even when everything around you is in another language, and vice versa.
         Only when a message carries no language signal at all (\"ok\", a bare path, a link, an emoji) do you keep the language of the last message that did; if there is none, use {}.
         When you write any file that may contain Croatian text, always use UTF-8 so diacritics (č, ć, ž, š, đ) are preserved exactly.

",
        lang_label(ui_lang)
    ));

    p.push_str(
        "## Choice cards
         When you want the user to choose between a few clear options, present a choice card instead of asking in prose: output a fenced code block tagged krystal-ask whose body is valid JSON of the form {\"questions\":[{\"question\":\"…\",\"header\":\"short label\",\"multiSelect\":false,\"options\":[{\"label\":\"…\",\"description\":\"…\"}]}]} — this app renders it as clickable cards with a custom-answer box.
         Emit that block as the very last thing in your reply and then STOP; the user's selection (or typed answer) arrives as their next message, so just continue naturally from it.
         Use it only for genuine forks where the choice changes what you do — never for routine questions.

",
    );

    // The process now survives between turns (see session/), so the old reason
    // for this rule — "your process is about to exit" — is no longer true. The rule
    // itself still is, for a different reason: Krystal renders exactly one reply per
    // message and stops listening at the turn's `result` event, so anything that
    // reports back later has nowhere to appear. It is also not guaranteed a session
    // survives: changing model/effort/mode, compacting, or going idle retires it.
    p.push_str(
        "## No background work
         IMPORTANT: this app shows exactly one reply per message and stops listening the moment your reply ends, so anything that reports back later has nowhere to appear. The session may also be restarted between messages.
         Never run Bash/PowerShell commands with run_in_background=true, and never launch background agents or tasks you intend to check later — you will not get to report what they found.
         Run long commands in the FOREGROUND with a generous timeout (up to 10 minutes) and wait for them inside the same reply; if something would take longer, break it into explicit steps the user triggers one reply at a time.

",
    );

    // The shell tools' `description` is optional, and Krystal names each step
    // by it (the action chip, the Activity panel). Without one the user is left
    // reading the raw command — which most of them can't.
    p.push_str(
        "## Commands
         Give every Bash/PowerShell call a short plain-language `description` of what it is for (\"Run the tests\", \"Search the code for the login form\"). The app shows it to the user as the name of that step, and many users can't read shell commands.

",
    );

    p.push_str("## Word documents
");
    if caps.pandoc {
        p.push_str(
            "Word documents (.docx) ARE supported via pandoc.
             To READ a .docx, run: pandoc 'file.docx' -t markdown (then read its text).
             To CREATE/replace a .docx from markdown, run: pandoc 'draft.md' -o 'out.docx'.
             A reference doc can carry styling: pandoc in.md -o out.docx --reference-doc=ref.docx.
",
        );
    }
    if caps.python_docx {
        p.push_str(
            "For SURGICAL edits that must preserve a .docx's existing formatting, use the python-docx library from a short python script (import docx) rather than pandoc.
",
        );
    }
    if !caps.pandoc && !caps.python_docx {
        p.push_str(
            "NOTE: Word (.docx) tooling is not installed, so you cannot open or write .docx files directly. If asked, tell the user to install pandoc and python-docx to enable Word support.
",
        );
    }

    p
}

/// Appended to the system prompt when the artifact tool is available. The tool's
/// own description says what an artifact *is*; this says when Krystal wants one,
/// which is the part a tool schema can't express on its own.
pub const ARTIFACT_NOTE: &str = "ARTIFACTS. You have an artifact tool (mcp__krystal__artifact). Krystal shows an artifact in a panel beside the conversation, and the user can open it, keep it, or send the file to someone else — so it is the right home for anything that is a finished *thing* rather than an explanation: a page, a chart, a diagram, a poster, a report, a small app. Prefer it over a fenced code block whenever the user would plausibly want to look at the result rather than read the source, and over writing a file whenever the thing is for the user rather than for the project's codebase. Revise an existing artifact (same id) instead of making a near-duplicate. Everyday coding work — editing the project's own source files — still belongs in the repo, not in an artifact.";

/// True when `text` opens with a `/skill-name` invocation — the CLI reads one
/// only at the very start of a prompt, and only as a bare word ending the token
/// (`/code-review the login screen`). A path like `/usr/bin` or a lone `/` is
/// not one.
fn starts_with_slash_command(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('/') else { return false };
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    if name.is_empty() || !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return false;
    }
    match rest[name.len()..].chars().next() {
        None => true,
        Some(c) => c.is_whitespace(),
    }
}

/// Assemble the message sent for one turn.
///
/// Everything but `text` is background: the task-list note, a compact seed, the
/// transcripts of #-referenced chats, the paths of attached files. `notes` used
/// to be appended to the system prompt and can't live there any more — the
/// system prompt is fixed when the session process starts, and the task list
/// changes whenever Claude ticks something off.
///
/// Background leads the message and is fenced off from the user's own words, so
/// it reads as standing context for what follows. The one exception is a message
/// that opens with `/skill-name`: the CLI only invokes a skill when the slash is
/// the first thing in the prompt, so putting anything ahead of it would quietly
/// demote the invocation to a line of prose. Those messages lead, and their
/// background follows.
pub fn build_prompt(
    text: &str,
    files: &[String],
    seed: Option<&str>,
    references: Option<&str>,
    notes: Option<&str>,
) -> String {
    let mut blocks: Vec<String> = Vec::new();
    if let Some(notes) = notes.filter(|n| !n.is_empty()) {
        blocks.push(notes.to_string());
    }
    if let Some(seed) = seed.filter(|s| !s.is_empty()) {
        blocks.push(format!(
            "Summary of our conversation so far (use it to continue seamlessly):\n{seed}"
        ));
    }
    if let Some(refs) = references.filter(|r| !r.is_empty()) {
        blocks.push(refs.to_string());
    }
    if !files.is_empty() {
        let mut b = String::from("Referenced files (read these as needed):");
        for f in files {
            b.push_str("\n- ");
            b.push_str(f);
        }
        blocks.push(b);
    }
    if blocks.is_empty() {
        return text.to_string();
    }
    let context = blocks.join("\n\n---\n\n");
    if starts_with_slash_command(text) {
        format!("{text}\n\n---\n\n{context}")
    } else {
        format!("{context}\n\n---\n\n{text}")
    }
}

pub(super) fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_turn_notes_lead_the_message_and_are_fenced_off() {
        // The task note can't live in the system prompt any more (it changes every
        // time a task is ticked off, which would retire the session each turn), so
        // it rides on the message — ahead of, and separated from, the user's words.
        let p = build_prompt("do the thing", &[], None, None, Some("OPEN TASKS: one, two"));
        assert!(p.starts_with("OPEN TASKS: one, two"));
        assert!(p.contains("---"));
        assert!(p.trim_end().ends_with("do the thing"));

        // No notes, no fence — an ordinary message is untouched.
        let plain = build_prompt("hello", &[], None, None, None);
        assert_eq!(plain, "hello");
        assert_eq!(build_prompt("hello", &[], None, None, Some("")), "hello");
    }

    #[test]
    fn a_slash_command_stays_at_the_head_of_the_prompt() {
        // Background context normally leads. It must not, here: the CLI reads
        // `/skill-name` only as the very first thing in the prompt, so a task
        // note in front of it would silently turn the skill into prose.
        let p = build_prompt(
            "/code-review the login screen",
            &["C:/shot.png".into()],
            None,
            None,
            Some("OPEN TASKS: one, two"),
        );
        assert!(p.starts_with("/code-review the login screen"), "{p}");
        assert!(p.contains("OPEN TASKS: one, two"), "context is still there: {p}");
        assert!(p.contains("C:/shot.png"), "attachments are still there: {p}");
    }

    #[test]
    fn only_a_real_slash_command_reorders_the_prompt() {
        assert!(starts_with_slash_command("/run"));
        assert!(starts_with_slash_command("/code-review the diff"));
        assert!(starts_with_slash_command("/git:sync\nand then"));
        // A path, a lone slash, a fraction — none of these invoke anything.
        assert!(!starts_with_slash_command("/usr/bin/env"));
        assert!(!starts_with_slash_command("/"));
        assert!(!starts_with_slash_command("/ leading space"));
        assert!(!starts_with_slash_command("/-dash-first"));
        assert!(!starts_with_slash_command("look at /etc/hosts"));
        // …so an ordinary message still gets its context first.
        let p = build_prompt("/usr/bin matters", &[], None, None, Some("NOTE"));
        assert!(p.starts_with("NOTE"), "{p}");
    }
}
