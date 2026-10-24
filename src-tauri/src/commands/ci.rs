//! The GitHub Actions build chip and run panel, through the GitHub CLI.

use super::*;

/// How many recent workflow runs the status line's popover lists.
const CI_RUN_LIMIT: &str = "15";

/// Run the GitHub CLI in a project folder, quietly: no prompts, no update
/// notice, no console window flashing up.
fn gh(cwd: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut cmd = std::process::Command::new("gh");
    cmd.current_dir(cwd)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(claude::CREATE_NO_WINDOW);
    }
    cmd.output()
}

/// Trim `gh run list --json …` down to what the UI draws. Anything that isn't
/// the array gh promises yields an empty list rather than an error.
fn parse_ci_runs(raw: &str) -> Vec<Value> {
    let s = |r: &Value, k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    serde_json::from_str::<Vec<Value>>(raw)
        .unwrap_or_default()
        .iter()
        .map(|r| {
            json!({
                "id": r.get("databaseId").and_then(|v| v.as_i64()).unwrap_or(0),
                "workflow": s(r, "workflowName"),
                "title": s(r, "displayTitle"),
                "status": s(r, "status"),
                "conclusion": s(r, "conclusion"),
                "branch": s(r, "headBranch"),
                "event": s(r, "event"),
                "createdAt": s(r, "createdAt"),
                "updatedAt": s(r, "updatedAt"),
                "url": s(r, "url"),
            })
        })
        .collect()
}

/// The project's recent GitHub Actions runs, newest first, for the build chip in
/// the git status line. Asked of the GitHub CLI (`gh`) rather than the REST API
/// directly: it already knows which repository the folder belongs to and carries
/// the user's sign-in, so private repositories work with nothing to configure.
/// `available` is false — and the UI simply shows no chip — when `gh` isn't
/// installed (`reason: "gh"`) or can't answer for this folder (not a GitHub
/// repository, not signed in, offline: `reason: "repo"`).
///
/// Async + `spawn_blocking` because this is a network round trip: a plain
/// command would hold the main thread for as long as GitHub takes to reply.
#[tauri::command]
pub async fn ci_runs(cwd: String) -> Value {
    tokio::task::spawn_blocking(move || {
        let fields = "databaseId,workflowName,displayTitle,status,conclusion,headBranch,event,createdAt,updatedAt,url";
        match gh(&cwd, &["run", "list", "--limit", CI_RUN_LIMIT, "--json", fields]) {
            Ok(out) if out.status.success() => json!({
                "available": true,
                "runs": parse_ci_runs(&String::from_utf8_lossy(&out.stdout)),
            }),
            Ok(out) => json!({
                "available": false,
                "reason": "repo",
                "error": String::from_utf8_lossy(&out.stderr).trim(),
            }),
            Err(e) => json!({ "available": false, "reason": "gh", "error": e.to_string() }),
        }
    })
    .await
    .unwrap_or_else(|e| json!({ "available": false, "reason": "gh", "error": e.to_string() }))
}

/// How much of a failed step's log the run panel shows: the end of it, where
/// the error is. The whole log stays one click away on GitHub.
const CI_LOG_LINES: usize = 80;
/// A run can fail in many jobs at once (a build matrix); the first few tell the story.
const CI_LOG_STEPS: usize = 6;

/// One run in full, from `gh run view --json …`: the run itself plus its jobs
/// and their steps — what the run panel draws. `None` when gh's output isn't
/// the object it promises.
fn parse_ci_run(raw: &str) -> Option<Value> {
    let r: Value = serde_json::from_str(raw).ok()?;
    if !r.is_object() || r.get("databaseId").is_none() {
        return None;
    }
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let list = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let jobs: Vec<Value> = list(&r, "jobs")
        .iter()
        .map(|j| {
            let steps: Vec<Value> = list(j, "steps")
                .iter()
                .map(|st| {
                    json!({
                        "name": s(st, "name"),
                        "status": s(st, "status"),
                        "conclusion": s(st, "conclusion"),
                        "startedAt": s(st, "startedAt"),
                        "completedAt": s(st, "completedAt"),
                    })
                })
                .collect();
            json!({
                "name": s(j, "name"),
                "status": s(j, "status"),
                "conclusion": s(j, "conclusion"),
                "startedAt": s(j, "startedAt"),
                "completedAt": s(j, "completedAt"),
                "url": s(j, "url"),
                "steps": steps,
            })
        })
        .collect();
    Some(json!({
        "id": r.get("databaseId").and_then(|v| v.as_i64()).unwrap_or(0),
        "number": r.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
        "attempt": r.get("attempt").and_then(|v| v.as_i64()).unwrap_or(1),
        "workflow": s(&r, "workflowName"),
        "title": s(&r, "displayTitle"),
        "status": s(&r, "status"),
        "conclusion": s(&r, "conclusion"),
        "branch": s(&r, "headBranch"),
        "sha": s(&r, "headSha"),
        "event": s(&r, "event"),
        "createdAt": s(&r, "createdAt"),
        "updatedAt": s(&r, "updatedAt"),
        "url": s(&r, "url"),
        "jobs": jobs,
    }))
}

