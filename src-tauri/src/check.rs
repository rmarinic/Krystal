//! "Done means checked": a project's **check command** (its tests, a type check,
//! a build), run whenever a turn that changed files is about to finish, so a
//! reply can't land with the project broken and nobody told.
//!
//! It rides on Claude Code's own **Stop hook** rather than on an instruction:
//! a prompt can be forgotten mid-task, a hook can't. When the check fails, the
//! hook exits 2 and its error output goes back to Claude as "Stop hook feedback",
//! and Claude carries on in the same turn to fix it (checked against CLI
//! 2.1.318). Two failed checks in a row and it stops blocking: the turn ends and
//! says so, rather than going round in circles over a failure that may have been
//! there before Claude touched anything.
//!
//! The hook is **this same executable**, relaunched with `HOOK_FLAG`, as the
//! artifact MCP server is (`artifacts.rs`). Krystal hands the session a settings
//! file with that hook in it (`--settings`), which Claude Code merges with the
//! user's own settings, so their hooks still run. With `--include-hook-events`
//! the stream reports the hook starting and what it printed, which is how the
//! window shows "Checking…" and the result (`report_from_hook`). Nothing else
//! travels between the two processes.
//!
//! The hook runs the check only when the turn used a file-editing tool, which
//! it reads from the session's transcript (`turn_edited`). An answer to a
//! question never waits on a test run. A file only a shell command changed is
//! not noticed; if the transcript can't be read, the check runs anyway.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

/// The argument that makes this executable the check hook instead of the app.
pub const HOOK_FLAG: &str = "--krystal-check-hook";
/// The key of the one line of JSON the hook prints for Krystal to read.
pub const REPORT_KEY: &str = "krystalCheck";
/// Failed checks Claude is sent back to fix in one turn before the hook lets go.
const MAX_BLOCKS: u32 = 2;
/// How long a check may run. Under the hook's own limit, so a hung test suite is
/// reported as such instead of the CLI killing the hook.
const RUN_TIMEOUT_SECS: u64 = 540;
const HOOK_TIMEOUT_SECS: u64 = 600;
/// How much of a failing check's output Claude is shown (the end, where test
/// runners and compilers put the summary), and how much the chip keeps.
const FEEDBACK_TAIL: usize = 3000;
const REPORT_TAIL: usize = 1500;
/// The tools that change files. A turn that used none of them isn't checked.
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// Is `name` one of the tools that change files?
pub fn is_edit_tool(name: &str) -> bool {
    EDIT_TOOLS.contains(&name)
}

/* ------------------------------ the settings ----------------------------- */

/// Write (if changed) the hook's config and the settings file that installs it,
/// and return the settings file's path, for `--settings`.
///
/// Both file names carry a hash of the command. The path is a session flag, so
/// changing the command changes the session key and the next message starts a
/// session that runs the new one.
pub fn ensure_settings(data_dir: &Path, project_key: &str, command: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = data_dir.join("checks");
    std::fs::create_dir_all(&dir).ok()?;
    let tag = &crate::util::fnv_hex(command)[..8];
    let cfg = dir.join(format!("{project_key}-{tag}.json"));
    write_if_changed(&cfg, &json!({ "command": command, "stateDir": dir.join("state") }))?;
    let settings = dir.join(format!("{project_key}-{tag}.settings.json"));
    write_if_changed(&settings, &settings_json(&exe, &cfg))?;
    Some(settings)
}

/// The settings that install the hook. Paths use forward slashes and are
/// quoted, which every shell the CLI may run a hook in (bash, cmd) reads the
/// same way, spaces in a user folder included.
fn settings_json(exe: &Path, cfg: &Path) -> Value {
    let fwd = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let command = format!("\"{}\" {HOOK_FLAG} \"{}\"", fwd(exe), fwd(cfg));
    json!({ "hooks": { "Stop": [ { "hooks": [
        { "type": "command", "command": command, "timeout": HOOK_TIMEOUT_SECS }
    ] } ] } })
}

