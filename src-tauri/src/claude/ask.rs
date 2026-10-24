//! Choice cards: the ```krystal-ask fence Claude writes, parsed out of the stream
//! as it arrives and turned into the same question card AskUserQuestion makes.

use super::*;

// Krystal renders multiple-choice "choice cards" from a tool segment carrying a
// `questions` array. The built-in `AskUserQuestion` tool is gated out of headless
// (`claude -p`) sessions, so instead we ask the model to emit a fenced
// ```krystal-ask block of JSON and rebuild that same segment here — keeping the
// feature working regardless of the CLI version. `AskParser` is a tiny state
// machine that lifts the block out of the streamed text so its raw JSON never
// flashes on screen before the card appears.
const ASK_OPEN: &str = "```krystal-ask";
const ASK_CLOSE: &str = "```";

/// Stream visible text to the live view and into the persisted transcript.
pub(super) fn ask_emit_text(result: &mut ChatResult, channel: &Channel<Value>, t: &str) {
    if t.is_empty() {
        return;
    }
    result.push_text(t);
    let _ = channel.send(json!({ "type": "token", "text": t }));
}

/// The `questions` array of a parsed body — either `{"questions":[…]}` or the
/// bare `[…]` array itself.
fn questions_of(v: &Value) -> Option<Value> {
    v.get("questions")
        .cloned()
        .filter(|q| q.is_array())
        .or_else(|| if v.is_array() { Some(v.clone()) } else { None })
}

