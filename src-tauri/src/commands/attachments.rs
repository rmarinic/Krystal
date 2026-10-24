//! Pasted and dropped attachments, and image previews.

use super::*;

/// Read a local image file and return it as a `data:` URL so the frontend can
/// preview it inline (e.g. when Claude reads an image). Returns an empty string
/// for anything that isn't a readable, sensibly-sized image — the UI shows a
/// "couldn't load" note in that case. Read on demand (chip expand), not eagerly.
#[tauri::command]
pub fn read_image(path: String) -> String {
    const MAX: u64 = 12 * 1024 * 1024; // 12 MB cap — these are inline previews, not downloads
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return String::new(),
    };
    match std::fs::metadata(p) {
        Ok(m) if m.is_file() && m.len() <= MAX => {}
        _ => return String::new(),
    }
    match std::fs::read(p) {
        Ok(bytes) => format!("data:{};base64,{}", mime, base64_encode(&bytes)),
        Err(_) => String::new(),
    }
}

/// Save a pasted/dropped attachment (e.g. a screenshot from the clipboard) into
/// the app's `attachments/` folder and return its absolute path, so the frontend
/// can hand that path to the `chat` command like any other referenced file —
/// Claude Code reads image files natively. Bytes arrive base64-encoded (textual
/// IPC), so a clipboard paste survives the round-trip unchanged.
#[tauri::command]
pub fn save_attachment(state: State<'_, AppState>, name: String, data_base64: String) -> CmdResult {
    const MAX: usize = 24 * 1024 * 1024; // 24 MB — pasted screenshots, not big uploads
    let bytes = base64_decode(&data_base64).ok_or("could not read the pasted data")?;
    if bytes.is_empty() {
        return Err("empty attachment".into());
    }
    if bytes.len() > MAX {
        return Err("attachment is too large".into());
    }
    let dir = state.data_dir.join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // A monotonic-ish, collision-resistant filename: <millis>-<sanitized name>.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe = sanitize_filename(&name);
    let path = dir.join(format!("{stamp}-{safe}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(json!({ "path": path.to_string_lossy() }))
}

/// Reduce a suggested filename to a safe leaf: strip any directory parts and keep
/// only sane characters, so a hostile clipboard name can't escape the folder.
fn sanitize_filename(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = leaf
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "attachment.png".into()
    } else {
        cleaned.chars().take(120).collect()
    }
}

/// Minimal standard-base64 decoder (the mirror of `base64_encode`). Ignores
/// whitespace and an optional `data:` prefix; returns None on malformed input.
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    // Accept a full "data:...;base64,<payload>" URL as well as a bare payload.
    let payload = match input.split_once("base64,") {
        Some((_, p)) => p,
        None => input,
    };
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(payload.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &b in payload.as_bytes() {
        if b == b'=' || b.is_ascii_whitespace() {
            continue;
        }
        let v = val(b)?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Minimal standard-base64 encoder (no padding shortcuts) — keeps the image
/// preview dependency-free rather than pulling in a crate for one call site.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = *chunk.get(1).unwrap_or(&0) as usize;
        let b2 = *chunk.get(2).unwrap_or(&0) as usize;
        out.push(T[b0 >> 2] as char);
        out.push(T[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { T[((b1 & 0x0f) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[b2 & 0x3f] as char } else { '=' });
    }
    out
}
