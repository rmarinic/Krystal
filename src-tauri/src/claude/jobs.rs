//! The background jobs a reply is waiting on (the sub-agents and shell commands
//! Claude sent off and said it would come back to), as the window shows them
//! while it waits: what each one is, how long it has run, and, for a shell,
//! the last thing it printed.
//!
//! Between answers nothing else is on the wire, sometimes for many minutes, and
//! a count ("1 running") can't tell a busy worker from a hung one. So the turn
//! sends the list itself (`background`, whenever it changes) and, for a shell, a
//! `job_activity` each time its output file grows: the one sign of life a
//! running command gives, read off the file the CLI writes its output to. A
//! worker's own signs (its steps) already reach the window as `agent_activity`.

use super::*;
use std::path::Path;
use std::time::Instant;

/// How often a waiting turn looks at its shells' output files.
pub(super) const JOB_WATCH_MS: u64 = 3000;

/// How much of the end of a shell's output one `job_activity` carries.
const JOB_TAIL_CHARS: usize = 1200;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum JobKind {
    Agent,
    Shell,
}

/// One job still out.
pub(super) struct Job {
    /// The tool call it runs under now: the id its chip and its agent run carry.
    /// For a worker resumed with SendMessage that is the SendMessage call.
    tool: String,
    kind: JobKind,
    description: String,
    started: Instant,
    /// The task that launched it, when a worker did (a worker's own shell).
    owner: Option<String>,
    /// Where the CLI writes a shell's output (named in the launch's result).
    output: Option<PathBuf>,
    /// How many bytes of that file have been reported.
    seen: u64,
}

/// Every job still out, in the order they started, by task id.
#[derive(Default)]
pub(super) struct Jobs {
    list: Vec<(String, Job)>,
    changed: bool,
}

impl Jobs {
    /// A `task_started` for background work.
    pub(super) fn started(&mut self, ev: &Value) {
        let s = |k: &str| ev.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let task = s("task_id");
        if task.is_empty() {
            return;
        }
        let owner = Some(s("parent_task_id")).filter(|p| !p.is_empty());
        let job = Job {
            tool: s("tool_use_id"),
            kind: if is_shell_task(ev) { JobKind::Shell } else { JobKind::Agent },
            description: s("description"),
            started: Instant::now(),
            owner,
            output: None,
            seen: 0,
        };
        self.list.retain(|(t, _)| *t != task);
        self.list.push((task, job));
        self.changed = true;
    }

    /// A job ended, and with it whatever it launched itself: a worker's own
    /// shell is reported to that worker, never to Claude, so once the worker
    /// is gone nothing would ever say the shell ended.
    pub(super) fn remove(&mut self, task: &str) {
        let before = self.list.len();
        self.list.retain(|(t, j)| t != task && j.owner.as_deref() != Some(task));
        self.changed |= self.list.len() != before;
    }

    /// Keep only the jobs `background_tasks_changed` still lists.
    pub(super) fn retain(&mut self, live: &std::collections::HashSet<&str>) {
        let before = self.list.len();
        self.list.retain(|(t, _)| live.contains(t.as_str()));
        self.changed |= self.list.len() != before;
    }

    /// The launch of a background shell came back with where its output goes
    /// ("…Output is being written to: C:\…\tasks\<task>.output. …").
    pub(super) fn note_output(&mut self, tool: &str, text: &str) {
        let Some((task, job)) = self.list.iter_mut().find(|(_, j)| j.tool == tool && j.kind == JobKind::Shell) else {
            return;
        };
        if let Some(path) = output_path(text, task) {
            job.output = Some(path);
        }
    }

    /// Did the list change since the window was last told?
    pub(super) fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    /// Is there an output file worth watching?
    pub(super) fn watches_output(&self) -> bool {
        self.list.iter().any(|(_, j)| j.output.is_some())
    }

    /// The list as the window gets it. Ages, not clock times: a browser on a
    /// phone may not share this computer's clock.
    pub(super) fn snapshot(&self) -> Value {
        let tool_of = |task: &str| self.list.iter().find(|(t, _)| t == task).map(|(_, j)| j.tool.clone());
        Value::Array(
            self.list
                .iter()
                .map(|(task, j)| {
                    json!({
                        "id": j.tool,
                        "task": task,
                        "kind": if j.kind == JobKind::Shell { "shell" } else { "agent" },
                        "description": j.description,
                        "ageMs": j.started.elapsed().as_millis() as u64,
                        "owner": j.owner.as_deref().and_then(tool_of),
                    })
                })
                .collect(),
        )
    }

