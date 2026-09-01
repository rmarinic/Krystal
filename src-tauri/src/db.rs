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

/// Lightweight thread metadata used by the chat/action code paths.
#[allow(dead_code)] // id/title are kept for completeness even if unused by callers
pub struct ThreadMeta {
    pub id: String,
    pub title: Option<String>,
    pub cwd: String,
    pub session_id: Option<String>,
    pub model: String,
    pub mode: String,
    pub seed: Option<String>,
    /// Orchestrator mode: run `model` as a supervisor that delegates to workers.
    pub orch: bool,
    /// Worker sub-agent model when orchestrating, or `auto` to let it choose.
    pub orch_sub: String,
    /// Reasoning depth for the turn (`claude --effort`); see `models::EFFORTS`.
    pub effort: String,
}

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

/// Folder display name = the last path segment (handles trailing slashes).
fn base_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    if name.is_empty() { path.to_string() } else { name.to_string() }
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

/// True context-window size = the input of the LAST internal API call of the
/// turn. The CLI's top-level usage SUMS every internal step (over-counts ~2-3x),
/// so we read the last iteration. Mirrors `contextOf` in db.js.
pub fn context_of(usage: &Option<Value>) -> i64 {
    let u = match usage {
        Some(v) => v,
        None => return 0,
    };
    let last = u
        .get("iterations")
        .and_then(|it| it.as_array())
        .and_then(|a| a.last())
        .unwrap_or(u);
    let g = |k: &str| last.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens")
}

fn usage_obj(turns: i64, in_tok: i64, out_tok: i64, cost: f64, context: i64) -> Value {
    json!({ "turns": turns, "inTok": in_tok, "outTok": out_tok, "costUsd": cost, "context": context })
}

/* ------------------------------- queries --------------------------------- */

fn thread_list_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "title": r.get::<_, Option<String>>(1)?,
        "cwd": r.get::<_, Option<String>>(2)?,
        "updatedAt": r.get::<_, Option<String>>(3)?,
        "createdAt": r.get::<_, Option<String>>(4)?,
        "usage": usage_obj(
            r.get::<_, i64>(5)?, r.get::<_, i64>(6)?, r.get::<_, i64>(7)?,
            r.get::<_, f64>(8)?, r.get::<_, i64>(9)?,
        ),
    }))
}

