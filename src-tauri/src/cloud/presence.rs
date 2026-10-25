//! Presence: while this computer is linked and "Reachable from krystal.rip" is
//! on, one outgoing WebSocket to `wss://app.krystal.rip/device` keeps it online
//! on the dashboard. The relay rides the same socket: from v2, whatever the
//! cloud sends that isn't presence's goes to `relay::Relay`, and what that has
//! to say goes out through the same loop.
//!
//! The contract is `../krystal-cloud/PROTOCOL.md` (protocol v1; v2 adds the
//! relay, see `relay`), implemented exactly:
//!
//!   - Connect with the device token as a bearer, in the header only, and no
//!     `Origin`. A `401` at the handshake means the token is dead.
//!   - Say `hello` first; the `welcome` names the heartbeat and what the
//!     dashboard calls this computer. Online from then until the socket closes.
//!   - Every `heartbeat` seconds send `{"type":"ping"}` byte for byte (the
//!     cloud answers that exact text without waking anything). No pong within
//!     10 s: the connection is dead — close it and dial again.
//!   - `4401` (or the `401`) → unlinked: forget the token, exactly like a 401
//!     from `GET /api/device`, and never dial again. `4409` → another Krystal
//!     took over this token: stop and say so. `4426` → update Krystal. Anything
//!     else → dial again after 1 s, 2 s, 4 s … 60 s, each ±20%, the wait reset
//!     once a connection has stayed up a minute past its welcome.
//!
//! The socket follows two things: the link's token (`Account::key`, so linking
//! opens it, unlinking closes it, relinking swaps it) and the switch. Turning
//! either off closes it with `1000`, as does the app quitting.
//!
//! `Wire`/`Socket` (in `wire`) are the seam: `wire::WsWire` is tokio-tungstenite
//! over rustls, and the tests drive the same loop on a fake socket in paused
//! tokio time. The token never leaves Rust and never reaches a log: the window
//! only ever sees `status()` = `{ reachable, conn }`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::time::{sleep, sleep_until, timeout, Instant};

use super::api::Net;
use super::link::{Link, API_VERSION};
use super::relay::{Handler, Relay};
use super::vault::Vault;
use super::wire::{Frame, Refused, Socket, Wire, CLOSE_WITHIN};

/// The heartbeat, byte for byte. Anything else still gets a pong, but wakes
/// the computer's object in the cloud on every beat.
pub const PING: &str = r#"{"type":"ping"}"#;

/// A ping with no pong after this long means the connection is dead. Don't wait
/// for TCP to notice; after a sleep or a network change that takes minutes.
const PONG_WITHIN: Duration = Duration::from_secs(10);

/// The cloud closes a connection that hasn't said hello within 10 s; a welcome
/// that hasn't come by this is a connection that won't produce one.
const WELCOME_WITHIN: Duration = Duration::from_secs(15);

/// The heartbeat when a welcome forgets to name one (the cloud says 30).
const DEFAULT_HEARTBEAT: u64 = 30;

/// A connection up this long after its welcome has proved the network works:
/// the next drop starts the backoff from 1 s again.
const SETTLED_AFTER: Duration = Duration::from_secs(60);

/// The longest wait between attempts, before jitter.
const BACKOFF_MAX: u64 = 60;

/// What the panel says about the connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Conn {
    /// Not linked, or the switch is off.
    Off,
    /// Dialling, or dialling again right after a drop.
    Connecting,
    /// Welcomed: online on the dashboard.
    Online,
    /// The cloud can't be reached; trying again on its own.
    Offline,
    /// `4409`: another Krystal took over this computer's token.
    Elsewhere,
    /// `4426`: this build speaks a protocol the cloud no longer accepts.
    UpdateRequired,
    /// Refused in a way retrying won't fix (a `426`, a `4xx`): a bug.
    Failed,
}

impl Conn {
    fn code(self) -> &'static str {
        match self {
            Conn::Off => "off",
            Conn::Connecting => "connecting",
            Conn::Online => "online",
            Conn::Offline => "offline",
            Conn::Elsewhere => "elsewhere",
            Conn::UpdateRequired => "update",
            Conn::Failed => "failed",
        }
    }
}

/* -------------------------------- the account ------------------------------- */

