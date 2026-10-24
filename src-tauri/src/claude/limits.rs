//! The plan's usage limits — the same numbers as Claude's own usage settings.
//!
//! Two sources, one shape. The usage endpoint behind the CLI's `/usage`
//! (`api/oauth/usage`, with the sign-in the CLI keeps in `.credentials.json`)
//! answers at any moment, so the app can show where you stand before you've
//! sent anything; but it is internal and undocumented, so everything read from
//! it is optional. And every turn, the CLI itself streams a `rate_limit_event`
//! with the server's utilization for each window — the supported surface,
//! but only there while a turn runs. Both are normalised to a list of windows:
//! `{ kind, label, pct, resetsAt, severity }` with `pct` 0–100 and `resetsAt`
//! in unix seconds. `kind` is `session` (5 hours), `weekly` (all models) or
//! `weekly_scoped` (one model's share of the week, named by `label`).

use super::*;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// The Claude Code sign-in token, unless it is missing or already expired (the
/// CLI only refreshes it when it runs, so an expired one just waits for the
/// next turn).
pub fn oauth_token() -> Result<String, &'static str> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "signed_out")?;
    let creds = std::fs::read_to_string(
        std::path::Path::new(&home).join(".claude").join(".credentials.json"),
    )
    .map_err(|_| "signed_out")?;
    let v: Value = serde_json::from_str(&creds).map_err(|_| "signed_out")?;
    let oauth = v.get("claudeAiOauth").ok_or("signed_out")?;
    let token = oauth.get("accessToken").and_then(|t| t.as_str()).unwrap_or("");
    if token.is_empty() {
        return Err("signed_out");
    }
    if let Some(exp) = oauth.get("expiresAt").and_then(|e| e.as_i64()) {
        if exp <= chrono::Utc::now().timestamp_millis() {
            return Err("expired");
        }
    }
    Ok(token.to_string())
}

/// Ask the usage endpoint. `{ available: true, windows }`, or
/// `{ available: false, reason }` — `api_key` (no plan, so no limits),
/// `signed_out`, `expired`, or `offline` for anything the endpoint refused.
pub async fn fetch_limits() -> Value {
    let token = match oauth_token() {
        Ok(t) => t,
        Err(reason) => {
            let api_key = std::env::var("ANTHROPIC_API_KEY").map(|k| !k.is_empty()).unwrap_or(false);
            let reason = if api_key && reason == "signed_out" { "api_key" } else { reason };
            return json!({ "available": false, "reason": reason });
        }
    };
    let unavailable = json!({ "available": false, "reason": "offline" });
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    else {
        return unavailable;
    };
    let resp = client
        .get(USAGE_URL)
        .header("authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("user-agent", concat!("krystal/", env!("CARGO_PKG_VERSION")))
        .send()
        .await;
    let body: Value = match resp {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
        _ => return unavailable,
    };
    match usage_windows(&body) {
        Some(windows) => json!({ "available": true, "windows": windows }),
        None => unavailable,
    }
}

fn unix_of(rfc3339: Option<&Value>) -> Option<i64> {
    let s = rfc3339?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp())
}

/// The endpoint's reply as windows. Its `limits` list is the one the usage
/// settings page draws from (it names the model a scoped limit is for); the
/// older `five_hour`/`seven_day` fields stand in when it's missing.
pub(super) fn usage_windows(body: &Value) -> Option<Vec<Value>> {
    let mut out = Vec::new();
    if let Some(limits) = body.get("limits").and_then(|l| l.as_array()) {
        for l in limits {
            let kind = match l.get("kind").and_then(|k| k.as_str()).unwrap_or("") {
                "session" => "session",
                "weekly_all" => "weekly",
                "weekly_scoped" => "weekly_scoped",
                _ => continue,
            };
            let Some(pct) = l.get("percent").and_then(|p| p.as_f64()) else { continue };
            let scope = l.get("scope");
            let label = scope
                .and_then(|s| s.pointer("/model/display_name").or_else(|| s.pointer("/surface/display_name")))
                .and_then(|n| n.as_str());
            out.push(json!({
                "kind": kind,
                "label": label,
                "pct": pct,
                "resetsAt": unix_of(l.get("resets_at")),
                "severity": l.get("severity").and_then(|s| s.as_str()).unwrap_or("normal"),
            }));
        }
    }
    if out.is_empty() {
        for (key, kind) in [("five_hour", "session"), ("seven_day", "weekly")] {
            let Some(w) = body.get(key).filter(|w| w.is_object()) else { continue };
            let Some(pct) = w.get("utilization").and_then(|u| u.as_f64()) else { continue };
            out.push(json!({
                "kind": kind, "label": null, "pct": pct,
                "resetsAt": unix_of(w.get("resets_at")), "severity": "normal",
            }));
        }
    }
    (!out.is_empty()).then_some(out)
}

