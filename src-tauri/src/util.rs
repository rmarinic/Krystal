//! Small helpers more than one module needs. Anything that lands here should be
//! genuinely shared — a helper only one module uses stays in that module.

/// The last segment of a path, as a display name ("C:\work\site\" → "site").
/// Handles both separators and a trailing one; a path with no segment at all
/// comes back unchanged.
pub fn base_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    if name.is_empty() { path.to_string() } else { name.to_string() }
}

/// This executable's full path, or `None` if the OS won't say.
pub fn exe_path() -> Option<String> {
    std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())
}

/// Minimal standard-base64 decoder (the mirror of `base64_encode`). Ignores
/// whitespace and an optional `data:` prefix; returns None on malformed input.
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
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
/// preview and PowerShell's `-EncodedCommand` (legacy.rs) dependency-free.
pub fn base64_encode(data: &[u8]) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_name_takes_the_last_segment() {
        assert_eq!(base_name(r"C:\work\site"), "site");
        assert_eq!(base_name("/home/me/notes.md"), "notes.md");
        assert_eq!(base_name(r"C:\work\site\"), "site");
        assert_eq!(base_name("plain"), "plain");
        assert_eq!(base_name("/"), "/");
    }

    #[test]
    fn base64_round_trips() {
        for data in [&b""[..], b"a", b"ab", b"abc", "čžš đ".as_bytes()] {
            let text = base64_encode(data);
            assert_eq!(base64_decode(&text).as_deref(), Some(data), "{text}");
        }
        assert_eq!(base64_encode(b"ab"), "YWI=");
    }
}