fn write_if_changed(path: &Path, value: &Value) -> Option<()> {
    let text = serde_json::to_string_pretty(value).ok()?;
    if std::fs::read_to_string(path).map(|old| old != text).unwrap_or(true) {
        std::fs::write(path, &text).ok()?;
    }
    Some(())
}

/// What the session's system prompt says about the check, so Claude can run it
/// itself before finishing rather than learn about it from a failure.
pub fn prompt_note(command: &str) -> String {
    format!(
        "## Checks\n\
         This project has a check command: `{command}`. When you finish a reply in which you changed files, the app runs it, and if it fails you'll be shown its output and should fix what it reports before finishing. Running it yourself before you finish saves a round trip. If it fails for a reason that has nothing to do with your changes, say so to the user instead of chasing it."
    )
}

/// A check command to offer for a project, read off its build files: what a
/// developer would run to see whether the project still works. None when
/// nothing says.
pub fn suggest_command(project: &Path) -> Option<String> {
    let has = |f: &str| project.join(f).exists();
    if let Ok(pkg) = std::fs::read_to_string(project.join("package.json")) {
        let test = serde_json::from_str::<Value>(&pkg).ok().and_then(|v| {
            v.get("scripts").and_then(|s| s.get("test")).and_then(|t| t.as_str()).map(str::to_string)
        });
        // `npm init`'s placeholder only says there are no tests.
        if test.is_some_and(|t| !t.contains("no test specified")) {
            return Some("npm test".into());
        }
    }
    if has("Cargo.toml") {
        return Some("cargo test".into());
    }
    if has("go.mod") {
        return Some("go test ./...".into());
    }
    if has("pytest.ini") || has("conftest.py") || (has("pyproject.toml") && has("tests")) {
        return Some("python -m pytest -q".into());
    }
    None
}

/* -------------------------- reading the stream --------------------------- */

/// The report the hook printed, if `ev` is the `hook_response` of a Stop hook
/// that was ours. Other hooks' responses (the user's own) give None.
pub fn report_from_hook(ev: &Value) -> Option<Value> {
    if ev.get("subtype").and_then(|v| v.as_str()) != Some("hook_response")
        || ev.get("hook_event").and_then(|v| v.as_str()) != Some("Stop")
    {
        return None;
    }
    let stdout = ev.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
    stdout.lines().find_map(|line| {
        serde_json::from_str::<Value>(line.trim()).ok()?.get(REPORT_KEY).cloned()
    })
}

/* ------------------------------- the hook -------------------------------- */

/// Did the turn now ending use a file-editing tool? Read off the session's
/// transcript (JSONL): a turn starts at a `user` entry the user sent, that is,
/// not a tool result, not the CLI's own `isMeta` note (Stop-hook feedback is
/// one of those, and the turn it continues has not ended), and not a sub-agent's.
pub fn turn_edited(transcript: &str) -> bool {
    let mut edited = false;
    for line in transcript.lines() {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        match e.get("type").and_then(|v| v.as_str()) {
            Some("user") if starts_turn(&e) => edited = false,
            Some("assistant") if uses_edit_tool(&e) => edited = true,
            _ => {}
        }
    }
    edited
}

/// Did Claude edit a file since the check last sent it back? If not, a check
/// that still fails will fail the same way, and sending it back again only
/// costs a round trip: it has already decided the failure isn't its to fix
/// (seen with the real CLI). True when there was no feedback to begin with.
pub fn edited_since_feedback(transcript: &str) -> bool {
    let mut edited = true;
    for line in transcript.lines() {
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        match e.get("type").and_then(|v| v.as_str()) {
            Some("user") if is_hook_feedback(&e) => edited = false,
            Some("assistant") if uses_edit_tool(&e) => edited = true,
            _ => {}
        }
    }
    edited
}

