//! One-off calls outside a chat's session: naming a chat, the plain text runs
//! behind Compact / Initialize / task drafting, and the composer's `$` shell.

use super::*;

/// Tidy a raw model reply into a usable chat title: first line only, no
/// surrounding quotes, trimmed trailing punctuation, capped to a few words.
fn clean_title(raw: &str) -> String {
    let line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let line = line.trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '*');
    let line = line.trim_end_matches(['.', '!', '?', ':', ';', ',']);
    let line = line.trim();
    let chars: Vec<char> = line.chars().collect();
    if chars.len() > 48 {
        let mut t: String = chars.iter().take(48).collect();
        t.push('…');
        t
    } else {
        line.to_string()
    }
}

/// How much of a reply the title call gets to read, from each end.
const TITLE_REPLY_HEAD: usize = 1200;
const TITLE_REPLY_TAIL: usize = 600;

/// The part of a reply worth titling from. A long answer says what it is about
/// at the top and what it came to at the bottom, so those two ends are kept and
/// the middle — where the working-out lives — is dropped.
fn title_excerpt(reply: &str) -> String {
    let reply = reply.trim();
    let chars: Vec<char> = reply.chars().collect();
    if chars.len() <= TITLE_REPLY_HEAD + TITLE_REPLY_TAIL {
        return reply.to_string();
    }
    let head: String = chars[..TITLE_REPLY_HEAD].iter().collect();
    let tail: String = chars[chars.len() - TITLE_REPLY_TAIL..].iter().collect();
    format!("{head}\n[…]\n{tail}")
}

/// Name a chat from the **answer** to its first message using the cheapest
/// model — a tiny one-off call kept deliberately short (small input, tiny
/// output) so it costs almost nothing and returns fast. The reply is what gets
/// summarized: an opening message is often a vague "can you look at this", and
/// only the answer says what the chat turned out to be about. The message rides
/// along as context for a reply that doesn't stand on its own. Returns None on
/// any failure (caller keeps the truncated first message). Never resumes a
/// session — it's standalone.
pub async fn generate_title(bin: &str, cwd: &str, user_prompt: &str, reply: &str) -> Option<String> {
    // The title names the chat's SUBJECT, not what happened in it: the chat goes
    // on being used for that subject, and "Fixed …" is stale by the next message.
    let sys = "You generate an extremely short title for a chat. Read the assistant's reply to work out \
        the SUBJECT of the conversation — the specific thing, area or topic it is about — and name that. \
        The title is a noun phrase naming the topic, never a description of what was done: no verbs of action \
        or outcome (fixed, added, updated, explained, investigating, how to…). \
        Good: \"Stop-button race in session pool\". Bad: \"Fixed the stop-button race in the session pool\". \
        Be specific — name the actual component or topic, not a generic label like \"Bug fix\" or \"Code question\". \
        The user's message is context only — do not just rephrase it. \
        Rules: 2–6 words, at most ~40 characters; no quotes; no trailing punctuation; no preamble or explanation. \
        Reply with ONLY the title, written in the same language as the assistant's reply.";
    let args = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        // Naming a chat needs no tool, and the prompt holds text a guest may
        // have written: whatever would need permission is simply refused.
        "--permission-mode".into(),
        "default".into(),
        "--model".into(),
        TITLE_MODEL.into(),
        "--append-system-prompt".into(),
        sys.into(),
    ];
    let prompt = format!(
        "Name the subject of this conversation.\n\n\
         ===== User's message (context) =====\n{}\n\n\
         ===== Assistant's reply (find the subject here) =====\n{}",
        take_chars(user_prompt, 400),
        title_excerpt(reply)
    );
    match run_claude_text(bin, &args, cwd, &prompt).await {
        Ok((text, _)) => {
            let t = clean_title(&text);
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        Err(_) => None,
    }
}

/// Run a one-off claude call (no streaming) and return its final text + usage.
/// Used by Compact, Hint and the Initialize wizard. Mirrors `runClaudeText`.
pub async fn run_claude_text(
    bin: &str,
    args: &[String],
    cwd: &str,
    prompt: &str,
) -> Result<(String, Option<Value>), String> {
    run_claude_text_live(bin, args, cwd, prompt, None).await
}

/// How often a one-off call reports how far its answer has got (`progress`).
const TEXT_PROGRESS_MS: u128 = 120;

/// What one stream event adds to a one-off call's answer: `(is_text, chars)` —
/// text the answer is made of, or thinking on the way to it. `None` for
/// anything else (tool calls, message bookkeeping).
fn answer_delta(ev: &Value) -> Option<(bool, usize)> {
    if ev.get("type")?.as_str()? != "stream_event" {
        return None;
    }
    let e = ev.get("event")?;
    if e.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    let d = e.get("delta")?;
    match d.get("type")?.as_str()? {
        "text_delta" => Some((true, d.get("text")?.as_str()?.chars().count())),
        "thinking_delta" => Some((false, d.get("thinking")?.as_str()?.chars().count())),
        _ => None,
    }
}

