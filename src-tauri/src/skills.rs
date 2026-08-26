/* skills.rs — the slash-commands ("skills") a chat can invoke.
 *
 * Claude Code has always accepted `/skill-name` at the head of a prompt, and
 * Krystal's chats have had that working the whole time — invisibly. Nothing in
 * the UI ever said so, and nothing listed what was available. This module is the
 * listing half; the composer's `/` picker (src/app/skills.js) is the other.
 *
 * Two sources, because neither one is complete on its own:
 *
 * * The CLI reports the real, authoritative set in its `system.init` event
 *   (`skills`), which includes the ones built into the binary — `code-review`,
 *   `run`, `dataviz` … — that exist nowhere on disk to be found. But that event
 *   only arrives once a chat has actually started a session, so a brand-new
 *   project has nothing to show. The frontend caches those names per project.
 *
 * * A filesystem scan of the project's and the user's `.claude/skills` and
 *   `.claude/commands` folders. Cold-start answer, and the only place a
 *   *description* can be read from (`SKILL.md` frontmatter), which is what makes
 *   the picker readable rather than a wall of bare names.
 *
 * The two are merged in the frontend, a described entry winning over a bare name.
 */

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Enough of a file to hold its frontmatter; skills put the body after it.
const FRONTMATTER_MAX_BYTES: usize = 8 * 1024;

/// A safety valve, not a real limit — a picker is not a file browser.
const MAX_SKILLS: usize = 250;

/// Where a skill came from, so the picker can group project-local ones first.
pub const SRC_PROJECT: &str = "project";
pub const SRC_USER: &str = "user";

/// The `name:` / `description:` pair out of a markdown file's YAML frontmatter.
/// Deliberately shallow: skills use a flat `key: value` header, and a real YAML
/// parser would be a dependency bought for two fields.
fn read_frontmatter(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(bytes) = std::fs::read(path) else {
        return (None, None);
    };
    let head = &bytes[..bytes.len().min(FRONTMATTER_MAX_BYTES)];
    let text = String::from_utf8_lossy(head);
    parse_frontmatter(&text)
}

fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    // Frontmatter has to open on the very first line, or there is none.
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "name" => name = Some(value.to_string()),
            "description" => description = Some(value.to_string()),
            _ => {}
        }
    }
    (name, description)
}

/// A skill name has to survive being typed after a `/`, so anything with
/// whitespace or a path separator in it isn't one.
fn is_usable_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

fn entry(name: &str, description: Option<String>, source: &str) -> Value {
    json!({
        "name": name,
        "description": description.unwrap_or_default(),
        "source": source,
    })
}

/// `<base>/.claude/skills/<name>/SKILL.md` — one skill per folder.
fn scan_skill_folders(base: &Path, source: &str, out: &mut Vec<Value>) {
    let Ok(dir) = std::fs::read_dir(base.join(".claude").join("skills")) else { return };
    for item in dir.flatten() {
        let manifest = item.path().join("SKILL.md");
        if !manifest.is_file() {
            continue;
        }
        let (fm_name, description) = read_frontmatter(&manifest);
        // The folder name is what the CLI actually resolves, so it wins over a
        // frontmatter `name:` that drifted away from it.
        let name = item.file_name().to_string_lossy().to_string();
        let name = if is_usable_name(&name) {
            name
        } else {
            fm_name.unwrap_or_default()
        };
        if is_usable_name(&name) {
            out.push(entry(&name, description, source));
        }
    }
}

/// `<base>/.claude/commands/<name>.md` — one command per file. Nested folders
/// namespace their commands (`git/sync.md` → `/git:sync`), so one level down is
/// worth walking; deeper than that is somebody else's filing system.
fn scan_command_files(base: &Path, source: &str, out: &mut Vec<Value>) {
    let root = base.join(".claude").join("commands");
    let Ok(dir) = std::fs::read_dir(&root) else { return };
    for item in dir.flatten() {
        let path = item.path();
        if path.is_dir() {
            let prefix = item.file_name().to_string_lossy().to_string();
            let Ok(inner) = std::fs::read_dir(&path) else { continue };
            for sub in inner.flatten() {
                if let Some(stem) = markdown_stem(&sub.path()) {
                    let name = format!("{prefix}:{stem}");
                    if is_usable_name(&name) {
                        let (_, description) = read_frontmatter(&sub.path());
                        out.push(entry(&name, description, source));
                    }
                }
            }
        } else if let Some(name) = markdown_stem(&path) {
            if is_usable_name(&name) {
                let (_, description) = read_frontmatter(&path);
                out.push(entry(&name, description, source));
            }
        }
    }
}

