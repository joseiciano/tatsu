use std::fmt::Write as _;

use serde_json::{Map, Value};

use super::carrier::{Unit, decode};
use crate::number_to_string;

/// Strings are read through the lone-surrogate carrier that `parse_lenient`
/// writes. A string put into a `Value` from outside `parse_lenient` is written
/// wrong if it holds U+FDD0 followed by U+FDD0 or by U+F0000..=U+F07FF, so
/// incoming JSON must go through `parse_lenient`. The same holds for
/// `stringify_pretty`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, None);
    out
}

pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, Some(0));
    out
}

fn write_value(out: &mut String, value: &Value, depth: Option<usize>) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_f64().filter(|f| f.is_finite()) {
            Some(f) => out.push_str(&number_to_string(f)),
            None => out.push_str("null"),
        },
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            write_container(out, '[', ']', items.iter(), depth, |out, item, inner| {
                write_value(out, item, inner)
            });
        }
        Value::Object(map) => {
            write_container(
                out,
                '{',
                '}',
                js_key_order(map).into_iter(),
                depth,
                |out, (key, item), inner| {
                    write_string(out, key);
                    out.push(':');
                    if inner.is_some() {
                        out.push(' ');
                    }
                    write_value(out, item, inner);
                },
            );
        }
    }
}

fn write_container<T>(
    out: &mut String,
    open: char,
    close: char,
    items: impl ExactSizeIterator<Item = T>,
    depth: Option<usize>,
    mut write_item: impl FnMut(&mut String, T, Option<usize>),
) {
    out.push(open);
    if items.len() == 0 {
        out.push(close);
        return;
    }
    let inner = depth.map(|d| d + 1);
    for (i, item) in items.enumerate() {
        if i > 0 {
            out.push(',');
        }
        newline(out, inner);
        write_item(out, item, inner);
    }
    newline(out, depth);
    out.push(close);
}

fn newline(out: &mut String, depth: Option<usize>) {
    if let Some(depth) = depth {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', depth * 2));
    }
}

pub fn js_key_order(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named = Vec::with_capacity(map.len());
    for (key, value) in map {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    if indexed.is_empty() {
        return named;
    }
    indexed.sort_unstable_by_key(|(index, _, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}

fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    let canonical = !bytes.is_empty()
        && bytes.iter().all(u8::is_ascii_digit)
        && (bytes[0] != b'0' || bytes.len() == 1);
    if !canonical {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for unit in decode(s) {
        match unit {
            Unit::Char('"') => out.push_str("\\\""),
            Unit::Char('\\') => out.push_str("\\\\"),
            Unit::Char('\u{8}') => out.push_str("\\b"),
            Unit::Char('\u{c}') => out.push_str("\\f"),
            Unit::Char('\n') => out.push_str("\\n"),
            Unit::Char('\r') => out.push_str("\\r"),
            Unit::Char('\t') => out.push_str("\\t"),
            Unit::Char(c) if c < ' ' => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            Unit::Char(c) => out.push(c),
            Unit::LoneSurrogate(unit) => {
                let _ = write!(out, "\\u{unit:04x}");
            }
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn short_escapes_match_json_stringify() {
        assert_eq!(
            stringify(&json!("\"\\\u{8}\u{c}\n\r\t")),
            r#""\"\\\b\f\n\r\t""#
        );
    }

    #[test]
    fn other_control_characters_use_lowercase_unicode_escapes() {
        assert_eq!(
            stringify(&json!("\u{0}\u{1}\u{b}\u{1a}\u{1f}")),
            r#""\u0000\u0001\u000b\u001a\u001f""#
        );
    }

    #[test]
    fn delete_slash_line_separators_and_non_bmp_are_written_raw() {
        let raw = "\u{7f}/\u{2028}\u{2029}é😀";
        assert_eq!(stringify(&json!(raw)), format!("\"{raw}\""));
    }

    #[test]
    fn numbers_are_written_with_js_number_to_text() {
        assert_eq!(
            stringify(&json!([13.0, 13, -0.0, 1e21, 1e-7, 0.5, u64::MAX])),
            "[13,13,0,1e+21,1e-7,0.5,18446744073709552000]"
        );
    }

    #[test]
    fn pretty_output_matches_two_space_json_stringify() {
        let value = json!({"a": [], "b": {}, "c": [1, {"d": 2}], "e": "x"});
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": 2\n    }\n  ],\n  \"e\": \"x\"\n}"
        );
        assert_eq!(stringify_pretty(&json!(5)), "5");
        assert_eq!(stringify_pretty(&json!([])), "[]");
    }

    #[test]
    fn compact_output_has_no_whitespace() {
        let value = json!({"a": [1, {"b": null}], "c": true});
        assert_eq!(stringify(&value), r#"{"a":[1,{"b":null}],"c":true}"#);
    }

    #[test]
    fn array_index_keys_come_first_in_ascending_order_like_js_objects() {
        let mut map = Map::new();
        for (key, value) in [
            ("b", 1),
            ("2", 2),
            ("1", 3),
            ("01", 4),
            ("-1", 5),
            ("4294967294", 6),
            ("4294967295", 7),
            ("0", 8),
        ] {
            map.insert(key.to_string(), json!(value));
        }
        assert_eq!(
            stringify(&Value::Object(map)),
            r#"{"0":8,"1":3,"2":2,"4294967294":6,"b":1,"01":4,"-1":5,"4294967295":7}"#
        );
    }
}