/// List threads, optionally restricted to a single project's folder.
pub fn list_threads(conn: &Connection, project: Option<&str>) -> Vec<Value> {
    let mut stmt = conn
        .prepare(
            "SELECT id,title,cwd,updated_at,created_at,turns,in_tok,out_tok,cost_usd,context
             FROM threads WHERE (?1 IS NULL OR cwd = ?1) ORDER BY updated_at DESC",
        )
        .unwrap();
    let rows = stmt.query_map(params![project], thread_list_row).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn get_meta(conn: &Connection, id: &str) -> Option<ThreadMeta> {
    conn.query_row(
        "SELECT id,title,cwd,session_id,model,mode,seed,orch,orch_sub,effort FROM threads WHERE id = ?1",
        [id],
        |r| {
            Ok(ThreadMeta {
                id: r.get(0)?,
                title: r.get(1)?,
                cwd: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                session_id: r.get(3)?,
                model: r
                    .get::<_, Option<String>>(4)?
                    .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                mode: r
                    .get::<_, Option<String>>(5)?
                    .unwrap_or_else(|| DEFAULT_MODE.to_string()),
                seed: r.get(6)?,
                orch: r.get::<_, Option<i64>>(7)?.unwrap_or(0) != 0,
                orch_sub: r
                    .get::<_, Option<String>>(8)?
                    .unwrap_or_else(|| "auto".to_string()),
                effort: r
                    .get::<_, Option<String>>(9)?
                    .unwrap_or_else(|| DEFAULT_EFFORT.to_string()),
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

pub fn get_thread(conn: &Connection, id: &str) -> Option<Value> {
    let mut meta = conn
        .query_row(
            "SELECT id,title,cwd,session_id,model,mode,seed,turns,in_tok,out_tok,cost_usd,context,created_at,updated_at,orch,orch_sub,effort
             FROM threads WHERE id = ?1",
            [id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "title": r.get::<_, Option<String>>(1)?,
                    "cwd": r.get::<_, Option<String>>(2)?,
                    "sessionId": r.get::<_, Option<String>>(3)?,
                    "model": r.get::<_, Option<String>>(4)?.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                    "mode": r.get::<_, Option<String>>(5)?.unwrap_or_else(|| DEFAULT_MODE.to_string()),
                    "seed": r.get::<_, Option<String>>(6)?,
                    "usage": usage_obj(
                        r.get::<_, i64>(7)?, r.get::<_, i64>(8)?, r.get::<_, i64>(9)?,
                        r.get::<_, f64>(10)?, r.get::<_, i64>(11)?,
                    ),
                    "createdAt": r.get::<_, Option<String>>(12)?,
                    "updatedAt": r.get::<_, Option<String>>(13)?,
                    "orch": r.get::<_, Option<i64>>(14)?.unwrap_or(0) != 0,
                    "orchSub": r.get::<_, Option<String>>(15)?.unwrap_or_else(|| "auto".to_string()),
                    "effort": r.get::<_, Option<String>>(16)?.unwrap_or_else(|| DEFAULT_EFFORT.to_string()),
                }))
            },
        )
        .optional()
        .ok()
        .flatten()?;
    meta["messages"] = Value::Array(messages_of(conn, id));
    Some(meta)
}

fn messages_of(conn: &Connection, id: &str) -> Vec<Value> {
    let mut stmt = conn
        .prepare("SELECT id,role,text,files,segments,compacted,favorite,ts,partial FROM messages WHERE thread_id = ?1 ORDER BY id ASC")
        .unwrap();
    let rows = stmt
        .query_map([id], |r| {
            let files_raw: Option<String> = r.get(3)?;
            let files = files_raw
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or_else(|| json!([]));
            let segments_raw: Option<String> = r.get(4)?;
            let segments = segments_raw
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or(Value::Null);
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "role": r.get::<_, String>(1)?,
                "text": r.get::<_, String>(2)?,
                "files": files,
                "segments": segments,
                "compacted": r.get::<_, i64>(5)? != 0,
                "favorite": r.get::<_, i64>(6)? != 0,
                "ts": r.get::<_, Option<String>>(7)?,
                "partial": r.get::<_, i64>(8)? != 0,
            }))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn create(conn: &Connection, cwd: &str, default_model: &str) -> Option<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let t = now();
    conn.execute(
        "INSERT INTO threads (id,title,cwd,session_id,model,seed,turns,in_tok,out_tok,cost_usd,context,created_at,updated_at)
         VALUES (?1,?2,?3,NULL,?4,NULL,0,0,0,0,0,?5,?6)",
        params![id, "New chat", cwd, default_model, t, t],
    )
    .ok()?;
    get_thread(conn, &id)
}

/// Name a branched chat after its source, tagged with a "↳" so it's easy to spot
/// in the list. Falls back to a plain name and caps the length so it stays tidy.
fn branch_title(source: Option<&str>) -> String {
    let base = source
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "New chat")
        .unwrap_or("New chat");
    let tagged = format!("↳ {base}");
    tagged.chars().take(120).collect()
}

/// Assemble the seed for a branched thread: the source's own carried summary (if
/// it had one) followed by its transcript, so the branch's first turn continues
/// seamlessly even though the underlying Claude session can't be forked. Bounded
/// to a sane size (keeps the most recent slice, like the #-reference context).
fn build_branch_seed(conn: &Connection, source_id: &str, prior_seed: Option<&str>) -> Option<String> {
    const MAX_CHARS: usize = 48_000;
    let mut body = String::new();
    if let Some(s) = prior_seed {
        if !s.trim().is_empty() {
            body.push_str(s.trim());
            body.push_str("\n\n");
        }
    }
    for (role, text) in recent_messages(conn, source_id, 2000) {
        let who = if role == "user" { "User" } else { "Assistant" };
        body.push_str(who);
        body.push_str(": ");
        body.push_str(&text);
        body.push_str("\n\n");
    }
    let body = body.trim_end();
    if body.is_empty() {
        return None;
    }
    let chars: Vec<char> = body.chars().collect();
    if chars.len() > MAX_CHARS {
        let tail: String = chars[chars.len() - MAX_CHARS..].iter().collect();
        Some(format!("[…earlier messages omitted…]\n\n{tail}"))
    } else {
        Some(body.to_string())
    }
}

/// Fork a conversation: create a new thread in the same folder that starts as a
/// copy of `source_id` — same settings and full transcript — but with its own
/// fresh Claude session. The prior conversation is folded into the new thread's
/// `seed` so Claude keeps full context on the first branched turn (the CLI
/// session itself can't be forked, so we reconstruct context the same way a
/// compaction summary is carried forward). The original thread is untouched.
pub fn branch(conn: &Connection, source_id: &str) -> Option<Value> {
    let (title, cwd, model, mode, orch, orch_sub, effort, seed) = conn
        .query_row(
            "SELECT title,cwd,model,mode,orch,orch_sub,effort,seed FROM threads WHERE id = ?1",
            [source_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(2)?.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                    r.get::<_, Option<String>>(3)?.unwrap_or_else(|| DEFAULT_MODE.to_string()),
                    r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "auto".to_string()),
                    r.get::<_, Option<String>>(6)?.unwrap_or_else(|| DEFAULT_EFFORT.to_string()),
                    r.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()?;

    let branch_seed = build_branch_seed(conn, source_id, seed.as_deref());
    let new_id = uuid::Uuid::new_v4().to_string();
    let t = now();
    let new_title = branch_title(title.as_deref());

    // A fresh session (usage reset to 0); the transcript is carried via the seed.
    conn.execute(
        "INSERT INTO threads (id,title,cwd,session_id,model,mode,orch,orch_sub,effort,seed,turns,in_tok,out_tok,cost_usd,context,created_at,updated_at)
         VALUES (?1,?2,?3,NULL,?4,?5,?6,?7,?8,?9,0,0,0,0,0,?10,?10)",
        params![new_id, new_title, cwd, model, mode, orch, orch_sub, effort, branch_seed, t],
    )
    .ok()?;

    // Copy the full transcript verbatim (files/segments columns carried across
    // as-is) so the branch renders identically. Favorites stay with the original.
    let _ = conn.execute(
        "INSERT INTO messages (thread_id,role,text,files,segments,compacted,favorite,ts)
         SELECT ?1, role, text, files, segments, compacted, 0, ts
         FROM messages WHERE thread_id = ?2 ORDER BY id ASC",
        params![new_id, source_id],
    );

    get_thread(conn, &new_id)
}

pub fn remove(conn: &Connection, id: &str) {
    let _ = conn.execute("DELETE FROM threads WHERE id = ?1", [id]);
}

pub fn set_model(conn: &Connection, id: &str, model: &str) {
    let _ = conn.execute("UPDATE threads SET model = ?1 WHERE id = ?2", params![model, id]);
}

pub fn set_mode(conn: &Connection, id: &str, mode: &str) {
    let _ = conn.execute("UPDATE threads SET mode = ?1 WHERE id = ?2", params![mode, id]);
}

pub fn set_orchestration(conn: &Connection, id: &str, orch: bool, sub_model: &str) {
    let _ = conn.execute(
        "UPDATE threads SET orch = ?1, orch_sub = ?2 WHERE id = ?3",
        params![orch as i64, sub_model, id],
    );
}

pub fn set_effort(conn: &Connection, id: &str, effort: &str) {
    let _ = conn.execute("UPDATE threads SET effort = ?1 WHERE id = ?2", params![effort, id]);
}

pub fn set_seed(conn: &Connection, id: &str, seed: Option<&str>) {
    let _ = conn.execute("UPDATE threads SET seed = ?1 WHERE id = ?2", params![seed, id]);
}

pub fn clear(conn: &Connection, id: &str) {
    let _ = conn.execute("DELETE FROM messages WHERE thread_id = ?1", [id]);
    let _ = conn.execute(
        "UPDATE threads SET session_id=NULL, seed=NULL, turns=0, in_tok=0, out_tok=0, cost_usd=0, context=0, updated_at=?1 WHERE id=?2",
        params![now(), id],
    );
}

/// Fall back to the opening words of a message when a thread has no real title
/// yet — the same name `finish_turn` would settle on.
fn title_from(user_text: &str) -> String {
    let chars: Vec<char> = user_text.chars().collect();
    let mut tt: String = chars.iter().take(48).collect();
    if chars.len() > 48 {
        tt.push('…');
    }
    tt
}

/// Open a turn: persist the user's message *before* Claude is asked anything, so
/// closing the app mid-answer can never swallow what was typed. The row is marked
/// `partial` — a turn is in flight over it — and cleared by `finish_turn` or
/// `abort_turn`. The thread also takes its fallback title now rather than at the
/// end, so a chat interrupted on its first turn is still findable in the sidebar.
/// Returns the message's row id.
pub fn begin_turn(conn: &Connection, id: &str, user_text: &str, files: &[String]) -> i64 {
    let t = now();
    let files_json = if files.is_empty() {
        None
    } else {
        Some(serde_json::to_string(files).unwrap_or_else(|_| "[]".into()))
    };
    let _ = conn.execute(
        "INSERT INTO messages (thread_id,role,text,files,compacted,favorite,partial,ts) VALUES (?1,'user',?2,?3,0,0,1,?4)",
        params![id, user_text, files_json, t],
    );
    let msg_id = conn.last_insert_rowid();

    let cur_title: Option<String> = conn
        .query_row("SELECT title FROM threads WHERE id = ?1", [id], |r| r.get(0))
        .ok()
        .flatten();
    let named = matches!(&cur_title, Some(s) if !s.is_empty() && s != "New chat");
    if named {
        let _ = conn.execute("UPDATE threads SET updated_at=?1 WHERE id=?2", params![t, id]);
    } else {
        let _ = conn.execute(
            "UPDATE threads SET title=?1, updated_at=?2 WHERE id=?3",
            params![title_from(user_text), t, id],
        );
    }
    msg_id
}

/// Write the answer down as it is being written. Called on a throttle from the
/// turn loop so a half-finished reply survives the app going away; the row stays
/// `partial` until the turn lands. Creates it on the first call and updates it
/// after that — returns its id either way.
pub fn save_partial(
    conn: &Connection,
    thread_id: &str,
    msg_id: Option<i64>,
    text: &str,
    segments: &[Value],
) -> i64 {
    let segments_json = if segments.is_empty() {
        None
    } else {
        Some(serde_json::to_string(segments).unwrap_or_else(|_| "[]".into()))
    };
    match msg_id {
        Some(mid) => {
            let _ = conn.execute(
                "UPDATE messages SET text=?1, segments=?2 WHERE id=?3",
                params![text, segments_json, mid],
            );
            mid
        }
        None => {
            let _ = conn.execute(
                "INSERT INTO messages (thread_id,role,text,files,segments,compacted,favorite,partial,ts) VALUES (?1,'assistant',?2,NULL,?3,0,0,1,?4)",
                params![thread_id, text, segments_json, now()],
            );
            conn.last_insert_rowid()
        }
    }
}

/// Close a turn that produced nothing usable (stopped before the first word, or a
/// session that refused to start). The user's message stays — it is theirs — but
/// stops being "in flight"; an empty answer placeholder is dropped.
pub fn abort_turn(conn: &Connection, user_msg_id: i64, assistant_msg_id: Option<i64>) {
    let _ = conn.execute(
        "UPDATE messages SET partial=0 WHERE id=?1",
        params![user_msg_id],
    );
    if let Some(mid) = assistant_msg_id {
        let _ = conn.execute(
            "DELETE FROM messages WHERE id=?1 AND TRIM(text)=''",
            params![mid],
        );
    }
}

/// Land one completed turn: fill in the rows `begin_turn`/`save_partial` opened
/// (creating the answer row for a turn that streamed nothing), clear the
/// in-flight flag and roll up the thread's totals.
/// Returns (cumulative usage, title, assistantId, ts).
#[allow(clippy::too_many_arguments)]
pub fn finish_turn(
    conn: &Connection,
    id: &str,
    user_msg_id: i64,
    assistant_msg_id: Option<i64>,
    user_text: &str,
    assistant_text: &str,
    segments: &[Value],
    session_id: Option<&str>,
    usage: &Option<Value>,
    cost_usd: f64,
) -> (Value, String, i64, String) {
    let t = now();
    let (cur_title, turns, in_tok, out_tok, cost) = conn
        .query_row(
            "SELECT title,turns,in_tok,out_tok,cost_usd FROM threads WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, f64>(4)?,
                ))
            },
        )
        .unwrap_or((None, 0, 0, 0, 0.0));

    let _ = conn.execute(
        "UPDATE messages SET partial=0 WHERE id=?1",
        params![user_msg_id],
    );

    let segments_json = if segments.is_empty() {
        None
    } else {
        Some(serde_json::to_string(segments).unwrap_or_else(|_| "[]".into()))
    };
    let assistant_id = match assistant_msg_id {
        Some(mid) => {
            let _ = conn.execute(
                "UPDATE messages SET text=?1, segments=?2, partial=0 WHERE id=?3",
                params![assistant_text, segments_json, mid],
            );
            mid
        }
        None => {
            let _ = conn.execute(
                "INSERT INTO messages (thread_id,role,text,files,segments,compacted,favorite,partial,ts) VALUES (?1,'assistant',?2,NULL,?3,0,0,0,?4)",
                params![id, assistant_text, segments_json, t],
            );
            conn.last_insert_rowid()
        }
    };

    let turn_in = context_of(usage);
    let title = match &cur_title {
        Some(s) if !s.is_empty() && s != "New chat" => s.clone(),
        _ => title_from(user_text),
    };
    let out = usage
        .as_ref()
        .and_then(|u| u.get("output_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);

    let new_turns = turns + 1;
    let new_in = in_tok + turn_in;
    let new_out = out_tok + out;
    let new_cost = cost + cost_usd;
    let new_ctx = turn_in;

    let _ = conn.execute(
        "UPDATE threads SET session_id=?1, title=?2, turns=?3, in_tok=?4, out_tok=?5, cost_usd=?6, context=?7, updated_at=?8 WHERE id=?9",
        params![session_id, title, new_turns, new_in, new_out, new_cost, new_ctx, t, id],
    );

    (
        usage_obj(new_turns, new_in, new_out, new_cost, new_ctx),
        title,
        assistant_id,
        t,
    )
}

/// Overwrite a thread's title (used by the auto-namer on the first turn).
pub fn set_title(conn: &Connection, id: &str, title: &str) {
    let _ = conn.execute(
        "UPDATE threads SET title = ?1 WHERE id = ?2",
        params![title, id],
    );
}

/// Stash a summary as a seed, drop the heavy session, reset the meter, and leave
/// a friendly marker in the transcript.
pub fn compact(conn: &Connection, id: &str, summary: &str) {
    let t = now();
    let _ = conn.execute(
        "UPDATE threads SET seed=?1, session_id=NULL, turns=0, in_tok=0, out_tok=0, cost_usd=0, context=0, updated_at=?2 WHERE id=?3",
        params![summary, t, id],
    );
    let _ = conn.execute(
        "INSERT INTO messages (thread_id,role,text,files,compacted,favorite,ts) VALUES (?1,'assistant',?2,NULL,1,0,?3)",
        params![
            id,
            "🧹 **Conversation compacted.** I kept a summary of everything important and dropped the bulk, so things stay quick and sharp. Just keep chatting.",
            t
        ],
    );
}

/// Persist a direct shell run (the composer's `$` escape hatch) as a
/// self-contained shell message so it survives reload. It deliberately does NOT
/// touch the Claude session, usage or turn count — it runs outside Claude.
pub fn add_shell_run(conn: &Connection, id: &str, command: &str, output: &str, code: i32) -> Value {
    let t = now();
    let seg = json!([{ "type": "shell", "command": command, "output": output, "code": code }]);
    let segments_json = serde_json::to_string(&seg).unwrap_or_else(|_| "[]".into());
    // `text` mirrors command + output so search can still find shell runs.
    let text = format!("$ {command}\n{output}");
    let _ = conn.execute(
        "INSERT INTO messages (thread_id,role,text,files,segments,compacted,favorite,ts) VALUES (?1,'assistant',?2,NULL,?3,0,0,?4)",
        params![id, text, segments_json, t],
    );
    let mid = conn.last_insert_rowid();
    let _ = conn.execute("UPDATE threads SET updated_at=?1 WHERE id=?2", params![t, id]);
    json!({ "id": mid, "ts": t })
}

pub fn recent_messages(conn: &Connection, id: &str, n: i64) -> Vec<(String, String)> {
    let mut stmt = conn
        .prepare("SELECT role,text FROM messages WHERE thread_id = ?1 ORDER BY id DESC LIMIT ?2")
        .unwrap();
    let rows = stmt
        .query_map(params![id, n], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .unwrap();
    let mut v: Vec<(String, String)> = rows.filter_map(|r| r.ok()).collect();
    v.reverse();
    v
}

/* ---- search + favorites ---- */

pub fn search(conn: &Connection, q: &str, project: Option<&str>) -> Vec<Value> {
    let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.thread_id, m.role, m.text, m.ts, t.title
             FROM messages m JOIN threads t ON t.id = m.thread_id
             WHERE m.text LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR t.cwd = ?2)
             ORDER BY m.id DESC LIMIT 60",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![like, project], |r| {
            Ok(json!({
                "messageId": r.get::<_, i64>(0)?,
                "threadId": r.get::<_, String>(1)?,
                "role": r.get::<_, String>(2)?,
                "text": r.get::<_, String>(3)?,
                "ts": r.get::<_, Option<String>>(4)?,
                "threadTitle": r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "New chat".into()),
            }))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn toggle_favorite(conn: &Connection, message_id: i64) -> Option<Value> {
    let cur: Option<i64> = conn
        .query_row("SELECT favorite FROM messages WHERE id = ?1", [message_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let cur = cur?;
    let fav = if cur != 0 { 0 } else { 1 };
    let _ = conn.execute("UPDATE messages SET favorite = ?1 WHERE id = ?2", params![fav, message_id]);
    Some(json!({ "favorite": fav != 0 }))
}

/// Remove a single message from a thread's transcript. Returns the thread id it
/// belonged to, or `None` if there was no such message.
///
/// This edits the *saved* transcript only — the `claude` session the thread
/// resumes from keeps its own history, so a deleted message can still colour
/// later replies until the chat is cleared or compacted. The UI says so.
pub fn delete_message(conn: &Connection, message_id: i64) -> Option<String> {
    let thread_id: Option<String> = conn
        .query_row("SELECT thread_id FROM messages WHERE id = ?1", [message_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let thread_id = thread_id?;
    conn.execute("DELETE FROM messages WHERE id = ?1", [message_id]).ok()?;
    Some(thread_id)
}

pub fn list_favorites(conn: &Connection, project: Option<&str>) -> Vec<Value> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.thread_id, m.text, m.ts, t.title
             FROM messages m JOIN threads t ON t.id = m.thread_id
             WHERE m.favorite = 1 AND (?1 IS NULL OR t.cwd = ?1) ORDER BY m.id DESC",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![project], |r| {
            Ok(json!({
                "messageId": r.get::<_, i64>(0)?,
                "threadId": r.get::<_, String>(1)?,
                "text": r.get::<_, String>(2)?,
                "ts": r.get::<_, Option<String>>(3)?,
                "threadTitle": r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "New chat".into()),
            }))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/* -------------------------------- projects ------------------------------- */

fn project_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "path": r.get::<_, Option<String>>(1)?,
        "name": r.get::<_, Option<String>>(2)?,
        "createdAt": r.get::<_, Option<String>>(3)?,
        "updatedAt": r.get::<_, Option<String>>(4)?,
        "chatCount": r.get::<_, i64>(5)?,
    }))
}

