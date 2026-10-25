//! The HTTP side: response helpers, the SSE body, and routing a request
//! (static shell, pairing, `/api`).

use super::*;

/* ------------------------------- responses ------------------------------- */

pub(super) type Body = BoxBody<Bytes, Infallible>;

pub(super) fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).boxed()
}

fn text_response(status: StatusCode, mime: &str, body: &str) -> Response<Body> {
    bytes_response(status, mime, Bytes::from(body.to_owned()))
}

fn bytes_response(status: StatusCode, mime: &str, body: Bytes) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        // One person over one LAN: caching would only ever serve a stale UI
        // after an app update.
        .header("cache-control", "no-store")
        .body(full(body))
        .unwrap()
}

fn json_response(status: StatusCode, value: &Value) -> Response<Body> {
    text_response(status, "application/json; charset=utf-8", &value.to_string())
}

fn ok_json(value: Value) -> Response<Body> {
    json_response(StatusCode::OK, &value)
}

pub(super) fn err_json(status: StatusCode, message: &str) -> Response<Body> {
    json_response(status, &json!({ "error": message }))
}

/* ---------------------------- the SSE body ------------------------------- */

/// A response body fed from a channel: every `Bytes` pushed in becomes one frame
/// on the wire, and closing the sender ends the response. That is all an SSE
/// stream needs, and it keeps a futures/stream dependency out of the tree.
pub(super) struct EventBody(pub(super) mpsc::UnboundedReceiver<Bytes>);

impl hyper::body::Body for EventBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        self.0.poll_recv(cx).map(|opt| opt.map(|b| Ok(Frame::data(b))))
    }
}

/// One SSE frame. `event:` is left implicit — the payload's own `type` field is
/// the discriminator, exactly as it is on the desktop side.
pub(super) fn sse_frame(payload: &str) -> Bytes {
    Bytes::from(format!("data: {payload}\n\n"))
}

/* -------------------------------- routing -------------------------------- */

/// Split `/api/threads?project=x` into its path and its raw query.
pub(super) fn split_query(uri: &str) -> (&str, &str) {
    match uri.split_once('?') {
        Some((p, q)) => (p, q),
        None => (uri, ""),
    }
}

