//! The whole link walked for real, against a running Krystal Cloud — the
//! Worker's own code, the real network layer and the real Credential Manager.
//! Ignored by default: it needs a cloud and a signed-in session to act as the
//! person at the dashboard.
//!
//!   KRYSTAL_CLOUD_URL=http://localhost:8787      (`npm run dev` in ../krystal-cloud)
//!   KRYSTAL_CLOUD_SESSION=<a krystal_session cookie value for some account>
//!   cargo test cloud::live -- --ignored --nocapture
//!
//! A session is a `sessions` row holding `sha256(token)` for some user: sign in
//! at the dashboard and copy the cookie, or, against a scratch local database
//! (`wrangler d1 … --local --persist-to <dir>`, then `wrangler dev --persist-to
//! <dir>`), insert a user and a session row for a token you made up.
//!
//! What a person would do: link, see the computer on the dashboard, unlink it
//! there and watch this side notice, link again, unlink from here — plus a
//! denial and a cancel.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::api::{base_url, HttpNet, Net, Offline, Reply, Verb};
use super::link::Link;
use super::vault::{Keyring, Vault};

/// The real network, minus the browser: the "confirm page" is opened by this
/// test acting as the user instead.
struct NoBrowser(HttpNet, Mutex<Vec<String>>);

impl Net for NoBrowser {
    fn call(
        &self,
        verb: Verb,
        path: &'static str,
        body: Option<Value>,
        bearer: Option<String>,
    ) -> impl std::future::Future<Output = Result<Reply, Offline>> + Send {
        self.0.call(verb, path, body, bearer)
    }
    fn sleep(&self, d: Duration) -> impl std::future::Future<Output = ()> + Send {
        self.0.sleep(d)
    }
    fn open(&self, url: &str) {
        self.1.lock().unwrap().push(url.to_string());
    }
}

/// The person at app.krystal.rip, signed in.
struct Dashboard {
    http: reqwest::Client,
    base: String,
    cookie: String,
}

impl Dashboard {
    async fn send(&self, req: reqwest::RequestBuilder) -> (u16, Value) {
        let res = req.header("cookie", &self.cookie).send().await.expect("the cloud answers");
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }
    async fn answer(&self, code: &str, approve: bool) {
        let path = if approve { "approve" } else { "deny" };
        let req = self.http.post(format!("{}/api/link/{path}", self.base)).json(&json!({ "code": code }));
        let (status, body) = self.send(req).await;
        assert_eq!(status, 200, "{path}: {body}");
    }
    async fn devices(&self) -> Vec<Value> {
        let (status, body) = self.send(self.http.get(format!("{}/api/devices", self.base))).await;
        assert_eq!(status, 200, "devices: {body}");
        body["devices"].as_array().cloned().unwrap_or_default()
    }
    async fn unlink(&self, id: &str) {
        let (status, body) = self.send(self.http.delete(format!("{}/api/devices/{id}", self.base))).await;
        assert_eq!(status, 200, "unlink: {body}");
    }
}

type Feed = tokio::sync::mpsc::UnboundedReceiver<Value>;

/// Drop what the feed already holds, so the next wait is for what comes next.
fn drain(rx: &mut Feed) {
    while rx.try_recv().is_ok() {}
}

async fn next_settled(rx: &mut Feed) -> Value {
    loop {
        let s = tokio::time::timeout(Duration::from_secs(60), rx.recv())
            .await
            .expect("the link settles within a minute")
            .expect("the feed stays open");
        if s["state"] != "linking" {
            return s;
        }
    }
}

#[tokio::test]
#[ignore = "needs a running Krystal Cloud: see the top of cloud/live.rs"]
async fn the_link_walked_for_real() {
    let base = base_url();
    let session = std::env::var("KRYSTAL_CLOUD_SESSION").expect("KRYSTAL_CLOUD_SESSION");
    let dash = Dashboard {
        http: reqwest::Client::builder().no_proxy().build().unwrap(),
        base: base.clone(),
        cookie: format!("krystal_session={session}"),
    };
    let name = format!("WALK-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]).to_uppercase();
    let vault = Keyring::new(&base);
    vault.clear();
    let net = NoBrowser(HttpNet::new(base.clone()), Mutex::new(Vec::new()));
    let link = Link::new(net, Keyring::new(&base), name.clone(), "0.34.0".into());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    link.on_change(move |s| {
        let _ = tx.send(s);
    });
    let link: Arc<_> = link;
    let mine = |devices: &[Value]| devices.iter().find(|d| d["name"] == json!(name)).cloned();

    // 1. Link: a code, the confirm page, approval at the dashboard → linked.
    let s = link.start().await;
    assert_eq!(s["state"], "linking", "{s}");
    let code = s["code"].as_str().unwrap().to_string();
    println!("  code {code}");
    assert!(link.status().to_string().find("pollSecret").is_none());
    dash.answer(&code, true).await;
    let s = next_settled(&mut rx).await;
    assert_eq!(s["state"], "linked", "{s}");
    println!("  linked to {} as {}", s["email"], s["deviceName"]);
    assert!(vault.load().is_some(), "the token is in Credential Manager");

    // 2. The computer is on the dashboard; the quiet check finds it linked.
    let device = mine(&dash.devices().await).expect("the computer shows on the dashboard");
    assert_eq!(link.check().await["state"], "linked");

    // 3. Unlinked from the dashboard → this side notices on its next check.
    dash.unlink(device["id"].as_str().unwrap()).await;
    let s = link.check().await;
    assert_eq!((s["state"].as_str(), s["problem"].as_str()), (Some("notLinked"), Some("unlinkedRemotely")));
    assert!(vault.load().is_none(), "the dead token is forgotten");
    println!("  unlinked at the dashboard, and noticed");

    // 4. A denial says so; a cancel goes quietly back.
    drain(&mut rx);
    let s = link.start().await;
    dash.answer(s["code"].as_str().unwrap(), false).await;
    let s = next_settled(&mut rx).await;
    assert_eq!(s["problem"], "denied", "{s}");
    let s = link.start().await;
    assert_eq!(s["state"], "linking");
    assert_eq!(link.cancel()["state"], "notLinked");

    // 5. Link again, then unlink from this side: gone from the dashboard too.
    drain(&mut rx);
    let s = link.start().await;
    dash.answer(s["code"].as_str().unwrap(), true).await;
    assert_eq!(next_settled(&mut rx).await["state"], "linked");
    assert!(mine(&dash.devices().await).is_some());
    let s = link.unlink().await;
    assert_eq!(s["state"], "notLinked");
    assert!(s["problem"].is_null(), "{s}");
    assert!(mine(&dash.devices().await).is_none(), "unlinking here removes it there");
    assert!(vault.load().is_none());
    println!("  linked again, then unlinked from the desktop");
}
