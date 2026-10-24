//! The per-project task list: its CRUD, drafting tasks from a description, and
//! the markdown snapshot that makes a chat turn task-aware.
//!
//! A per-project to-do list. Tasks are keyed by the project's folder path, so
//! they're shared across all of that project's chats and openable at any time.

use super::*;

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>, project: String) -> Value {
    let conn = state.db();
    json!({ "tasks": db::list_tasks(&conn, &project) })
}

#[tauri::command]
pub fn add_task(state: State<'_, AppState>, project: String, title: String, note: Option<String>) -> CmdResult {
    let title = title.trim();
    if title.is_empty() {
        return Err("empty task".into());
    }
    let title: String = title.chars().take(300).collect();
    let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    let conn = state.db();
    db::add_task(&conn, &project, &title, note.as_deref()).ok_or_else(|| "could not add task".into())
}

#[tauri::command]
pub fn update_task(state: State<'_, AppState>, id: i64, title: Option<String>, done: Option<bool>) -> CmdResult {
    // Reject a blank rename, but a missing title just means "only toggle done".
    let title = match title {
        Some(t) => {
            let t = t.trim();
            if t.is_empty() {
                return Err("empty task".into());
            }
            Some(t.chars().take(300).collect::<String>())
        }
        None => None,
    };
    let conn = state.db();
    db::update_task(&conn, id, title.as_deref(), done).ok_or_else(|| "not found".into())
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, id: i64) -> Value {
    let conn = state.db();
    db::delete_task(&conn, id);
    json!({ "ok": true })
}

#[tauri::command]
pub fn clear_done_tasks(state: State<'_, AppState>, project: String) -> Value {
    let conn = state.db();
    let n = db::clear_done_tasks(&conn, &project);
    json!({ "cleared": n })
}

#[tauri::command]
pub fn task_count(state: State<'_, AppState>, project: String) -> Value {
    let conn = state.db();
    json!({ "open": db::open_task_count(&conn, &project) })
}

/// Build the prompt that turns a free-text description of work into either a set
/// of clarifying questions (first pass, only when genuinely needed) or a clean,
/// actionable task list. Domain-agnostic: the project might be writing, code,
/// research, data — anything; Claude infers it from the folder and the brief.
fn tasks_prompt(brief: &str, answers: &[Value], ui_lang: &str) -> String {
    // Only a tie-break for text with no language signal — never an override.
    let fallback_lang = claude::lang_label(ui_lang);
    let answered = !answers.is_empty();
    let answers_block = if answered {
        let qa = answers
            .iter()
            .map(|a| {
                let q = a.get("question").and_then(|v| v.as_str()).unwrap_or("");
                let ans = match a.get("answer") {
                    Some(Value::Array(arr)) => arr
                        .iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join("; "),
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                format!("Q: {q}\nA: {ans}")
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        format!("\n\nThe person already answered some clarifying questions:\n{qa}\n")
    } else {
        String::new()
    };

    // When answers are present we force the task list; otherwise Claude may ask
    // first — but only if it truly needs to.
    let mode = if answered {
        "You now have enough to proceed. Return the TASKS object (never questions)."
    } else {
        "If — and only if — the description is too vague or ambiguous to break into clear, well-scoped tasks, you may FIRST return up to 4 short clarifying QUESTIONS. If it is already clear enough, skip the questions and return the TASKS directly."
    };

    format!(
        r#"You are helping someone turn what they want to do into a clear, actionable task list for THIS project folder. You may glance at the folder with your tools to ground the tasks in what's really here, but do NOT change any files.

What they want to do, in their own words:
"""
{brief}
"""{answers_block}

{mode}

Return a SINGLE JSON object (no prose, no code fence), shaped as ONE of:

A) Clarifying questions (only when needed, and only if no answers were given yet):
{{
  "questions": [
    {{
      "id": "<short-kebab-id>",
      "question": "<one clear question>",
      "why": "<short reason it matters>",
      "multi": false,
      "options": ["<option 1>", "<option 2>", "<option 3>"],
      "allowCustom": true
    }}
  ]
}}

B) The task list:
{{
  "tasks": [
    {{ "title": "<short imperative task, e.g. 'Add dark-mode toggle to settings'>", "note": "<optional one-line detail or acceptance hint, or empty>" }}
  ]
}}

Rules:
- Write every task and question in the SAME language the description is written in. If that is genuinely unclear, use {fallback_lang}.
- Make tasks specific and outcome-oriented — each should be one coherent piece of work, not a whole epic and not a trivial sub-step. Aim for roughly 3-12 tasks; split big items, merge tiny ones.
- Order tasks in a sensible sequence (dependencies / natural workflow first).
- Keep titles short (a line); put any extra detail in "note".
- Do not invent work the person didn't ask for; stay faithful to the description (and answers).
- Return ONLY the JSON object."#
    )
}

#[tauri::command]
pub async fn generate_tasks(
    state: State<'_, AppState>,
    cwd: String,
    brief: String,
    answers: Option<Vec<Value>>,
) -> CmdResult {
    if brief.trim().is_empty() {
        return Err("describe what you'd like to do first".into());
    }
    let answers = answers.unwrap_or_default();

    let sys = state.sys_prompt();
    // Either shape is valid here — a task list, or the clarifying questions that
    // have to come first — so the contract admits both and nothing else.
    let schema = json!({
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "note":  { "type": "string" }
                    },
                    "required": ["title"]
                }
            },
            "questions": question_schema()
        }
    });
    let args = with_json_schema(&claude::base_args(models::DEFAULT_MODEL, &sys), schema);
    let prompt = tasks_prompt(brief.trim(), &answers, &state.ui_lang());
    let (text, _usage) = claude::run_claude_text(&state.claude_bin(), &args, &cwd, &prompt).await?;

    match extract_json(&text) {
        Some(data) if data.get("tasks").map(|t| t.is_array()).unwrap_or(false) => Ok(data),
        Some(data) if data.get("questions").map(|q| q.is_array()).unwrap_or(false) => Ok(data),
        _ => Ok(json!({ "error": "Could not turn that into tasks. Please try rephrasing." })),
    }
}

