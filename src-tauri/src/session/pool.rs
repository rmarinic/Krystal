//! The pool of warm sessions, one per chat, and its eviction.

use super::*;


/// The warm sessions, one per chat. Held behind an async lock so the map can be
/// consulted from a command handler without blocking the window's message loop.
#[derive(Default)]
pub struct Pool(TokioMutex<HashMap<String, Session>>, StdMutex<HashMap<String, String>>);

impl Pool {
    /// The session for `thread_id`, started if there isn't a usable one. A session
    /// whose key no longer matches (the user changed model, mode, effort or the
    /// orchestrator) or whose process has died is retired and replaced.
    pub async fn acquire(
        &self,
        thread_id: &str,
        bin: &str,
        args: &[String],
        cwd: &str,
        orchestrating: bool,
    ) -> Result<Session, String> {
        let want = key_of(args, cwd);
        let mut map = self.0.lock().await;
        if let Some(s) = map.get(thread_id) {
            if s.key == want && s.alive() {
                let s = s.clone();
                s.touch();
                return Ok(s);
            }
            map.remove(thread_id);
        }
        let s = Session::spawn(bin, args, cwd, orchestrating)?;
        map.insert(thread_id.to_string(), s.clone());
        evict(&mut map);
        Ok(s)
    }

    pub async fn get(&self, thread_id: &str) -> Option<Session> {
        self.0.lock().await.get(thread_id).cloned()
    }

    /// Retire a chat's session — after clearing or compacting it, or when the chat
    /// goes away. The next message simply starts a fresh one.
    pub async fn retire(&self, thread_id: &str) {
        self.0.lock().await.remove(thread_id);
    }

    /// Leave a note for a chat's next message — something that happened to the
    /// project between turns that Claude has no way of knowing (its files were
    /// rewound). It rides on the user message like any per-turn context, and is
    /// kept here rather than on the `Session` because the session may well be
    /// retired before that message is sent.
    pub fn leave_note(&self, thread_id: &str, note: String) {
        if let Ok(mut notes) = self.1.lock() {
            notes.insert(thread_id.to_string(), note);
        }
    }

    /// Take (and forget) the note left for this chat, if any.
    pub fn take_note(&self, thread_id: &str) -> Option<String> {
        self.1.lock().ok().and_then(|mut notes| notes.remove(thread_id))
    }

    /// Retire everything (app shutdown). `kill_on_drop` does the rest.
    pub async fn retire_all(&self) {
        self.0.lock().await.clear();
    }
}

/// Drop dead and long-idle sessions, then trim to `MAX_WARM_SESSIONS`, most
/// stale first. A session waiting on a permission prompt is exempt from both:
/// it looks idle precisely because it is waiting for its user.
fn evict(map: &mut HashMap<String, Session>) {
    map.retain(|_, s| {
        s.alive() && (s.awaiting_permission() || s.idle_secs() < IDLE_TIMEOUT_SECS)
    });
    while map.len() > MAX_WARM_SESSIONS {
        let Some(stalest) = map
            .iter()
            .filter(|(_, s)| !s.awaiting_permission())
            .max_by_key(|(_, s)| s.idle_secs())
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        map.remove(&stalest);
    }
}
