//! Linking this computer to a Krystal Cloud account — a device-code flow, like
//! signing a TV in to an account.
//!
//!   1. `start`: `POST /api/link/start` → a short code to show (`KRY-…`) and a
//!      poll secret only this computer knows; the confirm page opens in the
//!      browser.
//!   2. The user confirms the code at app.krystal.rip while `poll_until_done`
//!      asks `POST /api/link/poll` every `interval` seconds: pending … then,
//!      exactly once, the device token (or denied, or expired).
//!   3. Linked: the token goes into the vault (Credential Manager). `check` asks
//!      `GET /api/device` whether it still works — a 401 means it was unlinked
//!      from the dashboard — and `unlink` kills it from this side.
//!
//! Anyone can see the code, so the code alone must never be able to claim the
//! token: the poll secret is what collects it, and it never leaves this module.
//! Neither does the token. What the window sees is `status()`: the state, the
//! code while linking, the account's email and this computer's name once
//! linked, and a `problem` to say plainly when something went wrong.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::watch;

use super::api::{Net, Offline, Reply, Verb};
use super::vault::{Linked, Vault};

/// The version of the device API this build speaks.
pub const API_VERSION: u32 = 1;

/// How much longer to wait between polls each time the cloud says `slow-down`
/// (RFC 8628's step).
const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);

/// Polls in a row that may fail to reach the cloud before linking gives up and
/// says the computer is offline. One dropped request is not worth a failure.
const MAX_MISSES: u32 = 3;

/// The cloud says when a code is gone (`410`), and an approval stays
/// collectable for a minute past the code's expiry. This is only the backstop
/// for a cloud that has stopped answering sensibly.
const PAST_EXPIRY: u64 = 90;

/// Something that went wrong, said plainly by the panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    /// The cloud couldn't be reached.
    Offline,
    /// `429 too-many-links`: too many links started from this network lately.
    TooMany,
    /// The user said no at app.krystal.rip.
    Denied,
    /// The code ran out before anyone confirmed it.
    Expired,
    /// Anything else: an answer we don't understand, or the vault refusing.
    Failed,
    /// `GET /api/device` said 401: unlinked from the dashboard.
    UnlinkedRemotely,
    /// Unlinked here, but the cloud couldn't be told.
    UnlinkedHereOnly,
}