const PROJECT_SELECT: &str = "SELECT p.id, p.path, p.name, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM threads t WHERE t.cwd = p.path) AS chat_count
     FROM projects p";

pub fn list_projects(conn: &Connection) -> Vec<Value> {
    let sql = format!("{PROJECT_SELECT} ORDER BY p.updated_at DESC");
    let mut stmt = conn.prepare(&sql).unwrap();
    let rows = stmt.query_map([], project_row).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn get_project(conn: &Connection, id: &str) -> Option<Value> {
    let sql = format!("{PROJECT_SELECT} WHERE p.id = ?1");
    conn.query_row(&sql, [id], project_row).optional().ok().flatten()
}

/// Create a project for `path`, or return (and touch) the existing one.
pub fn create_project(conn: &Connection, path: &str) -> Option<Value> {
    let t = now();
    let existing: Option<String> = conn
        .query_row("SELECT id FROM projects WHERE path = ?1", [path], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let id = match existing {
        Some(id) => {
            let _ = conn.execute("UPDATE projects SET updated_at = ?1 WHERE id = ?2", params![t, id]);
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO projects (id,path,name,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
                params![id, path, base_name(path), t],
            )
            .ok()?;
            id
        }
    };
    get_project(conn, &id)
}

/// Mark a project as just-opened (moves it to the top of the list) and return it.
pub fn select_project(conn: &Connection, id: &str) -> Option<Value> {
    let _ = conn.execute("UPDATE projects SET updated_at = ?1 WHERE id = ?2", params![now(), id]);
    get_project(conn, id)
}

/// The folder a project currently points at.
pub fn project_path(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT path FROM projects WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

/// Point a project at a different folder — the project keeps its identity and
/// takes everything keyed by its path with it: its chats (`threads.cwd`), its
/// tasks and its run command.
///
/// Every moved chat's `session_id` is dropped on purpose. Claude Code keys its
/// own session store by working directory, so resuming one of those sessions from
/// the new folder would look for a transcript that isn't there and fail the turn.
/// Krystal's own transcript is untouched — only the CLI-side continuation starts
/// fresh, the same way Clear already works.
///
/// Returns the updated project, or None if the move didn't happen (unknown
/// project, or another project already lives in that folder).
pub fn move_project(conn: &Connection, id: &str, new_path: &str) -> Option<Value> {
    let old = project_path(conn, id)?;
    if old == new_path {
        return get_project(conn, id);
    }
    if project_path_taken(conn, new_path) {
        return None;
    }
    // A name that still matches the old folder follows along; one the user picked
    // themselves stays as it is.
    let name = get_project(conn, id)
        .and_then(|p| p.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .filter(|n| *n != base_name(&old))
        .unwrap_or_else(|| base_name(new_path));

    let t = now();
    let _ = conn.execute_batch("BEGIN");
    let done = (|| -> rusqlite::Result<()> {
        conn.execute(
            "UPDATE projects SET path = ?1, name = ?2, updated_at = ?3 WHERE id = ?4",
            params![new_path, name, t, id],
        )?;
        conn.execute(
            "UPDATE threads SET cwd = ?1, session_id = NULL WHERE cwd = ?2",
            params![new_path, old],
        )?;
        conn.execute("UPDATE tasks SET project = ?1 WHERE project = ?2", params![new_path, old])?;
        // Pins are re-keyed to the new project path, and any that pointed *inside*
        // the old folder are rewritten to their new home — otherwise every pin
        // would silently turn into a dead path after a move.
        conn.execute(
            "UPDATE pins SET path = ?1 || substr(path, length(?2) + 1) WHERE project = ?2 AND path LIKE ?2 || '%'",
            params![new_path, old],
        )?;
        conn.execute("UPDATE pins SET project = ?1 WHERE project = ?2", params![new_path, old])?;
        // Extra folders get the same treatment: re-keyed to the new project, and
        // any that sat *inside* the old folder follow it to the new one.
        conn.execute(
            "UPDATE project_dirs SET path = ?1 || substr(path, length(?2) + 1) WHERE project = ?2 AND path LIKE ?2 || '%'",
            params![new_path, old],
        )?;
        conn.execute(
            "DELETE FROM project_dirs WHERE project = ?1",
            [new_path],
        )?;
        conn.execute(
            "UPDATE project_dirs SET project = ?1 WHERE project = ?2",
            params![new_path, old],
        )?;
        // run_config is keyed by path, so clear any stale row at the destination
        // before the old one takes its place.
        conn.execute("DELETE FROM run_config WHERE project = ?1", [new_path])?;
        conn.execute(
            "UPDATE run_config SET project = ?1 WHERE project = ?2",
            params![new_path, old],
        )?;
        Ok(())
    })();
    let _ = conn.execute_batch(if done.is_ok() { "COMMIT" } else { "ROLLBACK" });
    done.ok()?;
    get_project(conn, id)
}

/// Whether some project already points at this folder.
pub fn project_path_taken(conn: &Connection, path: &str) -> bool {
    conn.query_row("SELECT 1 FROM projects WHERE path = ?1", [path], |r| r.get::<_, i64>(0))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// Bump a project's recency by its folder path (called when a chat is created).
pub fn touch_project(conn: &Connection, path: &str) {
    let _ = conn.execute("UPDATE projects SET updated_at = ?1 WHERE path = ?2", params![now(), path]);
}

/* --------------------------------- tasks --------------------------------- */
/* A lightweight per-project to-do list. Tasks are keyed by the project's folder
 * path (the same `cwd` threads use), so they belong to the project regardless of
 * which chat is open. Created by hand or generated by Claude from a description. */

fn task_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?,
        "title": r.get::<_, String>(1)?,
        "note": r.get::<_, Option<String>>(2)?,
        "done": r.get::<_, i64>(3)? != 0,
        "createdAt": r.get::<_, Option<String>>(4)?,
        "updatedAt": r.get::<_, Option<String>>(5)?,
    }))
}

/// List a project's tasks in creation order (open and done kept in place so the
/// list never reshuffles when you tick something off).
pub fn list_tasks(conn: &Connection, project: &str) -> Vec<Value> {
    let mut stmt = conn
        .prepare(
            "SELECT id,title,note,done,created_at,updated_at FROM tasks
             WHERE project = ?1 ORDER BY id ASC",
        )
        .unwrap();
    let rows = stmt.query_map([project], task_row).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// Add one task and return it. Title is trimmed; an empty title is rejected by
/// the caller (the command layer).
pub fn add_task(conn: &Connection, project: &str, title: &str, note: Option<&str>) -> Option<Value> {
    let t = now();
    conn.execute(
        "INSERT INTO tasks (project,title,note,done,created_at,updated_at) VALUES (?1,?2,?3,0,?4,?4)",
        params![project, title, note, t],
    )
    .ok()?;
    let id = conn.last_insert_rowid();
    get_task(conn, id)
}

pub fn get_task(conn: &Connection, id: i64) -> Option<Value> {
    conn.query_row(
        "SELECT id,title,note,done,created_at,updated_at FROM tasks WHERE id = ?1",
        [id],
        task_row,
    )
    .optional()
    .ok()
    .flatten()
}

/// Update a task's title and/or done state (whichever fields are provided),
/// touching updated_at. Returns the fresh row.
pub fn update_task(conn: &Connection, id: i64, title: Option<&str>, done: Option<bool>) -> Option<Value> {
    let t = now();
    if let Some(title) = title {
        let _ = conn.execute(
            "UPDATE tasks SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, t, id],
        );
    }
    if let Some(done) = done {
        let _ = conn.execute(
            "UPDATE tasks SET done = ?1, updated_at = ?2 WHERE id = ?3",
            params![done as i64, t, id],
        );
    }
    get_task(conn, id)
}

pub fn delete_task(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM tasks WHERE id = ?1", [id]);
}

/// Overwrite a task's title, note and done state in one go — used when syncing
/// Claude's edits to the markdown snapshot back into the database.
pub fn set_task(conn: &Connection, id: i64, title: &str, note: Option<&str>, done: bool) {
    let _ = conn.execute(
        "UPDATE tasks SET title = ?1, note = ?2, done = ?3, updated_at = ?4 WHERE id = ?5",
        params![title, note, done as i64, now(), id],
    );
}

/// Remove every completed task in a project; returns how many were cleared.
pub fn clear_done_tasks(conn: &Connection, project: &str) -> usize {
    conn.execute("DELETE FROM tasks WHERE project = ?1 AND done = 1", [project])
        .unwrap_or(0)
}

/// Open-task count per project folder, for the sidebar badge — returned as a map
/// of path → count so the picker/foot button can show it without N queries.
pub fn open_task_count(conn: &Connection, project: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE project = ?1 AND done = 0",
        [project],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/* ------------------------------- run config ------------------------------ */
/* How to start a project locally for testing (the RUN button). One command per
 * project folder — the same `path` threads/tasks use — set by hand or detected
 * by Claude. Empty/whitespace is treated as "not set yet". */

/// The stored run command for a project folder, or None if unset/blank.
pub fn get_run_command(conn: &Connection, project: &str) -> Option<String> {
    conn.query_row(
        "SELECT command FROM run_config WHERE project = ?1",
        [project],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .filter(|s| !s.trim().is_empty())
}

/// Set (or overwrite) a project's run command.
/* ---------------------------------- pins --------------------------------- */
/// Files the user has pinned to the side of the chat for quick reference — a
/// task list, a brief, notes. Scoped to a project, ordered oldest-first so the
/// rail doesn't reshuffle itself as pins come and go.

pub fn list_pins(conn: &Connection, project: &str) -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, path, label FROM pins WHERE project = ?1 ORDER BY id ASC",
    ) {
        if let Ok(rows) = stmt.query_map([project], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "path": r.get::<_, String>(1)?,
                "label": r.get::<_, Option<String>>(2)?,
            }))
        }) {
            out.extend(rows.flatten());
        }
    }
    out
}

