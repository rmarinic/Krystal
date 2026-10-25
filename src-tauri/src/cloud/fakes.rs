//! The fakes the live connection's tests run on (`presence`'s and `relay`'s):
//! a scripted `Wire`, a fake socket whose far end the test plays as the cloud,
//! and a fake account. Test-only.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::watch;
use tokio::time::{sleep, timeout, Instant};

use super::presence::{read, Account, Presence};
use super::wire::{Frame, Refused, Socket, Wire};

/* ---------------------------- the fakes ----------------------------- *
 * `FakeWire` hands out scripted dials: a refusal, or one end of a fake
 * socket whose other end (`Cloud`) the test plays. Time is tokio's paused
 * clock, which jumps ahead whenever everything is waiting — so a day of
 * heartbeats runs in microseconds, and `Instant`s still say when. */

/// What the desktop put on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Sent {
    Text(String),
    Close(u16),
}

pub(super) struct FakeSocket {
    pub(super) rx: UnboundedReceiver<Frame>,
    pub(super) tx: UnboundedSender<Sent>,
}

impl Socket for FakeSocket {
    fn send(&mut self, text: String) -> impl Future<Output = Result<(), ()>> + Send {
        let r = self.tx.send(Sent::Text(text)).map_err(|_| ());
        async move { r }
    }
    async fn recv(&mut self) -> Frame {
        self.rx.recv().await.unwrap_or(Frame::Closed(None))
    }
    fn close(&mut self, code: u16) -> impl Future<Output = ()> + Send {
        let _ = self.tx.send(Sent::Close(code));
        async {}
    }
}

/// The cloud's end of one fake socket.
pub(super) struct Cloud {
    pub(super) tx: UnboundedSender<Frame>,
    pub(super) rx: UnboundedReceiver<Sent>,
}

impl Cloud {
    pub(super) fn say(&self, v: Value) {
        let _ = self.tx.send(Frame::Text(v.to_string()));
    }
    pub(super) fn welcome(&self, heartbeat: u64) {
        self.say(json!({
            "type": "welcome", "deviceId": "dev-1", "name": "MARIN-PC",
            "account": { "email": "you@example.com" }, "apiVersion": 1, "heartbeat": heartbeat,
        }));
    }
    pub(super) fn close(&self, code: u16) {
        let _ = self.tx.send(Frame::Closed(Some(code)));
    }
    /// The next thing the desktop sent (waiting in virtual time).
    pub(super) async fn heard(&mut self) -> Sent {
        timeout(Duration::from_secs(24 * 3600), self.rx.recv())
            .await
            .expect("the desktop says something")
            .expect("the socket is still there")
    }
    /// Read the hello and answer with a welcome.
    pub(super) async fn accept(&mut self, heartbeat: u64) {
        let Sent::Text(t) = self.heard().await else { panic!("expected a hello") };
        assert_eq!(read(&t)["type"], "hello");
        self.welcome(heartbeat);
    }
}

pub(super) enum Dial {
    Refuse(Refused),
    Accept(FakeSocket),
}

#[derive(Default)]
pub(super) struct WireState {
    pub(super) script: Mutex<VecDeque<Dial>>,
    /// The token and the (virtual) moment of every dial.
    pub(super) dials: Mutex<Vec<(String, Instant)>>,
}

#[derive(Clone, Default)]
pub(super) struct FakeWire(pub(super) Arc<WireState>);

impl FakeWire {
    pub(super) fn refuse(&self, r: Refused) -> &Self {
        self.0.script.lock().unwrap().push_back(Dial::Refuse(r));
        self
    }
    pub(super) fn socket(&self) -> Cloud {
        let (to_desk, rx) = unbounded_channel();
        let (tx, from_desk) = unbounded_channel();
        self.0.script.lock().unwrap().push_back(Dial::Accept(FakeSocket { rx, tx }));
        Cloud { tx: to_desk, rx: from_desk }
    }
    pub(super) fn dials(&self) -> usize {
        self.0.dials.lock().unwrap().len()
    }
    pub(super) fn tokens(&self) -> Vec<String> {
        self.0.dials.lock().unwrap().iter().map(|d| d.0.clone()).collect()
    }
    /// Whole seconds between consecutive dials.
    pub(super) fn gaps(&self) -> Vec<u64> {
        let d = self.0.dials.lock().unwrap();
        d.windows(2).map(|w| (w[1].1 - w[0].1).as_secs()).collect()
    }
}

