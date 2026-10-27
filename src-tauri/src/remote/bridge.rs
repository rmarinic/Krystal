//! The command bridge: `dispatch` maps a call from outside onto the same command
//! functions the window invokes.

use super::*;

/* ----------------------------- command bridge ---------------------------- *
 * What lets something other than this window drive Krystal: a caller from
 * outside names a backend command and passes its arguments as JSON, and gets
 * back exactly what the window would.
 *
 * An explicit allowlist, not a blanket proxy over everything the window can
 * invoke. Two reasons. Whoever carries calls in is the only thing between the
 * outside and this dispatcher, so the surface should be a decision rather than
 * a side effect. And a handful of commands are about *the machine you are
 * sitting at* — opening a link, this copy's Discord presence, installing Claude
 * Code, linking this computer to an account — which would fire on the wrong
 * computer, or hand the keys away, if run for someone elsewhere. Those are
 * `LOCAL_ONLY`, and `tests/commands.test.js` holds every command to being in
 * exactly one of the two lists. */

/// Commands that only ever run for the window on this machine: `dispatch` has
/// no arm for them, on purpose. Every registered command is either here or
/// handled by `dispatch`/`is_streaming_command` (`tests/commands.test.js`).
pub const LOCAL_ONLY: &[&str] = &[
    "open_external", "open_webview", "exe_path", "app_version", "notify",
    // A chip's Show in folder / Open act on this PC's files.
    "reveal_path", "open_path",
    "install_claude", "update_claude", "update_claude_npm", "open_login",
    "start_login", "submit_login_code", "cancel_login",
    "set_discord_enabled", "discord_set_project", "discord_set_share_name",
    // A save dialog and a browser: both reach for *this* machine's screen.
    "export_artifact", "open_artifact_externally",
    // Linking this computer to an account. Never from outside: the link is
    // what lets someone in at all.
    "cloud_status", "cloud_link_start", "cloud_link_open", "cloud_link_cancel",
    "cloud_check", "cloud_unlink", "cloud_presence", "cloud_set_reachable",
    // What guests may do here. Only ever set at this computer, so a guest can
    // never widen their own reach.
    "get_guest_access", "set_guest_access",
    // This computer reaching the account's others with its own token: the
    // account's whole reach, never lent to someone outside (and no bouncing
    // through one computer to a third).
    "hub_computers", "hub_call", "hub_stream", "hub_stream_cancel",
];

