//! Threads: their metadata, listing and loading, and the per-chat settings.

use super::*;

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

pub(super) fn usage_obj(turns: i64, in_tok: i64, out_tok: i64, cost: f64, context: i64) -> Value {
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

pub(super) fn messages_of(conn: &Connection, id: &str) -> Vec<Value> {
    let mut stmt = conn
        .prepare("SELECT id,role,text,files,segments,compacted,favorite,ts,partial,ckpt FROM messages WHERE thread_id = ?1 ORDER BY id ASC")
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
                "ckpt": r.get::<_, Option<String>>(9)?,
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