impl Wire for FakeWire {
    type Socket = FakeSocket;
    fn connect(&self, token: String) -> impl Future<Output = Result<FakeSocket, Refused>> + Send {
        self.0.dials.lock().unwrap().push((token, Instant::now()));
        // Nothing scripted: nothing answers.
        let next = self.0.script.lock().unwrap().pop_front();
        async move {
            match next {
                Some(Dial::Accept(s)) => Ok(s),
                Some(Dial::Refuse(r)) => Err(r),
                None => Err(Refused::Offline),
            }
        }
    }
    fn jitter(&self) -> f64 {
        1.0
    }
}

/// The link's side, recording what the connection told it.
pub(super) struct FakeAccount {
    pub(super) key: watch::Sender<Option<String>>,
    pub(super) revoked: Mutex<Vec<String>>,
    pub(super) named: Mutex<Vec<(String, Option<String>)>>,
}

impl FakeAccount {
    pub(super) fn linked(token: &str) -> Arc<Self> {
        Arc::new(Self {
            key: watch::channel(Some(token.to_string())).0,
            revoked: Mutex::default(),
            named: Mutex::default(),
        })
    }
    pub(super) fn link(&self, token: Option<&str>) {
        self.key.send_replace(token.map(str::to_string));
    }
    pub(super) fn names(&self) -> Vec<String> {
        self.named.lock().unwrap().iter().map(|n| n.0.clone()).collect()
    }
}

impl Account for FakeAccount {
    fn key(&self) -> watch::Receiver<Option<String>> {
        self.key.subscribe()
    }
    fn revoked(&self, token: &str) {
        self.revoked.lock().unwrap().push(token.to_string());
        self.key.send_replace(None);
    }
    fn named(&self, _token: &str, name: Option<&str>, email: Option<&str>) {
        if let Some(n) = name {
            self.named.lock().unwrap().push((n.to_string(), email.map(str::to_string)));
        }
    }
}

pub(super) type Feed = UnboundedReceiver<Value>;

pub(super) struct Rig {
    pub(super) p: Arc<Presence<FakeAccount, FakeWire>>,
    pub(super) account: Arc<FakeAccount>,
    pub(super) wire: FakeWire,
    pub(super) feed: Feed,
}

impl Rig {
    pub(super) fn new() -> Self {
        let account = FakeAccount::linked("the-device-token");
        let wire = FakeWire::default();
        let p = Presence::new(account.clone(), wire.clone(), true, "0.35.0".into());
        let (tx, feed) = unbounded_channel();
        p.on_change(move |s| {
            let _ = tx.send(s);
        });
        Self { p, account, wire, feed }
    }
    pub(super) fn start(&self) {
        tokio::spawn(self.p.clone().run());
    }
    pub(super) fn conn(&self) -> String {
        self.p.status()["conn"].as_str().unwrap().to_string()
    }
    /// Wait (in virtual time) until the connection reports `conn`.
    pub(super) async fn until(&mut self, conn: &str) {
        let wait = async {
            while self.conn() != conn {
                self.feed.recv().await.expect("the feed stays open");
            }
        };
        timeout(Duration::from_secs(24 * 3600), wait)
            .await
            .unwrap_or_else(|_| panic!("never {conn}; still {}", self.conn()));
    }
    /// Let everything that can run, run, and the clock move on by `d`.
    pub(super) async fn idle(&self, d: Duration) {
        sleep(d).await;
    }
}
