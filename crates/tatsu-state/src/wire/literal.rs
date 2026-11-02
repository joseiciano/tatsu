use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
use specta::{Type, Types, datatype::DataType};

macro_rules! bool_literal {
    ($name:ident, $value:literal, $ts:literal) => {
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
        pub struct $name;

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_bool($value)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                if bool::deserialize(deserializer)? == $value {
                    Ok($name)
                } else {
                    Err(D::Error::custom(concat!("expected `", $ts, "`")))
                }
            }
        }

        impl Type for $name {
            fn definition(_: &mut Types) -> DataType {
                DataType::Reference(specta_typescript::define($ts))
            }
        }
    };
}

bool_literal!(True, true, "true");
bool_literal!(False, false, "false");

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn false_accepts_and_writes_only_false() {
        assert_eq!(serde_json::to_value(False).unwrap(), json!(false));
        assert!(serde_json::from_value::<False>(json!(false)).is_ok());
        assert!(serde_json::from_value::<False>(json!(true)).is_err());
        assert!(serde_json::from_value::<False>(json!(0)).is_err());
    }

    #[test]
    fn true_accepts_and_writes_only_true() {
        assert_eq!(serde_json::to_value(True).unwrap(), json!(true));
        assert!(serde_json::from_value::<True>(json!(true)).is_ok());
        assert!(serde_json::from_value::<True>(json!(false)).is_err());
    }
}
