use serde::{Deserialize, Deserializer};

pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Probe {
        #[serde(
            default,
            deserialize_with = "super::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        value: Option<Option<String>>,
    }

    #[test]
    fn absent_null_and_present_round_trip_as_three_states() {
        for (input, value) in [
            (json!({}), None),
            (json!({ "value": null }), Some(None)),
            (json!({ "value": "x" }), Some(Some("x".to_string()))),
        ] {
            let probe: Probe = serde_json::from_value(input.clone()).unwrap();
            assert_eq!(probe.value, value);
            assert_eq!(serde_json::to_value(&probe).unwrap(), input);
        }
    }
}
