//! Dynamic model catalogue — fetches the live model list from the Anthropic
//! Models API (`GET /v1/models`) so the picker always reflects the latest
//! available Claude models instead of a hardcoded set.
//!
//! Auth: prefer `ANTHROPIC_API_KEY`; otherwise use the Claude Code OAuth access
//! token from `~/.claude/.credentials.json` (which the CLI keeps refreshed),
//! sent as a Bearer token with the `oauth-2025-04-20` beta header. The response
//! is curated to the newest model per tier (Opus/Sonnet/Haiku/Fable/…), cached
//! to disk, and everything falls back to the static list when the API is
//! unreachable, unauthenticated, or the token has expired.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{self, ModelInfo};

const MODELS_URL: &str = "https://api.anthropic.com/v1/models?limit=100";
const CACHE_FILE: &str = "models-cache.json";

#[derive(Serialize, Deserialize)]
struct Cache {
    fetched_at: i64,
    models: Vec<ModelInfo>,
}

/// Resolve API auth. Returns `(header_name, header_value, needs_oauth_beta)`.
fn resolve_auth() -> Option<(&'static str, String, bool)> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.is_empty() {
            return Some(("x-api-key", key, false));
        }
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    let creds =
        std::fs::read_to_string(Path::new(&home).join(".claude").join(".credentials.json")).ok()?;
    let v: Value = serde_json::from_str(&creds).ok()?;
    let oauth = v.get("claudeAiOauth")?;
    let token = oauth.get("accessToken")?.as_str()?.to_string();
    if token.is_empty() {
        return None;
    }
    // Skip an obviously-expired token — the call would 401. The cache / static
    // list covers us until the CLI refreshes it on the next chat turn.
    if let Some(exp) = oauth.get("expiresAt").and_then(|e| e.as_i64()) {
        if exp <= chrono::Utc::now().timestamp_millis() {
            return None;
        }
    }
    Some(("authorization", format!("Bearer {token}"), true))
}

/// Fetch and curate the live model catalogue. Follows pagination, keeps the
/// newest model per tier, and sorts into a stable display order.
pub async fn fetch_catalog() -> Result<Vec<ModelInfo>, String> {
    let (hname, hval, oauth) = resolve_auth().ok_or("no Claude credentials available")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // tier -> (created_at, id, name, ctx) for the newest model seen in that tier.
    let mut best: HashMap<String, (String, String, String, u64)> = HashMap::new();
    let mut after: Option<String> = None;

    for _ in 0..20 {
        // hard page cap — the catalogue is small
        let url = match &after {
            Some(a) => format!("{MODELS_URL}&after_id={a}"),
            None => MODELS_URL.to_string(),
        };
        let mut req = client
            .get(&url)
            .header("anthropic-version", "2023-06-01")
            .header(hname, &hval);
        if oauth {
            req = req.header("anthropic-beta", "oauth-2025-04-20");
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("models API returned {}", resp.status()));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        let data = body
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or("malformed models response")?;

        for m in data {
            let id = match m.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let name = m
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            let ctx = m.get("max_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let created = m
                .get("created_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tier = models::tier_of(&id, &name);
            // Keep the newest (created_at sorts lexically as ISO-8601). Ties and
            // missing dates keep whichever we saw first.
            match best.get(&tier) {
                Some((c, ..)) if c.as_str() >= created.as_str() => {}
                _ => {
                    best.insert(tier, (created, id, name, ctx));
                }
            }
        }

        if body.get("has_more").and_then(|v| v.as_bool()).unwrap_or(false) {
            match body.get("last_id").and_then(|v| v.as_str()) {
                Some(a) => after = Some(a.to_string()),
                None => break,
            }
        } else {
            break;
        }
    }

    if best.is_empty() {
        return Err("no models returned".into());
    }
    let mut out: Vec<ModelInfo> = best
        .into_iter()
        .map(|(tier, (_, id, name, ctx))| ModelInfo {
            blurb: models::blurb_for_tier(&tier).to_string(),
            ctx: if ctx == 0 { 200_000 } else { ctx },
            id,
            name,
            tier,
        })
        .collect();
    out.sort_by(|a, b| {
        models::tier_rank(&a.tier)
            .cmp(&models::tier_rank(&b.tier))
            .then(b.ctx.cmp(&a.ctx))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Persist the catalogue so the next launch shows the last-known models
/// instantly (and offline). Best-effort — a write failure is non-fatal.
pub fn save_cache(dir: &Path, models: &[ModelInfo]) {
    let cache = Cache {
        fetched_at: chrono::Utc::now().timestamp(),
        models: models.to_vec(),
    };
    if let Ok(txt) = serde_json::to_string(&cache) {
        let _ = std::fs::write(dir.join(CACHE_FILE), txt);
    }
}

/// Load the last cached catalogue, if any. `None` on first run or a bad file.
pub fn load_cache(dir: &Path) -> Option<Vec<ModelInfo>> {
    let txt = std::fs::read_to_string(dir.join(CACHE_FILE)).ok()?;
    let cache: Cache = serde_json::from_str(&txt).ok()?;
    if cache.models.is_empty() {
        None
    } else {
        Some(cache.models)
    }
}