fn markdown_stem(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    if ext != "md" {
        return None;
    }
    Some(path.file_stem()?.to_string_lossy().to_string())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

/// Every skill we can find on disk for `project`, project-local ones first.
/// Duplicate names collapse to the first one seen — a project skill shadows the
/// user's skill of the same name, which is how the CLI resolves it too.
pub fn scan(project: Option<&str>) -> Vec<Value> {
    let mut found = Vec::new();
    if let Some(p) = project.filter(|p| !p.trim().is_empty()) {
        let base = Path::new(p);
        scan_skill_folders(base, SRC_PROJECT, &mut found);
        scan_command_files(base, SRC_PROJECT, &mut found);
    }
    if let Some(home) = home_dir() {
        scan_skill_folders(&home, SRC_USER, &mut found);
        scan_command_files(&home, SRC_USER, &mut found);
    }
    dedupe(found)
}

fn dedupe(found: Vec<Value>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in found {
        let name = item["name"].as_str().unwrap_or_default().to_string();
        if seen.insert(name) {
            out.push(item);
            if out.len() >= MAX_SKILLS {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_name_and_description_out_of_frontmatter() {
        let (name, desc) = parse_frontmatter("---\nname: htmlcast\ndescription: Render a page\n---\n\n# body\n");
        assert_eq!(name.as_deref(), Some("htmlcast"));
        assert_eq!(desc.as_deref(), Some("Render a page"));
    }

    #[test]
    fn a_description_may_contain_colons() {
        let (_, desc) = parse_frontmatter("---\ndescription: Use when: you need it\n---\n");
        assert_eq!(desc.as_deref(), Some("Use when: you need it"));
    }

    #[test]
    fn no_frontmatter_is_not_an_error() {
        assert_eq!(parse_frontmatter("# just a heading\n"), (None, None));
        // A `---` that isn't on the first line doesn't open frontmatter.
        assert_eq!(parse_frontmatter("\n---\nname: nope\n---\n"), (None, None));
    }

    #[test]
    fn body_text_after_the_closing_fence_is_ignored() {
        let (name, _) = parse_frontmatter("---\nname: real\n---\nname: fake\n");
        assert_eq!(name.as_deref(), Some("real"));
    }

    #[test]
    fn rejects_names_that_could_not_be_typed_after_a_slash() {
        assert!(is_usable_name("code-review"));
        assert!(is_usable_name("git:sync"));
        assert!(!is_usable_name(""));
        assert!(!is_usable_name("two words"));
        assert!(!is_usable_name("a/b"));
    }

    #[test]
    fn the_first_of_a_duplicated_name_wins() {
        let out = dedupe(vec![
            entry("build", Some("project one".into()), SRC_PROJECT),
            entry("build", Some("user one".into()), SRC_USER),
            entry("other", None, SRC_USER),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["description"], "project one");
        assert_eq!(out[0]["source"], SRC_PROJECT);
    }

    #[test]
    fn scans_skill_folders_and_command_files() {
        let dir = std::env::temp_dir().join(format!("krystal-skills-{}", std::process::id()));
        let claude = dir.join(".claude");
        std::fs::create_dir_all(claude.join("skills").join("brief")).unwrap();
        std::fs::create_dir_all(claude.join("commands").join("git")).unwrap();
        std::fs::write(
            claude.join("skills").join("brief").join("SKILL.md"),
            "---\nname: brief\ndescription: Draft a brief\n---\n",
        )
        .unwrap();
        std::fs::write(claude.join("commands").join("ship.md"), "do the thing\n").unwrap();
        std::fs::write(claude.join("commands").join("git").join("sync.md"), "sync\n").unwrap();

        let mut found = Vec::new();
        scan_skill_folders(&dir, SRC_PROJECT, &mut found);
        scan_command_files(&dir, SRC_PROJECT, &mut found);
        let names: Vec<&str> = found.iter().map(|f| f["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"brief"), "{names:?}");
        assert!(names.contains(&"ship"), "{names:?}");
        assert!(names.contains(&"git:sync"), "nested commands namespace: {names:?}");
        let brief = found.iter().find(|f| f["name"] == "brief").unwrap();
        assert_eq!(brief["description"], "Draft a brief");

        std::fs::remove_dir_all(&dir).ok();
    }
}
