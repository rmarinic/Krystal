//! A turn's three beats (begin, partial, finish/abort), plus compaction, `$` runs
//! and the recent-messages window.

use super::*;

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
pub fn begin_turn(conn: &Connection, id: &str, user_text: &str, files: &[String], ckpt: &str) -> i64 {
    let t = now();
    let files_json = if files.is_empty() {
        None
    } else {
        Some(serde_json::to_string(files).unwrap_or_else(|_| "[]".into()))
    };
    let _ = conn.execute(
        "INSERT INTO messages (thread_id,role,text,files,compacted,favorite,partial,ts,ckpt) VALUES (?1,'user',?2,?3,0,0,1,?4,?5)",
        params![id, user_text, files_json, t, Some(ckpt).filter(|c| !c.is_empty())],
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
    messages_through(conn, id, None, n)
}

/// The last `n` messages of a thread up to row `through` (inclusive; `None` = the
/// end), oldest first.
pub(super) fn messages_through(conn: &Connection, id: &str, through: Option<i64>, n: i64) -> Vec<(String, String)> {
    let mut stmt = conn
        .prepare("SELECT role,text FROM messages WHERE thread_id = ?1 AND id <= ?2 ORDER BY id DESC LIMIT ?3")
        .unwrap();
    let rows = stmt
        .query_map(params![id, through.unwrap_or(i64::MAX), n], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .unwrap();
    let mut v: Vec<(String, String)> = rows.filter_map(|r| r.ok()).collect();
    v.reverse();
    v
}
