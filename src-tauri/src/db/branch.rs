//! Branching a chat: where it is cut and the seed the new branch starts from.

use super::*;

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
/// it had one) followed by its transcript up to `through` (a message row id;
/// `None` = all of it), so the branch's first turn continues seamlessly even
/// though the underlying Claude session can't be forked. Bounded to a sane size
/// (keeps the most recent slice, like the #-reference context).
fn build_branch_seed(
    conn: &Connection,
    source_id: &str,
    prior_seed: Option<&str>,
    through: Option<i64>,
) -> Option<String> {
    const MAX_CHARS: usize = 48_000;
    let mut body = String::new();
    if let Some(s) = prior_seed {
        if !s.trim().is_empty() {
            body.push_str(s.trim());
            body.push_str("\n\n");
        }
    }
    for (role, text) in messages_through(conn, source_id, through, 2000) {
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

/// Where a branch is cut from its source. `through` is the last message row it
/// keeps (`None` = the whole transcript — the header's Branch button).
///
/// Branching *from a message* (its own button in the transcript) means:
/// - from a **reply**: everything up to and including that reply;
/// - from **your message**: everything before it, and the message itself comes
///   back as `draft` so it can be reworded and sent down the new branch — the
///   "what if I'd asked that differently" case.
#[derive(Debug, PartialEq)]
pub struct BranchCut {
    pub through: Option<i64>,
    pub draft: Option<String>,
}

/// Work out the cut for branching `source_id` at message `at` (see `BranchCut`).
/// `None` when that message isn't one of this chat's.
pub fn branch_cut(conn: &Connection, source_id: &str, at: i64) -> Option<BranchCut> {
    let (role, text) = conn
        .query_row(
            "SELECT role,text FROM messages WHERE id = ?1 AND thread_id = ?2",
            params![at, source_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())),
        )
        .optional()
        .ok()
        .flatten()?;
    if role != "user" {
        return Some(BranchCut { through: Some(at), draft: None });
    }
    // Row ids are shared by every chat, so "before this one" is this chat's
    // previous row — or none at all when it opened the chat.
    let prev: Option<i64> = conn
        .query_row(
            "SELECT MAX(id) FROM messages WHERE thread_id = ?1 AND id < ?2",
            params![source_id, at],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    Some(BranchCut { through: Some(prev.unwrap_or(0)), draft: Some(text) })
}

/// Fork a conversation: create a new thread in the same folder that starts as a
/// copy of `source_id` — same settings and its transcript up to `through` (a
/// message row id, inclusive; `None` = all of it) — but with its own fresh
/// Claude session. The kept conversation is folded into the new thread's `seed`
/// so Claude keeps full context on the first branched turn (the CLI session
/// itself can't be forked, so we reconstruct context the same way a compaction
/// summary is carried forward). The original thread is untouched.
pub fn branch(conn: &Connection, source_id: &str, through: Option<i64>) -> Option<Value> {
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

    // A pending compaction summary speaks for the conversation *up to the
    // compaction*. A branch cut before that point would inherit the talk it was
    // cut away from — and the messages it keeps are all still here to seed from.
    let seed = seed.filter(|_| match through {
        None => true,
        Some(t) => conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE thread_id = ?1 AND compacted = 1 AND id > ?2",
                params![source_id, t],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n == 0)
            .unwrap_or(false),
    });

    let branch_seed = build_branch_seed(conn, source_id, seed.as_deref(), through);
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

    // Copy the kept transcript verbatim (files/segments columns carried across
    // as-is) so the branch renders identically. Favorites stay with the original.
    let _ = conn.execute(
        "INSERT INTO messages (thread_id,role,text,files,segments,compacted,favorite,ts)
         SELECT ?1, role, text, files, segments, compacted, 0, ts
         FROM messages WHERE thread_id = ?2 AND id <= ?3 ORDER BY id ASC",
        params![new_id, source_id, through.unwrap_or(i64::MAX)],
    );

    get_thread(conn, &new_id)
}