/// The CLI's note handing a Stop hook's complaint back to Claude.
fn is_hook_feedback(e: &Value) -> bool {
    if !e.get("isMeta").and_then(|v| v.as_bool()).unwrap_or(false) {
        return false;
    }
    let text = match e.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Array(blocks)) => blocks.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect(),
        _ => String::new(),
    };
    text.starts_with("Stop hook feedback")
}

fn starts_turn(e: &Value) -> bool {
    let flag = |k: &str| e.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    if flag("isMeta") || flag("isSidechain") {
        return false;
    }
    match e.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(_)) => true,
        Some(Value::Array(blocks)) => !blocks.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result")),
        _ => false,
    }
}

fn uses_edit_tool(e: &Value) -> bool {
    e.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .is_some_and(|blocks| {
            blocks.iter().any(|b| {
                b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                    && b.get("name").and_then(|n| n.as_str()).is_some_and(is_edit_tool)
            })
        })
}

/// How one run of the check came out.
#[derive(Debug, Default)]
pub struct CheckRun {
    /// The exit code; None when it couldn't be started or was killed.
    pub code: Option<i32>,
    pub timed_out: bool,
    pub output: String,
    pub ms: u128,
}

/// What the hook does about a run.
#[derive(Debug, PartialEq)]
enum Verdict {
    /// It passed: let the turn end.
    Passed,
    /// It failed: send Claude back to fix it (exit 2).
    Retry,
    /// It failed again, and Claude has had its tries: let the turn end, failed.
    GaveUp,
    /// It never finished: let the turn end and say so. A hung suite isn't
    /// something another pass would fix.
    TimedOut,
}

/// `changed`: Claude edited something since the check last sent it back (always
/// true the first time round).
fn verdict(run: &CheckRun, blocks_before: u32, changed: bool) -> Verdict {
    if run.timed_out {
        Verdict::TimedOut
    } else if run.code == Some(0) {
        Verdict::Passed
    } else if blocks_before < MAX_BLOCKS && changed {
        Verdict::Retry
    } else {
        Verdict::GaveUp
    }
}

/// What Claude is told when the check fails.
fn feedback(command: &str, run: &CheckRun) -> String {
    let code = run.code.map(|c| c.to_string()).unwrap_or_else(|| "none".into());
    format!(
        "Krystal ran this project's check after your changes, and it failed.\n\
         Command: `{command}` (exit code {code})\n\
         Fix what it reports, then finish. If the failure has nothing to do with your changes (it was failing before you started), don't chase it: tell the user that and finish.\n\n\
         The end of its output:\n{}",
        crate::util::tail_chars(run.output.trim_end(), FEEDBACK_TAIL)
    )
}

/// The report the hook prints for Krystal (`report_from_hook` reads it back).
fn report(command: &str, run: &CheckRun, verdict: &Verdict, attempt: u32) -> Value {
    json!({ REPORT_KEY: {
        "ok": *verdict == Verdict::Passed,
        "command": command,
        "code": run.code,
        "ms": run.ms as u64,
        "attempt": attempt,
        "retrying": *verdict == Verdict::Retry,
        "gaveUp": *verdict == Verdict::GaveUp,
        "timedOut": *verdict == Verdict::TimedOut,
        "output": crate::util::tail_chars(run.output.trim_end(), REPORT_TAIL),
    } })
}

/// Run as the Stop hook: read what the CLI says on stdin, maybe run the check,
/// print the report, and exit 0 (let the turn end) or 2 (send Claude back).
pub fn run_hook() -> ! {
    std::process::exit(hook_main())
}

