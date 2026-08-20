// Hide the extra console window on Windows in release builds (keep it in debug
// so server-style logs are visible while developing).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod claude;
mod commands;
mod db;
mod discord;
mod models;
mod session;

use commands::AppState;
use tauri::Manager;

fn main() {
    // Probe the environment once at startup (mirrors server.js boot).
    let caps = claude::probe_caps();
    let claude_bin = claude::resolve_claude();
    // Older Krystals defined orchestrator workers by writing `.md` files into the
    // user's own ~/.claude/agents. Those definitions now ride on `--agents`, so
    // clear out anything an earlier version (or a crash) left behind.
    claude::sweep_legacy_worker_agents();
    println!("\n  Krystal — local Claude Code chat");
    println!("  claude binary: {claude_bin}");
    if caps.pandoc && caps.python_docx {
        println!("  Word support: ON (pandoc + python-docx)\n");
    } else {
        let mut missing = Vec::new();
        if !caps.pandoc {
            missing.push("pandoc");
        }
        if !caps.python_docx {
            missing.push("python-docx");
        }
        println!("  Word support: OFF — missing {}\n", missing.join(" + "));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            let dir = app.path().app_data_dir().expect("resolve app data dir");
            std::fs::create_dir_all(&dir).ok();
            let db_path = dir.join("krystal.db");
            // Carry chats over from the pre-rename store (com.kristina.claudecode/kristina.db).
            db::migrate_legacy_store(&dir, &db_path);
            let conn = db::open(&db_path).expect("open krystal.db");
            println!("  database: {}", db_path.display());
            // Seed the model catalogue from the last cache (instant + offline);
            // the frontend refreshes it live via `refresh_models` at boot.
            let models = catalog::load_cache(&dir).unwrap_or_else(models::seed_models);
            app.manage(AppState {
                db: std::sync::Mutex::new(conn),
                caps,
                claude_bin: std::sync::Mutex::new(claude_bin.clone()),
                discord: discord::Presence::new(),
                running: std::sync::Mutex::new(std::collections::HashMap::new()),
                run_procs: std::sync::Mutex::new(std::collections::HashMap::new()),
                data_dir: dir.clone(),
                models: std::sync::Mutex::new(models),
                // Overwritten by the frontend at boot (and on every flag flip).
                ui_lang: std::sync::Mutex::new("en".to_string()),
                suggestions: std::sync::Mutex::new(true),
                sessions: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_ui_language,
            commands::refresh_models,
            commands::preflight,
            commands::install_claude,
            commands::update_claude,
            commands::open_login,
            commands::open_external,
            commands::open_webview,
            commands::list_projects,
            commands::create_project,
            commands::select_project,
            commands::move_project,
            commands::delete_project,
            commands::list_threads,
            commands::get_thread,
            commands::create_thread,
            commands::branch_thread,
            commands::delete_thread,
            commands::set_model,
            commands::set_mode,
            commands::set_effort,
            commands::set_suggestions,
            commands::set_orchestration,
            commands::clear_thread,
            commands::rename_thread,
            commands::search_messages,
            commands::list_favorites,
            commands::toggle_favorite,
            commands::delete_message,
            commands::list_tasks,
            commands::add_task,
            commands::update_task,
            commands::delete_task,
            commands::clear_done_tasks,
            commands::task_count,
            commands::generate_tasks,
            commands::chat,
            commands::stop_chat,
            commands::active_runs,
            commands::stop_all_chats,
            commands::exe_path,
            commands::app_version,
            commands::read_image,
            commands::save_attachment,
            commands::git_status,
            commands::git_branches,
            commands::git_checkout,
            commands::git_create_branch,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::claude_usage,
            commands::compact_thread,
            commands::run_shell,
            commands::get_run_config,
            commands::set_run_config,
            commands::detect_run_command,
            commands::run_app,
            commands::stop_run,
            commands::hint_thread,
            commands::init_analyze,
            commands::init_draft,
            commands::init_save,
            commands::list_pins,
            commands::add_pin,
            commands::remove_pin,
            commands::read_pinned_file,
            commands::read_claude_md,
            commands::claude_md_exists,
            commands::set_discord_enabled,
            commands::discord_set_project,
            commands::discord_set_share_name,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Krystal")
        .run(|app, event| {
            // Warm `claude` processes must not outlive the window that owns them.
            // `kill_on_drop` covers a normal teardown; clearing the pool here makes
            // sure the drop actually happens before the process goes away.
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                let state = app.state::<AppState>();
                tauri::async_runtime::block_on(state.sessions.retire_all());
            }
        });
}