/// `gh run view --log-failed` prints one line per log line, as
/// `job<TAB>step<TAB>timestamp text`. Fold that into one entry per failed step
/// — `{ job, step, text }` — keeping the end of each, without the timestamps.
fn parse_ci_failed_log(raw: &str) -> Vec<Value> {
    let mut groups: Vec<(String, String, Vec<&str>)> = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(job), Some(step), Some(rest)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let job = job.trim_start_matches('\u{feff}');
        // The timestamp is the first word; a line without one is kept whole.
        let text = match rest.split_once(' ') {
            Some((ts, text)) if ts.ends_with('Z') && ts.contains('T') => text,
            _ if rest.ends_with('Z') && rest.contains('T') && !rest.contains(' ') => "",
            _ => rest,
        };
        match groups.last_mut() {
            Some((j, st, lines)) if j == job && st == step => lines.push(text),
            _ => groups.push((job.to_string(), step.to_string(), vec![text])),
        }
    }
    groups
        .into_iter()
        .take(CI_LOG_STEPS)
        .map(|(job, step, lines)| {
            let from = lines.len().saturating_sub(CI_LOG_LINES);
            json!({
                "job": job,
                "step": step,
                "text": lines[from..].join("\n").trim_end(),
                "cut": from > 0,
            })
        })
        .collect()
}

