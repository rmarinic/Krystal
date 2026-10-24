//! SQLite store for Krystal (threads, messages, favorites).
//!
//! A faithful Rust port of the original `db.js`. Single file at
//! <app_data_dir>/krystal.db. On first run it migrates any existing
//! data/threads.json sitting next to it into the database, then leaves the
//! JSON as a backup. One-person local app — no auth, no concurrency concerns.
//!
//! Pre-rename installs stored data at `com.kristina.claudecode/kristina.db`;
//! `migrate_legacy_store` copies that across on first launch after the rename.

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

use crate::models::{DEFAULT_EFFORT, DEFAULT_MODE, DEFAULT_MODEL};
use crate::util::base_name;

/// ISO-8601 millisecond timestamp, matching JS `new Date().toISOString()`.
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The full schema, applied on every open (and by the tests against an in-memory
/// database, so they exercise the same tables the app runs on).
const SCHEMA: &str = r#"
        CREATE TABLE IF NOT EXISTS threads (
          id         TEXT PRIMARY KEY,
          title      TEXT,
          cwd        TEXT,
          session_id TEXT,
          model      TEXT,
          mode       TEXT DEFAULT 'auto',
          orch       INTEGER DEFAULT 0,
          orch_sub   TEXT DEFAULT 'auto',
          effort     TEXT DEFAULT 'high',
          seed       TEXT,
          turns      INTEGER DEFAULT 0,
          in_tok     INTEGER DEFAULT 0,
          out_tok    INTEGER DEFAULT 0,
          cost_usd   REAL    DEFAULT 0,
          context    INTEGER DEFAULT 0,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          role       TEXT NOT NULL,
          text       TEXT NOT NULL,
          files      TEXT,
          segments   TEXT,
          compacted  INTEGER DEFAULT 0,
          favorite   INTEGER DEFAULT 0,
          -- 1 while a turn is still being written (or if it never finished:
          -- the app closed mid-answer). Cleared when the turn lands.
          partial    INTEGER DEFAULT 0,
          -- On a user message: the id the CLI checkpoints the project's files
          -- under before answering it, so they can be put back (see
          -- `commands::rewind_files`). NULL on turns from before that existed.
          ckpt       TEXT,
          ts         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id);
        CREATE INDEX IF NOT EXISTS idx_msg_fav ON messages(favorite);

        CREATE TABLE IF NOT EXISTS projects (
          id         TEXT PRIMARY KEY,
          path       TEXT UNIQUE,
          name       TEXT,
          created_at TEXT,
          updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          project    TEXT NOT NULL,
          title      TEXT NOT NULL,
          note       TEXT,
          done       INTEGER DEFAULT 0,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_task_project ON tasks(project);

        CREATE TABLE IF NOT EXISTS pins (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          project    TEXT NOT NULL,
          path       TEXT NOT NULL,
          label      TEXT,
          created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pin_project ON pins(project);
        -- One row per file per project: pinning the same file twice is a no-op
        -- rather than a duplicate chip.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_unique ON pins(project, path);

        CREATE TABLE IF NOT EXISTS run_config (
          project    TEXT PRIMARY KEY,
          command    TEXT,
          updated_at TEXT
        );

        -- Extra folders a project's chats may reach into, beyond the project
        -- folder itself (`claude --add-dir`). One row per folder per project.
        CREATE TABLE IF NOT EXISTS project_dirs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          project    TEXT NOT NULL,
          path       TEXT NOT NULL,
          created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pdir_project ON project_dirs(project);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pdir_unique ON project_dirs(project, path);

        -- Artifacts: the self-contained documents Claude builds in the artifact
        -- panel. One row per VERSION, oldest first, so the panel can walk back
        -- through revisions. `art_id` is the slug Claude reuses to revise one.
        --
        -- `turn` is the id of the user message whose turn produced the version.
        -- A single turn can patch an artifact a dozen times as Claude works
        -- through it; those all collapse into one version, because a version is
        -- meaningful to the user ("what it looked like after I asked for X"),
        -- not to the tool call.
        CREATE TABLE IF NOT EXISTS artifacts (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          project    TEXT NOT NULL,
          thread_id  TEXT,
          art_id     TEXT NOT NULL,
          title      TEXT,
          kind       TEXT NOT NULL,
          content    TEXT NOT NULL,
          version    INTEGER NOT NULL,
          turn       INTEGER,
          created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_project ON artifacts(project, art_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_version ON artifacts(project, art_id, version);
        "#;

/// Open (creating if needed) the database, run migrations and the schema.
pub fn open(db_path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(SCHEMA)?;

    // Migrations for databases created before these columns existed.
    // Errors (e.g. column already present) are intentionally ignored.
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN segments TEXT", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN mode TEXT DEFAULT 'auto'", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN orch INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN orch_sub TEXT DEFAULT 'auto'", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN effort TEXT DEFAULT 'high'", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN partial INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN ckpt TEXT", []);

    let json_file = db_path
        .parent()
        .map(|p| p.join("threads.json"))
        .unwrap_or_else(|| Path::new("threads.json").to_path_buf());
    migrate_json(&conn, &json_file);
    seed_projects(&conn);
    Ok(conn)
}

/// One-time migration for the pre-rename install. Older builds stored data at
/// `%APPDATA%/com.kristina.claudecode/kristina.db`; the Krystal rename changed
/// both the identifier (so the data dir moved) and the DB filename. If the new
/// DB doesn't exist yet but the old one does, checkpoint and copy it across so
/// existing chats carry over seamlessly.
pub fn migrate_legacy_store(new_dir: &Path, new_db: &Path) {
    if new_db.exists() {
        return; // already on the new store — nothing to do
    }
    // The old data dir is a sibling of the new one under %APPDATA%.
    let old_db = match new_dir.parent() {
        Some(appdata) => appdata.join("com.kristina.claudecode").join("kristina.db"),
        None => return,
    };
    if !old_db.exists() {
        return; // fresh install, no legacy data
    }
    // Fold any WAL contents back into the main file so a single copy is complete.
    if let Ok(conn) = Connection::open(&old_db) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    match std::fs::copy(&old_db, new_db) {
        Ok(_) => println!("  migrated existing chats from {}", old_db.display()),
        Err(e) => eprintln!("  could not migrate legacy database: {e}"),
    }
}

/// Ensure every distinct folder that already has chats shows up as a project,
/// so imported/older threads remain reachable through the project picker.
fn seed_projects(conn: &Connection) {
    let paths: Vec<String> = {
        let mut stmt = match conn.prepare(
            "SELECT DISTINCT cwd FROM threads
             WHERE cwd IS NOT NULL AND cwd <> '' AND cwd NOT IN (SELECT path FROM projects)",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows = stmt.query_map([], |r| r.get::<_, String>(0));
        match rows {
            Ok(it) => it.filter_map(|r| r.ok()).collect(),
            Err(_) => return,
        }
    };
    for p in paths {
        let id = uuid::Uuid::new_v4().to_string();
        let t = now();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO projects (id,path,name,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
            params![id, p, base_name(&p), t],
        );
    }
}

/// One-time import of an old data/threads.json into the empty database.
fn migrate_json(conn: &Connection, json_file: &Path) {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))
        .unwrap_or(0);
    if count > 0 || !json_file.exists() {
        return;
    }
    let parsed: Value = match std::fs::read_to_string(json_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => return,
    };
    let threads = match parsed.get("threads").and_then(|t| t.as_array()) {
        Some(a) if !a.is_empty() => a.clone(),
        _ => return,
    };
    for t in &threads {
        let u = t.get("usage").cloned().unwrap_or_else(|| json!({}));
        let getu = |k: &str| u.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
        let _ = conn.execute(
            "INSERT INTO threads (id,title,cwd,session_id,model,seed,turns,in_tok,out_tok,cost_usd,context,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                t.get("id").and_then(|x| x.as_str()).unwrap_or(""),
                t.get("title").and_then(|x| x.as_str()).unwrap_or("New chat"),
                t.get("cwd").and_then(|x| x.as_str()).unwrap_or(""),
                t.get("sessionId").and_then(|x| x.as_str()),
                t.get("model").and_then(|x| x.as_str()).unwrap_or(DEFAULT_MODEL),
                t.get("seed").and_then(|x| x.as_str()),
                getu("turns") as i64,
                getu("inTok") as i64,
                getu("outTok") as i64,
                getu("costUsd"),
                getu("context") as i64,
                t.get("createdAt").and_then(|x| x.as_str()).map(|s| s.to_string()).unwrap_or_else(now),
                t.get("updatedAt").and_then(|x| x.as_str()).map(|s| s.to_string()).unwrap_or_else(now),
            ],
        );
        if let Some(msgs) = t.get("messages").and_then(|m| m.as_array()) {
            let tid = t.get("id").and_then(|x| x.as_str()).unwrap_or("");
            for m in msgs {
                let files = m
                    .get("files")
                    .filter(|f| f.is_array())
                    .map(|f| f.to_string());
                let _ = conn.execute(
                    "INSERT INTO messages (thread_id,role,text,files,compacted,favorite,ts) VALUES (?1,?2,?3,?4,?5,0,?6)",
                    params![
                        tid,
                        m.get("role").and_then(|x| x.as_str()).unwrap_or("user"),
                        m.get("text").and_then(|x| x.as_str()).unwrap_or(""),
                        files,
                        m.get("compacted").and_then(|x| x.as_bool()).unwrap_or(false) as i64,
                        m.get("ts").and_then(|x| x.as_str()).map(|s| s.to_string()).unwrap_or_else(now),
                    ],
                );
            }
        }
    }
    let _ = std::fs::rename(json_file, json_file.with_extension("json.imported"));
    println!("  migrated {} chat(s) from threads.json into SQLite", threads.len());
}

mod artifacts;
mod branch;
mod messages;
mod pins;
mod projects;
mod run_config;
mod tasks;
mod threads;
mod turns;

pub use artifacts::*;
pub use branch::*;
pub use messages::*;
pub use pins::*;
pub use projects::*;
pub use run_config::*;
pub use tasks::*;
pub use threads::*;
pub use turns::*;


#[cfg(test)]
mod tests {
    use super::*;

    /// A blank database with the real schema, in memory.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn id_of(p: &Value) -> String {
        p["id"].as_str().unwrap().to_string()
    }

    fn cwd_of(conn: &Connection, thread: &str) -> String {
        conn.query_row("SELECT cwd FROM threads WHERE id = ?1", [thread], |r| r.get(0))
            .unwrap()
    }

    /// A thread to run turns against.
    fn thread(conn: &Connection) -> String {
        id_of(&create(conn, "/proj", "sonnet").unwrap())
    }

    /// The rows of a thread, as the UI would reload them.
    fn rows(conn: &Connection, id: &str) -> Vec<Value> {
        messages_of(conn, id)
    }

    #[test]
    fn the_users_message_is_saved_before_the_answer_is_asked_for() {
        let conn = db();
        let id = thread(&conn);
        begin_turn(&conn, &id, "how do I ship this?", &[], "");

        // Nothing has come back from Claude yet, and it is already on disk —
        // closing the app here must not lose what was typed.
        let msgs = rows(&conn, &id);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["text"], "how do I ship this?");
        assert_eq!(msgs[0]["partial"], true);
        // ...and the chat is findable in the sidebar rather than still "New chat".
        let title: Option<String> = conn
            .query_row("SELECT title FROM threads WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(title.as_deref(), Some("how do I ship this?"));
    }

    #[test]
    fn a_half_written_answer_survives_the_app_closing() {
        let conn = db();
        let id = thread(&conn);
        let uid = begin_turn(&conn, &id, "explain the pool", &[], "");
        let aid = save_partial(&conn, &id, None, "The pool keeps", &[]);
        // Same row on every flush, not a new one per tick.
        let again = save_partial(
            &conn,
            &id,
            Some(aid),
            "The pool keeps warm sessions",
            &[json!({ "type": "text", "text": "The pool keeps warm sessions" })],
        );
        assert_eq!(aid, again);

        // The app dies here: both rows are on disk, both flagged as unfinished.
        let msgs = rows(&conn, &id);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["id"].as_i64(), Some(uid));
        assert_eq!(msgs[1]["text"], "The pool keeps warm sessions");
        assert_eq!(msgs[1]["partial"], true);
        assert_eq!(msgs[1]["segments"][0]["type"], "text");
    }

    #[test]
    fn finishing_a_turn_fills_in_the_rows_it_opened() {
        let conn = db();
        let id = thread(&conn);
        let uid = begin_turn(&conn, &id, "hello", &[], "");
        let aid = save_partial(&conn, &id, None, "Hel", &[]);
        let (usage, _title, assistant_id, _ts) = finish_turn(
            &conn,
            &id,
            uid,
            Some(aid),
            "hello",
            "Hello there",
            &[json!({ "type": "text", "text": "Hello there" })],
            Some("sess-1"),
            &Some(json!({ "input_tokens": 10, "output_tokens": 4 })),
            0.02,
        );

        // No duplicate rows: the partial ones were completed in place.
        assert_eq!(assistant_id, aid);
        let msgs = rows(&conn, &id);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["partial"], false);
        assert_eq!(msgs[1]["text"], "Hello there");
        assert_eq!(msgs[1]["partial"], false);
        assert_eq!(usage["turns"], 1);
    }

    #[test]
    fn a_turn_that_answered_nothing_still_keeps_the_message() {
        let conn = db();
        let id = thread(&conn);
        let uid = begin_turn(&conn, &id, "wait, stop", &[], "");
        let aid = save_partial(&conn, &id, None, "", &[]);
        abort_turn(&conn, uid, Some(aid));

        // The empty answer placeholder goes; the typed message stays, and is no
        // longer flagged as in flight.
        let msgs = rows(&conn, &id);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["text"], "wait, stop");
        assert_eq!(msgs[0]["partial"], false);
    }

    #[test]
    fn aborting_keeps_an_answer_that_had_already_started() {
        let conn = db();
        let id = thread(&conn);
        let uid = begin_turn(&conn, &id, "long one", &[], "");
        let aid = save_partial(&conn, &id, None, "Sure — first", &[]);
        abort_turn(&conn, uid, Some(aid));

        let msgs = rows(&conn, &id);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1]["text"], "Sure — first");
        assert_eq!(msgs[1]["partial"], true);   // cut off, and says so
    }

    #[test]
    fn a_second_turn_does_not_rename_a_chat_that_already_has_a_name() {
        let conn = db();
        let id = thread(&conn);
        set_title(&conn, &id, "Shipping the release");
        begin_turn(&conn, &id, "and now the changelog", &[], "");
        let title: Option<String> = conn
            .query_row("SELECT title FROM threads WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(title.as_deref(), Some("Shipping the release"));
    }

    #[test]
    fn pinning_the_same_file_twice_is_a_no_op() {
        let conn = db();
        let pins = add_pin(&conn, "/proj", "/proj/TODO.md", "TODO.md");
        assert_eq!(pins.len(), 1);
        // Pinning it again must not produce a second chip for the same file.
        let pins = add_pin(&conn, "/proj", "/proj/TODO.md", "TODO.md");
        assert_eq!(pins.len(), 1);
        // The same path under a *different* project is a separate pin.
        assert_eq!(add_pin(&conn, "/other", "/proj/TODO.md", "TODO.md").len(), 1);
        assert_eq!(list_pins(&conn, "/proj").len(), 1);

        let id = pins[0]["id"].as_i64().unwrap();
        remove_pin(&conn, id);
        assert!(list_pins(&conn, "/proj").is_empty());
        assert_eq!(list_pins(&conn, "/other").len(), 1, "another project's pin is untouched");
    }

    #[test]
    fn adding_the_same_extra_folder_twice_is_a_no_op() {
        let conn = db();
        assert_eq!(add_project_dir(&conn, "/proj", "/shared/assets").len(), 1);
        assert_eq!(add_project_dir(&conn, "/proj", "/shared/assets").len(), 1);
        assert_eq!(add_project_dir(&conn, "/proj", "/shared/docs").len(), 2);
        assert_eq!(project_dir_paths(&conn, "/proj"), ["/shared/assets", "/shared/docs"]);

        let id = list_project_dirs(&conn, "/proj")[0]["id"].as_i64().unwrap();
        remove_project_dir(&conn, id);
        assert_eq!(project_dir_paths(&conn, "/proj"), ["/shared/docs"]);
        assert!(project_dir_paths(&conn, "/other").is_empty());
    }

    #[test]
    fn moving_a_project_repoints_extra_folders_that_lived_inside_it() {
        let conn = db();
        let p = create_project(&conn, "/old/place").unwrap();
        let id = id_of(&p);
        add_project_dir(&conn, "/old/place", "/old/place/vendor");
        add_project_dir(&conn, "/old/place", "/elsewhere/shared");

        move_project(&conn, &id, "/new/place").unwrap();

        let dirs = project_dir_paths(&conn, "/new/place");
        assert_eq!(dirs.len(), 2, "both folders follow the project");
        assert!(dirs.contains(&"/new/place/vendor".to_string()), "{dirs:?}");
        assert!(dirs.contains(&"/elsewhere/shared".to_string()), "outside folders stay put: {dirs:?}");
        assert!(project_dir_paths(&conn, "/old/place").is_empty());
    }

    /// Save one artifact state from chat `t1`, titled by its id.
    fn art(conn: &Connection, project: &str, art_id: &str, kind: &str, content: &str, turn: i64) {
        let w = ArtifactWrite { project, thread_id: "t1", art_id, title: art_id, kind, content, turn: Some(turn) };
        save_artifact(conn, &w);
    }

    #[test]
    fn an_artifact_gets_one_version_per_turn_however_often_it_is_patched() {
        let conn = db();
        // Turn one builds it, then patches it twice more while working.
        art(&conn, "/p", "chart", "text/html", "<h1>a</h1>", 1);
        art(&conn, "/p", "chart", "text/html", "<h1>b</h1>", 1);
        art(&conn, "/p", "chart", "text/html", "<h1>c</h1>", 1);
        let v = get_artifact(&conn, "/p", "chart", None).unwrap();
        assert_eq!(v["version"], 1, "one turn is one version");
        assert_eq!(v["versions"], 1);
        assert_eq!(v["content"], "<h1>c</h1>", "and it holds where the turn ended up");

        // The next turn opens a new version, and the old one is still reachable.
        art(&conn, "/p", "chart", "text/html", "<h1>d</h1>", 2);
        let v = get_artifact(&conn, "/p", "chart", None).unwrap();
        assert_eq!(v["version"], 2);
        assert_eq!(v["versions"], 2);
        assert_eq!(get_artifact(&conn, "/p", "chart", Some(1)).unwrap()["content"], "<h1>c</h1>");
    }

    #[test]
    fn the_artifact_list_names_each_artifact_once_at_its_latest_version() {
        let conn = db();
        art(&conn, "/p", "a", "text/html", "1", 1);
        art(&conn, "/p", "a", "text/html", "2", 2);
        art(&conn, "/p", "b", "text/markdown", "x", 3);
        art(&conn, "/other", "c", "text/html", "y", 1);

        let list = list_artifacts(&conn, "/p");
        assert_eq!(list.len(), 2, "two artifacts, not four rows");
        let a = list.iter().find(|x| x["artId"] == "a").unwrap();
        assert_eq!(a["version"], 2);
        assert_eq!(a["versions"], 2);
        assert!(list.iter().all(|x| x["artId"] != "c"), "another project's artifact stays there");

        delete_artifact(&conn, "/p", "a");
        assert_eq!(list_artifacts(&conn, "/p").len(), 1);
        assert!(get_artifact(&conn, "/p", "a", None).is_none(), "every version goes");
    }

    #[test]
    fn moving_a_project_takes_its_artifacts_along() {
        let conn = db();
        art(&conn, "/old/place", "poster", "image/svg+xml", "<svg/>", 1);
        let id = id_of(&create_project(&conn, "/old/place").unwrap());
        move_project(&conn, &id, "/new/place").expect("should move");

        assert!(list_artifacts(&conn, "/old/place").is_empty());
        let moved = list_artifacts(&conn, "/new/place");
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0]["artId"], "poster");
    }

    #[test]
    fn moving_a_project_repoints_pins_that_lived_inside_it() {
        let conn = db();
        let p = create_project(&conn, "/old/place").unwrap();
        let id = id_of(&p);
        // One pin inside the folder, one outside it.
        add_pin(&conn, "/old/place", "/old/place/docs/TODO.md", "TODO.md");
        add_pin(&conn, "/old/place", "/elsewhere/brief.md", "brief.md");

        move_project(&conn, &id, "/new/place").expect("should move");

        let pins = list_pins(&conn, "/new/place");
        assert_eq!(pins.len(), 2, "both pins follow the project");
        assert!(list_pins(&conn, "/old/place").is_empty());
        let paths: Vec<&str> = pins.iter().map(|p| p["path"].as_str().unwrap()).collect();
        // The one inside the folder is rewritten; the one outside is left alone.
        assert!(paths.contains(&"/new/place/docs/TODO.md"), "got {paths:?}");
        assert!(paths.contains(&"/elsewhere/brief.md"), "got {paths:?}");
    }

    #[test]
    fn moving_a_project_takes_its_chats_tasks_and_run_command_along() {
        let conn = db();
        let p = create_project(&conn, "/old/place").unwrap();
        let id = id_of(&p);
        let t = create(&conn, "/old/place", "claude-opus-5").unwrap();
        let tid = t["id"].as_str().unwrap().to_string();
        add_task(&conn, "/old/place", "ship it", None).unwrap();
        set_run_command(&conn, "/old/place", "npm run dev");
        // A chat elsewhere must stay put.
        let other = create(&conn, "/somewhere/else", "claude-opus-5").unwrap();
        let oid = other["id"].as_str().unwrap().to_string();

        let moved = move_project(&conn, &id, "/new/place").expect("should move");
        assert_eq!(moved["path"], "/new/place");
        assert_eq!(moved["name"], "place");
        assert_eq!(moved["chatCount"], 1);
        assert_eq!(cwd_of(&conn, &tid), "/new/place");
        assert_eq!(cwd_of(&conn, &oid), "/somewhere/else");
        assert_eq!(list_tasks(&conn, "/new/place").len(), 1);
        assert!(list_tasks(&conn, "/old/place").is_empty());
        assert_eq!(get_run_command(&conn, "/new/place").as_deref(), Some("npm run dev"));
        assert!(get_run_command(&conn, "/old/place").is_none());
    }

    // Resuming a session from a folder Claude Code never ran in fails the turn,
    // so a moved chat starts a fresh CLI session instead.
    #[test]
    fn moving_a_project_drops_its_chats_claude_sessions() {
        let conn = db();
        let id = id_of(&create_project(&conn, "/old").unwrap());
        let t = create(&conn, "/old", "claude-opus-5").unwrap();
        let tid = t["id"].as_str().unwrap().to_string();
        conn.execute("UPDATE threads SET session_id = 'sess-1' WHERE id = ?1", [&tid])
            .unwrap();

        move_project(&conn, &id, "/new").expect("should move");
        let sid: Option<String> = conn
            .query_row("SELECT session_id FROM threads WHERE id = ?1", [&tid], |r| r.get(0))
            .unwrap();
        assert_eq!(sid, None);
    }

    #[test]
    fn a_hand_picked_name_survives_the_move() {
        let conn = db();
        let id = id_of(&create_project(&conn, "/old/place").unwrap());
        conn.execute("UPDATE projects SET name = 'Novel' WHERE id = ?1", [&id]).unwrap();
        let moved = move_project(&conn, &id, "/new/place").unwrap();
        assert_eq!(moved["name"], "Novel");
    }

    #[test]
    fn a_folder_another_project_already_uses_is_refused() {
        let conn = db();
        let a = id_of(&create_project(&conn, "/a").unwrap());
        create_project(&conn, "/b").unwrap();
        assert!(move_project(&conn, &a, "/b").is_none());
        // …and nothing moved.
        assert_eq!(project_path(&conn, &a).as_deref(), Some("/a"));
    }

    #[test]
    fn moving_a_project_onto_its_own_folder_is_a_no_op() {
        let conn = db();
        let id = id_of(&create_project(&conn, "/same").unwrap());
        let p = move_project(&conn, &id, "/same").expect("should be fine");
        assert_eq!(p["path"], "/same");
    }

    #[test]
    fn a_stale_run_command_at_the_destination_is_replaced() {
        let conn = db();
        let id = id_of(&create_project(&conn, "/old").unwrap());
        set_run_command(&conn, "/old", "npm run dev");
        set_run_command(&conn, "/new", "left over from before");
        move_project(&conn, &id, "/new").expect("should move");
        assert_eq!(get_run_command(&conn, "/new").as_deref(), Some("npm run dev"));
    }

    /// A chat with two finished turns; returns the four row ids in order
    /// (ask 1, reply 1, ask 2, reply 2).
    fn two_turns(conn: &Connection, id: &str) -> [i64; 4] {
        let mut ids = vec![];
        for (ask, reply) in [("first ask", "first reply"), ("second ask", "second reply")] {
            let uid = begin_turn(conn, id, ask, &[], "");
            let (_u, _t, aid, _ts) =
                finish_turn(conn, id, uid, None, ask, reply, &[], Some("s"), &None, 0.0);
            ids.extend([uid, aid]);
        }
        [ids[0], ids[1], ids[2], ids[3]]
    }

    fn texts(conn: &Connection, id: &str) -> Vec<String> {
        rows(conn, id).iter().map(|m| m["text"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn branching_from_a_reply_keeps_everything_through_it() {
        let conn = db();
        let id = thread(&conn);
        let [_, r1, _, _] = two_turns(&conn, &id);

        let cut = branch_cut(&conn, &id, r1).unwrap();
        assert_eq!(cut, BranchCut { through: Some(r1), draft: None });
        let b = branch(&conn, &id, cut.through).unwrap();
        let bid = id_of(&b);
        assert_eq!(texts(&conn, &bid), ["first ask", "first reply"]);
        // Claude is seeded with exactly what the branch shows, nothing after it.
        let seed = b["seed"].as_str().unwrap();
        assert!(seed.contains("first reply") && !seed.contains("second"));
        // The original is untouched.
        assert_eq!(texts(&conn, &id).len(), 4);
    }

    #[test]
    fn branching_from_your_message_stops_before_it_and_hands_it_back() {
        let conn = db();
        let id = thread(&conn);
        let [a1, r1, a2, _] = two_turns(&conn, &id);

        let cut = branch_cut(&conn, &id, a2).unwrap();
        assert_eq!(cut, BranchCut { through: Some(r1), draft: Some("second ask".into()) });
        let bid = id_of(&branch(&conn, &id, cut.through).unwrap());
        assert_eq!(texts(&conn, &bid), ["first ask", "first reply"]);

        // From the very first message there is nothing before it: an empty
        // branch with the same settings, and that message to reword.
        let cut = branch_cut(&conn, &id, a1).unwrap();
        assert_eq!(cut.draft.as_deref(), Some("first ask"));
        let b = branch(&conn, &id, cut.through).unwrap();
        assert!(texts(&conn, &id_of(&b)).is_empty());
        assert!(b["seed"].is_null());
    }

    #[test]
    fn a_branch_cannot_be_cut_at_another_chats_message() {
        let conn = db();
        let id = thread(&conn);
        let other = thread(&conn);
        let [_, r1, _, _] = two_turns(&conn, &other);
        assert!(branch_cut(&conn, &id, r1).is_none());
    }

    #[test]
    fn a_branch_cut_before_a_compaction_leaves_its_summary_behind() {
        let conn = db();
        let id = thread(&conn);
        let [_, r1, _, _] = two_turns(&conn, &id);
        compact(&conn, &id, "SUMMARY of both turns");

        let early = branch(&conn, &id, Some(r1)).unwrap();
        assert!(!early["seed"].as_str().unwrap().contains("SUMMARY"));
        // The whole-chat branch still carries it.
        let whole = branch(&conn, &id, None).unwrap();
        assert!(whole["seed"].as_str().unwrap().contains("SUMMARY"));
    }
}
