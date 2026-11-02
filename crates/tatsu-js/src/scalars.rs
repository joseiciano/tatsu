use serde_json::Value;

use crate::json::carrier::{Unit, decode};
use crate::number_to_string;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UriError;

impl std::fmt::Display for UriError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("URI malformed")
    }
}

impl std::error::Error for UriError {}

pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(s),
        Value::Array(_) => string_to_number(&to_js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub fn to_js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

pub fn utf16_len(s: &str) -> usize {
    decode(s)
        .map(|unit| match unit {
            Unit::Char(c) => c.len_utf16(),
            Unit::LoneSurrogate(_) => 1,
        })
        .sum()
}

pub fn encode_uri_component(s: &str) -> Result<String, UriError> {
    let mut out = String::with_capacity(s.len());
    let mut buf = [0u8; 4];
    for unit in decode(s) {
        let c = match unit {
            Unit::Char(c) => c,
            Unit::LoneSurrogate(_) => return Err(UriError),
        };
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            for byte in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    Ok(out)
}

pub fn parse_int(s: &str, radix: u32) -> f64 {
    let s = s.trim_start_matches(is_js_whitespace);
    let (negative, s) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let (mut radix, mut strip_prefix) = (radix, true);
    if radix != 0 {
        if !(2..=36).contains(&radix) {
            return f64::NAN;
        }
        strip_prefix = radix == 16;
    } else {
        radix = 10;
    }
    let s = match s.get(..2) {
        Some("0x" | "0X") if strip_prefix => {
            radix = 16;
            &s[2..]
        }
        _ => s,
    };
    let end = s.find(|c: char| !c.is_digit(radix)).unwrap_or(s.len());
    let digits = &s[..end];
    if digits.is_empty() {
        return f64::NAN;
    }
    let magnitude = digits_to_f64(digits, radix);
    if negative { -magnitude } else { magnitude }
}

pub fn to_fixed(x: f64, digits: u32) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.abs() >= 1e21 {
        return number_to_string(x);
    }
    let exact = format!("{:.1100}", x.abs());
    let (int_part, frac_part) = exact.split_once('.').expect("precision adds a point");
    let keep = digits as usize;
    let mut kept: Vec<u8> = int_part
        .bytes()
        .chain(frac_part.bytes().take(keep))
        .collect();
    if frac_part.as_bytes()[keep] >= b'5' {
        round_up(&mut kept);
    }
    let int_len = kept.len() - keep;
    let mut out = String::new();
    if x < 0.0 {
        out.push('-');
    }
    out.push_str(std::str::from_utf8(&kept[..int_len]).expect("ascii digits"));
    if keep > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(&kept[int_len..]).expect("ascii digits"));
    }
    out
}

fn round_up(digits: &mut Vec<u8>) {
    for d in digits.iter_mut().rev() {
        if *d == b'9' {
            *d = b'0';
        } else {
            *d += 1;
            return;
        }
    }
    digits.insert(0, b'1');
}

