//! Pinned files: the rail of files kept at hand beside the chat.
//!
//! Files pinned to the side of the chat for quick reference. See `src/app/pins.js`.

use super::*;

/// A pinned file is read fresh every time it's opened — the point is to check
/// what a file says *right now* (a task list Claude just ticked something off,
/// a brief that changed), so nothing here is cached. Big files are truncated
/// rather than refused: a peek at the top still answers the question.
const PIN_MAX_BYTES: usize = 400 * 1024;

#[tauri::command]
pub fn list_pins(state: State<'_, AppState>, project: String) -> Value {
    let conn = state.db();
    json!({ "pins": db::list_pins(&conn, &project) })
}

#[tauri::command]
pub fn add_pin(state: State<'_, AppState>, project: String, path: String) -> CmdResult {
    let path = path.trim().to_string();
    if project.trim().is_empty() || path.is_empty() {
        return Err("nothing to pin".into());
    }
    if !std::path::Path::new(&path).is_file() {
        return Err("not-a-file".into());
    }
    let label = crate::util::base_name(&path);
    let conn = state.db();
    Ok(json!({ "pins": db::add_pin(&conn, &project, &path, &label) }))
}

#[tauri::command]
pub fn remove_pin(state: State<'_, AppState>, project: String, id: i64) -> Value {
    let conn = state.db();
    db::remove_pin(&conn, id);
    json!({ "pins": db::list_pins(&conn, &project) })
}

/// Read a pinned file for the viewer. Reports a missing or unreadable file as
/// data rather than an error, so the panel can say "this file is gone" instead
/// of the UI swallowing it — a pin whose file moved is a normal thing to hit.
#[tauri::command]
pub fn read_pinned_file(path: String) -> Value {
    let p = std::path::Path::new(&path);
    let name = crate::util::base_name(&path);
    if !p.is_file() {
        return json!({ "exists": false, "name": name, "path": path });
    }
    let bytes = match std::fs::read(p) {
        Ok(b) => b,
        Err(e) => {
            return json!({ "exists": true, "unreadable": e.to_string(), "name": name, "path": path })
        }
    };
    let truncated = bytes.len() > PIN_MAX_BYTES;
    let slice = if truncated { &bytes[..PIN_MAX_BYTES] } else { &bytes[..] };
    // from_utf8_lossy keeps a stray non-UTF-8 byte (or a multi-byte char cut in
    // half at the truncation point) from turning the whole file into an error.
    let text = String::from_utf8_lossy(slice);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).replace("\r\n", "\n");
    let markdown = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false);
    json!({
        "exists": true,
        "name": name,
        "path": path,
        "text": text,
        "markdown": markdown,
        "truncated": truncated,
    })
}
