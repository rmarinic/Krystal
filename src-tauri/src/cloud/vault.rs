//! Where the link is kept: Windows Credential Manager, through `keyring`.
//!
//! The device token is a long-lived credential that will one day let someone
//! drive this computer, so it lives in the OS credential store and nowhere else
//! — not in the database, not in settings, not in a log, never in the webview.
//! The account's email and the device's name ride in the same entry: they are
//! what the panel shows, and keeping the link in one place means it can't be
//! half there.

use serde::{Deserialize, Serialize};

/// The credential's service name in Credential Manager.
const SERVICE: &str = "Krystal Cloud";

/// One link to an account, as it was handed over by `/api/link/poll`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    pub device_id: String,
    pub device_token: String,
    pub email: String,
    /// What the dashboard calls this computer (it can be renamed there).
    pub name: String,
}

// By hand, so a stray `{:?}` can never print the token.
impl std::fmt::Debug for Linked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Linked")
            .field("device_id", &self.device_id)
            .field("device_token", &"<redacted>")
            .field("email", &self.email)
            .field("name", &self.name)
            .finish()
    }
}

/// Somewhere to keep a link between runs.
pub trait Vault: Send + Sync + 'static {
    fn load(&self) -> Option<Linked>;
    fn save(&self, link: &Linked) -> Result<(), String>;
    fn clear(&self);
}

/// The OS credential store. One entry per cloud base URL, so linking a dev
/// build to `wrangler dev` never overwrites the real link.
pub struct Keyring {
    account: String,
}

impl Keyring {
    pub fn new(base_url: &str) -> Self {
        Self { account: base_url.to_string() }
    }

    fn entry(&self) -> Option<keyring::Entry> {
        keyring::Entry::new(SERVICE, &self.account).ok()
    }
}

impl Vault for Keyring {
    fn load(&self) -> Option<Linked> {
        let raw = self.entry()?.get_password().ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn save(&self, link: &Linked) -> Result<(), String> {
        let raw = serde_json::to_string(link).map_err(|e| e.to_string())?;
        let entry = self.entry().ok_or("the credential store is unavailable")?;
        // The error says which store failed, never what was being stored.
        entry
            .set_password(&raw)
            .map_err(|_| "could not save the link in Windows Credential Manager".to_string())
    }

    fn clear(&self) {
        if let Some(entry) = self.entry() {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_never_prints_its_token() {
        let link = Linked {
            device_id: "d1".into(),
            device_token: "s3cret-token".into(),
            email: "you@example.com".into(),
            name: "MARIN-PC".into(),
        };
        let shown = format!("{link:?}");
        assert!(!shown.contains("s3cret-token"), "{shown}");
        assert!(shown.contains("you@example.com"));
    }

    #[test]
    fn a_link_round_trips_through_its_stored_form() {
        let link = Linked {
            device_id: "d1".into(),
            device_token: "t".into(),
            email: "you@example.com".into(),
            name: "MARIN-PC".into(),
        };
        let raw = serde_json::to_string(&link).unwrap();
        assert!(raw.contains("\"deviceToken\""));
        assert_eq!(serde_json::from_str::<Linked>(&raw).unwrap(), link);
    }
}
