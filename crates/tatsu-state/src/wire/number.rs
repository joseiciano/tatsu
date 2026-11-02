use serde::Serializer;

const TWO_POW_53: f64 = 9_007_199_254_740_992.0;

pub fn serialize<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    let value = *value;
    if !value.is_finite() {
        serializer.serialize_unit()
    } else if value.fract() == 0.0 && value.abs() <= TWO_POW_53 {
        serializer.serialize_i64(value as i64)
    } else {
        serializer.serialize_f64(value)
    }
}

pub mod option {
    use serde::Serializer;

    pub fn serialize<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => super::serialize(value, serializer),
            None => serializer.serialize_none(),
        }
    }
}

pub mod map {
    use indexmap::IndexMap;
    use serde::{Serializer, ser::SerializeMap};

    pub fn serialize<S: Serializer>(
        value: &IndexMap<String, f64>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(value.len()))?;
        for (key, value) in value {
            map.serialize_key(key)?;
            map.serialize_value(&super::Js(*value))?;
        }
        map.end()
    }
}

struct Js(f64);

impl serde::Serialize for Js {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize(&self.0, serializer)
    }
}

#[cfg(test)]
mod tests {
    use serde::Serialize;

    #[derive(Serialize)]
    struct Js(#[serde(serialize_with = "super::serialize")] f64);

    fn js(value: f64) -> String {
        serde_json::to_string(&Js(value)).unwrap()
    }

    #[test]
    fn whole_numbers_are_written_like_json_stringify() {
        assert_eq!(js(100.0), "100");
        assert_eq!(js(-42.0), "-42");
        assert_eq!(js(0.0), "0");
        assert_eq!(js(9_007_199_254_740_991.0), "9007199254740991");
        assert_eq!(js(-9_007_199_254_740_991.0), "-9007199254740991");
        assert_eq!(js(-9_007_199_254_740_992.0), "-9007199254740992");
    }

    #[test]
    fn negative_zero_is_written_as_zero() {
        assert_eq!(js(-0.0), "0");
    }

    #[test]
    fn fractions_stay_floats() {
        assert_eq!(js(2.5), "2.5");
        assert_eq!(js(0.1), "0.1");
    }

    #[test]
    fn non_finite_values_are_written_as_null() {
        assert_eq!(js(f64::NAN), "null");
        assert_eq!(js(f64::INFINITY), "null");
        assert_eq!(js(f64::NEG_INFINITY), "null");
    }

    #[test]
    fn whole_numbers_past_two_pow_53_stay_floats() {
        assert_eq!(js(9_007_199_254_740_992.0), "9007199254740992");
        assert_eq!(js(18_014_398_509_481_984.0), "1.8014398509481984e+16");
    }

    #[derive(Serialize)]
    struct JsOption(#[serde(serialize_with = "super::option::serialize")] Option<f64>);

    #[test]
    fn options_write_none_as_null_and_values_like_json_stringify() {
        let js_option = |value| serde_json::to_string(&JsOption(value)).unwrap();
        assert_eq!(js_option(None), "null");
        assert_eq!(js_option(Some(1_717_000_000_000.0)), "1717000000000");
        assert_eq!(js_option(Some(2.5)), "2.5");
    }

    #[derive(Serialize)]
    struct JsMap(
        #[serde(serialize_with = "super::map::serialize")] indexmap::IndexMap<String, f64>,
    );

    #[test]
    fn map_values_are_written_like_json_stringify_in_insert_order() {
        let map = [("b", 1.0), ("a", 0.25)]
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect();
        assert_eq!(
            serde_json::to_string(&JsMap(map)).unwrap(),
            r#"{"b":1,"a":0.25}"#
        );
    }
}
