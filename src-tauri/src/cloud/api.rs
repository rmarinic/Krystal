//! Talking to Krystal Cloud: the HTTP layer the link state machine runs on.
//!
//! Every call is made from here, never from the webview. The Worker refuses a
//! state-changing request that carries a foreign `Origin` (the webview's would
//! be `tauri://…`), and the device token must never reach JavaScript anyway.
//! reqwest sends no `Origin`, which is exactly what a computer calling its own
//! account should look like.
//!
//! `Net` is the seam the link logic is written against, so its tests can run
//! on a fake that answers from a script and sleeps in virtual time.

use std::future::Future;
use std::time::Duration;

use serde_json::Value;

/// Where Krystal Cloud lives unless `KRYSTAL_CLOUD_URL` says otherwise
/// (`http://localhost:8787` for `wrangler dev`).
pub const DEFAULT_BASE: &str = "https://app.krystal.rip";

/// How long one call may take before it counts as unreachable.
const TIMEOUT: Duration = Duration::from_secs(15);

/// The base URL this run talks to, without a trailing slash.
pub fn base_url() -> String {
    std::env::var("KRYSTAL_CLOUD_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| v.starts_with("http://") || v.starts_with("https://"))
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Get,
    Post,
}

/// An answer from the cloud: the HTTP status and the JSON body (`Null` when the
/// body wasn't JSON). Errors are `{ "error": "<code>" }` with a non-200 status.
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

/// The cloud could not be reached at all: no network, DNS, TLS, a timeout.
/// Different from the cloud answering "no".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Offline;

/// What the link logic needs from the outside world.
pub trait Net: Send + Sync + 'static {
    /// One JSON call to `path` (e.g. `/api/link/start`), with the device token
    /// as a bearer when given.
    fn call(
        &self,
        verb: Verb,
        path: &'static str,
        body: Option<Value>,
        bearer: Option<String>,
    ) -> impl Future<Output = Result<Reply, Offline>> + Send;

    /// Wait. Real time here; virtual time in the tests.
    fn sleep(&self, d: Duration) -> impl Future<Output = ()> + Send;

    /// Open the confirm page in the default browser.
    fn open(&self, url: &str);
}

/// The real thing: reqwest (rustls) against `base_url()`.
pub struct HttpNet {
    client: reqwest::Client,
    base: String,
}

impl HttpNet {
    pub fn new(base: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(format!("Krystal/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Self { client, base }
    }
}

impl Net for HttpNet {
    fn call(
        &self,
        verb: Verb,
        path: &'static str,
        body: Option<Value>,
        bearer: Option<String>,
    ) -> impl Future<Output = Result<Reply, Offline>> + Send {
        let url = format!("{}{path}", self.base);
        let mut req = match verb {
            Verb::Get => self.client.get(url),
            Verb::Post => self.client.post(url),
        };
        if let Some(body) = body {
            req = req.json(&body);
        }
        if let Some(token) = bearer {
            req = req.bearer_auth(token);
        }
        async move {
            // Deliberately no detail in the error: a reqwest error can quote the
            // request, and nothing about a call carrying the token gets logged.
            let res = req.send().await.map_err(|_| Offline)?;
            let status = res.status().as_u16();
            let body = res.json::<Value>().await.unwrap_or(Value::Null);
            Ok(Reply { status, body })
        }
    }

    fn sleep(&self, d: Duration) -> impl Future<Output = ()> + Send {
        tokio::time::sleep(d)
    }

    fn open(&self, url: &str) {
        // Only ever our own confirm page: the URL comes back from the server, and
        // a link that points anywhere else is not one this app opens.
        if url.starts_with(&format!("{}/", self.base)) {
            let _ = crate::commands::open_external(url.to_string());
        }
    }
}