fn hook_main() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    let cfg_path = args.iter().position(|a| a == HOOK_FLAG).and_then(|i| args.get(i + 1));
    let cfg: Value = cfg_path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    let command = cfg.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let state_dir = cfg.get("stateDir").and_then(|v| v.as_str()).map(PathBuf::from);

    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let input: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    let get = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("");

    // Read failing is no reason to skip the check; an empty one is.
    let transcript = std::fs::read_to_string(get("transcript_path")).ok();
    let edited = transcript.as_deref().map_or(true, turn_edited);
    let changed = transcript.as_deref().map_or(true, edited_since_feedback);
    if command.is_empty() || !edited {
        println!("{}", json!({ REPORT_KEY: { "skipped": true } }));
        return 0;
    }

    // Failed checks so far this turn. A first stop (not `stop_hook_active`)
    // starts the count over.
    let session = get("session_id");
    let count_file = state_dir
        .filter(|_| !session.is_empty())
        .map(|d| d.join(format!("{}.blocks", crate::util::fnv_hex(session))));
    let active = input.get("stop_hook_active").and_then(|v| v.as_bool()).unwrap_or(false);
    let blocks_before = if active {
        count_file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| t.trim().parse().ok()).unwrap_or(0)
    } else {
        0
    };

    let cwd = if get("cwd").is_empty() { std::env::current_dir().unwrap_or_default() } else { PathBuf::from(get("cwd")) };
    let run = run_check(&command, &cwd, std::time::Duration::from_secs(RUN_TIMEOUT_SECS));
    let v = verdict(&run, blocks_before, changed);
    println!("{}", report(&command, &run, &v, blocks_before + 1));
    if v != Verdict::Retry {
        if let Some(f) = &count_file {
            let _ = std::fs::remove_file(f);
        }
        return 0;
    }
    if let Some(f) = &count_file {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(f, (blocks_before + 1).to_string());
    }
    eprintln!("{}", feedback(&command, &run));
    2
}

/// Run the check in the project folder, through the same shell the RUN button
/// uses, with stdout and stderr together (in arrival order, near enough), and
/// kill its whole tree if it outlives `limit`.
pub fn run_check(command: &str, cwd: &Path, limit: std::time::Duration) -> CheckRun {
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};
    let started = std::time::Instant::now();

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        c.creation_flags(crate::claude::CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return CheckRun { output: format!("could not start the check: {e}"), ..Default::default() },
    };

    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    let readers: Vec<_> = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|mut pipe| {
        let out = out.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        })
    })
    .collect();

    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() >= limit => {
                timed_out = true;
                crate::claude::kill_process_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => break None,
        }
    };
    for r in readers {
        let _ = r.join();
    }
    let bytes = out.lock().unwrap().clone();
    CheckRun {
        code,
        timed_out,
        output: strip_ansi(&String::from_utf8_lossy(&bytes)),
        ms: started.elapsed().as_millis(),
    }
}