/// Pin a file. Pinning one that is already pinned just returns the whole list
/// again, so the caller never has to special-case a duplicate.
pub fn add_pin(conn: &Connection, project: &str, path: &str, label: &str) -> Vec<Value> {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO pins (project, path, label, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![project, path, label, now()],
    );
    list_pins(conn, project)
}

pub fn remove_pin(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM pins WHERE id = ?1", [id]);
}

/* ------------------------------ extra folders ----------------------------- */
/// Folders outside the project that its chats may still read and write — a
/// shared assets folder, a second repo, the notes you keep somewhere else. Each
/// one reaches the CLI as `--add-dir`, so this is a project-level permission
/// list rather than a bookmark list. Oldest-first, like pins.

pub fn list_project_dirs(conn: &Connection, project: &str) -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT id, path FROM project_dirs WHERE project = ?1 ORDER BY id ASC")
    {
        if let Ok(rows) = stmt.query_map([project], |r| {
            Ok(json!({ "id": r.get::<_, i64>(0)?, "path": r.get::<_, String>(1)? }))
        }) {
            out.extend(rows.flatten());
        }
    }
    out
}

/// Adding a folder twice is a no-op rather than a duplicate row.
pub fn add_project_dir(conn: &Connection, project: &str, path: &str) -> Vec<Value> {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO project_dirs (project, path, created_at) VALUES (?1, ?2, ?3)",
        params![project, path, now()],
    );
    list_project_dirs(conn, project)
}

