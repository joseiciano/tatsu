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

#[cfg(test)]
mod tests {
    use super::trim;

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