/// The `[ … ]` slice that starts at `from`, honouring strings and escapes so a
/// bracket inside an option's text can't close it early. None if it never closes.
fn balanced_array(s: &str, from: usize) -> Option<&str> {
    let b = s.as_bytes();
    let (mut depth, mut in_str, mut esc) = (0i32, false, false);
    for i in from..b.len() {
        let c = b[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[from..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Pull the `questions` array out of a ```krystal-ask block body. Accepts either
/// the full `{"questions":[…]}` object or a bare `[…]` array; returns None if the
/// body doesn't hold an array of questions.
///
/// A strict parse is tried first, then a lenient recovery: models do sometimes
/// close a long block one brace short, or trail a line of prose after the JSON.
/// The `questions` array itself is intact in both cases, so we lift it out on its
/// own rather than losing the whole card to a stray character.
fn parse_ask_questions(body: &str) -> Option<Value> {
    let body = body.trim();
    if let Some(q) = serde_json::from_str::<Value>(body).ok().as_ref().and_then(questions_of) {
        return Some(q);
    }
    let from = match body.find("\"questions\"") {
        Some(k) => k + body[k..].find('[')?,
        None => body.find('[')?,
    };
    let v: Value = serde_json::from_str(balanced_array(body, from)?).ok()?;
    // Only a real list of question objects — never a stray array of scalars.
    let ok = v
        .as_array()
        .is_some_and(|a| !a.is_empty() && a.iter().all(|q| q.is_object()));
    if ok { Some(v) } else { None }
}

/// Turn a captured ```krystal-ask body into the same `{questions}` tool segment the
/// frontend already knows how to render. On any parse failure, fall back to showing
/// the raw text so nothing the model wrote is ever lost.
fn ask_emit_question(result: &mut ChatResult, channel: &Channel<Value>, body: &str) {
    match parse_ask_questions(body) {
        Some(q) => {
            let first = q.as_array().and_then(|a| a.first());
            let qtext = first
                .and_then(|f| f.get("question"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let header = first
                .and_then(|f| f.get("header"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(qtext);
            let id = format!("ask-{}", result.segments.len());
            let msg = json!({
                "type": "tool",
                "name": "AskUserQuestion",
                "id": id,
                "detail": qtext,
                "target": take_chars(header, 28),
                "questions": q,
            });
            result.push_tool(msg.clone());
            let _ = channel.send(msg);
        }
        // Not the JSON we expected — show it verbatim rather than dropping it.
        None => ask_emit_text(result, channel, body),
    }
}

#[derive(Default)]
pub(super) struct AskParser {
    /// Text held back: either a short tail that might begin the open marker, or
    /// the block body accumulating until its closing fence arrives.
    held: String,
    in_block: bool,
}

impl AskParser {
    /// Feed a chunk of streamed assistant text. Plain prose is forwarded
    /// immediately; a ```krystal-ask block is withheld, captured, and converted
    /// into a choice-card segment once its closing fence arrives.
    pub(super) fn feed(&mut self, t: &str, result: &mut ChatResult, channel: &Channel<Value>) {
        self.held.push_str(t);
        loop {
            if self.in_block {
                if let Some(p) = self.held.find(ASK_CLOSE) {
                    let body = self.held[..p].to_string();
                    ask_emit_question(result, channel, &body);
                    self.held = self.held[p + ASK_CLOSE.len()..].to_string();
                    self.in_block = false;
                    continue;
                }
                return; // still buffering the block body
            }
            if let Some(p) = self.held.find(ASK_OPEN) {
                let before = self.held[..p].to_string();
                ask_emit_text(result, channel, &before);
                self.held = self.held[p + ASK_OPEN.len()..].to_string();
                self.in_block = true;
                continue;
            }
            // No marker yet — emit everything except a short trailing window that
            // could be the start of one split across the next delta.
            let keep = ASK_OPEN.len() - 1;
            if self.held.len() <= keep {
                return;
            }
            let mut cut = self.held.len() - keep;
            while cut > 0 && !self.held.is_char_boundary(cut) {
                cut -= 1;
            }
            let safe = self.held[..cut].to_string();
            ask_emit_text(result, channel, &safe);
            self.held = self.held[cut..].to_string();
            return;
        }
    }

    /// End of a text block / turn: release whatever is still held. An unterminated
    /// block is shown verbatim (with its opening fence) so nothing is lost.
    pub(super) fn flush(&mut self, result: &mut ChatResult, channel: &Channel<Value>) {
        if self.held.is_empty() {
            self.in_block = false;
            return;
        }
        let leftover = std::mem::take(&mut self.held);
        if self.in_block {
            ask_emit_text(result, channel, &format!("{ASK_OPEN}{leftover}"));
            self.in_block = false;
        } else {
            ask_emit_text(result, channel, &leftover);
        }
    }
}

/// Remove any ```krystal-ask blocks from a finished answer string so the raw JSON
/// never leaks into a persisted/fallback transcript (the block becomes a card).
pub(super) fn strip_ask_blocks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find(ASK_OPEN) {
        out.push_str(&rest[..p]);
        let after = &rest[p + ASK_OPEN.len()..];
        match after.find(ASK_CLOSE) {
            Some(q) => rest = &after[q + ASK_CLOSE.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_removes_a_single_block() {
        let s = "Here are some options:
```krystal-ask
{\"questions\":[]}
```";
        assert_eq!(strip_ask_blocks(s), "Here are some options:");
    }

    #[test]
    fn strip_keeps_text_on_both_sides() {
        let s = "before ```krystal-ask
{}
``` after";
        assert_eq!(strip_ask_blocks(s), "before  after");
    }

    #[test]
    fn strip_drops_an_unterminated_block() {
        let s = "intro ```krystal-ask
{\"questions\": [";
        assert_eq!(strip_ask_blocks(s), "intro");
    }

    #[test]
    fn strip_leaves_ordinary_text_and_code_fences_untouched() {
        let s = "see ```rust
fn main() {}
``` ok";
        assert_eq!(strip_ask_blocks(s), s.trim());
    }

    #[test]
    fn parse_accepts_questions_object() {
        let body = "{\"questions\":[{\"question\":\"Pick\",\"options\":[{\"label\":\"A\"}]}]}";
        let q = parse_ask_questions(body).expect("should parse");
        assert!(q.is_array());
        assert_eq!(q.as_array().unwrap().len(), 1);
    }

    #[test]
    fn parse_accepts_bare_array() {
        let body = "[{\"question\":\"Pick\"}]";
        assert!(parse_ask_questions(body).is_some());
    }

    // The real-world slip: a long block closed one brace short of the root object.

    #[test]
    fn parse_recovers_a_missing_closing_brace() {
        let body = "{\"questions\":[{\"question\":\"What next?\",\"header\":\"Next step\",\
                     \"multiSelect\":true,\"options\":[{\"label\":\"4.2 [gate]\",\
                     \"description\":\"a ] inside the text\"},{\"label\":\"B\"}]}]";
        let q = parse_ask_questions(body).expect("should recover");
        let a = q.as_array().unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["options"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn parse_recovers_with_trailing_prose() {
        let body = "{\"questions\":[{\"question\":\"Pick\",\"options\":[{\"label\":\"A\"}]}]}\nLet me know.";
        assert!(parse_ask_questions(body).is_some());
    }

    #[test]
    fn parse_rejects_non_json_and_non_arrays() {
        assert!(parse_ask_questions("not json").is_none());
        assert!(parse_ask_questions("{\"questions\": 5}").is_none());
        assert!(parse_ask_questions("{\"foo\": 1}").is_none());
    }
}