/// `run_claude_text`, telling `progress` as the answer is written:
/// `{ "chars": <answer so far>, "thought": <thinking so far> }`, at most every
/// `TEXT_PROGRESS_MS`. It is what lets a wait move with the work instead of on
/// a timer (the Compact overlay); the first delta goes out straight away.
pub async fn run_claude_text_live(
    bin: &str,
    args: &[String],
    cwd: &str,
    prompt: &str,
    progress: Option<&Channel<Value>>,
) -> Result<(String, Option<Value>), String> {
    let (args, _sys_file) = spill_system_prompt(args);
    let mut child = claude_command(bin, &args, cwd)
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let prompt_owned = prompt.to_string();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(prompt_owned.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let mut r = stderr;
        let _ = r.read_to_string(&mut s).await;
        s
    });

    let mut text = String::new();
    let mut usage: Option<Value> = None;
    let (mut written, mut thought) = (0usize, 0usize);
    let mut last_progress: Option<std::time::Instant> = None;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let ev: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let (Some(ch), Some((is_text, n))) = (progress, answer_delta(&ev)) {
            if is_text {
                written += n;
            } else {
                thought += n;
            }
            if last_progress.map_or(true, |t| t.elapsed().as_millis() >= TEXT_PROGRESS_MS) {
                let _ = ch.send(json!({ "chars": written, "thought": thought }));
                last_progress = Some(std::time::Instant::now());
            }
            continue;
        }
        if ev.get("type").and_then(|v| v.as_str()) == Some("result") {
            if let Some(r) = ev.get("result").and_then(|v| v.as_str()) {
                // A signed-out CLI still "answers" — with its login notice. Fail
                // with that, or the caller reports a reply it couldn't parse.
                if looks_logged_out(r) && ev.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
                    return Err(r.to_string());
                }
                text = r.to_string();
            }
            if let Some(u) = ev.get("usage") {
                if !u.is_null() {
                    usage = Some(u.clone());
                }
            }
        }
    }

    let _ = writer.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let errout = err_task.await.unwrap_or_default();

    if !text.is_empty() {
        Ok((text, usage))
    } else {
        let code = status.code().unwrap_or(-1);
        Err(if errout.trim().is_empty() {
            format!("claude exited {code}")
        } else {
            errout.trim().to_string()
        })
    }
}

/// Run a one-off shell command directly (the composer's `$` escape hatch),
/// capturing combined stdout+stderr and the exit code. Uses PowerShell on
/// Windows (so `ls`, `cat`, … work as users expect) and `sh -c` elsewhere.
/// Bounded by a timeout and an output cap so a runaway command can't hang the UI
/// or bloat the transcript. Returns `(output, exit_code)`.
pub async fn run_shell_capture(command: &str, cwd: &str) -> Result<(String, i32), String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("could not start shell: {e}"))?;
    let out = match tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err("command timed out after 120s".into()),
    };

    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stderr.trim().is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    const CAP: usize = 100_000;
    if combined.len() > CAP {
        combined.truncate(CAP);
        combined.push_str("\n… (output truncated)");
    }

    Ok((combined.trim_end().to_string(), out.status.code().unwrap_or(-1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_delta_counts_text_and_thinking_only() {
        let text = json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
            "delta":{"type":"text_delta","text":"Sažetak"}}});
        assert_eq!(answer_delta(&text), Some((true, 7)));
        let think = json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
            "delta":{"type":"thinking_delta","thinking":"hmm"}}});
        assert_eq!(answer_delta(&think), Some((false, 3)));
        let tool = json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,
            "delta":{"type":"input_json_delta","partial_json":"{"}}});
        assert_eq!(answer_delta(&tool), None);
        assert_eq!(answer_delta(&json!({"type":"result","result":"x"})), None);
    }

    #[test]
    fn title_excerpt_keeps_both_ends_of_a_long_reply() {
        // A short reply goes through whole.
        assert_eq!(title_excerpt("  Fixed the scroll lock.  "), "Fixed the scroll lock.");

        // A long one keeps its opening and its conclusion and drops the middle —
        // counted in characters, so multi-byte text can't split mid-letter.
        let long = format!("POČETAK{}KRAJ", "š".repeat(5000));
        let cut = title_excerpt(&long);
        assert!(cut.starts_with("POČETAK"));
        assert!(cut.ends_with("KRAJ"));
        assert!(cut.contains("[…]"));
        assert!(cut.chars().count() < TITLE_REPLY_HEAD + TITLE_REPLY_TAIL + 10);
    }
}
