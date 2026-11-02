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
}