/// The connection's account: where the token comes from, and where word about
/// it goes. `Link` is the real one.
pub trait Account: Send + Sync + 'static {
    /// The token while linked, `None` otherwise — followed, not polled.
    fn key(&self) -> watch::Receiver<Option<String>>;
    /// The cloud said `token` is dead.
    fn revoked(&self, token: &str);
    /// The cloud named this computer (and maybe its account's email).
    fn named(&self, token: &str, name: Option<&str>, email: Option<&str>);
}

impl<N: Net, V: Vault> Account for Link<N, V> {
    fn key(&self) -> watch::Receiver<Option<String>> {
        Link::key(self)
    }
    fn revoked(&self, token: &str) {
        Link::revoked(self, token)
    }
    fn named(&self, token: &str, name: Option<&str>, email: Option<&str>) {
        Link::named(self, token, name, email)
    }
}

/* ------------------------------ the connection ----------------------------- */

type OnChange = Box<dyn Fn(Value) + Send + Sync>;

/// The live connection for one link.
pub struct Presence<A: Account, W: Wire> {
    account: Arc<A>,
    wire: W,
    app_version: String,
    conn: Mutex<Conn>,
    /// The switch.
    reachable: watch::Sender<bool>,
    /// The app is quitting.
    quit: watch::Sender<bool>,
    /// A socket is open — what `shutdown` waits on to see the goodbye sent.
    open: watch::Sender<bool>,
    on_change: OnceLock<OnChange>,
    /// What runs the relay's requests. Until it's set, the relay is off.
    handler: OnceLock<Arc<dyn Handler>>,
}

/// How staying connected ended, for the outer loop.
enum End {
    /// The token, the switch or the app moved on: look again.
    Stopped,
    /// The token is dead.
    Revoked,
    /// Stop here until something changes (`4409`, `4426`, a bug).
    Parked(Conn),
}

/// How one socket ended.
enum Ended {
    Stopped,
    Revoked,
    Replaced,
    UpdateRequired,
    /// Dropped: dial again. `welcomed` is when it went online, if it did.
    Lost { welcomed: Option<Instant> },
}

/// The receivers a connection must stop for, bundled so every wait can race
/// them: the token, the switch, the app quitting.
struct Watches {
    key: watch::Receiver<Option<String>>,
    want: watch::Receiver<bool>,
    quit: watch::Receiver<bool>,
}

impl Watches {
    /// Resolves at the next change of any of them.
    async fn changed(&mut self) {
        tokio::select! {
            _ = self.key.changed() => {}
            _ = self.want.changed() => {}
            _ = self.quit.changed() => {}
        }
    }
}

impl<A: Account, W: Wire> Presence<A, W> {
    pub fn new(account: Arc<A>, wire: W, reachable: bool, app_version: String) -> Arc<Self> {
        Arc::new(Self {
            account,
            wire,
            app_version,
            conn: Mutex::new(Conn::Off),
            reachable: watch::channel(reachable).0,
            quit: watch::channel(false).0,
            open: watch::channel(false).0,
            on_change: OnceLock::new(),
            handler: OnceLock::new(),
        })
    }

    /// Called with the new status whenever the connection changes — the
    /// window's `cloud-presence` event.
    pub fn on_change(&self, f: impl Fn(Value) + Send + Sync + 'static) {
        let _ = self.on_change.set(Box::new(f));
    }

    /// Run the relay's requests with `handler` (the app's own commands), from
    /// the next welcome on.
    pub fn serve(&self, handler: Arc<dyn Handler>) {
        let _ = self.handler.set(handler);
    }