impl Problem {
    fn code(self) -> &'static str {
        match self {
            Problem::Offline => "offline",
            Problem::TooMany => "tooMany",
            Problem::Denied => "denied",
            Problem::Expired => "expired",
            Problem::Failed => "failed",
            Problem::UnlinkedRemotely => "unlinkedRemotely",
            Problem::UnlinkedHereOnly => "unlinkedHereOnly",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Phase {
    NotLinked,
    Linking { code: String, link_url: String },
    Linked(Linked),
}

/// How a round of polling ended.
#[derive(Debug, PartialEq)]
pub(super) enum Outcome {
    Approved(Linked),
    Denied,
    Expired,
    Offline,
    Failed,
    Cancelled,
}

/// What `POST /api/link/start` handed back.
#[derive(Debug, PartialEq)]
struct Started {
    code: String,
    poll_secret: String,
    link_url: String,
    expires_in: u64,
    interval: u64,
}

struct Inner {
    phase: Phase,
    problem: Option<Problem>,
    /// Bumped by every start, cancel and shutdown. A request or a poll that
    /// finds it moved on since it began lands nowhere.
    attempt: u64,
    /// Dropping or sending on this stops the poll in flight.
    cancel: Option<watch::Sender<bool>>,
}

impl Inner {
    fn stop_polling(&mut self) {
        if let Some(tx) = self.cancel.take() {
            let _ = tx.send(true);
        }
    }
}

type OnChange = Box<dyn Fn(Value) + Send + Sync>;

/// The link, for one cloud base URL. Shared (`Arc`) because a poll runs on its
/// own task while the window keeps asking for the status.
pub struct Link<N: Net, V: Vault> {
    net: N,
    vault: V,
    /// What this computer is called when it asks to be linked.
    device_name: String,
    app_version: String,
    inner: Mutex<Inner>,
    on_change: OnceLock<OnChange>,
}

impl<N: Net, V: Vault> Link<N, V> {
    pub fn new(net: N, vault: V, device_name: String, app_version: String) -> Arc<Self> {
        let phase = vault.load().map(Phase::Linked).unwrap_or(Phase::NotLinked);
        Arc::new(Self {
            net,
            vault,
            device_name,
            app_version,
            inner: Mutex::new(Inner { phase, problem: None, attempt: 0, cancel: None }),
            on_change: OnceLock::new(),
        })
    }

    /// Called with the new status whenever it changes on its own (a poll
    /// landing, a check finding the link gone) — the window's `cloud-link` event.
    pub fn on_change(&self, f: impl Fn(Value) + Send + Sync + 'static) {
        let _ = self.on_change.set(Box::new(f));
    }

    fn changed(&self) {
        if let Some(f) = self.on_change.get() {
            f(self.status());
        }
    }

    // A poisoned lock still holds a perfectly good state.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// What the window may know. Never the token, never the poll secret.
    pub fn status(&self) -> Value {
        let g = self.lock();
        let (state, code, email, name) = match &g.phase {
            Phase::NotLinked => ("notLinked", None, None, self.device_name.as_str()),
            Phase::Linking { code, .. } => ("linking", Some(code.as_str()), None, self.device_name.as_str()),
            Phase::Linked(l) => ("linked", None, Some(l.email.as_str()), l.name.as_str()),
        };
        json!({
            "state": state,
            "linked": state == "linked",
            "email": email,
            "deviceName": name,
            "code": code,
            "problem": g.problem.map(Problem::code),
        })
    }

    /// Ask for a code, open the confirm page and start polling. Already linked
    /// (or already linking) just reports where things stand.
    pub async fn start(self: &Arc<Self>) -> Value {
        let attempt = {
            let mut g = self.lock();
            if !matches!(g.phase, Phase::NotLinked) {
                drop(g);
                return self.status();
            }
            g.attempt += 1;
            g.problem = None;
            g.attempt
        };
        let body = json!({
            "name": self.device_name,
            "platform": std::env::consts::OS,
            "appVersion": self.app_version,
            "apiVersion": API_VERSION,
        });
        let started = match self.net.call(Verb::Post, "/api/link/start", Some(body), None).await {
            Ok(r) => read_start(&r),
            Err(Offline) => Err(Problem::Offline),
        };

        let mut g = self.lock();
        if g.attempt != attempt {
            // Cancelled (or started again) while the code was on its way.
            drop(g);
            return self.status();
        }
        match started {
            Err(p) => {
                g.problem = Some(p);
                drop(g);
            }
            Ok(s) => {
                let (tx, rx) = watch::channel(false);
                g.cancel = Some(tx);
                g.phase = Phase::Linking { code: s.code, link_url: s.link_url.clone() };
                drop(g);
                self.net.open(&s.link_url);
                let me = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let outcome =
                        poll_until_done(&me.net, &s.poll_secret, s.interval, s.expires_in, rx).await;
                    if let Some(stray) = me.settle(attempt, outcome) {
                        me.revoke(stray).await;
                    }
                });
            }
        }
        self.changed();
        self.status()
    }

    /// Land a round of polling. Hands back a token that nobody here wants any
    /// more — the user cancelled at the last moment, or it couldn't be stored —
    /// so the caller can kill it rather than leave a live credential behind.
    pub(super) fn settle(&self, attempt: u64, outcome: Outcome) -> Option<String> {
        let mut g = self.lock();
        if g.attempt != attempt {
            return match outcome {
                Outcome::Approved(l) => Some(l.device_token),
                _ => None,
            };
        }
        g.cancel = None;
        let mut stray = None;
        let next = match outcome {
            Outcome::Cancelled => return None,
            Outcome::Approved(mut l) => {
                // The poll's answer doesn't carry the name; it's the one we asked with.
                if l.name.is_empty() {
                    l.name = self.device_name.clone();
                }
                match self.vault.save(&l) {
                Ok(()) => {
                    g.problem = None;
                    Phase::Linked(l)
                }
                Err(_) => {
                    g.problem = Some(Problem::Failed);
                    stray = Some(l.device_token);
                    Phase::NotLinked
                }
                }
            }
            Outcome::Denied => not_linked(&mut g, Problem::Denied),
            Outcome::Expired => not_linked(&mut g, Problem::Expired),
            Outcome::Offline => not_linked(&mut g, Problem::Offline),
            Outcome::Failed => not_linked(&mut g, Problem::Failed),
        };
        g.phase = next;
        drop(g);
        self.changed();
        stray
    }

