//! Reaching out of the app: desktop notifications, links, the in-app browser,
//! and Show in folder / Open for files Claude touched.

use super::*;

/// Raise a desktop notification — a reply landed, or a turn stopped to ask for
/// permission, while the window was in the background. The frontend decides
/// *when* (it knows what is on screen and whether the user switched this off);
/// this only shows it. A machine with notifications turned off simply shows
/// nothing, which is not an error worth reporting to anyone.
#[tauri::command]
pub fn notify<R: tauri::Runtime>(app: tauri::AppHandle<R>, title: String, body: String) -> CmdResult {
    use tauri_plugin_notification::NotificationExt;
    // A toast is no place for a whole answer.
    let clip = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    let _ = app
        .notification()
        .builder()
        .title(clip(&title, 120))
        .body(clip(&body, 240))
        .show();
    Ok(json!({ "ok": true }))
}

/// Open a URL in the user's default browser. Validated to http(s) only and free
/// of control/quote characters, then handed to `explorer.exe` (which launches
/// the default handler) as a single argument — no shell, so no `cmd` re-parsing.
#[tauri::command]
pub fn open_external(url: String) -> CmdResult {
    let ok_scheme = {
        let l = url.to_ascii_lowercase();
        l.starts_with("http://") || l.starts_with("https://")
    };
    let safe = !url.chars().any(|c| c.is_control() || c == '"');
    if !ok_scheme || !safe {
        return Err("refused to open this link".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("could not open the link: {e}"))?;
    Ok(json!({ "ok": true }))
}

/// What "Open" on an action chip may do with a file Claude touched. Opening
/// hands the file to its default program — which, for a script or a binary,
/// *runs* it. A click meant to look at a file must never do that, so scripts
/// open as text in Notepad and binaries aren't opened at all (Show in folder
/// still works). Mirrored by `chipOpenKind` in `src/app/messages.js`, which
/// only decides how the button is labelled; this is the rule that holds.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenKind {
    Default,
    AsText,
    Never,
}

pub fn open_kind(path: &std::path::Path) -> OpenKind {
    const AS_TEXT: &[&str] = &[
        "ps1", "psm1", "psd1", "bat", "cmd", "js", "jse", "vbs", "vbe", "wsf", "wsh",
        "py", "pyw", "sh", "reg", "hta",
    ];
    const NEVER: &[&str] = &[
        "exe", "com", "scr", "pif", "msi", "msp", "msix", "appx", "dll", "sys", "ocx",
        "cpl", "lnk", "url", "jar", "msc", "application", "appref-ms", "gadget",
        "settingcontent-ms",
    ];
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if AS_TEXT.contains(&ext.as_str()) {
        OpenKind::AsText
    } else if NEVER.contains(&ext.as_str()) {
        OpenKind::Never
    } else {
        OpenKind::Default
    }
}

/// A path from a tool call, made into one Windows understands: Claude may write
/// `C:/x/y`, or the Git Bash form `/c/x/y`. Only absolute paths are taken (a
/// relative one would resolve against Krystal's own working directory, not the
/// project's), and nothing with a quote or control character, since
/// `reveal_path` has to place it inside a quoted argument.
pub fn local_path(raw: &str) -> Result<std::path::PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().any(|c| c.is_control() || c == '"') {
        return Err("not a usable path".into());
    }
    let b = raw.as_bytes();
    let unixy_drive = b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b'/';
    let p = if unixy_drive {
        format!("{}:/{}", (b[1] as char).to_ascii_uppercase(), &raw[3..])
    } else {
        raw.to_string()
    };
    let path = std::path::PathBuf::from(p.replace('/', "\\"));
    if !path.is_absolute() {
        return Err("not a usable path".into());
    }
    Ok(path)
}

/// Show a file Claude touched in Explorer, selected. A file that has since gone
/// opens the folder it was in instead (`gone: true` says so), as long as that
/// folder is still there.
#[tauri::command]
pub fn reveal_path(path: String) -> CmdResult {
    let path = local_path(&path)?;
    let mut cmd = std::process::Command::new("explorer.exe");
    let mut gone = false;
    if path.is_dir() {
        cmd.arg(&path);
    } else if path.exists() {
        // `/select,"path"` has to reach explorer as written: `arg` would quote
        // the whole thing, and explorer doesn't recognise a quoted `/select`.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.raw_arg(format!("/select,\"{}\"", path.display()));
        }
        #[cfg(not(windows))]
        {
            cmd.arg(&path);
        }
    } else {
        let dir = path.parent().filter(|d| d.is_dir()).ok_or("that file isn't there anymore")?;
        cmd.arg(dir);
        gone = true;
    }
    cmd.spawn().map_err(|e| format!("could not show it: {e}"))?;
    Ok(json!({ "ok": true, "gone": gone }))
}

