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
}