/// A turn's `rate_limit_event` as windows. Its `unifiedWindows` carry a
/// utilization (0–1) per window; a window it doesn't mention keeps whatever
/// the endpoint last said.
pub(super) fn event_windows(ev: &Value) -> Vec<Value> {
    let Some(windows) = ev.pointer("/rate_limit_info/unifiedWindows").and_then(|w| w.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (key, w) in windows {
        let kind = match key.as_str() {
            "five_hour" => "session",
            "seven_day" => "weekly",
            _ => continue,
        };
        let Some(u) = w.get("utilization").and_then(|u| u.as_f64()) else { continue };
        let severity = match w.get("status").and_then(|s| s.as_str()) {
            Some("rejected") => "limited",
            Some("allowed_warning") => "warning",
            _ => "normal",
        };
        out.push(json!({
            "kind": kind, "label": null,
            "pct": (u * 1000.0).round() / 10.0,
            "resetsAt": w.get("resetsAt").and_then(|r| r.as_i64()),
            "severity": severity,
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_limits_become_windows() {
        let body = json!({
            "five_hour": { "utilization": 8.0, "resets_at": "2026-10-24T22:39:59.896452+00:00" },
            "limits": [
                { "kind": "session", "percent": 8, "severity": "normal",
                  "resets_at": "2026-10-24T22:39:59.896452+00:00", "scope": null },
                { "kind": "weekly_all", "percent": 67, "severity": "normal",
                  "resets_at": "2026-10-26T08:59:59.896474+00:00", "scope": null },
                { "kind": "weekly_scoped", "percent": 0, "severity": "normal",
                  "resets_at": "2026-10-26T09:00:00+00:00",
                  "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null } },
                { "kind": "something_new", "percent": 3 }
            ]
        });
        let w = usage_windows(&body).unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(w[0]["kind"], "session");
        assert_eq!(w[0]["pct"], 8.0);
        assert_eq!(w[0]["resetsAt"], 1792881599);
        assert_eq!(w[1]["kind"], "weekly");
        assert_eq!(w[2]["kind"], "weekly_scoped");
        assert_eq!(w[2]["label"], "Fable");
    }

    #[test]
    fn endpoint_without_limits_falls_back() {
        let body = json!({
            "five_hour": { "utilization": 12.0, "resets_at": "2026-10-24T22:00:00+00:00" },
            "seven_day": { "utilization": 40.0, "resets_at": null },
            "seven_day_opus": null
        });
        let w = usage_windows(&body).unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(w[1]["kind"], "weekly");
        assert_eq!(w[1]["pct"], 40.0);
        assert!(w[1]["resetsAt"].is_null());
        assert!(usage_windows(&json!({ "error": "nope" })).is_none());
    }

    #[test]
    fn turn_event_becomes_windows() {
        let ev = json!({ "type": "rate_limit_event", "rate_limit_info": {
            "status": "allowed", "resetsAt": 1792881600, "rateLimitType": "five_hour",
            "unifiedWindows": {
                "five_hour": { "utilization": 0.07, "resetsAt": 1792881600, "status": "allowed" },
                "seven_day": { "utilization": 0.995, "resetsAt": 1793005200, "status": "rejected" }
            }
        }});
        let mut w = event_windows(&ev);
        w.sort_by_key(|x| x["kind"].as_str().unwrap_or("").to_string());
        assert_eq!(w[0]["kind"], "session");
        assert_eq!(w[0]["pct"], 7.0);
        assert_eq!(w[1]["pct"], 99.5);
        assert_eq!(w[1]["severity"], "limited");
        assert!(event_windows(&json!({ "type": "rate_limit_event" })).is_empty());
    }

    /// The real endpoint, with this machine's sign-in — run it when its shape
    /// is in doubt: `cargo test live_endpoint -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_endpoint() {
        let v = fetch_limits().await;
        println!("{v:#}");
        assert_eq!(v["available"], true, "{v}");
    }
}