/// Drop terminal colour codes (`ESC [ … letter`) that a tool printed anyway.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for d in chars.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: Value) -> String {
        format!("{v}\n")
    }
    fn prompt(text: &str) -> String {
        line(json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }))
    }
    fn tool(name: &str) -> String {
        line(json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t", "name": name, "input": {} }] } }))
    }
    fn tool_result() -> String {
        line(json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t", "content": "ok" }] } }))
    }

    #[test]
    fn only_a_turn_that_edited_files_is_checked() {
        // As the transcript has it: a turn starts at the user's own message.
        let edited_then_asked = [prompt("fix it"), tool("Edit"), tool_result(), prompt("what is X?"), tool("Read"), tool_result()].concat();
        assert!(!turn_edited(&edited_then_asked), "the last turn only read");
        let edits_now = [prompt("what is X?"), prompt("now fix it"), tool("Read"), tool_result(), tool("Write"), tool_result()].concat();
        assert!(turn_edited(&edits_now));
        assert!(turn_edited(&[prompt("go"), tool("MultiEdit")].concat()));
        assert!(!turn_edited(&[prompt("go"), tool("Bash")].concat()), "a shell isn't seen as an edit");
    }

    #[test]
    fn the_hooks_own_feedback_does_not_start_a_new_turn() {
        // Claude edited, the check failed, the CLI fed that back as an `isMeta`
        // user note, and Claude is finishing again: still the same, edited turn.
        let t = [
            prompt("fix it"),
            tool("Edit"),
            tool_result(),
            line(json!({ "type": "user", "isMeta": true, "message": { "role": "user", "content": "Stop hook feedback:\nfailed" } })),
            tool("Read"),
            tool_result(),
        ]
        .concat();
        assert!(turn_edited(&t));
        // A sub-agent's prompt is no new turn either.
        let t2 = [prompt("go"), tool("Edit"), line(json!({ "type": "user", "isSidechain": true, "message": { "content": "explore" } }))].concat();
        assert!(turn_edited(&t2));
    }

    #[test]
    fn whether_claude_edited_since_the_check_sent_it_back() {
        let feedback = line(json!({ "type": "user", "isMeta": true,
            "message": { "role": "user", "content": "Stop hook feedback:
[krystal]: failed" } }));
        assert!(edited_since_feedback(&[prompt("go"), tool("Edit")].concat()), "no feedback yet");
        assert!(!edited_since_feedback(&[prompt("go"), tool("Edit"), feedback.clone(), tool("Read")].concat()), "only looked");
        assert!(edited_since_feedback(&[prompt("go"), tool("Edit"), feedback.clone(), tool("Edit")].concat()), "tried a fix");
        // Some other `isMeta` note is not the hook's feedback.
        let other = line(json!({ "type": "user", "isMeta": true, "message": { "content": "Caveat: …" } }));
        assert!(edited_since_feedback(&[prompt("go"), tool("Edit"), other].concat()));
    }

    #[test]
    fn a_failure_sends_claude_back_twice_then_lets_go() {
        let fail = CheckRun { code: Some(1), ..Default::default() };
        assert_eq!(verdict(&fail, 0, true), Verdict::Retry);
        assert_eq!(verdict(&fail, 1, true), Verdict::Retry);
        assert_eq!(verdict(&fail, 2, true), Verdict::GaveUp);
        assert_eq!(verdict(&CheckRun { code: Some(0), ..Default::default() }, 1, true), Verdict::Passed);
        let hung = CheckRun { timed_out: true, ..Default::default() };
        assert_eq!(verdict(&hung, 0, true), Verdict::TimedOut, "a hung suite isn't Claude's to retry");
        let unstartable = CheckRun { code: None, ..Default::default() };
        assert_eq!(verdict(&unstartable, 0, true), Verdict::Retry, "a command that won't start is a failure to report");
        // Claude changed nothing since it was sent back (it judged the failure
        // not its own): failing again ends the turn instead of a second round trip.
        assert_eq!(verdict(&fail, 1, false), Verdict::GaveUp);
        // …but a fix made some other way (a shell command) still passes.
        assert_eq!(verdict(&CheckRun { code: Some(0), ..Default::default() }, 1, false), Verdict::Passed);
    }

    #[test]
    fn claude_is_told_the_command_the_code_and_the_end_of_the_output() {
        let long: String = (0..400).map(|i| format!("test {i} ok\n")).collect();
        let run = CheckRun { code: Some(1), output: format!("{long}FAILED test_add: expected 4, got 5\n"), ..Default::default() };
        let f = feedback("npm test", &run);
        assert!(f.contains("`npm test` (exit code 1)"));
        assert!(f.contains("FAILED test_add: expected 4, got 5"));
        assert!(!f.contains("test 0 ok"), "only the end of a long log");
        assert!(f.contains("nothing to do with your changes"), "an out for a failure that was there before");
    }

    #[test]
    fn the_report_round_trips_through_a_hook_response() {
        let run = CheckRun { code: Some(1), output: "boom".into(), ms: 1200, ..Default::default() };
        let printed = report("cargo test", &run, &Verdict::Retry, 1);
        // The CLI hands back what the hook printed as `stdout`, other lines and all.
        let ev = json!({ "type": "system", "subtype": "hook_response", "hook_event": "Stop",
                         "stdout": format!("noise\r\n{printed}\r\n"), "exit_code": 2 });
        let r = report_from_hook(&ev).expect("ours");
        assert_eq!(r["ok"], false);
        assert_eq!(r["retrying"], true);
        assert_eq!(r["command"], "cargo test");
        assert_eq!(r["output"], "boom");
        // Someone else's Stop hook, or another hook event, is not ours.
        assert!(report_from_hook(&json!({ "subtype": "hook_response", "hook_event": "Stop", "stdout": "" })).is_none());
        let other = json!({ "subtype": "hook_response", "hook_event": "PreToolUse", "stdout": printed.to_string() });
        assert!(report_from_hook(&other).is_none());
    }

    #[test]
    fn the_settings_install_one_quoted_stop_hook() {
        let s = settings_json(Path::new(r"C:\Users\Jane Doe\AppData\Local\Krystal\krystal.exe"), Path::new(r"C:\data\checks\k.json"));
        let hook = &s["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(hook["type"], "command");
        assert_eq!(
            hook["command"],
            "\"C:/Users/Jane Doe/AppData/Local/Krystal/krystal.exe\" --krystal-check-hook \"C:/data/checks/k.json\""
        );
        assert!(hook["timeout"].as_u64().unwrap() > RUN_TIMEOUT_SECS, "the check times out before the hook does");
    }

    #[test]
    fn changing_the_command_changes_the_settings_path() {
        let dir = std::env::temp_dir().join(format!("krystal-check-{}", std::process::id()));
        let a = ensure_settings(&dir, "proj", "npm test").unwrap();
        let again = ensure_settings(&dir, "proj", "npm test").unwrap();
        let b = ensure_settings(&dir, "proj", "npm run lint").unwrap();
        assert_eq!(a, again, "same command, same session key");
        assert_ne!(a, b, "a new command starts a new session");
        let cfg = std::fs::read_to_string(dir.join("checks").join(a.file_name().unwrap().to_string_lossy().replace(".settings", ""))).unwrap();
        assert!(cfg.contains("npm test"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_project_suggests_its_own_check() {
        let dir = std::env::temp_dir().join(format!("krystal-suggest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(suggest_command(&dir), None);
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#).unwrap();
        assert_eq!(suggest_command(&dir), None, "npm's placeholder is no test");
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"test":"node tests/all.js"}}"#).unwrap();
        assert_eq!(suggest_command(&dir).as_deref(), Some("npm test"));
        std::fs::remove_file(dir.join("package.json")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]").unwrap();
        assert_eq!(suggest_command(&dir).as_deref(), Some("cargo test"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_check_runs_in_the_project_and_reports_its_exit_code_and_output() {
        let dir = std::env::temp_dir();
        let ok = run_check("echo all-good", &dir, std::time::Duration::from_secs(60));
        assert_eq!(ok.code, Some(0));
        assert!(ok.output.contains("all-good"), "{ok:?}");
        let bad = run_check("echo broken; exit 3", &dir, std::time::Duration::from_secs(60));
        assert_eq!(bad.code, Some(3));
        assert!(bad.output.contains("broken"));
    }

    #[test]
    fn a_check_that_outlives_its_limit_is_stopped() {
        let cmd = if cfg!(windows) { "Start-Sleep -Seconds 30" } else { "sleep 30" };
        let run = run_check(cmd, &std::env::temp_dir(), std::time::Duration::from_millis(1500));
        assert!(run.timed_out);
        assert!(run.ms < 20_000, "it was killed, not waited out: {}ms", run.ms);
    }

    #[test]
    fn colour_codes_are_dropped() {
        assert_eq!(strip_ansi("\u{1b}[31mFAIL\u{1b}[0m test"), "FAIL test");
    }
}
