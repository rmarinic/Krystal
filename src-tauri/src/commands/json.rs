//! Getting JSON out of a one-off `claude` call: the `--json-schema` contract and
//! the fallback that digs a JSON value out of a free-text reply.

use super::*;

/// Strip a leading/trailing ```markdown fence around a draft, if present.
pub(super) fn strip_md_fence(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // drop an optional language tag on the first line
        let rest = match rest.find('\n') {
            Some(nl) => &rest[nl + 1..],
            None => rest,
        };
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    t.to_string()
}

/// The clarifying-question shape both the task generator and the Initialize
/// wizard ask for. Used to build their `--json-schema` contracts below.
pub(super) fn question_schema() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "id":          { "type": "string" },
                "question":    { "type": "string" },
                "why":         { "type": "string" },
                "multi":       { "type": "boolean" },
                "options":     { "type": "array", "items": { "type": "string" } },
                "allowCustom": { "type": "boolean" }
            },
            "required": ["id", "question", "options"]
        }
    })
}

/// Attach a `--json-schema` contract to a one-off call whose reply we parse as
/// JSON. The CLI validates the model's structured output against it, which turns
/// "the reply *should* be JSON" into "the reply *is* JSON of this shape".
/// `extract_json` stays as the safety net for a CLI too old to know the flag.
pub(super) fn with_json_schema(args: &[String], schema: Value) -> Vec<String> {
    let mut out = args.to_vec();
    out.push("--json-schema".into());
    out.push(schema.to_string());
    out
}

/// Pull the first balanced JSON object/array out of a model reply (tolerates
/// ```json fences or a stray sentence before/after). Mirrors `extractJson`.
pub(super) fn extract_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    let s = strip_code_fence(trimmed);
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&c| c == b'{' || c == b'[')?;
    let open = bytes[start];
    let close = if open == b'{' { b'}' } else { b']' };
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return serde_json::from_str(&s[start..=i]).ok();
            }
        }
        i += 1;
    }
    None
}

fn strip_code_fence(s: &str) -> &str {
    if let Some(a) = s.find("```") {
        let after = &s[a + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        let after = after.trim_start();
        if let Some(b) = after.find("```") {
            return after[..b].trim();
        }
    }
    s
}