/// Open a file Claude touched, by the rule in `open_kind`: its default program,
/// Notepad for a script, or not at all for something that would run. A file
/// that has since gone is an answer (`gone: true`), not an error, so the window
/// can say so in the user's language.
#[tauri::command]
pub fn open_path(path: String) -> CmdResult {
    let path = local_path(&path)?;
    if !path.exists() {
        return Ok(json!({ "ok": false, "gone": true }));
    }
    let program = if path.is_dir() {
        "explorer.exe"
    } else {
        match open_kind(&path) {
            OpenKind::Default => "explorer.exe",
            OpenKind::AsText => "notepad.exe",
            OpenKind::Never => return Err("this file would run if opened, so it isn't".into()),
        }
    };
    std::process::Command::new(program)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("could not open it: {e}"))?;
    Ok(json!({ "ok": true }))
}

/// Open a URL in a native child webview window — the in-app browser. Unlike an
/// embedded `<iframe>`, a top-level webview is not subject to the page's
/// `X-Frame-Options` / `Content-Security-Policy: frame-ancestors` headers, so
/// sites like YouTube/Google/X that refuse to be framed (the old iframe viewer
/// showed "Refused to connect") load correctly here. Validated to http(s) only.
///
/// The window is a standalone top-level window outside the main window's
/// capability scope (the `default` capability targets only `"main"`), so the
/// page it loads gets no access to Krystal's IPC — showing arbitrary sites is
/// safe. A single reusable window is kept: reopening navigates it instead of
/// stacking new windows.
#[tauri::command]
pub fn open_webview(app: tauri::AppHandle, url: String) -> CmdResult {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let parsed = tauri::Url::parse(&url).map_err(|_| "invalid link".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("refused to open this link".into());
    }
    let title = format!(
        "Krystal — {}",
        parsed.host_str().unwrap_or("link")
    );

    const LABEL: &str = "linkview";
    if let Some(win) = app.get_webview_window(LABEL) {
        win.navigate(parsed)
            .map_err(|e| format!("could not open the link: {e}"))?;
        let _ = win.set_title(&title);
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(json!({ "ok": true }));
    }

    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1100.0, 820.0)
        .min_inner_size(480.0, 360.0)
        .center()
        .focused(true)
        .build()
        .map_err(|e| format!("could not open the link: {e}"))?;

    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chip_paths_become_windows_paths_or_are_refused() {
        use std::path::PathBuf;
        assert_eq!(local_path("C:/Users/x/a.png").unwrap(), PathBuf::from(r"C:\Users\x\a.png"));
        assert_eq!(local_path("/c/Users/x/a b.md").unwrap(), PathBuf::from(r"C:\Users\x\a b.md"));
        assert_eq!(local_path(r"  D:\p\q.txt ").unwrap(), PathBuf::from(r"D:\p\q.txt"));
        // Relative paths would resolve against Krystal's own cwd, not the project's.
        assert!(local_path("src/main.rs").is_err());
        assert!(local_path("C:foo.txt").is_err());
        // A quote would break out of `/select,"…"`.
        assert!(local_path(r#"C:\a" /other"#).is_err());
        assert!(local_path("").is_err());
    }

    #[test]
    fn opening_a_chip_file_never_runs_it() {
        use std::path::Path;
        assert_eq!(open_kind(Path::new(r"C:\x\shot.PNG")), OpenKind::Default);
        assert_eq!(open_kind(Path::new(r"C:\x\notes.md")), OpenKind::Default);
        assert_eq!(open_kind(Path::new(r"C:\x\Makefile")), OpenKind::Default);
        assert_eq!(open_kind(Path::new(r"C:\x\build.ps1")), OpenKind::AsText);
        assert_eq!(open_kind(Path::new(r"C:\x\run.CMD")), OpenKind::AsText);
        assert_eq!(open_kind(Path::new(r"C:\x\tool.js")), OpenKind::AsText);
        assert_eq!(open_kind(Path::new(r"C:\x\setup.exe")), OpenKind::Never);
        assert_eq!(open_kind(Path::new(r"C:\x\link.lnk")), OpenKind::Never);
        assert_eq!(open_kind(Path::new(r"C:\x\app.msi")), OpenKind::Never);
    }
}
