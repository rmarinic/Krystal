// Hide the extra console window on Windows in release builds (keep it in debug
// so server-style logs are visible while developing).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod claude;
mod commands;
mod db;
mod discord;
mod models;

use commands::AppState;
use tauri::Manager;

fn main() {
    // Probe the environment once at startup (mirrors server.js boot).
    let caps = claude::probe_caps();
    let claude_bin = claude::resolve_claude();
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
                data_dir: dir.clone(),
                models: std::sync::Mutex::new(models),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
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
            commands::delete_project,
            commands::list_threads,
            commands::get_thread,
            commands::create_thread,
            commands::delete_thread,
            commands::set_model,
            commands::set_mode,
            commands::set_orchestration,
            commands::clear_thread,
            commands::rename_thread,
            commands::search_messages,
            commands::list_favorites,
            commands::toggle_favorite,
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
            commands::hint_thread,
            commands::init_analyze,
            commands::init_draft,
            commands::init_save,
            commands::read_claude_md,
            commands::claude_md_exists,
            commands::set_discord_enabled,
            commands::discord_set_project,
            commands::discord_set_share_name,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Krystal");
}
