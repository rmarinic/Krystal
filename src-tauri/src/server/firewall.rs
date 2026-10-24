//! The Windows Firewall check and the one-prompt rule that lets a phone in.

use super::*;

/* ---------------------------- Windows Firewall ---------------------------- */
/* The single most common reason "it says it's running but my phone can't open
 * it": Windows Firewall. Loopback is never filtered, so the host sees a perfectly
 * healthy server on `localhost` while every packet from the phone is dropped
 * before it reaches us — nothing on this side ever learns that it happened.
 *
 * Windows normally asks (the "allow access" popup) the first time a program
 * listens, but that only covers the exe that was running at the time: a user who
 * dismissed it once, or who tried remote access in a dev build and now runs the
 * installed one, ends up with a server nothing can reach and no way to tell.
 * So Krystal looks for itself in the inbound rules and, if it isn't there, offers
 * to put itself there. */

/// Name of the rule Krystal creates for itself. Stable, so re-applying replaces
/// the previous one instead of piling duplicates up.
const FIREWALL_RULE: &str = "Krystal Remote";

/// Run a command with no console window and hand back its stdout, or `None` if
/// it could not be run at all (which is different from "it ran and said no").
#[cfg(target_os = "windows")]
fn quiet_output(program: &str, args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new(program)
        .args(args)
        .creation_flags(crate::claude::CREATE_NO_WINDOW)
        .output()
        .ok()?;
    // netsh writes its "no rules match" line to stdout, so both halves matter.
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(text)
}

/// Is this exe named by any enabled inbound rule?
///
/// Asked of `netsh`, whose *labels* are localised but whose *values* — the
/// program paths — are not, so a plain case-insensitive search for our own path
/// works on any Windows language. It cannot tell an allow rule from a block one
/// or read which profiles a rule covers; that is what "Re-apply" is for, since
/// the rule Krystal writes itself covers every profile.
#[cfg(target_os = "windows")]
fn firewall_allows_us() -> Option<bool> {
    let exe = crate::util::exe_path()?.to_lowercase();
    let dump = quiet_output(
        "netsh",
        &["advfirewall", "firewall", "show", "rule", "name=all", "dir=in", "verbose"],
    )?;
    Some(dump.to_lowercase().contains(&exe))
}

#[cfg(not(target_os = "windows"))]
fn firewall_allows_us() -> Option<bool> {
    None
}

/// What the Remote panel needs to say about the firewall: whether this platform
/// has one Krystal can speak to, and whether it currently lets us in.
pub fn firewall_status() -> Value {
    json!({
        "supported": cfg!(target_os = "windows"),
        // `null` when the check could not run — the UI says nothing rather than
        // accusing a firewall that may be innocent.
        "allowed": firewall_allows_us(),
        "exe": crate::util::exe_path(),
    })
}

/// Write the elevated half as a script rather than trying to nest quoting three
/// deep through `Start-Process`. UTF-8 **with BOM** because Windows PowerShell
/// reads a `.ps1` as the system codepage otherwise, and an install path can hold
/// non-ASCII (a user folder called `Đorđe`, say).
#[cfg(target_os = "windows")]
pub(super) fn write_firewall_script(exe: &str) -> Result<std::path::PathBuf, String> {
    // Single-quoted PowerShell strings take no escapes but their own doubled quote.
    let ps_quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let path = std::env::temp_dir().join("krystal-firewall.ps1");
    // No `localport`: the rule is scoped to this program, exactly like the one
    // Windows' own prompt writes, so changing the port later doesn't strand it.
    let script = format!(
        "$ErrorActionPreference = 'Stop'\r\n\
         $name = {name}\r\n\
         $exe  = {exe}\r\n\
         netsh advfirewall firewall delete rule name=$name | Out-Null\r\n\
         netsh advfirewall firewall add rule name=$name dir=in action=allow \
         protocol=TCP program=$exe profile=any enable=yes\r\n\
         exit $LASTEXITCODE\r\n",
        name = ps_quote(FIREWALL_RULE),
        exe = ps_quote(exe),
    );
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(script.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| format!("could not write the helper script: {e}"))?;
    Ok(path)
}

/// Add (or replace) the inbound rule that lets other devices reach this Krystal.
/// Needs administrator rights, so it goes through `Start-Process -Verb RunAs` —
/// the user sees one UAC prompt and nothing else.
#[cfg(target_os = "windows")]
pub fn firewall_allow() -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    let exe = crate::util::exe_path().ok_or("could not work out where Krystal is installed")?;
    let script = write_firewall_script(&exe)?;
    // Refusing the UAC prompt makes `Start-Process` throw, and what PowerShell
    // then exits with is its own business; catch it and say 1 ourselves.
    let launch = format!(
        "try {{ $p = Start-Process -FilePath 'powershell' -Verb RunAs -WindowStyle Hidden \
         -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}'; \
         exit $p.ExitCode }} catch {{ exit 1 }}",
        script.display().to_string().replace('\'', "''"),
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &launch])
        .creation_flags(crate::claude::CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("could not run the firewall helper: {e}"))?;
    let _ = std::fs::remove_file(&script);
    if !out.status.success() {
        // The overwhelmingly likely one is a declined UAC prompt; say so plainly
        // instead of quoting PowerShell at someone.
        return Err("Windows did not allow the change — the permission prompt was refused."
            .to_string());
    }
    Ok(firewall_status())
}

#[cfg(not(target_os = "windows"))]
pub fn firewall_allow() -> Result<Value, String> {
    Err("Only Windows has a firewall Krystal can set up for you.".to_string())
}