fn string_to_number(s: &str) -> f64 {
    let s = trim(s);
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some(radix) = match s.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    } {
        let digits = &s[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return digits_to_f64(digits, radix);
    }
    if is_decimal_literal(s) {
        s.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

fn is_decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let count_digits = |i: &mut usize| {
        let start = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i - start
    };
    let mut mantissa = count_digits(&mut i);
    if b.get(i) == Some(&b'.') {
        i += 1;
        mantissa += count_digits(&mut i);
    }
    if mantissa == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if count_digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

fn digits_to_f64(digits: &str, radix: u32) -> f64 {
    match radix {
        10 => digits.parse().unwrap_or(f64::NAN),
        2 | 4 | 8 | 16 | 32 => power_of_two_to_f64(digits, radix.trailing_zeros()),
        _ => generic_radix_to_f64(digits, radix),
    }
}

fn power_of_two_to_f64(digits: &str, bits_per_digit: u32) -> f64 {
    let mut bits = Vec::with_capacity(digits.len() * bits_per_digit as usize);
    for c in digits.chars() {
        let d = c.to_digit(1 << bits_per_digit).expect("validated digit");
        for shift in (0..bits_per_digit).rev() {
            bits.push((d >> shift) & 1 == 1);
        }
    }
    let first_one = bits.iter().position(|&b| b).unwrap_or(bits.len());
    let bits = &bits[first_one..];
    if bits.len() <= 53 {
        return bits.iter().fold(0u64, |acc, &b| (acc << 1) | u64::from(b)) as f64;
    }
    let mut mantissa = bits[..53]
        .iter()
        .fold(0u64, |acc, &b| (acc << 1) | u64::from(b));
    let round = bits[53];
    let sticky = bits[54..].iter().any(|&b| b);
    if round && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let exponent = (bits.len() - 53) as i32;
    mantissa as f64 * 2f64.powi(exponent)
}

fn generic_radix_to_f64(digits: &str, radix: u32) -> f64 {
    const MAXIMUM_MULTIPLIER: u32 = u32::MAX / 36;
    let digits: Vec<u32> = digits
        .trim_start_matches('0')
        .chars()
        .map(|c| c.to_digit(radix).expect("validated digit"))
        .collect();
    let mut result = 0.0f64;
    let mut i = 0;
    while i < digits.len() {
        let (mut part, mut multiplier) = (0u32, 1u32);
        while i < digits.len() {
            let m = multiplier * radix;
            if m > MAXIMUM_MULTIPLIER {
                break;
            }
            part = part * radix + digits[i];
            multiplier = m;
            i += 1;
        }
        result = fold_part(result, multiplier, part);
    }
    result
}

// V8 is built with clang, which contracts `result * multiplier + part` into one
// fused multiply-add on aarch64 but not on x86_64.
#[cfg(target_arch = "aarch64")]
fn fold_part(result: f64, multiplier: u32, part: u32) -> f64 {
    result.mul_add(f64::from(multiplier), f64::from(part))
}

#[cfg(not(target_arch = "aarch64"))]
fn fold_part(result: f64, multiplier: u32, part: u32) -> f64 {
    result * f64::from(multiplier) + f64::from(part)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn same(a: f64, b: f64) -> bool {
        (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
    }

    #[test]
    fn number_follows_js_coercion() {
        assert!(same(to_number(&json!("")), 0.0));
        assert!(same(to_number(&json!("  ")), 0.0));
        assert!(same(to_number(&json!(" 12 ")), 12.0));
        assert!(same(to_number(&json!([5])), 5.0));
        assert!(same(to_number(&json!([])), 0.0));
        assert!(same(to_number(&json!([null])), 0.0));
        assert!(to_number(&json!([1, 2])).is_nan());
        assert!(to_number(&json!({})).is_nan());
        assert!(same(to_number(&json!(true)), 1.0));
        assert!(same(to_number(&json!(false)), 0.0));
        assert!(same(to_number(&json!(null)), 0.0));
    }

    #[test]
    fn number_string_grammar_matches_js() {
        assert!(to_number(&json!("1_000")).is_nan());
        assert!(same(to_number(&json!("0b11")), 3.0));
        assert!(same(to_number(&json!("0O17")), 15.0));
        assert!(same(to_number(&json!("0x1f")), 31.0));
        assert!(to_number(&json!("-0x1f")).is_nan());
        assert!(to_number(&json!("0x")).is_nan());
        assert!(same(to_number(&json!("-Infinity")), f64::NEG_INFINITY));
        assert!(same(to_number(&json!("+Infinity")), f64::INFINITY));
        assert!(to_number(&json!("infinity")).is_nan());
        assert!(to_number(&json!("inf")).is_nan());
        assert!(to_number(&json!("NaN")).is_nan());
        assert!(same(to_number(&json!(".5")), 0.5));
        assert!(same(to_number(&json!("5.")), 5.0));
        assert!(same(to_number(&json!("-0")), -0.0));
        assert!(same(to_number(&json!("1e3")), 1000.0));
        assert!(to_number(&json!(".")).is_nan());
        assert!(to_number(&json!("1e")).is_nan());
        assert!(to_number(&json!("e5")).is_nan());
        assert!(to_number(&json!("\u{0085}1")).is_nan());
        assert!(same(to_number(&json!("\u{FEFF}7\u{3000}")), 7.0));
    }

    #[test]
    fn truthiness_matches_js() {
        assert!(!truthy(&json!(null)));
        assert!(!truthy(&json!(0)));
        assert!(!truthy(&json!(-0.0)));
        assert!(!truthy(&json!("")));
        assert!(!truthy(&json!(false)));
        assert!(truthy(&json!(" ")));
        assert!(truthy(&json!("0")));
        assert!(truthy(&json!([])));
        assert!(truthy(&json!({})));
        assert!(truthy(&json!(0.1)));
    }

    #[test]
    fn js_string_matches_string_constructor() {
        assert_eq!(to_js_string(&json!(null)), "null");
        assert_eq!(to_js_string(&json!(1e21)), "1e+21");
        assert_eq!(to_js_string(&json!(-0.0)), "0");
        assert_eq!(
            to_js_string(&json!([1, null, [2, [3]], {}])),
            "1,,2,3,[object Object]"
        );
        assert_eq!(to_js_string(&json!({"a": 1})), "[object Object]");
    }

    #[test]
    fn parse_int_matches_js() {
        assert!(same(parse_int("08", 0), 8.0));
        assert!(same(parse_int("0x1f", 0), 31.0));
        assert!(same(parse_int("0x1f", 16), 31.0));
        assert!(same(parse_int("0x1f", 10), 0.0));
        assert!(same(parse_int("  -12px", 0), -12.0));
        assert!(same(parse_int("-0", 0), -0.0));
        assert!(same(parse_int("z", 36), 35.0));
        assert!(same(parse_int("1e3", 0), 1.0));
        assert!(parse_int("", 0).is_nan());
        assert!(parse_int("0x", 0).is_nan());
        assert!(parse_int("12", 1).is_nan());
        assert!(parse_int("12", 37).is_nan());
    }

    #[test]
    fn encode_uri_component_matches_js() {
        assert_eq!(
            encode_uri_component("a b&c=d/e?f#g").unwrap(),
            "a%20b%26c%3Dd%2Fe%3Ff%23g"
        );
        assert_eq!(encode_uri_component("-_.!~*'()").unwrap(), "-_.!~*'()");
        assert_eq!(
            encode_uri_component("é€😀").unwrap(),
            "%C3%A9%E2%82%AC%F0%9F%98%80"
        );
    }

    #[test]
    fn utf16_len_counts_code_units() {
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(utf16_len("aé"), 2);
        assert_eq!(utf16_len(""), 0);
    }

    #[test]
    fn to_fixed_rounds_on_the_exact_decimal_value() {
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(0.000001, 2), "0.00");
        assert_eq!(to_fixed(0.000001, 7), "0.0000010");
        assert_eq!(to_fixed(-1.5, 0), "-2");
        assert_eq!(to_fixed(-0.0001, 2), "-0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(99.5, 0), "100");
        assert_eq!(to_fixed(1e21, 2), "1e+21");
        assert_eq!(to_fixed(f64::NAN, 2), "NaN");
    }
}
