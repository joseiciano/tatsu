use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;
use time::macros::format_description;
use time::{OffsetDateTime, UtcOffset};

pub(crate) fn iso(at: OffsetDateTime) -> String {
    at.to_offset(UtcOffset::UTC)
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .unwrap_or_default()
}

fn stamp(at: OffsetDateTime) -> String {
    at.to_offset(UtcOffset::UTC)
        .format(format_description!(
            "[hour]:[minute]:[second].[subsecond digits:3]"
        ))
        .unwrap_or_default()
}

pub(crate) fn data_suffix<T: Serialize + ?Sized>(data: &T) -> String {
    match serde_json::to_value(data) {
        Ok(value) => format!(" {}", tatsu_js::stringify(&value)),
        Err(_) => " [unserializable]".to_string(),
    }
}

pub(crate) fn line(at: OffsetDateTime, category: &str, message: &str, suffix: &str) -> String {
    format!("[{}] [{category}] {message}{suffix}", stamp(at))
}

pub(crate) fn line_now(category: &str, message: &str, suffix: &str) -> String {
    line(OffsetDateTime::now_utc(), category, message, suffix)
}

pub(crate) fn append(path: &Path, text: &str) -> io::Result<()> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(text.as_bytes())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde::Serializer;
    use serde_json::json;
    use time::macros::datetime;

    pub(crate) struct Unserializable;

    impl Serialize for Unserializable {
        fn serialize<S: Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("cycle"))
        }
    }

    #[test]
    fn stamps_are_utc_with_millisecond_precision() {
        let at = datetime!(2026-03-04 23:05:06.789_123 -05:00);

        assert_eq!(iso(at), "2026-03-05T04:05:06.789Z");
        assert_eq!(line(at, "boot", "hi", ""), "[04:05:06.789] [boot] hi");
    }

    #[test]
    fn iso_pads_whole_seconds_to_three_digits() {
        assert_eq!(
            iso(datetime!(2026-01-02 03:04:05 UTC)),
            "2026-01-02T03:04:05.000Z"
        );
    }

    #[test]
    fn data_is_compact_js_json() {
        let data = json!({"b": 1.0, "a": [true, null, "x\"y"], "n": 1.5e21});

        assert_eq!(
            data_suffix(&data),
            r#" {"b":1,"a":[true,null,"x\"y"],"n":1.5e+21}"#
        );
    }

    #[test]
    fn serialize_error_writes_unserializable() {
        assert_eq!(data_suffix(&Unserializable), " [unserializable]");
    }
}