    /// Kill a token on the cloud's side. Best effort: there is nobody to tell
    /// if it fails, and the dashboard can always unlink it.
    async fn revoke(&self, token: String) {
        let _ = self.net.call(Verb::Post, "/api/device/unlink", None, Some(token)).await;
    }

    /// Stop linking: no more polls, back to Not linked. Also abandons a start
    /// whose code hasn't arrived yet.
    pub fn cancel(&self) -> Value {
        {
            let mut g = self.lock();
            if matches!(g.phase, Phase::Linked(_)) {
                drop(g);
                return self.status();
            }
            g.attempt += 1;
            g.stop_polling();
            g.phase = Phase::NotLinked;
            g.problem = None;
        }
        self.changed();
        self.status()
    }

    /// "Open again": the confirm page, for a browser tab that got closed.
    pub fn open_again(&self) {
        let url = match &self.lock().phase {
            Phase::Linking { link_url, .. } => link_url.clone(),
            _ => return,
        };
        self.net.open(&url);
    }

    /// Ask the cloud, quietly, whether the link still holds. A 401 means it was
    /// unlinked from the dashboard: forget the token and say so. Offline, or the
    /// cloud having a bad moment, changes nothing — that isn't the link's fault.
    pub async fn check(&self) -> Value {
        // Bound first, so the lock is released before `status()` takes it again.
        let held = match &self.lock().phase {
            Phase::Linked(l) => Some(l.device_token.clone()),
            _ => None,
        };
        let Some(token) = held else { return self.status() };
        let reply = self.net.call(Verb::Get, "/api/device", None, Some(token.clone())).await;
        let mut g = self.lock();
        // Unlinked (or relinked) here while the check was out: not ours to touch.
        let Phase::Linked(l) = &mut g.phase else {
            drop(g);
            return self.status();
        };
        if l.device_token != token {
            drop(g);
            return self.status();
        }
        let changed = match reply {
            Ok(r) if r.status == 401 => {
                self.vault.clear();
                g.phase = Phase::NotLinked;
                g.problem = Some(Problem::UnlinkedRemotely);
                true
            }
            Ok(r) if r.status == 200 => {
                // Renamed on the dashboard, or the account's email changed.
                let email = r.body["account"]["email"].as_str().unwrap_or(&l.email).to_string();
                let name = r.body["name"].as_str().unwrap_or(&l.name).to_string();
                let fresh = email != l.email || name != l.name;
                if fresh {
                    l.email = email;
                    l.name = name;
                    let _ = self.vault.save(l);
                }
                fresh
            }
            _ => false,
        };
        drop(g);
        if changed {
            self.changed();
        }
        self.status()
    }

    /// Unlink from this side. The token is forgotten here first, whatever the
    /// cloud says: once the user has said "unlink", this computer must not hold
    /// a way in. If the cloud can't be told, the panel says so — the dashboard
    /// can finish the job.
    pub async fn unlink(&self) -> Value {
        let token = {
            let mut g = self.lock();
            match std::mem::replace(&mut g.phase, Phase::NotLinked) {
                Phase::Linked(l) => {
                    self.vault.clear();
                    g.problem = None;
                    l.device_token
                }
                other => {
                    g.phase = other;
                    drop(g);
                    return self.status();
                }
            }
        };
        let told = matches!(
            self.net.call(Verb::Post, "/api/device/unlink", None, Some(token)).await,
            Ok(r) if r.status == 200 || r.status == 401
        );
        if !told {
            let mut g = self.lock();
            if g.phase == Phase::NotLinked && g.problem.is_none() {
                g.problem = Some(Problem::UnlinkedHereOnly);
            }
        }
        self.changed();
        self.status()
    }

    /// The window is closing: stop any poll in flight.
    pub fn shutdown(&self) {
        let mut g = self.lock();
        g.attempt += 1;
        g.stop_polling();
    }
}

/// Back to Not linked, saying why.
fn not_linked(g: &mut Inner, p: Problem) -> Phase {
    g.problem = Some(p);
    Phase::NotLinked
}

