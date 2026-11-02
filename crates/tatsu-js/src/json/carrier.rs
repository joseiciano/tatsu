const MARKER: char = '\u{FDD0}';
const PAYLOAD_BASE: u32 = 0xF0000;
const SURROGATE_FIRST: u16 = 0xD800;
const SURROGATE_LAST: u16 = 0xDFFF;

pub(super) fn push_char(out: &mut String, c: char) {
    if c == MARKER {
        out.push(MARKER);
    }
    out.push(c);
}

pub(super) fn push_lone_surrogate(out: &mut String, unit: u16) {
    debug_assert!((SURROGATE_FIRST..=SURROGATE_LAST).contains(&unit));
    out.push(MARKER);
    out.push(
        char::from_u32(PAYLOAD_BASE + u32::from(unit - SURROGATE_FIRST))
            .expect("payload range is valid scalar values"),
    );
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Unit {
    Char(char),
    LoneSurrogate(u16),
}

pub(super) fn decode(s: &str) -> impl Iterator<Item = Unit> + '_ {
    let mut chars = s.chars().peekable();
    std::iter::from_fn(move || {
        let c = chars.next()?;
        if c != MARKER {
            return Some(Unit::Char(c));
        }
        match chars.peek().copied() {
            Some(MARKER) => {
                chars.next();
                Some(Unit::Char(MARKER))
            }
            Some(next) => match surrogate_from_payload(next) {
                Some(unit) => {
                    chars.next();
                    Some(Unit::LoneSurrogate(unit))
                }
                None => Some(Unit::Char(MARKER)),
            },
            None => Some(Unit::Char(MARKER)),
        }
    })
}

fn surrogate_from_payload(c: char) -> Option<u16> {
    let offset = u32::from(c).checked_sub(PAYLOAD_BASE)?;
    let span = u32::from(SURROGATE_LAST - SURROGATE_FIRST);
    (offset <= span).then(|| SURROGATE_FIRST + offset as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(units: &[Unit]) -> String {
        let mut out = String::new();
        for unit in units {
            match unit {
                Unit::Char(c) => push_char(&mut out, *c),
                Unit::LoneSurrogate(u) => push_lone_surrogate(&mut out, *u),
            }
        }
        out
    }

    #[test]
    fn carrier_round_trips_lone_surrogates_and_literal_markers() {
        let units = vec![
            Unit::Char('a'),
            Unit::LoneSurrogate(0xD800),
            Unit::Char(MARKER),
            Unit::LoneSurrogate(0xDFFF),
            Unit::Char(MARKER),
            Unit::Char('\u{F0000}'),
            Unit::Char(MARKER),
        ];
        assert_eq!(decode(&encode(&units)).collect::<Vec<_>>(), units);
    }

    #[test]
    fn carrier_bare_marker_from_rust_code_decodes_as_itself() {
        let s = format!("{MARKER}x{MARKER}");
        assert_eq!(
            decode(&s).collect::<Vec<_>>(),
            vec![Unit::Char(MARKER), Unit::Char('x'), Unit::Char(MARKER)]
        );
    }
}