/// A required string argument (missing reads as empty, which the commands then
/// reject themselves — the same as a bad call from the window).
fn arg_str(a: &Value, key: &str) -> String {
    a.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// An optional string argument. Absent and `null` both mean `None`.
fn arg_opt_str(a: &Value, key: &str) -> Option<String> {
    a.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn arg_i64(a: &Value, key: &str) -> i64 {
    a.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn arg_opt_i64(a: &Value, key: &str) -> Option<i64> {
    a.get(key).and_then(|v| v.as_i64())
}

fn arg_bool(a: &Value, key: &str) -> bool {
    a.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn arg_opt_bool(a: &Value, key: &str) -> Option<bool> {
    a.get(key).and_then(|v| v.as_bool())
}

fn arg_list(a: &Value, key: &str) -> Vec<Value> {
    a.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default()
}

/// Wrap a command's return value as JSON. Commands hand back `Value`, `Vec<Value>`
/// or `&str`; the client only ever sees JSON either way.
fn as_json<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// Run one allowlisted command. `Some(Err)` for a command that failed; `None`
/// for one this machine does not expose, so a caller can tell "refused" apart
/// from "went wrong".
pub async fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    let st = || -> tauri::State<'_, AppState> { app.state() };
    let out = match cmd {
        /* ---- config & catalogue ---- */
        "get_config" => as_json(commands::get_config(st())),
        "set_ui_language" => as_json(commands::set_ui_language(st(), arg_str(a, "lang"))),
        "refresh_models" => commands::refresh_models(st()).await,
        "preflight" => as_json(commands::preflight(st())),

        /* ---- projects ---- */
        "list_projects" => as_json(commands::list_projects(st())),
        "create_project" => commands::create_project(st(), arg_str(a, "path")),
        "select_project" => commands::select_project(st(), arg_str(a, "id")),
        "move_project" => commands::move_project(st(), arg_str(a, "id"), arg_str(a, "path")).await,
        "delete_project" => as_json(commands::delete_project(st(), arg_str(a, "id"))),

        /* ---- chats ---- */
        "list_threads" => as_json(commands::list_threads(st(), arg_opt_str(a, "project"))),
        "get_thread" => commands::get_thread(st(), arg_str(a, "id")),
        // Nudge the window's sidebar so a chat started elsewhere shows up there
        // without a manual refresh.
        "create_thread" => commands::create_thread(st(), arg_str(a, "cwd")).inspect(|_| {
            let _ = app.emit(EV_THREADS, json!({ "project": arg_str(a, "cwd") }));
        }),
        "branch_thread" => commands::branch_thread(st(), arg_str(a, "id"), arg_opt_i64(a, "messageId")),
        "rewind_files" => {
            commands::rewind_files(st(), arg_str(a, "threadId"), arg_str(a, "ckpt"), arg_opt_bool(a, "dryRun")).await
        }
        "delete_thread" => commands::delete_thread(st(), arg_str(a, "id")).await,
        "rename_thread" => commands::rename_thread(st(), arg_str(a, "id"), arg_str(a, "title")),
        "clear_thread" => commands::clear_thread(st(), arg_str(a, "id")).await,
        // Its progress feeds the desktop's overlay; a remote caller just waits.
        "compact_thread" => {
            commands::compact_thread(st(), arg_str(a, "id"), Channel::new(|_| Ok(()))).await
        }

        /* ---- per-chat settings ---- */
        "set_model" => commands::set_model(st(), arg_str(a, "id"), arg_str(a, "model")),
        "set_mode" => commands::set_mode(st(), arg_str(a, "id"), arg_str(a, "mode")),
        "set_effort" => commands::set_effort(st(), arg_str(a, "id"), arg_str(a, "effort")),
        "set_suggestions" => as_json(commands::set_suggestions(st(), arg_bool(a, "enabled"))),
        "set_orchestration" => commands::set_orchestration(
            st(),
            arg_str(a, "id"),
            arg_bool(a, "enabled"),
            arg_str(a, "subModel"),
        ),

        /* ---- turns in flight ---- */
        "stop_chat" => commands::stop_chat(st(), arg_str(a, "threadId"), arg_opt_bool(a, "force")).await,
        // Ask mode's permission prompts travel with the turn's events, so whoever
        // is watching the turn — the phone included — has to be able to answer.
        "answer_permission" => commands::answer_permission(
            st(),
            arg_str(a, "threadId"),
            arg_str(a, "requestId"),
            arg_str(a, "decision"),
        )
        .await,
        "active_runs" => commands::active_runs(st()).await.and_then(as_json),
        "stop_all_chats" => commands::stop_all_chats(st()).await,

        /* ---- search & favourites ---- */
        "search_messages" => as_json(commands::search_messages(
            st(),
            arg_str(a, "q"),
            arg_opt_str(a, "project"),
        )),
        "list_favorites" => as_json(commands::list_favorites(st(), arg_opt_str(a, "project"))),
        "toggle_favorite" => commands::toggle_favorite(st(), arg_i64(a, "messageId")),
        "delete_message" => commands::delete_message(st(), arg_i64(a, "messageId")),

        /* ---- tasks ---- */
        "list_tasks" => as_json(commands::list_tasks(st(), arg_str(a, "project"))),
        "add_task" => commands::add_task(
            st(),
            arg_str(a, "project"),
            arg_str(a, "title"),
            arg_opt_str(a, "note"),
        ),
        "update_task" => commands::update_task(
            st(),
            arg_i64(a, "id"),
            arg_opt_str(a, "title"),
            arg_opt_bool(a, "done"),
        ),
        "delete_task" => as_json(commands::delete_task(st(), arg_i64(a, "id"))),
        "clear_done_tasks" => as_json(commands::clear_done_tasks(st(), arg_str(a, "project"))),
        "task_count" => as_json(commands::task_count(st(), arg_str(a, "project"))),
        "generate_tasks" => commands::generate_tasks(
            st(),
            arg_str(a, "cwd"),
            arg_str(a, "brief"),
            Some(arg_list(a, "answers")),
        )
        .await,

        /* ---- the project's own files & folders ---- */
        "list_pins" => as_json(commands::list_pins(st(), arg_str(a, "project"))),
        "add_pin" => commands::add_pin(st(), arg_str(a, "project"), arg_str(a, "path")),
        "remove_pin" => as_json(commands::remove_pin(st(), arg_str(a, "project"), arg_i64(a, "id"))),
        "read_pinned_file" => as_json(commands::read_pinned_file(arg_str(a, "path"))),
        // Artifacts. `open_artifact_externally` is deliberately absent: it opens a
        // browser window, which would appear on this machine's screen rather
        // than the screen of whoever asked.
        "list_artifacts" => as_json(commands::list_artifacts(st(), arg_str(a, "project"))),
        "get_artifact" => commands::get_artifact(
            st(),
            arg_str(a, "project"),
            arg_str(a, "artId"),
            arg_opt_i64(a, "version"),
        ),
        "delete_artifact" => as_json(commands::delete_artifact(
            st(),
            arg_str(a, "project"),
            arg_str(a, "artId"),
        )),
        "list_project_dirs" => as_json(commands::list_project_dirs(st(), arg_str(a, "project"))),
        "add_project_dir" => {
            commands::add_project_dir(st(), arg_str(a, "project"), arg_str(a, "path"))
        }
        "remove_project_dir" => as_json(commands::remove_project_dir(
            st(),
            arg_str(a, "project"),
            arg_i64(a, "id"),
        )),
        "list_skills" => as_json(commands::list_skills(arg_opt_str(a, "project"))),
        "read_image" => as_json(commands::read_image(arg_str(a, "path"))),
        "save_attachment" => commands::save_attachment(
            st(),
            arg_str(a, "name"),
            arg_str(a, "dataBase64"),
        ),

        /* ---- CLAUDE.md / the Initialize wizard ---- */
        "read_claude_md" => commands::read_claude_md(st(), arg_str(a, "id")),
        "claude_md_exists" => as_json(commands::claude_md_exists(arg_str(a, "cwd"))),
        "init_analyze" => {
            commands::init_analyze(st(), arg_str(a, "id"), arg_opt_str(a, "brief")).await
        }
        "init_draft" => commands::init_draft(
            st(),
            arg_str(a, "id"),
            arg_opt_str(a, "summary"),
            arg_list(a, "answers"),
            arg_opt_str(a, "brief"),
        )
        .await,
        "init_save" => commands::init_save(st(), arg_str(a, "id"), arg_str(a, "markdown")),

        /* ---- running the project ---- */
        "run_shell" => {
            commands::run_shell(st(), arg_str(a, "threadId"), arg_str(a, "command")).await
        }
        "get_run_config" => as_json(commands::get_run_config(st(), arg_str(a, "project"))),
        "set_run_config" => as_json(commands::set_run_config(
            st(),
            arg_str(a, "project"),
            arg_str(a, "command"),
        )),
        "detect_run_command" => commands::detect_run_command(st(), arg_str(a, "project")).await,
        "stop_run" => commands::stop_run(st(), arg_str(a, "project")).await,

        /* ---- git ---- */
        "git_status" => as_json(commands::git_status(arg_str(a, "cwd"))),
        "git_branches" => as_json(commands::git_branches(arg_str(a, "cwd"))),
        "git_checkout" => as_json(commands::git_checkout(arg_str(a, "cwd"), arg_str(a, "branch"))),
        "git_create_branch" => {
            as_json(commands::git_create_branch(arg_str(a, "cwd"), arg_str(a, "name")))
        }
        "git_fetch" => as_json(commands::git_fetch(arg_str(a, "cwd"))),
        "git_pull" => as_json(commands::git_pull(arg_str(a, "cwd"))),
        "git_push" => as_json(commands::git_push(arg_str(a, "cwd"))),
        "ci_runs" => as_json(commands::ci_runs(arg_str(a, "cwd")).await),
        "ci_run" => as_json(commands::ci_run(arg_str(a, "cwd"), arg_i64(a, "id")).await),

        /* ---- usage ---- */
        "claude_usage" => as_json(commands::claude_usage().await),

        // Not exposed. `chat` and `run_app` stream, so they go through
        // `stream`; everything else here is deliberately local-only.
        _ => return None,
    };
    Some(out)
}

/// Commands reachable through `stream` (they report progress through a
/// `Channel` rather than returning once).
pub fn is_streaming_command(cmd: &str) -> bool {
    matches!(cmd, "chat" | "run_app" | "watch_turn")
}
