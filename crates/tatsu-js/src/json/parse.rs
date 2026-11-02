use std::fmt;

use serde_json::{Map, Number, Value};

use super::carrier::{push_char, push_lone_surrogate};

const MAX_DEPTH: usize = 512;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: &'static str,
    pub position: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at position {}", self.message, self.position)
    }
}

impl std::error::Error for ParseError {}

pub fn parse_lenient(text: &str) -> Result<Value, ParseError> {
    let mut parser = Parser { text, pos: 0 };
    parser.skip_whitespace();
    let value = parser.value(0)?;
    parser.skip_whitespace();
    if parser.pos != text.len() {
        return Err(parser.error("Unexpected non-whitespace character after JSON"));
    }
    Ok(value)
}

struct Parser<'a> {
    text: &'a str,
    pos: usize,
}

impl Parser<'_> {
    fn error(&self, message: &'static str) -> ParseError {
        ParseError {
            message,
            position: self.pos,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn unexpected(&self) -> ParseError {
        match self.peek() {
            None => self.error("Unexpected end of JSON input"),
            Some(_) => self.error("Unexpected token"),
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), ParseError> {
        if self.peek() != Some(byte) {
            return Err(self.unexpected());
        }
        self.pos += 1;
        Ok(())
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, ParseError> {
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Value::String),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.unexpected()),
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, ParseError> {
        if !self.text[self.pos..].starts_with(word) {
            return Err(self.error("Unexpected token"));
        }
        self.pos += word.len();
        Ok(value)
    }

    fn enter(&self, depth: usize) -> Result<usize, ParseError> {
        if depth >= MAX_DEPTH {
            return Err(self.error("Maximum nesting depth exceeded"));
        }
        Ok(depth + 1)
    }

    fn object(&mut self, depth: usize) -> Result<Value, ParseError> {
        let depth = self.enter(depth)?;
        self.pos += 1;
        let mut map = Map::new();
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(map));
        }
        loop {
            if self.peek() != Some(b'"') {
                return Err(self.unexpected());
            }
            let key = self.string()?;
            self.skip_whitespace();
            self.expect(b':')?;
            self.skip_whitespace();
            let value = self.value(depth)?;
            map.insert(key, value);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    self.skip_whitespace();
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Object(map));
                }
                _ => return Err(self.unexpected()),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, ParseError> {
        let depth = self.enter(depth)?;
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            items.push(self.value(depth)?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    self.skip_whitespace();
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(self.unexpected()),
            }
        }
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let Some(c) = self.text[self.pos..].chars().next() else {
                return Err(self.error("Unterminated string in JSON"));
            };
            match c {
                '"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                '\\' => {
                    self.pos += 1;
                    self.escape(&mut out)?;
                }
                c if c < ' ' => return Err(self.error("Bad control character in string literal")),
                c => {
                    self.pos += c.len_utf8();
                    push_char(&mut out, c);
                }
            }
        }
    }

    fn escape(&mut self, out: &mut String) -> Result<(), ParseError> {
        let short = match self.peek() {
            Some(b'"') => '"',
            Some(b'\\') => '\\',
            Some(b'/') => '/',
            Some(b'b') => '\u{8}',
            Some(b'f') => '\u{c}',
            Some(b'n') => '\n',
            Some(b'r') => '\r',
            Some(b't') => '\t',
            Some(b'u') => {
                self.pos += 1;
                let unit = self.hex4()?;
                self.code_unit(out, unit);
                return Ok(());
            }
            None => return Err(self.error("Unterminated string in JSON")),
            Some(_) => return Err(self.error("Bad escaped character in JSON")),
        };
        self.pos += 1;
        out.push(short);
        Ok(())
    }

    fn code_unit(&mut self, out: &mut String, unit: u16) {
        if (0xD800..=0xDBFF).contains(&unit)
            && let Some(low) = self.following_low_surrogate()
        {
            self.pos += 6;
            let scalar = 0x10000 + ((u32::from(unit) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
            out.push(char::from_u32(scalar).expect("surrogate pair forms a scalar value"));
            return;
        }
        match char::from_u32(u32::from(unit)) {
            Some(c) => push_char(out, c),
            None => push_lone_surrogate(out, unit),
        }
    }

    fn following_low_surrogate(&self) -> Option<u16> {
        let rest = self.text.as_bytes().get(self.pos..self.pos + 6)?;
        if &rest[..2] != b"\\u" {
            return None;
        }
        let unit = parse_hex4(&rest[2..])?;
        (0xDC00..=0xDFFF).contains(&unit).then_some(unit)
    }

    fn hex4(&mut self) -> Result<u16, ParseError> {
        let unit = self
            .text
            .as_bytes()
            .get(self.pos..self.pos + 4)
            .and_then(parse_hex4)
            .ok_or_else(|| self.error("Bad Unicode escape in JSON"))?;
        self.pos += 4;
        Ok(unit)
    }

    fn number(&mut self) -> Result<Value, ParseError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.error("No number after minus sign in JSON")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            self.required_digits("Unterminated fractional number in JSON")?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            self.required_digits("Exponent part is missing a number in JSON")?;
        }
        let parsed: f64 = self.text[start..self.pos]
            .parse()
            .expect("JSON number grammar is a subset of Rust float syntax");
        Ok(number_value(parsed))
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
    }

    fn required_digits(&mut self, message: &'static str) -> Result<(), ParseError> {
        if !matches!(self.peek(), Some(b'0'..=b'9')) {
            return Err(self.error(message));
        }
        self.digits();
        Ok(())
    }
}

