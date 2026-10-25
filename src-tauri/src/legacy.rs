//! Tidying up after features that are gone.
//!
//! The LAN server (phone access on port 7420) could add an inbound Windows
//! Firewall rule for Krystal, named "Krystal Remote". The server is gone, so the
//! rule would only ever let in a listener that no longer exists — but it
//! shouldn't outlive the feature that made it. On launch, off the UI thread: if
//! the rule is there, delete it, and once that's settled, never look again.
//!
//! Deleting a firewall rule needs administrator rights, and Krystal installs per
//! user and runs unelevated. So the quiet delete is tried first (it works on an
//! elevated launch), and if Windows refuses it, Krystal asks **once**: a single
//! UAC prompt for `netsh`. Whatever the answer, it never asks again.

use std::path::Path;

/// The rule the old server's "Allow" button wrote.
const OLD_RULE: &str = "Krystal Remote";

/// Left in the app data folder once the rule is gone, or the one ask was made.
const DONE_MARK: &str = "firewall-rule-removed";

/// Start the cleanup in the background. Never blocks; at most one UAC prompt,
/// ever.
pub fn remove_old_firewall_rule(data_dir: &Path) {
    let mark = data_dir.join(DONE_MARK);
    if mark.exists() {
        return;
    }
    std::thread::spawn(move || {
        if old_rule_settled() {
            let _ = std::fs::write(&mark, b"");
        }
    });
}

/// True once there is nothing left to do: the rule was never there, it was
/// just deleted, or the user has been asked. False only when `netsh` couldn't
/// be run at all — try again next launch.
#[cfg(target_os = "windows")]
fn old_rule_settled() -> bool {
    let name = format!("name={OLD_RULE}");
    match netsh(&["advfirewall", "firewall", "show", "rule", &name]) {
        // `show` exits 1 with "No rules match" when there is no such rule.
        Some(false) => true,
        Some(true) => {
            if netsh(&["advfirewall", "firewall", "delete", "rule", &name]) != Some(true) {
                // Let the window come up first, so the prompt isn't the first
                // thing on screen.
                std::thread::sleep(std::time::Duration::from_secs(4));
                ask_to_delete();
            }
            true
        }
        None => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn old_rule_settled() -> bool {
    true
}

/// What the elevated helper runs: `netsh` deleting the rule, through one UAC
/// prompt. A refused prompt makes `Start-Process` throw; that is an answer, not
/// an error. The rule name is the only thing quoted, and it is ours.
#[cfg(target_os = "windows")]
fn ask_script() -> String {
    format!(
        "try {{ Start-Process -FilePath 'netsh' -ArgumentList \
         'advfirewall firewall delete rule \"name={OLD_RULE}\"' \
         -Verb RunAs -WindowStyle Hidden -Wait }} catch {{ }}"
    )
}

/// Run `ask_script` in a hidden PowerShell. Passed as `-EncodedCommand` (UTF-16LE,
/// base64) so no quoting has to survive a second command line.
#[cfg(target_os = "windows")]
fn ask_to_delete() {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"])
        .arg(encoded_command(&ask_script()))
        .creation_flags(crate::claude::CREATE_NO_WINDOW)
        .output();
}

/// PowerShell's `-EncodedCommand` form of a script.
#[cfg(target_os = "windows")]
fn encoded_command(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    crate::util::base64_encode(&utf16)
}

/// Run `netsh` with no console window: `Some(exit code was 0)`, or `None` if
/// it couldn't be run at all.
#[cfg(target_os = "windows")]
fn netsh(args: &[&str]) -> Option<bool> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("netsh")
        .args(args)
        .creation_flags(crate::claude::CREATE_NO_WINDOW)
        .output()
        .ok()
        .map(|out| out.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_cleanup_is_never_run_again() {
        let dir = std::env::temp_dir().join(format!("krystal-legacy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(DONE_MARK), b"").unwrap();
        // Returns at once: with the mark there, no thread is started and no
        // `netsh` is run.
        remove_old_firewall_rule(&dir);
        assert!(dir.join(DONE_MARK).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On a machine without the rule (CI, a fresh install) the check says it's
    /// gone, which is what lets the mark be written.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_machine_without_the_rule_counts_as_clean() {
        let name = format!("name={OLD_RULE}");
        if netsh(&["advfirewall", "firewall", "show", "rule", &name]) == Some(false) {
            assert!(old_rule_settled());
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_one_ask_deletes_exactly_the_old_rule() {
        let script = ask_script();
        assert!(script.contains("-Verb RunAs"), "{script}");
        assert!(script.contains(r#"delete rule "name=Krystal Remote""#), "{script}");
        assert!(script.starts_with("try {") && script.ends_with("catch { }"), "{script}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn an_encoded_command_is_base64_of_utf16le() {
        // `[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('ab'))`
        assert_eq!(encoded_command("ab"), "YQBiAA==");
    }
}
