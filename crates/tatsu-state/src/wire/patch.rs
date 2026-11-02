use serde::{Deserialize, Deserializer, Serialize, Serializer};
use specta::{Type, Types, datatype::DataType};

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Patch<T> {
    #[default]
    Unchanged,
    Cleared,
    Set(T),
}

impl<T> Patch<T> {
    pub fn is_absent(&self) -> bool {
        !matches!(self, Patch::Set(_))
    }

    pub fn apply_to(self, target: &mut Option<T>) {
        match self {
            Patch::Unchanged => {}
            Patch::Cleared => *target = None,
            Patch::Set(value) => *target = Some(value),
        }
    }

    pub fn apply_to_required(self, target: &mut T) {
        if let Patch::Set(value) = self {
            *target = value;
        }
    }
}

impl<T: Serialize> Serialize for Patch<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Patch::Set(value) => value.serialize(serializer),
            Patch::Unchanged | Patch::Cleared => serializer.serialize_none(),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Patch::Set)
    }
}

impl<T: Type> Type for Patch<T> {
    fn definition(types: &mut Types) -> DataType {
        T::definition(types)
    }
}
