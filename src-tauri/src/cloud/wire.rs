//! The live connection's wire: the seam presence is written against
//! (`Wire` dials, `Socket` talks), and the real thing — tokio-tungstenite over
//! rustls with the webpki roots reqwest already uses.
//!
//! The device token goes in the `Authorization` header only, never in the URL,
//! and there is no `Origin`: the desktop is not a web page. Nothing here puts
//! a handshake error into words, because one can quote the request.

use std::future::Future;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION, USER_AGENT};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// How long a dial may take before it counts as offline.
const DIAL_WITHIN: Duration = Duration::from_secs(15);

/// How long a goodbye (`1000`) may take on a connection that may be dead.
pub(super) const CLOSE_WITHIN: Duration = Duration::from_secs(2);

/// One incoming frame, as presence sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Text(String),
    /// Binary, or a frame there's nothing to do with.
    Other,
    /// The socket closed: the cloud's close code, or `None` when it just went.
    Closed(Option<u16>),
}

/// A dial that didn't produce a socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// `401 device-revoked`: the token is dead.
    Revoked,
    /// Any other HTTP answer to the handshake.
    Status(u16),
    /// No network, DNS, TLS, a timeout: nothing answered.
    Offline,
}

/// One open WebSocket. `recv` must be cancel-safe: it races the heartbeat.
pub trait Socket: Send + 'static {
    fn send(&mut self, text: String) -> impl Future<Output = Result<(), ()>> + Send;
    fn recv(&mut self) -> impl Future<Output = Frame> + Send;
    /// Say goodbye with `code` and wait (briefly) for the cloud to agree.
    fn close(&mut self, code: u16) -> impl Future<Output = ()> + Send;
}

/// What presence needs from the outside world.
pub trait Wire: Send + Sync + 'static {
    type Socket: Socket;
    /// Open `/device` with `token` as the bearer.
    fn connect(&self, token: String) -> impl Future<Output = Result<Self::Socket, Refused>> + Send;
    /// A factor in 0.8..=1.2 for one backoff wait.
    fn jitter(&self) -> f64;
}

/* ------------------------------- the real thing ----------------------------- */


/// `/device` on the cloud at `base`: `https` becomes `wss`, `http` becomes `ws`
/// (`KRYSTAL_CLOUD_URL=http://localhost:8787` → `ws://localhost:8787/device`).
pub fn device_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{ws}/device")
}

/// tokio-tungstenite over rustls (the webpki roots reqwest uses).
pub struct WsWire {
    url: String,
}

impl WsWire {
    pub fn new(base: &str) -> Self {
        Self { url: device_url(base) }
    }
}

impl Wire for WsWire {
    type Socket = WsSocket;

    fn connect(&self, token: String) -> impl Future<Output = Result<WsSocket, Refused>> + Send {
        let url = self.url.clone();
        async move {
            // Deliberately no detail in any error: a handshake error can quote
            // the request, and nothing carrying the token gets logged.
            let mut req = url.into_client_request().map_err(|_| Refused::Offline)?;
            let mut auth = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| Refused::Offline)?;
            auth.set_sensitive(true);
            let headers = req.headers_mut();
            headers.insert(AUTHORIZATION, auth);
            if let Ok(ua) = HeaderValue::from_str(&format!("Krystal/{}", env!("CARGO_PKG_VERSION"))) {
                headers.insert(USER_AGENT, ua);
            }
            // No Origin: the desktop is not a web page (tungstenite adds none).
            match timeout(DIAL_WITHIN, tokio_tungstenite::connect_async(req)).await {
                Ok(Ok((ws, _))) => Ok(WsSocket(ws)),
                Ok(Err(WsError::Http(res))) => match res.status().as_u16() {
                    401 => Err(Refused::Revoked),
                    s => Err(Refused::Status(s)),
                },
                Ok(Err(_)) | Err(_) => Err(Refused::Offline),
            }
        }
    }

    fn jitter(&self) -> f64 {
        // Nothing here needs a real RNG: a v4 uuid's bits are random enough to
        // keep a fleet of computers from redialling in lockstep after a deploy.
        let bits = uuid::Uuid::new_v4().as_u128() as u64;
        0.8 + 0.4 * (bits as f64 / u64::MAX as f64)
    }
}

pub struct WsSocket(WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>);

impl Socket for WsSocket {
    async fn send(&mut self, text: String) -> Result<(), ()> {
        self.0.send(Message::text(text)).await.map_err(|_| ())
    }

    async fn recv(&mut self) -> Frame {
        loop {
            match self.0.next().await {
                None | Some(Err(_)) => return Frame::Closed(None),
                Some(Ok(Message::Text(t))) => return Frame::Text(t.as_str().to_string()),
                Some(Ok(Message::Close(f))) => return Frame::Closed(f.map(|f| u16::from(f.code))),
                Some(Ok(Message::Binary(_))) => return Frame::Other,
                // Protocol-level pings are answered by tungstenite itself.
                Some(Ok(_)) => {}
            }
        }
    }

