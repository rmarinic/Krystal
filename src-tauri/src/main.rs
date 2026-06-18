// Hide the extra console window on Windows in release builds (keep it in debug
// so server-style logs are visible while developing).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;
mod commands;
mod db;
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
            let db_path = dir.join("kristina.db");
            let conn = db::open(&db_path).expect("open kristina.db");
            println!("  database: {}", db_path.display());
            app.manage(AppState {
                db: std::sync::Mutex::new(conn),
                caps,
                claude_bin: std::sync::Mutex::new(claude_bin.clone()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::preflight,
            commands::install_claude,
            commands::open_login,
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
            commands::clear_thread,
            commands::search_messages,
            commands::list_favorites,
            commands::toggle_favorite,
            commands::chat,
            commands::compact_thread,
            commands::hint_thread,
            commands::init_analyze,
            commands::init_draft,
            commands::init_save,
            commands::read_claude_md,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Krystal");
}