    /// One `job_activity` per shell whose output grew since the last look: the
    /// end of what it has printed so far.
    pub(super) fn watch(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        for (_, j) in self.list.iter_mut() {
            let Some(path) = j.output.as_deref() else { continue };
            let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else { continue };
            if len <= j.seen {
                continue;
            }
            j.seen = len;
            if let Some(tail) = output_tail(path) {
                out.push(json!({ "type": "job_activity", "id": j.tool, "tail": tail }));
            }
        }
        out
    }
}

/// The output file a background shell's launch result names. It ends in the
/// task's own id, which is what makes it findable in a path that may hold
/// spaces and dots of its own.
fn output_path(text: &str, task: &str) -> Option<PathBuf> {
    const LEAD: &str = "written to: ";
    let start = text.find(LEAD)? + LEAD.len();
    let file = format!("{task}.output");
    let end = text[start..].find(&file)? + start + file.len();
    Some(PathBuf::from(text[start..end].trim()))
}

/// The end of a shell's output so far, trimmed of the blank lines a progress
/// bar or a trailing newline leaves.
fn output_tail(path: &Path) -> Option<String> {
    let tail = read_tail(path, JOB_TAIL_CHARS)?;
    let tail = tail.trim_end();
    (!tail.is_empty()).then(|| tail.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(task: &str, tool: &str, owner: Option<&str>) -> Value {
        let mut ev = json!({ "type": "system", "subtype": "task_started", "task_id": task,
            "tool_use_id": tool, "task_type": "local_bash", "is_backgrounded": true,
            "description": "Build it" });
        if let Some(o) = owner {
            ev["parent_task_id"] = json!(o);
            ev["owned_by_subagent"] = json!(true);
        }
        ev
    }

    #[test]
    fn the_output_file_is_read_off_the_launch_result() {
        let text = "Command running in background with ID: b2yl99bxd. Output is being written to: \
                    C:\\Users\\A Name\\Temp\\claude\\x.y\\tasks\\b2yl99bxd.output. You will be notified.";
        assert_eq!(
            output_path(text, "b2yl99bxd"),
            Some(PathBuf::from("C:\\Users\\A Name\\Temp\\claude\\x.y\\tasks\\b2yl99bxd.output"))
        );
        assert_eq!(output_path("Async agent launched", "b2yl99bxd"), None);
    }

    #[test]
    fn the_list_says_what_is_out_and_who_launched_it() {
        let mut jobs = Jobs::default();
        jobs.started(&json!({ "task_id": "a1", "tool_use_id": "toolu_send", "task_type": "local_agent",
            "description": "Build the importer" }));
        jobs.started(&shell("b1", "toolu_inner", Some("a1")));
        assert!(jobs.take_changed());
        assert!(!jobs.take_changed(), "told once");
        let list = jobs.snapshot();
        assert_eq!(list[0]["id"], json!("toolu_send"));
        assert_eq!(list[0]["kind"], json!("agent"));
        assert_eq!(list[0]["description"], json!("Build the importer"));
        assert!(list[0]["owner"].is_null());
        assert_eq!(list[1]["kind"], json!("shell"));
        assert_eq!(list[1]["owner"], json!("toolu_send"), "nested under the worker's own call");
    }

    #[test]
    fn a_worker_takes_its_own_shells_with_it() {
        let mut jobs = Jobs::default();
        jobs.started(&json!({ "task_id": "a1", "tool_use_id": "t", "task_type": "local_agent" }));
        jobs.started(&shell("b1", "toolu_inner", Some("a1")));
        jobs.started(&shell("b2", "toolu_mine", None));
        jobs.take_changed();
        jobs.remove("a1");
        assert!(jobs.take_changed());
        let list = jobs.snapshot();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["task"], json!("b2"));
    }

    #[test]
    fn a_shell_reports_only_when_its_output_grows() {
        let dir = std::env::temp_dir().join(format!("krystal-jobs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("b9.output");
        std::fs::write(&file, "").unwrap();
        let mut jobs = Jobs::default();
        jobs.started(&shell("b9", "toolu_b9", None));
        jobs.note_output("toolu_b9", &format!("Output is being written to: {}. Done.", file.display()));
        assert!(jobs.watches_output());
        assert!(jobs.watch().is_empty(), "nothing printed yet");
        std::fs::write(&file, "compiling\nlinking\n\n").unwrap();
        let seen = jobs.watch();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["type"], json!("job_activity"));
        assert_eq!(seen[0]["id"], json!("toolu_b9"));
        assert_eq!(seen[0]["tail"], json!("compiling\nlinking"));
        assert!(jobs.watch().is_empty(), "no new output, no new sign");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