    async fn close(&mut self, code: u16) {
        let frame = CloseFrame { code: CloseCode::from(code), reason: "".into() };
        let _ = timeout(CLOSE_WITHIN, async {
            let _ = self.0.close(Some(frame)).await;
            // Read until the cloud's own close comes back.
            while let Some(Ok(_)) = self.0.next().await {}
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const PING: &str = r#"{"type":"ping"}"#;

    fn read(text: &str) -> Value {
        serde_json::from_str(text).unwrap_or(Value::Null)
    }

    #[test]
    fn jitter_stays_within_twenty_percent() {
        let wire = WsWire::new("https://x");
        for _ in 0..1000 {
            let j = wire.jitter();
            assert!((0.8..=1.2).contains(&j), "{j}");
        }
    }


    #[test]
    fn the_device_url_follows_krystal_cloud_url() {
        assert_eq!(device_url("https://app.krystal.rip"), "wss://app.krystal.rip/device");
        assert_eq!(device_url("http://localhost:8787"), "ws://localhost:8787/device");
        assert_eq!(device_url("http://localhost:8787/"), "ws://localhost:8787/device");
    }

    /// A one-connection WebSocket server on localhost, standing in for the
    /// cloud's handshake: it answers `401` unless the bearer is right, and
    /// reports the headers it was sent.
    async fn local_cloud(
        on_open: impl FnOnce(WebSocketStream<tokio::net::TcpStream>) -> tokio::task::JoinHandle<()> + Send + 'static,
    ) -> (String, tokio::sync::oneshot::Receiver<Vec<(String, String)>>) {
        use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            // The shape tungstenite's handshake callback must have.
            #[allow(clippy::result_large_err)]
            let check = move |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
                let headers = req
                    .headers()
                    .iter()
                    .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                    .collect::<Vec<_>>();
                let ok = req.uri().path() == "/device"
                    && req.headers().get("authorization").and_then(|v| v.to_str().ok())
                        == Some("Bearer the-device-token");
                let _ = seen_tx.send(headers);
                if ok {
                    Ok(res)
                } else {
                    let mut no = ErrorResponse::new(Some(r#"{"error":"device-revoked"}"#.into()));
                    *no.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                    Err(no)
                }
            };
            if let Ok(ws) = tokio_tungstenite::accept_hdr_async(tcp, check).await {
                let _ = on_open(ws).await;
            }
        });
        (base, seen_rx)
    }

    #[tokio::test]
    async fn the_real_socket_sends_the_bearer_and_no_origin_and_reads_close_codes() {
        let (base, seen) = local_cloud(|mut ws| {
            tokio::spawn(async move {
                // Answer the hello with a welcome, the ping with a pong, then revoke.
                let hello = ws.next().await.unwrap().unwrap();
                assert_eq!(read(hello.to_text().unwrap())["type"], "hello");
                ws.send(Message::text(r#"{"type":"welcome","heartbeat":30}"#)).await.unwrap();
                let ping = ws.next().await.unwrap().unwrap();
                assert_eq!(ping.to_text().unwrap(), PING);
                ws.send(Message::text(r#"{"type":"pong"}"#)).await.unwrap();
                let frame = CloseFrame { code: CloseCode::from(4401), reason: "device-revoked".into() };
                let _ = ws.close(Some(frame)).await;
            })
        })
        .await;
        let wire = WsWire::new(&base);
        let mut sock = wire.connect("the-device-token".into()).await.expect("connected");
        let headers = seen.await.unwrap();
        assert!(headers.iter().all(|(k, _)| k != "origin"), "no Origin: {headers:?}");
        assert!(headers.iter().any(|(k, v)| k == "user-agent" && v.starts_with("Krystal/")));

        sock.send(r#"{"type":"hello"}"#.into()).await.unwrap();
        assert!(matches!(sock.recv().await, Frame::Text(t) if read(&t)["type"] == "welcome"));
        sock.send(PING.into()).await.unwrap();
        assert_eq!(sock.recv().await, Frame::Text(r#"{"type":"pong"}"#.into()));
        assert_eq!(sock.recv().await, Frame::Closed(Some(4401)));
    }

    #[tokio::test]
    async fn the_real_socket_reads_a_401_handshake_as_revoked() {
        let (base, _seen) = local_cloud(|_| tokio::spawn(async {})).await;
        let refused = WsWire::new(&base).connect("a-dead-token".into()).await.err();
        assert_eq!(refused, Some(Refused::Revoked));
    }

    #[tokio::test]
    async fn the_real_socket_says_goodbye_with_1000() {
        let (got_tx, got_rx) = tokio::sync::oneshot::channel();
        let (base, _seen) = local_cloud(move |mut ws| {
            tokio::spawn(async move {
                while let Some(Ok(m)) = ws.next().await {
                    if let Message::Close(f) = m {
                        let _ = got_tx.send(f.map(|f| u16::from(f.code)));
                        break;
                    }
                }
            })
        })
        .await;
        let mut sock = WsWire::new(&base).connect("the-device-token".into()).await.expect("connected");
        sock.close(1000).await;
        assert_eq!(got_rx.await.unwrap(), Some(1000));
    }

    #[tokio::test]
    async fn nothing_listening_is_offline() {
        let refused = WsWire::new("http://127.0.0.1:9").connect("t".into()).await.err();
        assert_eq!(refused, Some(Refused::Offline));
    }

}