/// Stable, filesystem-safe key for a project path (FNV-1a) so each project's
/// snapshot overwrites its own file.
pub(super) fn project_key(path: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

const TASK_SNAPSHOT_LEGEND: &str =
    "<!-- HOW TO EDIT (saved back into the app automatically after your reply):\n     • toggle done: change [ ] to [x] or back\n     • rename / re-note: edit the text after the (id:N) marker\n     • add a task: add a new line  - [ ] My new task — optional note\n     • delete a task: remove its whole line\n     Keep the (id:N) marker on existing tasks — it's how edits are matched.\n     KEEP THIS CURRENT: when your work finishes one of these tasks, tick it off\n     here in the same reply — you don't need to be asked. Never invent tasks or\n     reorder the list on your own, and don't tick off what isn't really done. -->";

/// Render the project's tasks as the markdown Claude reads/edits.
fn render_task_markdown(project: &str, tasks: &[Value]) -> String {
    let mut md = format!("# Task list — {}\n\n{}\n\n", crate::util::base_name(project), TASK_SNAPSHOT_LEGEND);
    for t in tasks {
        let id = t.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
        let done = t.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
        let title = t.get("title").and_then(|x| x.as_str()).unwrap_or("");
        let note = t
            .get("note")
            .and_then(|x| x.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        md.push_str(if done { "- [x] " } else { "- [ ] " });
        md.push_str(&format!("(id:{id}) {title}"));
        if let Some(note) = note {
            md.push_str(" — ");
            md.push_str(note);
        }
        md.push('\n');
    }
    md
}

/// Write the project's tasks to a markdown file under `<data_dir>/task-lists/`
/// that Claude can `Read` (and edit) on demand. Returns the path + written text.
fn write_task_snapshot(data_dir: &std::path::Path, project: &str, tasks: &[Value]) -> Option<(std::path::PathBuf, String)> {
    let dir = data_dir.join("task-lists");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("{}.md", project_key(project)));
    let md = render_task_markdown(project, tasks);
    std::fs::write(&file, &md).ok()?;
    Some((file, md))
}

/// A task line parsed back out of the snapshot. `id` is `None` for a line Claude
/// added (no `(id:N)` marker yet).
struct ParsedTask {
    id: Option<i64>,
    done: bool,
    title: String,
    note: Option<String>,
}

/// Parse the snapshot markdown back into task rows. Lines that aren't `- [ ] …`
/// checkboxes (the header, the legend, blanks) are ignored.
fn parse_task_markdown(md: &str) -> Vec<ParsedTask> {
    let mut out = Vec::new();
    for raw in md.lines() {
        let line = raw.trim();
        // Match "- [ ] rest" / "- [x] rest" (also tolerate * bullets).
        let rest = line
            .strip_prefix("- [")
            .or_else(|| line.strip_prefix("* ["));
        let rest = match rest {
            Some(r) => r,
            None => continue,
        };
        let (mark, after) = match rest.split_once(']') {
            Some((m, a)) => (m.trim(), a.trim()),
            None => continue,
        };
        let done = mark.eq_ignore_ascii_case("x");
        // Optional "(id:N)" marker.
        let (id, body) = if let Some(b) = after.strip_prefix("(id:") {
            if let Some((num, tail)) = b.split_once(')') {
                (num.trim().parse::<i64>().ok(), tail.trim().to_string())
            } else {
                (None, after.to_string())
            }
        } else {
            (None, after.to_string())
        };
        // Split "title — note" on the first em-dash separator.
        let (title, note) = match body.split_once(" — ") {
            Some((t, n)) => (t.trim().to_string(), {
                let n = n.trim();
                if n.is_empty() { None } else { Some(n.to_string()) }
            }),
            None => (body.trim().to_string(), None),
        };
        if title.is_empty() {
            continue;
        }
        out.push(ParsedTask { id, done, title, note });
    }
    out
}

/// After a chat turn, fold any edits Claude made to the snapshot back into the
/// database (toggles, renames, additions, deletions). No-op (returns `None`) when
/// the file is byte-for-byte what we wrote — so reads never mutate anything.
/// On a real change it re-writes the snapshot (so new tasks gain id markers) and
/// returns the fresh (open, total) counts for the UI.
pub(super) fn reconcile_task_snapshot(
    db: &std::sync::Mutex<rusqlite::Connection>,
    data_dir: &std::path::Path,
    project: &str,
    path: &std::path::Path,
    written: &str,
) -> Option<(usize, usize)> {
    let current = std::fs::read_to_string(path).ok()?;
    if current == written {
        return None; // Claude didn't touch it
    }
    let parsed = parse_task_markdown(&current);

    let conn = db.lock().unwrap();
    let existing = db::list_tasks(&conn, project);
    let existing_ids: std::collections::HashSet<i64> =
        existing.iter().filter_map(|t| t.get("id").and_then(|x| x.as_i64())).collect();

    let mut changed = false;
    let mut seen = std::collections::HashSet::new();
    for p in &parsed {
        match p.id {
            Some(id) if existing_ids.contains(&id) => {
                seen.insert(id);
                // Update in place if anything differs.
                let cur = existing.iter().find(|t| t.get("id").and_then(|x| x.as_i64()) == Some(id));
                let differs = cur.map(|c| {
                    let ct = c.get("title").and_then(|x| x.as_str()).unwrap_or("");
                    let cn = c.get("note").and_then(|x| x.as_str()).unwrap_or("");
                    let cd = c.get("done").and_then(|x| x.as_bool()).unwrap_or(false);
                    ct != p.title || cn != p.note.as_deref().unwrap_or("") || cd != p.done
                }).unwrap_or(true);
                if differs {
                    db::set_task(&conn, id, &p.title, p.note.as_deref(), p.done);
                    changed = true;
                }
            }
            _ => {
                // New line (no/unknown id) → insert.
                if let Some(t) = db::add_task(&conn, project, &p.title, p.note.as_deref()) {
                    if p.done {
                        if let Some(nid) = t.get("id").and_then(|x| x.as_i64()) {
                            db::update_task(&conn, nid, None, Some(true));
                        }
                    }
                    changed = true;
                }
            }
        }
    }
    // Delete tasks whose line Claude removed.
    for id in &existing_ids {
        if !seen.contains(id) {
            db::delete_task(&conn, *id);
            changed = true;
        }
    }

    if !changed {
        return None;
    }
    // Re-snapshot from the fresh DB so new tasks carry id markers next time.
    let fresh = db::list_tasks(&conn, project);
    let total = fresh.len();
    let open = fresh
        .iter()
        .filter(|t| !t.get("done").and_then(|d| d.as_bool()).unwrap_or(false))
        .count();
    drop(conn);
    let _ = write_task_snapshot(data_dir, project, &fresh);
    Some((open, total))
}

/// Everything the chat turn needs to make Claude task-aware: the system-prompt
/// note, plus the snapshot path + exact bytes written (to detect edits afterward).
pub(super) struct TaskAwareness {
    pub(super) note: String,
    pub(super) path: std::path::PathBuf,
    pub(super) written: String,
}

/// How many open task titles the awareness note spells out before it stops and
/// points at the file for the rest.
const TASK_NOTE_TITLES: usize = 12;

/// Build the awareness note and drop a fresh snapshot.
///
/// The note NAMES the open tasks rather than only counting them: to notice that
/// the work it just did finishes one of them, Claude has to know what's on the
/// list, and re-reading the file every turn purely to find that out would be
/// wasteful. The rest — notes, completed items, `(id:N)` markers — stays in the
/// file. An empty list still gets a one-line note so "add that to my tasks" works
/// from a standing start.
pub(super) fn prepare_task_awareness(
    data_dir: &std::path::Path,
    db: &std::sync::Mutex<rusqlite::Connection>,
    project: &str,
) -> Option<TaskAwareness> {
    let tasks = {
        let conn = db.lock().unwrap();
        db::list_tasks(&conn, project)
    };
    let (path, written) = write_task_snapshot(data_dir, project, &tasks)?;
    let total = tasks.len();
    let open_titles: Vec<String> = tasks
        .iter()
        .filter(|t| !t.get("done").and_then(|d| d.as_bool()).unwrap_or(false))
        .filter_map(|t| t.get("title").and_then(|x| x.as_str()))
        .map(|s| {
            let s = s.trim();
            if s.chars().count() > 70 {
                s.chars().take(70).collect::<String>() + "…"
            } else {
                s.to_string()
            }
        })
        .collect();
    let open = open_titles.len();

    if total == 0 {
        let note = format!(
            "TASK LIST: this project has a to-do list the user manages in the Krystal app, and it is currently EMPTY (file: {}). Leave it alone unless the user asks you to track something — then add `- [ ] Task title` lines to that file and the app picks them up automatically after your reply.",
            path.display()
        );
        return Some(TaskAwareness { note, path, written });
    }

    let listing = if open == 0 {
        " Every task on it is already done.".to_string()
    } else {
        let shown = open_titles
            .iter()
            .take(TASK_NOTE_TITLES)
            .cloned()
            .collect::<Vec<_>>()
            .join("; ");
        let more = open.saturating_sub(TASK_NOTE_TITLES);
        if more > 0 {
            format!(" Open: {shown}; and {more} more (in the file).")
        } else {
            format!(" Open: {shown}.")
        }
    };
    let note = format!(
        "TASK LIST: this project has a to-do list the user manages in the Krystal app — {total} task(s), {open} open.{listing} The full list is in {}; READ that file when you need a task's note, the completed ones, or the `(id:N)` markers.\n\
         KEEP IT CURRENT WITHOUT BEING ASKED: whenever work in this conversation actually finishes one of those open tasks, edit that file before you end your reply and flip that line's `[ ]` to `[x]`. Add a `- [ ] …` line when the user hands you new work worth tracking, change a line's text to rename it, delete a line to drop it. Keep every existing `(id:N)` marker exactly as it is — the app matches lines back to tasks by it. Your edits are folded into the app automatically once your reply ends, so there's no need to paste the list back at the user.\n\
         Use judgement: only tick off what is genuinely done, never invent or reshuffle tasks the user didn't ask for, and don't drag the list into a conversation it has nothing to do with.",
        path.display()
    );
    Some(TaskAwareness { note, path, written })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: i64, title: &str, note: Option<&str>, done: bool) -> Value {
        json!({ "id": id, "title": title, "note": note, "done": done })
    }

    /// The snapshot is the whole task-sync contract: whatever `render` writes,
    /// `parse` has to read back identically, or a turn that only READ the file
    /// would look like an edit and rewrite the user's list.
    #[test]
    fn snapshot_round_trips() {
        let tasks = vec![
            task(1, "Fix the scroll lock", None, false),
            task(2, "Agent window", Some("timeline + tokens"), true),
        ];
        let md = render_task_markdown("G:/Projects/demo", &tasks);
        let parsed = parse_task_markdown(&md);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, Some(1));
        assert_eq!(parsed[0].title, "Fix the scroll lock");
        assert_eq!(parsed[0].note, None);
        assert!(!parsed[0].done);
        assert_eq!(parsed[1].id, Some(2));
        assert_eq!(parsed[1].title, "Agent window");
        assert_eq!(parsed[1].note.as_deref(), Some("timeline + tokens"));
        assert!(parsed[1].done);
    }

    /// The header and the how-to legend must never parse as tasks — the legend
    /// spells out a `- [ ] My new task` example, so this is a real trap.
    #[test]
    fn header_and_legend_are_not_tasks() {
        let md = render_task_markdown("G:/Projects/demo", &[]);
        assert!(md.contains("- [ ] My new task"), "legend example still present");
        assert!(parse_task_markdown(&md).is_empty());
    }

    #[test]
    fn ticking_a_box_is_read_back_as_done() {
        let tasks = vec![task(7, "Ship it", None, false)];
        let md = render_task_markdown("p", &tasks);
        let edited = md.replace("- [ ] (id:7)", "- [x] (id:7)");
        let parsed = parse_task_markdown(&edited);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, Some(7));
        assert!(parsed[0].done, "the toggle Claude makes must register");
    }

    #[test]
    fn a_line_without_an_id_marker_is_a_new_task() {
        let md = format!(
            "{}- [ ] Brand new thing — with a note\n",
            render_task_markdown("p", &[task(1, "Existing", None, false)])
        );
        let parsed = parse_task_markdown(&md);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].id, None, "no marker → inserted as new");
        assert_eq!(parsed[1].title, "Brand new thing");
        assert_eq!(parsed[1].note.as_deref(), Some("with a note"));
    }

    /// Tolerated hand-edits: `*` bullets and an upper-case X.
    #[test]
    fn parse_tolerates_bullet_and_case_variants() {
        let parsed = parse_task_markdown("* [X] (id:3) Done thing\n- [x] (id:4) Also done\n");
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].done && parsed[1].done);
        assert_eq!(parsed[0].id, Some(3));
    }
}