    // A poisoned lock still holds a perfectly good state.
    fn conn(&self) -> MutexGuard<'_, Conn> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, next: Conn) {
        let was = std::mem::replace(&mut *self.conn(), next);
        if was != next {
            self.changed();
        }
    }

    fn changed(&self) {
        if let Some(f) = self.on_change.get() {
            f(self.status());
        }
    }

    /// What the window may know. With the switch off it is off at once, even
    /// while the goodbye is still on its way.
    pub fn status(&self) -> Value {
        let reachable = *self.reachable.borrow();
        let conn = if reachable { *self.conn() } else { Conn::Off };
        json!({ "reachable": reachable, "conn": conn.code() })
    }

    /// The switch. Off closes the socket; on (again) dials — which is also how
    /// someone retries after `4409`, `4426` or a refusal.
    pub fn set_reachable(&self, on: bool) -> Value {
        if self.reachable.send_if_modified(|v| std::mem::replace(v, on) != on) {
            self.changed();
        }
        self.status()
    }

    /// The app is quitting: say goodbye (`1000`) if a socket is open, and wait
    /// a moment for it to go, so the dashboard greys this computer at once
    /// instead of when it next looks.
    pub async fn shutdown(&self) {
        self.quit.send_replace(true);
        let mut open = self.open.subscribe();
        let _ = timeout(CLOSE_WITHIN, open.wait_for(|o| !o)).await;
    }

    /// The connection's whole life. Spawned once at launch; returns only when
    /// the app quits.
    pub async fn run(self: Arc<Self>) {
        let mut w = Watches {
            key: self.account.key(),
            want: self.reachable.subscribe(),
            quit: self.quit.subscribe(),
        };
        loop {
            if *w.quit.borrow_and_update() {
                self.set(Conn::Off);
                return;
            }
            let token = w.key.borrow_and_update().clone();
            let on = *w.want.borrow_and_update();
            match token.filter(|_| on) {
                None => self.set(Conn::Off),
                Some(token) => match self.stay_connected(&token, &mut w).await {
                    End::Stopped => continue,
                    End::Revoked => {
                        // The link forgets the token; its key moves to `None`.
                        self.account.revoked(&token);
                        continue;
                    }
                    End::Parked(conn) => self.set(conn),
                },
            }
            w.changed().await;
        }
    }

    /// Dial, converse, and dial again with backoff, until the token, the
    /// switch or the app moves on, or the cloud says to stop.
    async fn stay_connected(&self, token: &str, w: &mut Watches) -> End {
        self.set(Conn::Connecting);
        let mut tries: u32 = 0;
        loop {
            let dialed = tokio::select! {
                biased;
                _ = w.changed() => return End::Stopped,
                d = self.wire.connect(token.to_string()) => d,
            };
            let ended = match dialed {
                Err(Refused::Revoked) => return End::Revoked,
                // 426 and friends: a bug on one side. Retrying won't fix it.
                Err(Refused::Status(s)) if s < 500 => return End::Parked(Conn::Failed),
                Err(_) => Ended::Lost { welcomed: None },
                Ok(sock) => self.session(sock, token, w).await,
            };
            match ended {
                Ended::Stopped => return End::Stopped,
                Ended::Revoked => return End::Revoked,
                Ended::Replaced => return End::Parked(Conn::Elsewhere),
                Ended::UpdateRequired => return End::Parked(Conn::UpdateRequired),
                Ended::Lost { welcomed } => {
                    if welcomed.is_some_and(|at| at.elapsed() >= SETTLED_AFTER) {
                        tries = 0;
                    }
                    // Right after a drop it's "connecting"; once a dial has
                    // failed too, the cloud is out of reach.
                    self.set(if welcomed.is_some() { Conn::Connecting } else { Conn::Offline });
                }
            }
            let wait = backoff(tries, self.wire.jitter());
            tries = tries.saturating_add(1);
            tokio::select! {
                biased;
                _ = w.changed() => return End::Stopped,
                _ = sleep(wait) => {}
            }
        }
    }

    /// One open socket, from hello to close.
    async fn session(&self, mut sock: W::Socket, token: &str, w: &mut Watches) -> Ended {
        self.open.send_replace(true);
        let ended = self.converse(&mut sock, token, w).await;
        self.open.send_replace(false);
        ended
    }

    async fn converse(&self, sock: &mut W::Socket, token: &str, w: &mut Watches) -> Ended {
        let hello = json!({
            "type": "hello",
            "apiVersion": API_VERSION,
            "appVersion": self.app_version,
            "platform": std::env::consts::OS,
        });
        if sock.send(hello.to_string()).await.is_err() {
            return Ended::Lost { welcomed: None };
        }

        // Until the welcome, nothing counts as online.
        let deadline = Instant::now() + WELCOME_WITHIN;
        let welcome = loop {
            let frame = tokio::select! {
                biased;
                _ = w.changed() => {
                    sock.close(1000).await;
                    return Ended::Stopped;
                }
                f = sock.recv() => f,
                _ = sleep_until(deadline) => {
                    sock.close(1000).await;
                    return Ended::Lost { welcomed: None };
                }
            };
            match frame {
                Frame::Closed(code) => return closed(code, None),
                Frame::Text(t) => {
                    let m = read(&t);
                    if m["type"] == "welcome" {
                        break m;
                    }
                }
                Frame::Other => {}
            }
        };
        self.account.named(token, welcome["name"].as_str(), welcome["account"]["email"].as_str());
        let beat = welcome["heartbeat"].as_u64().unwrap_or(DEFAULT_HEARTBEAT);
        let every = Duration::from_secs(beat.clamp(5, 300));
        // This socket's requests: they end with it (dropping `relay` stops them).
        let (mut relay, mut outbox) = Relay::new(self.handler.get().cloned(), &welcome);
        self.set(Conn::Online);
        let welcomed = Instant::now();

        let mut next_ping = welcomed + every;
        let mut pong_due: Option<Instant> = None;
        loop {
            let deadline = pong_due.unwrap_or(next_ping);
            tokio::select! {
                biased;
                _ = w.changed() => {
                    sock.close(1000).await;
                    return Ended::Stopped;
                }
                f = sock.recv() => match f {
                    Frame::Closed(code) => return closed(code, Some(welcomed)),
                    Frame::Text(t) => {
                        let m = read(&t);
                        match m["type"].as_str() {
                            Some("pong") => pong_due = None,
                            Some("renamed") => self.account.named(token, m["name"].as_str(), None),
                            // The relay's frames. It ignores a type it doesn't
                            // know, as the protocol asks: later versions add them.
                            _ => relay.frame(&m),
                        }
                    }
                    Frame::Other => {}
                },
                _ = sleep_until(deadline) => {
                    if pong_due.is_some() {
                        sock.close(1000).await;
                        return Ended::Lost { welcomed: Some(welcomed) };
                    }
                    if sock.send(PING.to_string()).await.is_err() {
                        return Ended::Lost { welcomed: Some(welcomed) };
                    }
                    let now = Instant::now();
                    pong_due = Some(now + PONG_WITHIN);
                    next_ping = now + every;
                }
                // After the heartbeat: a busy stream never holds up a ping.
                Some(text) = outbox.recv() => {
                    if sock.send(text).await.is_err() {
                        return Ended::Lost { welcomed: Some(welcomed) };
                    }
                }
            }
        }
    }
}