/// Percent-decode one query-string value (`+` is a space, `%XX` a byte). A stray
/// `%` that isn't a valid escape is left as itself rather than eaten.
pub(super) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) if hex.chars().all(|c| c.is_ascii_hexdigit()) => {
                        out.push(b);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Look one parameter up in a raw query string.
pub(super) fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

/// The embedded UI, as a (mime, body) pair — or `None` if the path isn't one of
/// ours. Everything here is public: the shell is the PIN prompt.
pub(super) fn static_asset(method: &Method, path: &str) -> Option<(&'static str, &'static [u8])> {
    if method != Method::GET {
        return None;
    }
    let js = "text/javascript; charset=utf-8";
    match path {
        "/" | "/index.html" => Some(("text/html; charset=utf-8", INDEX_HTML.as_bytes())),
        "/app.css" => Some(("text/css; charset=utf-8", APP_CSS.as_bytes())),
        "/app.js" => Some((js, APP_JS.as_bytes())),
        "/vendor/marked.js" => Some((js, MARKED_JS.as_bytes())),
        "/vendor/purify.js" => Some((js, PURIFY_JS.as_bytes())),
        "/manifest.webmanifest" => Some(("application/manifest+json", MANIFEST.as_bytes())),
        "/icons/apple-touch-icon.png" => Some(("image/png", APPLE_TOUCH_ICON)),
        "/icons/icon-192.png" => Some(("image/png", ICON_192)),
        "/icons/icon-512.png" => Some(("image/png", ICON_512)),
        _ => None,
    }
}

pub(super) fn bearer(req: &Request<Incoming>) -> Option<String> {
    let raw = req.headers().get("authorization")?.to_str().ok()?;
    raw.strip_prefix("Bearer ").map(|s| s.trim().to_string())
}

async fn read_json(req: Request<Incoming>) -> Value {
    match req.into_body().collect().await {
        Ok(collected) => serde_json::from_slice(&collected.to_bytes()).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

pub(super) fn str_field(body: &Value, key: &str) -> String {
    body.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

/// A JSON array of strings, with anything non-string dropped rather than the
/// whole list being refused.
pub(super) fn args_of_strings(body: &Value, key: &str) -> Vec<String> {
    body.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

pub(super) async fn handle<R: Runtime>(
    ctx: Ctx<R>,
    req: Request<Incoming>,
) -> Result<Response<Body>, Infallible> {
    let method = req.method().clone();
    let uri = req.uri().to_string();
    let (path, query) = split_query(&uri);
    let (path, query) = (path.to_string(), query.to_string());

    // Static half: the app shell. No token needed — the shell IS the PIN prompt,
    // and it holds nothing but markup until a token has been traded for.
    if let Some((mime, body)) = static_asset(&method, &path) {
        return Ok(bytes_response(StatusCode::OK, mime, Bytes::from_static(body)));
    }
    if method == Method::GET && path == "/favicon.ico" {
        return Ok(Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(full(Bytes::new()))
            .unwrap());
    }

    // Trade the PIN for a token. Rate-limited: a six-digit secret on a LAN is
    // only a secret if you aren't allowed to guess forever.
    if method == Method::POST && path == "/api/auth" {
        let body = read_json(req).await;
        return Ok(match ctx.gate.pair(&str_field(&body, "pin")) {
            Pairing::Ok(token) => ok_json(json!({ "token": token })),
            Pairing::Wrong(left) => json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": "bad-pin", "attemptsLeft": left }),
            ),
            Pairing::Locked => err_json(StatusCode::TOO_MANY_REQUESTS, "locked"),
        });
    }

    if !path.starts_with("/api/") {
        return Ok(err_json(StatusCode::NOT_FOUND, "not found"));
    }

    // Everything past here is the authenticated API.
    if !bearer(&req).map(|t| ctx.gate.accepts(&t)).unwrap_or(false) {
        return Ok(err_json(StatusCode::UNAUTHORIZED, "unauthorized"));
    }

    Ok(api(ctx, method, &path, &query, req).await)
}

pub(super) async fn api<R: Runtime>(
    ctx: Ctx<R>,
    method: Method,
    path: &str,
    query: &str,
    req: Request<Incoming>,
) -> Response<Body> {
    match (&method, path) {
        (&Method::GET, "/api/hello") => {
            ok_json(json!({
                "ok": true,
                "version": commands::app_version(),
                // What to call this machine in the connected client's UI.
                "name": machine_name(),
            }))
        }

        (&Method::GET, "/api/projects") => {
            let state = ctx.app.state::<AppState>();
            ok_json(commands::list_projects(state))
        }

        (&Method::GET, "/api/threads") => {
            let project = query_param(query, "project");
            let state = ctx.app.state::<AppState>();
            ok_json(commands::list_threads(state, project))
        }

        (&Method::GET, "/api/thread") => {
            let Some(id) = query_param(query, "id") else {
                return err_json(StatusCode::BAD_REQUEST, "id required");
            };
            let state = ctx.app.state::<AppState>();
            match commands::get_thread(state, id) {
                Ok(v) => ok_json(v),
                Err(e) => err_json(StatusCode::NOT_FOUND, &e),
            }
        }

        (&Method::POST, "/api/threads") => {
            let body = read_json(req).await;
            let cwd = str_field(&body, "project");
            let created = {
                let state = ctx.app.state::<AppState>();
                commands::create_thread(state, cwd.clone())
            };
            match created {
                Ok(v) => {
                    // Nudge the desktop's sidebar so a chat started on the phone
                    // shows up there without a manual refresh.
                    let _ = ctx.app.emit(EV_THREADS, json!({ "project": cwd }));
                    ok_json(v)
                }
                Err(e) => err_json(StatusCode::BAD_REQUEST, &e),
            }
        }

        (&Method::POST, "/api/stop") => {
            let body = read_json(req).await;
            let thread_id = str_field(&body, "threadId");
            // Same escalation as the window: press stop twice and the second one
            // kills the process instead of politely asking it again.
            let force = body.get("force").and_then(|v| v.as_bool());
            let state = ctx.app.state::<AppState>();
            match commands::stop_chat(state, thread_id, force).await {
                Ok(v) => ok_json(v),
                Err(e) => err_json(StatusCode::BAD_REQUEST, &e),
            }
        }

        (&Method::POST, "/api/chat") => {
            let body = read_json(req).await;
            chat_stream(ctx, body).await
        }

        /* ---- the command bridge another Krystal drives this one through ---- */
        (&Method::POST, "/api/invoke") => {
            let body = read_json(req).await;
            let cmd = str_field(&body, "cmd");
            let args = body.get("args").cloned().unwrap_or_else(|| json!({}));
            if is_streaming_command(&cmd) {
                // Calling one of these here would return only once it finished,
                // with every event thrown away. Point the caller at the door it
                // actually wants rather than silently doing the wrong thing.
                return err_json(StatusCode::BAD_REQUEST, "use /api/stream for this command");
            }
            match dispatch(&ctx.app, &cmd, &args).await {
                Some(Ok(value)) => ok_json(json!({ "value": value })),
                Some(Err(e)) => err_json(StatusCode::BAD_REQUEST, &e),
                None => err_json(StatusCode::NOT_FOUND, "command not available remotely"),
            }
        }

        (&Method::POST, "/api/stream") => {
            let body = read_json(req).await;
            let cmd = str_field(&body, "cmd");
            let args = body.get("args").cloned().unwrap_or_else(|| json!({}));
            match cmd.as_str() {
                "chat" => chat_stream(ctx, args).await,
                "run_app" => run_app_stream(ctx, args).await,
                _ => err_json(StatusCode::NOT_FOUND, "command not available remotely"),
            }
        }

        _ => err_json(StatusCode::NOT_FOUND, "not found"),
    }
}