/// Make sense of `POST /api/link/start`'s answer.
fn read_start(r: &Reply) -> Result<Started, Problem> {
    if r.status == 429 {
        return Err(Problem::TooMany);
    }
    if r.status != 200 {
        return Err(Problem::Failed);
    }
    let text = |k: &str| r.body[k].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let (Some(code), Some(poll_secret), Some(link_url)) =
        (text("code"), text("pollSecret"), text("linkUrl"))
    else {
        return Err(Problem::Failed);
    };
    Ok(Started {
        code,
        poll_secret,
        link_url,
        expires_in: r.body["expiresIn"].as_u64().unwrap_or(600),
        interval: r.body["interval"].as_u64().unwrap_or(3),
    })
}

/// What one poll said.
enum Poll {
    Pending,
    SlowDown,
    Done(Outcome),
}

fn read_poll(r: &Reply) -> Poll {
    match r.status {
        200 => match r.body["status"].as_str() {
            Some("pending") => Poll::Pending,
            Some("denied") => Poll::Done(Outcome::Denied),
            Some("approved") => {
                let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
                match (text(&r.body["deviceId"]), text(&r.body["deviceToken"])) {
                    (Some(device_id), Some(device_token)) => Poll::Done(Outcome::Approved(Linked {
                        device_id,
                        device_token,
                        email: text(&r.body["account"]["email"]).unwrap_or_default(),
                        name: String::new(),
                    })),
                    _ => Poll::Done(Outcome::Failed),
                }
            }
            _ => Poll::Done(Outcome::Failed),
        },
        410 => Poll::Done(Outcome::Expired),
        429 => Poll::SlowDown,
        _ => Poll::Done(Outcome::Failed),
    }
}

