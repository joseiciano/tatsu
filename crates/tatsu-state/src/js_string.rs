use std::cmp::Ordering;

fn is_js_trimmed(c: char) -> bool {
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

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_js_trimmed)
}

pub(crate) fn compare(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::{compare, trim};

    #[test]
    fn compares_utf16_code_units_not_code_points() {
        assert_eq!(compare("\u{FF5E}", "\u{1F600}"), Ordering::Greater);
        assert!("\u{FF5E}" < "\u{1F600}");
        assert_eq!(compare("a\u{10000}", "a\u{FFFF}"), Ordering::Less);
    }

    #[test]
    fn compares_like_js_less_than_for_prefixes_and_equal_strings() {
        assert_eq!(compare("ab", "abc"), Ordering::Less);
        assert_eq!(compare("b", "abc"), Ordering::Greater);
        assert_eq!(compare("\u{1F600}", "\u{1F600}"), Ordering::Equal);
        assert_eq!(compare("", ""), Ordering::Equal);
    }

    #[test]
    fn trims_the_byte_order_mark_like_js() {
        assert_eq!(trim("\u{FEFF}tab\u{FEFF}"), "tab");
        assert_eq!(trim("\u{FEFF}"), "");
    }

    #[test]
    fn keeps_next_line_like_js() {
        assert_eq!(trim("\u{0085}tab\u{0085}"), "\u{0085}tab\u{0085}");
        assert_eq!(trim("\u{0085}"), "\u{0085}");
    }

    #[test]
    fn trims_ascii_space_separators_and_line_terminators() {
        assert_eq!(
            trim(
                " \t\n\r\u{000B}\u{000C}\u{00A0}\u{1680}\u{2000}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}x y\u{3000} "
            ),
            "x y"
        );
    }

    #[test]
    fn keeps_zero_width_and_mongolian_vowel_separator() {
        assert_eq!(trim("\u{200B}x\u{180E}"), "\u{200B}x\u{180E}");
    }
}