pub fn remove_project_dir(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM project_dirs WHERE id = ?1", [id]);
}

/// Just the paths, for building `--add-dir` flags on a chat turn.
pub fn project_dir_paths(conn: &Connection, project: &str) -> Vec<String> {
    list_project_dirs(conn, project)
        .into_iter()
        .filter_map(|d| d["path"].as_str().map(str::to_string))
        .collect()
}

pub fn set_run_command(conn: &Connection, project: &str, command: &str) {
    let t = now();
    let _ = conn.execute(
        "INSERT INTO run_config (project,command,updated_at) VALUES (?1,?2,?3)
         ON CONFLICT(project) DO UPDATE SET command = ?2, updated_at = ?3",
        params![project, command, t],
    );
}

/// Delete a project and all of its chats.
pub fn delete_project(conn: &Connection, id: &str) {
    let path: Option<String> = conn
        .query_row("SELECT path FROM projects WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    if let Some(path) = path {
        let _ = conn.execute("DELETE FROM threads WHERE cwd = ?1", [&path]);
        let _ = conn.execute("DELETE FROM tasks WHERE project = ?1", [&path]);
        let _ = conn.execute("DELETE FROM run_config WHERE project = ?1", [&path]);
        let _ = conn.execute("DELETE FROM project_dirs WHERE project = ?1", [&path]);
    }
    let _ = conn.execute("DELETE FROM projects WHERE id = ?1", [id]);
}

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
        begin_turn(&conn, &id, "how do I ship this?", &[]);

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
        let uid = begin_turn(&conn, &id, "explain the pool", &[]);
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
        let uid = begin_turn(&conn, &id, "hello", &[]);
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
        let uid = begin_turn(&conn, &id, "wait, stop", &[]);
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
        let uid = begin_turn(&conn, &id, "long one", &[]);
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
        begin_turn(&conn, &id, "and now the changelog", &[]);
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
}
