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

use crate::models::{DEFAULT_MODE, DEFAULT_MODEL};

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
}

/// ISO-8601 millisecond timestamp, matching JS `new Date().toISOString()`.
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Open (creating if needed) the database, run migrations and the schema.
pub fn open(db_path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS threads (
          id         TEXT PRIMARY KEY,
          title      TEXT,
          cwd        TEXT,
          session_id TEXT,
          model      TEXT,
          mode       TEXT DEFAULT 'auto',
          orch       INTEGER DEFAULT 0,
          orch_sub   TEXT DEFAULT 'auto',
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
        "#,
    )?;

    // Migrations for databases created before these columns existed.
    // Errors (e.g. column already present) are intentionally ignored.
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN segments TEXT", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN mode TEXT DEFAULT 'auto'", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN orch INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN orch_sub TEXT DEFAULT 'auto'", []);

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
        "SELECT id,title,cwd,session_id,model,mode,seed,orch,orch_sub FROM threads WHERE id = ?1",
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
            "SELECT id,title,cwd,session_id,model,mode,seed,turns,in_tok,out_tok,cost_usd,context,created_at,updated_at,orch,orch_sub
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
        .prepare("SELECT id,role,text,files,segments,compacted,favorite,ts FROM messages WHERE thread_id = ?1 ORDER BY id ASC")
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
            }))
        })
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn create(conn: &Connection, cwd: &str) -> Option<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let t = now();
    conn.execute(
        "INSERT INTO threads (id,title,cwd,session_id,model,seed,turns,in_tok,out_tok,cost_usd,context,created_at,updated_at)
         VALUES (?1,?2,?3,NULL,?4,NULL,0,0,0,0,0,?5,?6)",
        params![id, "New chat", cwd, DEFAULT_MODEL, t, t],
    )
    .ok()?;
    get_thread(conn, &id)
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

/// Record one completed turn; returns (cumulative usage, title, assistantId, ts).
#[allow(clippy::too_many_arguments)]
pub fn record_turn(
    conn: &Connection,
    id: &str,
    user_text: &str,
    files: &[String],
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

    let files_json = if files.is_empty() {
        None
    } else {
        Some(serde_json::to_string(files).unwrap_or_else(|_| "[]".into()))
    };
    let _ = conn.execute(
        "INSERT INTO messages (thread_id,role,text,files,compacted,favorite,ts) VALUES (?1,'user',?2,?3,0,0,?4)",
        params![id, user_text, files_json, t],
    );
    let segments_json = if segments.is_empty() {
        None
    } else {
        Some(serde_json::to_string(segments).unwrap_or_else(|_| "[]".into()))
    };
    let _ = conn.execute(
        "INSERT INTO messages (thread_id,role,text,files,segments,compacted,favorite,ts) VALUES (?1,'assistant',?2,NULL,?3,0,0,?4)",
        params![id, assistant_text, segments_json, t],
    );
    let assistant_id = conn.last_insert_rowid();

    let turn_in = context_of(usage);
    let title = match &cur_title {
        Some(s) if !s.is_empty() && s != "New chat" => s.clone(),
        _ => {
            let chars: Vec<char> = user_text.chars().collect();
            let mut tt: String = chars.iter().take(48).collect();
            if chars.len() > 48 {
                tt.push('…');
            }
            tt
        }
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
    }
    let _ = conn.execute("DELETE FROM projects WHERE id = ?1", [id]);
}