/// One workflow run in detail, for the run panel: its jobs and steps, and — for
/// a run that failed — the end of each failed step's log, so the reason is
/// readable without leaving the app. The log is a second, slower round trip
/// (gh downloads the run's log archive), so it is only fetched for a failure,
/// and its absence never fails the call: the steps alone are still worth showing.
#[tauri::command]
pub async fn ci_run(cwd: String, id: i64) -> Value {
    tokio::task::spawn_blocking(move || {
        let id = id.to_string();
        let fields = "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,number,status,updatedAt,url,workflowName";
        let run = match gh(&cwd, &["run", "view", &id, "--json", fields]) {
            Ok(out) if out.status.success() => parse_ci_run(&String::from_utf8_lossy(&out.stdout)),
            Ok(out) => {
                return json!({
                    "available": false,
                    "reason": "repo",
                    "error": String::from_utf8_lossy(&out.stderr).trim(),
                })
            }
            Err(e) => return json!({ "available": false, "reason": "gh", "error": e.to_string() }),
        };
        let Some(run) = run else {
            return json!({ "available": false, "reason": "repo", "error": "" });
        };
        let failed = matches!(
            run["conclusion"].as_str().unwrap_or(""),
            "failure" | "timed_out" | "startup_failure"
        );
        let logs = if failed {
            match gh(&cwd, &["run", "view", &id, "--log-failed"]) {
                Ok(out) if out.status.success() => parse_ci_failed_log(&String::from_utf8_lossy(&out.stdout)),
                _ => Vec::new(),
            }
        } else {
            Vec::new()
        };
        json!({ "available": true, "run": run, "logs": logs })
    })
    .await
    .unwrap_or_else(|e| json!({ "available": false, "reason": "gh", "error": e.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The UI keys a run by `id` and colours it from `status`/`conclusion`; a
    /// run still in flight has no conclusion yet, and gh's output that isn't the
    /// promised array (an error page, nothing at all) must read as "no runs".
    #[test]
    fn ci_runs_are_trimmed_to_what_the_ui_draws() {
        let raw = r#"[
            {"databaseId":42,"workflowName":"Release","displayTitle":"Release v1","status":"completed",
             "conclusion":"success","headBranch":"v1","event":"push","createdAt":"2026-10-08T09:15:06Z",
             "updatedAt":"2026-10-08T09:21:14Z","url":"https://github.com/o/r/actions/runs/42"},
            {"databaseId":43,"workflowName":"CI","status":"in_progress","conclusion":null}
        ]"#;
        let runs = parse_ci_runs(raw);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0]["id"], 42);
        assert_eq!(runs[0]["workflow"], "Release");
        assert_eq!(runs[0]["branch"], "v1");
        assert_eq!(runs[0]["url"], "https://github.com/o/r/actions/runs/42");
        assert_eq!(runs[1]["status"], "in_progress");
        assert_eq!(runs[1]["conclusion"], "");
        assert_eq!(runs[1]["title"], "");

        assert!(parse_ci_runs("").is_empty());
        assert!(parse_ci_runs(r#"{"message":"Not Found"}"#).is_empty());
    }

    /// The run panel draws jobs and their steps, and a run with no jobs yet (just
    /// queued) or output that isn't a run at all must not take it down.
    #[test]
    fn a_ci_run_keeps_its_jobs_and_steps() {
        let raw = r#"{"databaseId":42,"number":7,"attempt":2,"workflowName":"Release","displayTitle":"Release v1",
            "status":"completed","conclusion":"failure","headBranch":"v1","headSha":"451f1d479849","event":"push",
            "createdAt":"2026-10-08T09:15:06Z","updatedAt":"2026-10-08T09:21:14Z","url":"https://github.com/o/r/actions/runs/42",
            "jobs":[{"name":"release","status":"completed","conclusion":"failure","startedAt":"2026-10-08T09:15:10Z",
                     "completedAt":"2026-10-08T09:21:10Z","url":"https://github.com/o/r/actions/runs/42/job/9",
                     "steps":[{"name":"Checkout","number":2,"status":"completed","conclusion":"success"},
                              {"name":"Build","number":3,"status":"completed","conclusion":"failure"}]}]}"#;
        let run = parse_ci_run(raw).expect("a run");
        assert_eq!(run["id"], 42);
        assert_eq!(run["number"], 7);
        assert_eq!(run["attempt"], 2);
        assert_eq!(run["sha"], "451f1d479849");
        assert_eq!(run["jobs"][0]["name"], "release");
        assert_eq!(run["jobs"][0]["steps"][1]["name"], "Build");
        assert_eq!(run["jobs"][0]["steps"][1]["conclusion"], "failure");
        assert_eq!(run["jobs"][0]["steps"][0]["startedAt"], "");

        let queued = parse_ci_run(r#"{"databaseId":43,"status":"queued","conclusion":null}"#).expect("a run");
        assert_eq!(queued["jobs"].as_array().unwrap().len(), 0);
        assert_eq!(queued["attempt"], 1);

        assert!(parse_ci_run("").is_none());
        assert!(parse_ci_run("[]").is_none());
        assert!(parse_ci_run(r#"{"message":"Not Found"}"#).is_none());
    }

    /// Failed-step logs come as `job<TAB>step<TAB>timestamp text`. Each step's
    /// lines are gathered, the timestamps dropped, and only the end kept — the
    /// error is at the bottom of a long build log, not the top.
    #[test]
    fn a_failed_log_is_grouped_by_step_and_keeps_its_end() {
        let mut raw = String::from("\u{feff}");
        for i in 0..200 {
            raw.push_str(&format!("build\tCompile\t2026-10-08T09:15:06.1234567Z line {i}\n"));
        }
        raw.push_str("build\tCompile\t2026-10-08T09:15:07.0000000Z\n");
        raw.push_str("build\tCompile\t2026-10-08T09:15:07.0000000Z error: it broke\n");
        raw.push_str("test\tRun tests\t2026-10-08T09:16:00.0000000Z   indented stays indented\n");
        raw.push_str("not a log line\n");
        let logs = parse_ci_failed_log(&raw);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0]["job"], "build");
        assert_eq!(logs[0]["step"], "Compile");
        assert_eq!(logs[0]["cut"], true);
        let text = logs[0]["text"].as_str().unwrap();
        assert_eq!(text.lines().count(), CI_LOG_LINES);
        assert!(text.ends_with("\nerror: it broke"));
        assert!(!text.contains("line 0\n"));
        assert!(!text.contains("2026-10-08"));
        assert_eq!(logs[1]["step"], "Run tests");
        assert_eq!(logs[1]["text"], "  indented stays indented");
        assert_eq!(logs[1]["cut"], false);

        assert!(parse_ci_failed_log("").is_empty());
    }
}