/// Poll until the link is answered, the code runs out, or `cancel` fires (a
/// Cancel, a fresh start, the window closing — or its sender being dropped).
/// Waits *before* each poll: the code has only just been minted, and nobody
/// confirms one in under a second.
pub(super) async fn poll_until_done<N: Net>(
    net: &N,
    poll_secret: &str,
    interval: u64,
    expires_in: u64,
    mut cancel: watch::Receiver<bool>,
) -> Outcome {
    let mut every = Duration::from_secs(interval.clamp(1, 60));
    let budget = Duration::from_secs(expires_in.saturating_add(PAST_EXPIRY));
    let mut waited = Duration::ZERO;
    let mut misses = 0;
    loop {
        tokio::select! {
            biased;
            _ = cancel.changed() => return Outcome::Cancelled,
            _ = net.sleep(every) => {}
        }
        waited += every;
        if waited > budget {
            return Outcome::Expired;
        }
        let body = json!({ "pollSecret": poll_secret });
        match net.call(Verb::Post, "/api/link/poll", Some(body), None).await {
            Err(Offline) => {
                misses += 1;
                if misses >= MAX_MISSES {
                    return Outcome::Offline;
                }
            }
            Ok(r) => {
                misses = 0;
                match read_poll(&r) {
                    Poll::Pending => {}
                    Poll::SlowDown => every += SLOW_DOWN_STEP,
                    Poll::Done(o) => return o,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};

    /* ---------------------------- the fakes ----------------------------- *
     * `FakeNet` answers each path from a script (and, for a poll with nothing
     * scripted, "pending"), records every call and every sleep, and sleeps in
     * virtual time — so a ten-minute link runs in microseconds. */

    type Script = HashMap<&'static str, VecDeque<Result<Reply, Offline>>>;
    type Call = (Verb, &'static str, Option<Value>, Option<String>);
    type Feed = tokio::sync::mpsc::UnboundedReceiver<Value>;
    type OnPoll = Box<dyn FnMut(usize) + Send>;

    #[derive(Default)]
    struct FakeState {
        script: Mutex<Script>,
        calls: Mutex<Vec<Call>>,
        slept: Mutex<Vec<Duration>>,
        opened: Mutex<Vec<String>>,
        /// Fires after each poll with how many there have been.
        on_poll: Mutex<Option<OnPoll>>,
    }

    #[derive(Clone, Default)]
    struct FakeNet(Arc<FakeState>);

    impl FakeNet {
        fn answer(&self, path: &'static str, reply: Result<Reply, Offline>) -> &Self {
            self.0.script.lock().unwrap().entry(path).or_default().push_back(reply);
            self
        }
        fn polls(&self) -> usize {
            self.calls_to("/api/link/poll").len()
        }
        fn calls_to(&self, path: &str) -> Vec<(Option<Value>, Option<String>)> {
            let calls = self.0.calls.lock().unwrap();
            calls.iter().filter(|c| c.1 == path).map(|c| (c.2.clone(), c.3.clone())).collect()
        }
        fn slept(&self) -> Vec<u64> {
            self.0.slept.lock().unwrap().iter().map(|d| d.as_secs()).collect()
        }
    }

    impl Net for FakeNet {
        fn call(
            &self,
            verb: Verb,
            path: &'static str,
            body: Option<Value>,
            bearer: Option<String>,
        ) -> impl std::future::Future<Output = Result<Reply, Offline>> + Send {
            self.0.calls.lock().unwrap().push((verb, path, body, bearer));
            let scripted = self.0.script.lock().unwrap().get_mut(path).and_then(VecDeque::pop_front);
            let reply = scripted.unwrap_or_else(|| match path {
                "/api/link/poll" => Ok(ok(json!({ "status": "pending" }))),
                _ => Ok(err(500, "server-error")),
            });
            if path == "/api/link/poll" {
                let n = self.polls();
                if let Some(f) = self.0.on_poll.lock().unwrap().as_mut() {
                    f(n);
                }
            }
            async move { reply }
        }

        fn sleep(&self, d: Duration) -> impl std::future::Future<Output = ()> + Send {
            self.0.slept.lock().unwrap().push(d);
            async {}
        }

        fn open(&self, url: &str) {
            self.0.opened.lock().unwrap().push(url.to_string());
        }
    }

    #[derive(Clone, Default)]
    struct MemVault(Arc<Mutex<Option<Linked>>>);

    impl Vault for MemVault {
        fn load(&self) -> Option<Linked> {
            self.0.lock().unwrap().clone()
        }
        fn save(&self, link: &Linked) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(link.clone());
            Ok(())
        }
        fn clear(&self) {
            *self.0.lock().unwrap() = None;
        }
    }

    /// A vault that won't take anything (a locked-down credential store).
    struct FullVault;
    impl Vault for FullVault {
        fn load(&self) -> Option<Linked> {
            None
        }
        fn save(&self, _: &Linked) -> Result<(), String> {
            Err("no".into())
        }
        fn clear(&self) {}
    }

    fn ok(body: Value) -> Reply {
        Reply { status: 200, body }
    }
    fn err(status: u16, code: &str) -> Reply {
        Reply { status, body: json!({ "error": code }) }
    }
    fn pending() -> Result<Reply, Offline> {
        Ok(ok(json!({ "status": "pending" })))
    }
    fn started() -> Reply {
        ok(json!({
            "code": "KRY-7F3Q-AB2C",
            "pollSecret": "poll-secret-only-we-know",
            "linkUrl": "https://app.krystal.rip/link?code=KRY-7F3Q-AB2C",
            "expiresIn": 600,
            "interval": 3,
        }))
    }
    fn approved() -> Reply {
        ok(json!({
            "status": "approved",
            "deviceId": "dev-1",
            "deviceToken": "the-device-token",
            "account": { "email": "you@example.com" },
        }))
    }
    fn linked() -> Linked {
        Linked {
            device_id: "dev-1".into(),
            device_token: "the-device-token".into(),
            email: "you@example.com".into(),
            name: "MARIN-PC".into(),
        }
    }

    /// A link plus a feed of every status it announced on its own.
    fn link_with<V: Vault>(net: &FakeNet, vault: V) -> (Arc<Link<FakeNet, V>>, Feed) {
        let link = Link::new(net.clone(), vault, "MARIN-PC".into(), "0.34.0".into());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        link.on_change(move |s| {
            let _ = tx.send(s);
        });
        (link, rx)
    }

    /// The next announced status that is no longer "linking".
    async fn settled(rx: &mut Feed) -> Value {
        loop {
            let s = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .expect("the link settles")
                .expect("the feed stays open");
            if s["state"] != "linking" {
                return s;
            }
        }
    }

    async fn poll(net: &FakeNet) -> Outcome {
        let (_tx, rx) = watch::channel(false);
        poll_until_done(net, "secret", 3, 600, rx).await
    }

    /* ---------------------------- polling ------------------------------- */

    #[tokio::test]
    async fn pending_then_approved_hands_over_the_token() {
        let net = FakeNet::default();
        net.answer("/api/link/poll", pending()).answer("/api/link/poll", Ok(approved()));
        let Outcome::Approved(l) = poll(&net).await else { panic!("not approved") };
        assert_eq!((l.device_id.as_str(), l.device_token.as_str()), ("dev-1", "the-device-token"));
        assert_eq!(l.email, "you@example.com");
        // Waited before every poll, at the interval asked for.
        assert_eq!(net.slept(), vec![3, 3]);
        // The poll secret is what each poll carries, and nothing else.
        let (body, bearer) = &net.calls_to("/api/link/poll")[0];
        assert_eq!(body.as_ref().unwrap(), &json!({ "pollSecret": "secret" }));
        assert!(bearer.is_none());
    }

    #[tokio::test]
    async fn a_denial_ends_polling() {
        let net = FakeNet::default();
        net.answer("/api/link/poll", Ok(ok(json!({ "status": "denied" }))));
        assert_eq!(poll(&net).await, Outcome::Denied);
        assert_eq!(net.polls(), 1);
    }

    #[tokio::test]
    async fn a_gone_code_is_expired() {
        let net = FakeNet::default();
        net.answer("/api/link/poll", pending()).answer("/api/link/poll", Ok(err(410, "link-expired")));
        assert_eq!(poll(&net).await, Outcome::Expired);
        assert_eq!(net.polls(), 2);
    }

    #[tokio::test]
    async fn a_cloud_that_never_says_expired_is_given_up_on_anyway() {
        // Pending forever: the backstop is the code's lifetime plus the grace.
        let net = FakeNet::default();
        let (_tx, rx) = watch::channel(false);
        assert_eq!(poll_until_done(&net, "s", 3, 30, rx).await, Outcome::Expired);
        assert_eq!(net.polls() as u64, (30 + PAST_EXPIRY) / 3);
    }

    #[tokio::test]
    async fn slow_down_backs_off_and_keeps_the_longer_interval() {
        let net = FakeNet::default();
        net.answer("/api/link/poll", Ok(err(429, "slow-down")))
            .answer("/api/link/poll", pending())
            .answer("/api/link/poll", Ok(err(429, "slow-down")))
            .answer("/api/link/poll", Ok(approved()));
        assert!(matches!(poll(&net).await, Outcome::Approved(_)));
        assert_eq!(net.slept(), vec![3, 8, 8, 13]);
    }

    #[tokio::test]
    async fn a_dropped_poll_is_retried_but_a_dead_network_is_offline() {
        let net = FakeNet::default();
        net.answer("/api/link/poll", Err(Offline))
            .answer("/api/link/poll", Err(Offline))
            .answer("/api/link/poll", pending())
            .answer("/api/link/poll", Err(Offline))
            .answer("/api/link/poll", Err(Offline))
            .answer("/api/link/poll", Err(Offline));
        assert_eq!(poll(&net).await, Outcome::Offline);
        // Two misses, a good answer that reset the count, then three in a row.
        assert_eq!(net.polls(), 6);
    }

    #[tokio::test]
    async fn an_answer_we_dont_understand_fails_rather_than_spins() {
        let net = FakeNet::default();
        net.answer("/api/link/poll", Ok(ok(json!({ "status": "approved" }))));
        assert_eq!(poll(&net).await, Outcome::Failed);
    }

    #[tokio::test]
    async fn cancel_stops_polling() {
        let net = FakeNet::default();
        let (tx, rx) = watch::channel(false);
        let fire = Arc::new(tx);
        let hold = fire.clone();
        *net.0.on_poll.lock().unwrap() = Some(Box::new(move |n| {
            if n == 2 {
                let _ = fire.send(true);
            }
        }));
        assert_eq!(poll_until_done(&net, "s", 3, 600, rx).await, Outcome::Cancelled);
        assert_eq!(net.polls(), 2, "no poll after the cancel");
        drop(hold);
    }

    #[tokio::test]
    async fn the_window_going_away_stops_polling_too() {
        let net = FakeNet::default();
        let (tx, rx) = watch::channel(false);
        drop(tx);
        assert_eq!(poll_until_done(&net, "s", 3, 600, rx).await, Outcome::Cancelled);
        assert_eq!(net.polls(), 0);
    }

    /* ------------------------- the whole link --------------------------- */

    #[tokio::test]
    async fn linking_shows_the_code_opens_the_page_and_lands_linked() {
        let net = FakeNet::default();
        net.answer("/api/link/start", Ok(started()))
            .answer("/api/link/poll", pending())
            .answer("/api/link/poll", Ok(approved()));
        let vault = MemVault::default();
        let (link, mut rx) = link_with(&net, vault.clone());
        assert_eq!(link.status()["state"], "notLinked");

        link.start().await;
        let first = rx.recv().await.unwrap();
        assert_eq!(first["state"], "linking");
        assert_eq!(first["code"], "KRY-7F3Q-AB2C");
        assert_eq!(
            net.0.opened.lock().unwrap().as_slice(),
            ["https://app.krystal.rip/link?code=KRY-7F3Q-AB2C"]
        );

        // What it asked to be linked as.
        let (body, _) = &net.calls_to("/api/link/start")[0];
        let body = body.as_ref().unwrap();
        assert_eq!(body["name"], "MARIN-PC");
        assert_eq!(body["appVersion"], "0.34.0");
        assert_eq!(body["apiVersion"], 1);
        assert_eq!(body["platform"], std::env::consts::OS);

        let done = settled(&mut rx).await;
        assert_eq!(done["state"], "linked");
        assert_eq!(done["linked"], true);
        assert_eq!(done["email"], "you@example.com");
        assert_eq!(done["deviceName"], "MARIN-PC");
        assert!(done["problem"].is_null());
        assert_eq!(vault.load(), Some(linked()));
    }

    #[tokio::test]
    async fn the_window_never_sees_the_token_or_the_poll_secret() {
        let net = FakeNet::default();
        net.answer("/api/link/start", Ok(started())).answer("/api/link/poll", Ok(approved()));
        let (link, mut rx) = link_with(&net, MemVault::default());
        let mut seen = vec![link.start().await];
        seen.push(settled(&mut rx).await);
        seen.push(link.status());
        for s in seen {
            let text = s.to_string();
            assert!(!text.contains("the-device-token"), "{text}");
            assert!(!text.contains("poll-secret-only-we-know"), "{text}");
        }
    }

    #[tokio::test]
    async fn a_denied_or_expired_link_says_so() {
        for (answer, problem) in [
            (ok(json!({ "status": "denied" })), "denied"),
            (err(410, "link-expired"), "expired"),
        ] {
            let net = FakeNet::default();
            net.answer("/api/link/start", Ok(started())).answer("/api/link/poll", Ok(answer));
            let (link, mut rx) = link_with(&net, MemVault::default());
            link.start().await;
            let done = settled(&mut rx).await;
            assert_eq!(done["state"], "notLinked");
            assert_eq!(done["problem"], problem);
            assert!(done["code"].is_null());
        }
    }

    #[tokio::test]
    async fn a_start_that_cannot_get_a_code_says_why() {
        for (answer, problem) in [
            (Err(Offline), "offline"),
            (Ok(err(429, "too-many-links")), "tooMany"),
            (Ok(err(400, "bad-name")), "failed"),
            (Ok(ok(json!({ "code": "KRY-1" }))), "failed"),
        ] {
            let net = FakeNet::default();
            net.answer("/api/link/start", answer);
            let (link, _rx) = link_with(&net, MemVault::default());
            let s = link.start().await;
            assert_eq!((s["state"].as_str(), s["problem"].as_str()), (Some("notLinked"), Some(problem)));
            assert_eq!(net.polls(), 0);
            assert!(net.0.opened.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn a_retry_clears_the_last_problem() {
        let net = FakeNet::default();
        net.answer("/api/link/start", Err(Offline)).answer("/api/link/start", Ok(started()));
        let (link, _rx) = link_with(&net, MemVault::default());
        assert_eq!(link.start().await["problem"], "offline");
        assert!(link.start().await["problem"].is_null());
    }

    #[tokio::test]
    async fn cancel_goes_back_to_not_linked() {
        let net = FakeNet::default();
        net.answer("/api/link/start", Ok(started()));
        let (link, _rx) = link_with(&net, MemVault::default());
        link.start().await;
        let attempt = link.lock().attempt;
        let s = link.cancel();
        assert_eq!(s["state"], "notLinked");
        assert!(s["problem"].is_null());
        assert!(link.lock().cancel.is_none(), "the poll was told to stop");
        // A poll that was already in flight lands nowhere — and a token it
        // collected is handed back to be killed, not kept.
        assert_eq!(link.settle(attempt, Outcome::Approved(linked())), Some("the-device-token".into()));
        assert_eq!(link.status()["state"], "notLinked");
    }

    #[tokio::test]
    async fn a_token_that_cannot_be_stored_is_not_kept_anywhere() {
        let net = FakeNet::default();
        net.answer("/api/link/start", Ok(started())).answer("/api/link/poll", Ok(approved()));
        let (link, mut rx) = link_with(&net, FullVault);
        link.start().await;
        let done = settled(&mut rx).await;
        assert_eq!((done["state"].as_str(), done["problem"].as_str()), (Some("notLinked"), Some("failed")));
        // Killed on the cloud's side, with the token as its own bearer.
        for _ in 0..200 {
            if !net.calls_to("/api/device/unlink").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let (_, bearer) = &net.calls_to("/api/device/unlink")[0];
        assert_eq!(bearer.as_deref(), Some("the-device-token"));
    }

    /* ------------------------- checking & unlinking --------------------- */

    fn already_linked(net: &FakeNet) -> (Arc<Link<FakeNet, MemVault>>, MemVault, Feed) {
        let vault = MemVault::default();
        vault.save(&linked()).unwrap();
        let (link, rx) = link_with(net, vault.clone());
        (link, vault, rx)
    }

    #[tokio::test]
    async fn a_link_kept_from_last_time_is_linked_at_launch() {
        let net = FakeNet::default();
        let (link, _, _) = already_linked(&net);
        let s = link.status();
        assert_eq!((s["state"].as_str(), s["email"].as_str()), (Some("linked"), Some("you@example.com")));
        // Linked already: start is a no-op, not a second device.
        link.start().await;
        assert!(net.calls_to("/api/link/start").is_empty());
    }

    #[tokio::test]
    async fn a_401_means_it_was_unlinked_at_app_krystal_rip() {
        let net = FakeNet::default();
        net.answer("/api/device", Ok(err(401, "device-revoked")));
        let (link, vault, mut rx) = already_linked(&net);
        let s = link.check().await;
        assert_eq!(s["state"], "notLinked");
        assert_eq!(s["problem"], "unlinkedRemotely");
        assert_eq!(vault.load(), None, "the token is forgotten");
        assert_eq!(rx.recv().await.unwrap()["problem"], "unlinkedRemotely");
        let (_, bearer) = &net.calls_to("/api/device")[0];
        assert_eq!(bearer.as_deref(), Some("the-device-token"));
    }

    #[tokio::test]
    async fn a_check_that_cannot_reach_the_cloud_changes_nothing() {
        for answer in [Err(Offline), Ok(err(500, "server-error"))] {
            let net = FakeNet::default();
            net.answer("/api/device", answer);
            let (link, vault, _) = already_linked(&net);
            let s = link.check().await;
            assert_eq!(s["state"], "linked");
            assert!(s["problem"].is_null());
            assert!(vault.load().is_some());
        }
    }

    #[tokio::test]
    async fn a_rename_on_the_dashboard_is_picked_up() {
        let net = FakeNet::default();
        let me = json!({ "deviceId": "dev-1", "name": "Studio PC", "account": { "email": "you@example.com" } });
        net.answer("/api/device", Ok(ok(me)));
        let (link, vault, _) = already_linked(&net);
        assert_eq!(link.check().await["deviceName"], "Studio PC");
        assert_eq!(vault.load().unwrap().name, "Studio PC");
    }

    #[tokio::test]
    async fn not_linked_never_calls_home() {
        let net = FakeNet::default();
        let (link, _rx) = link_with(&net, MemVault::default());
        link.check().await;
        link.unlink().await;
        assert!(net.0.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unlink_tells_the_cloud_and_forgets_the_token() {
        let net = FakeNet::default();
        net.answer("/api/device/unlink", Ok(ok(json!({ "ok": true }))));
        let (link, vault, _) = already_linked(&net);
        let s = link.unlink().await;
        assert_eq!(s["state"], "notLinked");
        assert!(s["problem"].is_null());
        assert_eq!(vault.load(), None);
        let (_, bearer) = &net.calls_to("/api/device/unlink")[0];
        assert_eq!(bearer.as_deref(), Some("the-device-token"));
    }

    #[tokio::test]
    async fn unlink_offline_still_forgets_the_token_and_says_so() {
        let net = FakeNet::default();
        net.answer("/api/device/unlink", Err(Offline));
        let (link, vault, _) = already_linked(&net);
        let s = link.unlink().await;
        assert_eq!((s["state"].as_str(), s["problem"].as_str()), (Some("notLinked"), Some("unlinkedHereOnly")));
        assert_eq!(vault.load(), None);
    }
}