fn parse_hex4(bytes: &[u8]) -> Option<u16> {
    let text = std::str::from_utf8(bytes).ok()?;
    if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(text, 16).ok()
}

fn number_value(parsed: f64) -> Value {
    if !parsed.is_finite() {
        return Value::Null;
    }
    let negative_zero = parsed == 0.0 && parsed.is_sign_negative();
    if parsed.fract() == 0.0 && parsed.abs() <= MAX_SAFE_INTEGER && !negative_zero {
        return Value::Number(Number::from(parsed as i64));
    }
    Number::from_f64(parsed).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use serde_json::json;

    use super::*;
    use crate::{stringify, stringify_pretty};

    proptest! {
        #[test]
        fn never_panics_on_arbitrary_text(text in any::<String>()) {
            let _ = parse_lenient(&text);
        }

        #[test]
        fn never_panics_on_truncated_documents(cut in 0usize..200) {
            let doc = "{\"a\":[1,-2.5e-3,\"\\ud800\\u00e9\u{FDD0}x\",{\"b\":null,\"c\":true}],\"d\":\"\\ud83d\\ude00\"}";
            let end = (0..=cut.min(doc.len())).rev().find(|i| doc.is_char_boundary(*i)).unwrap();
            let result = parse_lenient(&doc[..end]);
            prop_assert_eq!(result.is_ok(), end == doc.len());
        }
    }

    #[test]
    fn lone_surrogates_round_trip_alone_and_next_to_pairs() {
        let input = r#"["\ud800","\udfff","\ud800\udfff","\udfff\ud800","x\ud83d\ude00\ud83d","\ud800\ud800\udc00","\udbff\u0041"]"#;
        let value = parse_lenient(input).unwrap();
        let expected = r#"["\ud800","\udfff","𐏿","\udfff\ud800","x😀\ud83d","\ud800𐀀","\udbffA"]"#;
        assert_eq!(stringify(&value), expected);
    }

    #[test]
    fn lone_surrogates_in_keys_round_trip() {
        let input = "{\n  \"\\udc00k\": \"v\"\n}";
        assert_eq!(stringify_pretty(&parse_lenient(input).unwrap()), input);
    }

    #[test]
    fn literal_marker_text_in_input_survives_unchanged() {
        let input = "[\"\u{FDD0}\u{F0000}\",\"\u{FDD0}\",\"\\ufdd0\\udbff\"]";
        assert_eq!(
            stringify(&parse_lenient(input).unwrap()),
            "[\"\u{FDD0}\u{F0000}\",\"\u{FDD0}\",\"\u{FDD0}\\udbff\"]"
        );
    }

    #[test]
    fn whole_numbers_are_integers_so_loaders_can_read_them() {
        let value = parse_lenient(r#"{"schemaVersion":9,"n":-3,"big":1e3}"#).unwrap();
        assert_eq!(value["schemaVersion"].as_u64(), Some(9));
        assert_eq!(value["n"].as_i64(), Some(-3));
        assert_eq!(value["big"].as_u64(), Some(1000));
    }

    #[test]
    fn numbers_follow_js_parsing() {
        let value = parse_lenient("[1e400,-1e400,-0,12345678901234567890,0.1,1E+2]").unwrap();
        assert_eq!(
            stringify(&value),
            "[null,null,0,12345678901234567000,0.1,100]"
        );
    }

    #[test]
    fn duplicate_keys_keep_first_position_and_last_value() {
        let value = parse_lenient(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(stringify(&value), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn json_whitespace_and_escapes_are_accepted() {
        let value =
            parse_lenient(" \t\r\n{ \"a\" : [ 1 , \"\\/\\\"\\\\\\b\\f\\n\\r\\t\\u00E9\" ] } \n")
                .unwrap();
        assert_eq!(value, json!({"a": [1, "/\"\\\u{8}\u{c}\n\r\té"]}));
    }

    #[test]
    fn text_json_parse_rejects_is_rejected() {
        for text in [
            "",
            " ",
            "\u{feff}1",
            "\u{a0}1",
            "01",
            "+1",
            ".5",
            "1.",
            "1e",
            "-",
            "[1,]",
            "{\"a\":1,}",
            "{a:1}",
            "'a'",
            "\"\\x\"",
            "\"\\u12\"",
            "\"\\u12G4\"",
            "\"a",
            "\"\u{1}\"",
            "tru",
            "nul",
            "[1 2]",
            "{\"a\" 1}",
            "1 2",
            "NaN",
            "Infinity",
            "[",
            "{\"a\":",
        ] {
            assert!(parse_lenient(text).is_err(), "accepted {text:?}");
        }
    }

    #[test]
    fn deep_nesting_is_an_error_not_a_stack_overflow() {
        let deep = "[".repeat(100_000);
        assert_eq!(
            parse_lenient(&deep).unwrap_err().message,
            "Maximum nesting depth exceeded"
        );
        let ok = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse_lenient(&ok).is_ok());
    }

    #[test]
    fn errors_report_the_byte_position() {
        let error = parse_lenient("[1,]").unwrap_err();
        assert_eq!(error.position, 3);
        assert_eq!(error.to_string(), "Unexpected token at position 3");
    }
}
