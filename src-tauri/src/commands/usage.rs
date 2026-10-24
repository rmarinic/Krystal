//! Claude subscription usage, read from the CLI's local history.
//!
//! Estimate Claude Code subscription usage by summing *weighted* tokens from the
//! local session transcripts (~/.claude/projects/**/*.jsonl) into a rolling
//! 5-hour window and a 7-day window — the same method the official-style status
//! line uses. Output is weighted so cheap cache-reads don't dominate fresh output
//! (mirrors Anthropic's rough cost ratios). The CLI exposes no per-plan limits, so
//! the frontend turns these totals into percentages against user-calibrated caps.

use super::*;

const W_INPUT: f64 = 1.0;
const W_OUTPUT: f64 = 5.0;
const W_CACHE_CREATE: f64 = 1.25;
const W_CACHE_READ: f64 = 0.1;

fn claude_home() -> Option<std::path::PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(std::path::Path::new(&home).join(".claude"))
}

/// Recursively collect `*.jsonl` paths under `dir` whose mtime is newer than
/// `min_mtime` (unix secs) — old session files can't hold tokens inside the
/// 7-day window, so skipping them keeps the scan quick.
fn collect_recent_jsonl(dir: &std::path::Path, min_mtime: f64, out: &mut Vec<std::path::PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_recent_jsonl(&path, min_mtime, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            if mtime >= min_mtime {
                out.push(path);
            }
        }
    }
}

/// Weighted token usage for the current 5-hour session block and the weekly
/// window. `block_start` is the live session's start (reset = start + 5h);
/// `week_from` is the start of the counted weekly window. `available:false`
/// when there's no `~/.claude/projects` to read.
///
/// `weekly_reset` (unix secs) is the user-calibrated weekly reset anchor — when
/// present we count the week from the most recent past reset, matching Claude's
/// fixed weekly cycle; otherwise we fall back to a trailing 7 days.
#[tauri::command]
pub fn claude_usage(weekly_reset: Option<f64>) -> Value {
    let projects = match claude_home() {
        Some(h) => h.join("projects"),
        None => return json!({ "available": false }),
    };
    if !projects.is_dir() {
        return json!({ "available": false });
    }

    let now = chrono::Utc::now().timestamp() as f64;
    // Look back far enough to cover a full weekly window (anchored up to ~7 days
    // back) plus slack for reconstructing the 5-hour blocks.
    let scan_from = now - 8.0 * 86400.0;

    let mut files = Vec::new();
    collect_recent_jsonl(&projects, scan_from, &mut files);

    // (timestamp, weighted-tokens) for every usage row in range.
    let mut entries: Vec<(f64, f64)> = Vec::new();
    for path in files {
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for line in content.lines() {
            // Cheap pre-filter: only the assistant turns carry a usage block.
            if !line.contains("\"usage\"") {
                continue;
            }
            let entry: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let usage = match entry.get("message").and_then(|m| m.get("usage")) {
                Some(u) if u.is_object() => u,
                _ => continue,
            };
            let ts = match entry.get("timestamp").and_then(|t| t.as_str()) {
                Some(s) => match chrono::DateTime::parse_from_rfc3339(s) {
                    Ok(dt) => dt.timestamp() as f64,
                    Err(_) => continue,
                },
                None => continue,
            };
            if ts < scan_from {
                continue;
            }
            let tok = |k: &str| usage.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let weighted = tok("input_tokens") * W_INPUT
                + tok("output_tokens") * W_OUTPUT
                + tok("cache_creation_input_tokens") * W_CACHE_CREATE
                + tok("cache_read_input_tokens") * W_CACHE_READ;
            entries.push((ts, weighted));
        }
    }
    entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // --- 5-hour session block (matches Claude's "resets in …"): a block runs 5h
    // from its first turn, floored to the hour; a >=5h gap opens a new block. ---
    const FIVE_H: f64 = 5.0 * 3600.0;
    let floor_hour = |t: f64| (t / 3600.0).floor() * 3600.0;
    let mut block_start: Option<f64> = None;
    let mut last_ts = 0.0f64;
    for &(ts, _) in &entries {
        match block_start {
            None => block_start = Some(floor_hour(ts)),
            Some(bs) => {
                if ts - bs >= FIVE_H || ts - last_ts >= FIVE_H {
                    block_start = Some(floor_hour(ts));
                }
            }
        }
        last_ts = ts;
    }
    // The block is only "live" if its 5-hour window hasn't already elapsed.
    let active_start = block_start.filter(|bs| now < bs + FIVE_H);
    let h5: f64 = match active_start {
        Some(bs) => entries.iter().filter(|(t, _)| *t >= bs).map(|(_, w)| w).sum(),
        None => 0.0,
    };

    // --- Weekly window: from the calibrated reset anchor when we have one (so the
    // sum matches Claude's fixed weekly cycle), else a trailing 7 days. ---
    let week_from = weekly_reset
        .filter(|r| *r <= now && *r >= scan_from)
        .unwrap_or(now - 7.0 * 86400.0);
    let d7: f64 = entries.iter().filter(|(t, _)| *t >= week_from).map(|(_, w)| w).sum();

    json!({
        "available": true,
        "h5": h5,
        "d7": d7,
        "blockStart": active_start,
        "weekFrom": week_from,
        "now": now,
    })
}