/// What a close from the cloud means.
fn closed(code: Option<u16>, welcomed: Option<Instant>) -> Ended {
    match code {
        Some(4401) => Ended::Revoked,
        Some(4409) => Ended::Replaced,
        Some(4426) => Ended::UpdateRequired,
        other => {
            if other == Some(4400) {
                // Our bug, not the network's: worth a line in the log.
                eprintln!("  cloud: the connection was closed as bad-message (4400)");
            }
            Ended::Lost { welcomed }
        }
    }
}

/// A frame's JSON, or `Null` for one that isn't.
pub(super) fn read(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// The wait before attempt `tries + 1`: 1 s, 2 s, 4 s … 60 s, times `jitter`
/// (0.8–1.2), and never under a second — every attempt costs the cloud a
/// request and a database read.
fn backoff(tries: u32, jitter: f64) -> Duration {
    let base = (1u64 << tries.min(6)).min(BACKOFF_MAX) as f64;
    Duration::from_secs_f64((base * jitter.clamp(0.8, 1.2)).max(1.0))
}

/* -------------------------------- the switch -------------------------------- */

/// "Reachable from krystal.rip" is on unless turned off; off is a mark in the
/// app data folder, so the choice holds before the window has even loaded.
const OFF_MARK: &str = "cloud-unreachable";

pub fn load_reachable(dir: &Path) -> bool {
    !off_mark(dir).exists()
}

pub fn save_reachable(dir: &Path, on: bool) {
    let mark = off_mark(dir);
    let _ = if on { std::fs::remove_file(mark) } else { std::fs::write(mark, b"") };
}

fn off_mark(dir: &Path) -> PathBuf {
    dir.join(OFF_MARK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::fakes::*;

    /* ---------------------------- connecting ---------------------------- */

    #[tokio::test(start_paused = true)]
    async fn hello_first_then_online_at_the_welcome() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        let Sent::Text(hello) = cloud.heard().await else { panic!("expected a hello") };
        let hello = read(&hello);
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["apiVersion"], API_VERSION);
        assert_eq!(hello["appVersion"], "0.35.0");
        assert_eq!(hello["platform"], std::env::consts::OS);
        assert_eq!(rig.wire.tokens(), ["the-device-token"], "the device token is the bearer");
        assert_eq!(rig.conn(), "connecting", "not online before the welcome");

        cloud.welcome(30);
        rig.until("online").await;
        // The dashboard owns the name: the welcome's goes to the link.
        let named = rig.account.named.lock().unwrap().clone();
        assert_eq!(named, [("MARIN-PC".to_string(), Some("you@example.com".to_string()))]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_heartbeat_is_the_exact_ping_at_the_welcomes_interval() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(20).await;
        rig.until("online").await;
        let online = Instant::now();
        for n in 1..=3u64 {
            assert_eq!(cloud.heard().await, Sent::Text(PING.into()));
            assert_eq!(PING, r#"{"type":"ping"}"#, "byte for byte");
            assert_eq!((Instant::now() - online).as_secs(), 20 * n, "every `heartbeat` seconds, not 30");
            cloud.say(json!({ "type": "pong" }));
        }
        assert_eq!(rig.wire.dials(), 1);
        assert_eq!(rig.conn(), "online");
    }

    #[tokio::test(start_paused = true)]
    async fn no_pong_within_ten_seconds_is_a_dead_connection() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        let mut again = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        assert_eq!(cloud.heard().await, Sent::Text(PING.into()));
        let pinged = Instant::now();
        // No pong. Closed on our side at ten seconds, then dialled again.
        assert_eq!(cloud.heard().await, Sent::Close(1000));
        assert_eq!((Instant::now() - pinged).as_secs(), 10);
        again.accept(30).await;
        rig.until("online").await;
        assert_eq!(rig.wire.gaps(), [41], "30 s to the ping, 10 s for the pong, 1 s of backoff");
    }

    #[tokio::test(start_paused = true)]
    async fn messages_of_types_it_doesnt_know_are_ignored() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        let _hello = cloud.heard().await;
        cloud.say(json!({ "type": "relay-request", "id": 1 }));
        let _ = cloud.tx.send(Frame::Text("not json".into()));
        let _ = cloud.tx.send(Frame::Other);
        rig.idle(Duration::from_secs(1)).await;
        assert_eq!(rig.conn(), "connecting", "only a welcome makes it online");
        cloud.welcome(30);
        rig.until("online").await;
        cloud.say(json!({ "type": "from-the-future" }));
        assert_eq!(cloud.heard().await, Sent::Text(PING.into()));
        assert_eq!(rig.wire.dials(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_welcome_that_never_comes_is_given_up_on() {
        let mut rig = Rig::new();
        let mut silent = rig.wire.socket();
        let mut cloud = rig.wire.socket();
        rig.start();
        let _hello = silent.heard().await;
        assert_eq!(silent.heard().await, Sent::Close(1000));
        cloud.accept(30).await;
        rig.until("online").await;
        assert_eq!(rig.wire.gaps(), [WELCOME_WITHIN.as_secs() + 1]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_rename_on_the_dashboard_reaches_the_link() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        rig.until("online").await;
        cloud.say(json!({ "type": "renamed", "name": "Home PC" }));
        rig.idle(Duration::from_millis(1)).await;
        assert_eq!(rig.account.names(), ["MARIN-PC", "Home PC"]);
    }

    /* ---------------------------- reconnecting -------------------------- */

    #[tokio::test(start_paused = true)]
    async fn a_dead_network_is_redialled_1_2_4_up_to_60_seconds_apart() {
        let mut rig = Rig::new();
        // Nothing scripted: every dial finds the cloud out of reach.
        rig.start();
        rig.until("offline").await;
        while rig.wire.dials() < 10 {
            rig.idle(Duration::from_secs(1)).await;
        }
        assert_eq!(rig.wire.gaps()[..9], [1, 2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(rig.conn(), "offline");
    }

    #[tokio::test(start_paused = true)]
    async fn the_cloud_closing_or_failing_is_redialled_too() {
        for trouble in [Some(1006), Some(1011), Some(1012), Some(4408), Some(4400), None] {
            let mut rig = Rig::new();
            let mut cloud = rig.wire.socket();
            let mut again = rig.wire.socket();
            rig.start();
            cloud.accept(30).await;
            rig.until("online").await;
            let _ = cloud.tx.send(Frame::Closed(trouble));
            rig.until("connecting").await;
            again.accept(30).await;
            rig.until("online").await;
            assert!(rig.account.revoked.lock().unwrap().is_empty(), "{trouble:?}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_503_at_the_handshake_backs_off_and_tries_again() {
        let mut rig = Rig::new();
        rig.wire.refuse(Refused::Status(503)).refuse(Refused::Status(502));
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        rig.until("online").await;
        assert_eq!(rig.wire.gaps(), [1, 2]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_minute_online_resets_the_backoff() {
        let mut rig = Rig::new();
        rig.wire.refuse(Refused::Offline).refuse(Refused::Offline).refuse(Refused::Offline);
        let mut first = rig.wire.socket();
        rig.wire.refuse(Refused::Offline);
        let mut brief = rig.wire.socket();
        rig.wire.refuse(Refused::Offline);
        let mut last = rig.wire.socket();
        rig.start();

        // 1, 2, 4 s of failures, then up for well over a minute.
        first.accept(30).await;
        for _ in 0..3 {
            assert_eq!(first.heard().await, Sent::Text(PING.into()));
            first.say(json!({ "type": "pong" }));
        }
        first.close(1012);
        // Back to 1 s, then 2 s.
        brief.accept(30).await;
        rig.until("online").await;
        // Up for only a few seconds: no reset, so the next waits carry on (4, 8).
        rig.idle(Duration::from_secs(5)).await;
        brief.close(1006);
        last.accept(30).await;
        rig.until("online").await;
        // Dials: 3 refused, `first`, refused, `brief`, refused, `last`. A gap
        // after a socket is its time up plus the wait that followed.
        let g = rig.wire.gaps();
        assert_eq!(g[..3], [1, 2, 4]);
        assert_eq!(g[3..5], [90 + 1, 2], "the wait started over after a minute online: {g:?}");
        assert_eq!(g[5..], [5 + 4, 8], "a few seconds online is no reset: {g:?}");
    }

    #[test]
    fn backoff_stays_between_one_second_and_the_cap_whatever_the_jitter() {
        assert_eq!(backoff(0, 1.0), Duration::from_secs(1));
        assert_eq!(backoff(0, 0.8), Duration::from_secs(1), "never faster than once a second");
        assert_eq!(backoff(3, 0.8), Duration::from_secs_f64(6.4));
        assert_eq!(backoff(3, 1.2), Duration::from_secs_f64(9.6));
        assert_eq!(backoff(30, 1.0), Duration::from_secs(60));
        assert_eq!(backoff(u32::MAX, 5.0), Duration::from_secs(72), "jitter is clamped to ±20%");
    }

    /* ------------------------- what makes it stop ----------------------- */

    #[tokio::test(start_paused = true)]
    async fn a_revoked_token_at_the_handshake_unlinks_and_never_redials() {
        let mut rig = Rig::new();
        rig.wire.refuse(Refused::Revoked);
        rig.start();
        rig.until("off").await;
        rig.idle(Duration::from_secs(3600)).await;
        assert_eq!(*rig.account.revoked.lock().unwrap(), ["the-device-token"]);
        assert_eq!(rig.wire.dials(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_4401_close_unlinks_and_never_redials() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        rig.until("online").await;
        cloud.close(4401);
        rig.until("off").await;
        rig.idle(Duration::from_secs(3600)).await;
        assert_eq!(*rig.account.revoked.lock().unwrap(), ["the-device-token"]);
        assert_eq!(rig.wire.dials(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn replaced_says_elsewhere_and_waits_for_the_switch() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        rig.until("online").await;
        cloud.close(4409);
        rig.until("elsewhere").await;
        rig.idle(Duration::from_secs(3600)).await;
        assert_eq!(rig.wire.dials(), 1, "no automatic reconnect");

        // Off and on again is how it's taken back.
        let mut back = rig.wire.socket();
        assert_eq!(rig.p.set_reachable(false)["conn"], "off");
        rig.p.set_reachable(true);
        back.accept(30).await;
        rig.until("online").await;
        assert_eq!(rig.wire.dials(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn update_required_stops_and_says_so() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        let _hello = cloud.heard().await;
        cloud.close(4426);
        rig.until("update").await;
        rig.idle(Duration::from_secs(3600)).await;
        assert_eq!(rig.wire.dials(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_426_is_a_bug_not_something_to_loop_on() {
        let mut rig = Rig::new();
        rig.wire.refuse(Refused::Status(426));
        rig.start();
        rig.until("failed").await;
        rig.idle(Duration::from_secs(3600)).await;
        assert_eq!(rig.wire.dials(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn the_switch_going_off_says_goodbye_and_on_dials_again() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        rig.until("online").await;
        let s = rig.p.set_reachable(false);
        assert_eq!((s["reachable"].as_bool(), s["conn"].as_str()), (Some(false), Some("off")));
        assert_eq!(cloud.heard().await, Sent::Close(1000));
        rig.idle(Duration::from_secs(3600)).await;
        assert_eq!(rig.wire.dials(), 1);

        let mut again = rig.wire.socket();
        rig.p.set_reachable(true);
        again.accept(30).await;
        rig.until("online").await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_switch_off_stops_a_backoff_wait_too() {
        let mut rig = Rig::new();
        rig.start();
        rig.until("offline").await;
        rig.p.set_reachable(false);
        rig.until("off").await;
        let dials = rig.wire.dials();
        rig.idle(Duration::from_secs(3600)).await;
        assert_eq!(rig.wire.dials(), dials);
    }

    #[tokio::test(start_paused = true)]
    async fn off_at_launch_never_dials() {
        let account = FakeAccount::linked("t");
        let wire = FakeWire::default();
        let p = Presence::new(account, wire.clone(), false, "0.35.0".into());
        tokio::spawn(p.clone().run());
        sleep(Duration::from_secs(3600)).await;
        assert_eq!(wire.dials(), 0);
        assert_eq!(p.status(), json!({ "reachable": false, "conn": "off" }));
    }

    #[tokio::test(start_paused = true)]
    async fn unlinking_says_goodbye_and_relinking_dials_with_the_new_token() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        rig.until("online").await;
        rig.account.link(None);
        assert_eq!(cloud.heard().await, Sent::Close(1000));
        rig.until("off").await;
        assert_eq!(rig.p.status()["reachable"], true, "the switch is left as it was");

        let mut fresh = rig.wire.socket();
        rig.account.link(Some("a-new-token"));
        fresh.accept(30).await;
        rig.until("online").await;
        assert_eq!(rig.wire.tokens(), ["the-device-token", "a-new-token"]);
    }

    #[tokio::test(start_paused = true)]
    async fn quitting_says_goodbye() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        rig.until("online").await;
        rig.p.shutdown().await;
        assert_eq!(cloud.heard().await, Sent::Close(1000));
        rig.until("off").await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_window_never_sees_the_token() {
        let mut rig = Rig::new();
        let mut cloud = rig.wire.socket();
        rig.start();
        cloud.accept(30).await;
        rig.until("online").await;
        rig.p.set_reachable(false);
        rig.until("off").await;
        while let Ok(s) = rig.feed.try_recv() {
            assert!(!s.to_string().contains("the-device-token"), "{s}");
        }
        assert!(!rig.p.status().to_string().contains("the-device-token"));
    }

    /* ------------------------------ the switch -------------------------- */

    #[test]
    fn the_switch_is_on_until_turned_off_and_remembered() {
        let dir = std::env::temp_dir().join(format!("krystal-presence-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load_reachable(&dir), "on by default");
        save_reachable(&dir, false);
        assert!(!load_reachable(&dir));
        save_reachable(&dir, true);
        assert!(load_reachable(&dir));
        save_reachable(&dir, true);
        assert!(load_reachable(&dir), "on twice is still on");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
