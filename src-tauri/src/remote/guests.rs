//! What the owner lets guests do: people this computer was shared with at
//! app.krystal.rip. The owner sets it in Settings → Remote (`get_guest_access`
//! / `set_guest_access`, both local-only, so a guest can never widen it), and
//! `access.rs` holds every guest request to it.
//!
//! Kept in a file in the app data folder rather than the window's storage: the
//! relay serves guests from the moment the app starts, before any window has
//! loaded, and the rule must already be the owner's then. Read on each guest
//! request (a few hundred bytes), so a change applies to the very next one.
//!
//! The defaults are the careful ones: a guest's turns run in Ask or Plan, their
//! permission prompts wait for the owner, no commands, only project folders.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::models;

const FILE: &str = "guest-access.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GuestAccess {
    /// The chat modes a guest's turn may run in (`models::MODES` ids). A chat
    /// set to another one runs a guest's turn in the nearest of these that does
    /// less (`models::cap_mode`). None at all: guests can read, not send.
    pub modes: Vec<String>,
    /// May a guest answer a turn's permission prompts? Off, they wait for the
    /// owner (here, or signed in as the owner at app.krystal.rip).
    pub approve: bool,
    /// The `$` shell, the RUN button and git's changing commands.
    pub commands: bool,
    /// Paths anywhere on this computer, not only inside the project folders.
    pub all_files: bool,
}

impl Default for GuestAccess {
    fn default() -> Self {
        GuestAccess { modes: vec!["ask".into(), "plan".into()], approve: false, commands: false, all_files: false }
    }
}

impl GuestAccess {
    /// The owner's choice, or the defaults when nothing (or nothing readable)
    /// was saved.
    pub fn load(dir: &Path) -> Self {
        std::fs::read_to_string(dir.join(FILE))
            .ok()
            .and_then(|s| serde_json::from_str::<GuestAccess>(&s).ok())
            .map(GuestAccess::tidy)
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(FILE), text).map_err(|e| e.to_string())
    }

    /// Known modes only, each once, in `MODES` order (most able first).
    pub fn tidy(mut self) -> Self {
        self.modes = models::MODES
            .iter()
            .filter(|m| self.modes.iter().any(|x| x == m.id))
            .map(|m| m.id.to_string())
            .collect();
        self
    }

    pub fn allows_mode(&self, mode: &str) -> bool {
        self.modes.iter().any(|m| m == mode)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tests::TempDir;

    #[test]
    fn nothing_saved_is_the_careful_defaults() {
        let dir = TempDir::new();
        let a = GuestAccess::load(&dir.0);
        assert_eq!(a.modes, ["ask", "plan"]);
        assert!(!a.approve && !a.commands && !a.all_files);
    }

    #[test]
    fn a_saved_choice_comes_back_tidied() {
        let dir = TempDir::new();
        let a = GuestAccess { modes: vec!["plan".into(), "yolo".into(), "auto".into(), "plan".into()], approve: true, commands: false, all_files: true };
        a.save(&dir.0).unwrap();
        let back = GuestAccess::load(&dir.0);
        assert_eq!(back.modes, ["auto", "plan"], "unknown dropped, each once, most able first");
        assert!(back.approve && back.all_files && !back.commands);
    }

    #[test]
    fn a_garbled_file_falls_back_to_the_defaults_and_missing_fields_to_theirs() {
        let dir = TempDir::new();
        std::fs::write(dir.0.join(FILE), "{ not json").unwrap();
        assert_eq!(GuestAccess::load(&dir.0), GuestAccess::default());
        std::fs::write(dir.0.join(FILE), r#"{ "commands": true }"#).unwrap();
        let a = GuestAccess::load(&dir.0);
        assert!(a.commands);
        assert_eq!(a.modes, ["ask", "plan"]);
    }
}
