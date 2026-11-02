use std::fmt;

use serde::ser::{self, Impossible, Serialize, SerializeStruct, Serializer};

const TAG: &str = "type";

pub(crate) fn event_type<E: Serialize>(event: &E) -> &'static str {
    match event.serialize(TypeCapture) {
        Ok(name) => name,
        Err(NotAnEvent) => unreachable!("slice events are adjacently tagged with `{TAG}`"),
    }
}

#[derive(Debug)]
struct NotAnEvent;

impl fmt::Display for NotAnEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not an adjacently tagged event")
    }
}

impl std::error::Error for NotAnEvent {}

impl ser::Error for NotAnEvent {
    fn custom<T: fmt::Display>(_: T) -> Self {
        NotAnEvent
    }
}

struct TypeCapture;

struct TagCapture(Option<&'static str>);

struct VariantName;

macro_rules! reject {
    ($($method:ident($($arg:ty),*) -> $ok:ty;)*) => {
        $(fn $method(self, $(_: $arg),*) -> Result<$ok, NotAnEvent> {
            Err(NotAnEvent)
        })*
    };
}

macro_rules! reject_all_but_struct_and_unit_variant {
    () => {
        reject! {
            serialize_bool(bool) -> Self::Ok;
            serialize_i8(i8) -> Self::Ok;
            serialize_i16(i16) -> Self::Ok;
            serialize_i32(i32) -> Self::Ok;
            serialize_i64(i64) -> Self::Ok;
            serialize_u8(u8) -> Self::Ok;
            serialize_u16(u16) -> Self::Ok;
            serialize_u32(u32) -> Self::Ok;
            serialize_u64(u64) -> Self::Ok;
            serialize_f32(f32) -> Self::Ok;
            serialize_f64(f64) -> Self::Ok;
            serialize_char(char) -> Self::Ok;
            serialize_str(&str) -> Self::Ok;
            serialize_bytes(&[u8]) -> Self::Ok;
            serialize_none() -> Self::Ok;
            serialize_unit() -> Self::Ok;
            serialize_unit_struct(&'static str) -> Self::Ok;
            serialize_seq(Option<usize>) -> Self::SerializeSeq;
            serialize_tuple(usize) -> Self::SerializeTuple;
            serialize_tuple_struct(&'static str, usize) -> Self::SerializeTupleStruct;
            serialize_tuple_variant(&'static str, u32, &'static str, usize) -> Self::SerializeTupleVariant;
            serialize_map(Option<usize>) -> Self::SerializeMap;
            serialize_struct_variant(&'static str, u32, &'static str, usize) -> Self::SerializeStructVariant;
        }

        fn serialize_some<T: ?Sized + Serialize>(self, _: &T) -> Result<Self::Ok, NotAnEvent> {
            Err(NotAnEvent)
        }

        fn serialize_newtype_struct<T: ?Sized + Serialize>(
            self,
            _: &'static str,
            _: &T,
        ) -> Result<Self::Ok, NotAnEvent> {
            Err(NotAnEvent)
        }

        fn serialize_newtype_variant<T: ?Sized + Serialize>(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: &T,
        ) -> Result<Self::Ok, NotAnEvent> {
            Err(NotAnEvent)
        }
    };
}

impl Serializer for TypeCapture {
    type Ok = &'static str;
    type Error = NotAnEvent;
    type SerializeSeq = Impossible<Self::Ok, NotAnEvent>;
    type SerializeTuple = Impossible<Self::Ok, NotAnEvent>;
    type SerializeTupleStruct = Impossible<Self::Ok, NotAnEvent>;
    type SerializeTupleVariant = Impossible<Self::Ok, NotAnEvent>;
    type SerializeMap = Impossible<Self::Ok, NotAnEvent>;
    type SerializeStruct = TagCapture;
    type SerializeStructVariant = Impossible<Self::Ok, NotAnEvent>;

    reject_all_but_struct_and_unit_variant!();

    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
    ) -> Result<Self::Ok, NotAnEvent> {
        Err(NotAnEvent)
    }

    fn serialize_struct(self, _: &'static str, _: usize) -> Result<TagCapture, NotAnEvent> {
        Ok(TagCapture(None))
    }
}

impl SerializeStruct for TagCapture {
    type Ok = &'static str;
    type Error = NotAnEvent;

    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), NotAnEvent> {
        if key == TAG {
            self.0 = Some(value.serialize(VariantName)?);
        }
        Ok(())
    }

    fn end(self) -> Result<&'static str, NotAnEvent> {
        self.0.ok_or(NotAnEvent)
    }
}

impl Serializer for VariantName {
    type Ok = &'static str;
    type Error = NotAnEvent;
    type SerializeSeq = Impossible<Self::Ok, NotAnEvent>;
    type SerializeTuple = Impossible<Self::Ok, NotAnEvent>;
    type SerializeTupleStruct = Impossible<Self::Ok, NotAnEvent>;
    type SerializeTupleVariant = Impossible<Self::Ok, NotAnEvent>;
    type SerializeMap = Impossible<Self::Ok, NotAnEvent>;
    type SerializeStruct = Impossible<Self::Ok, NotAnEvent>;
    type SerializeStructVariant = Impossible<Self::Ok, NotAnEvent>;

    reject_all_but_struct_and_unit_variant!();

    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
    ) -> Result<Self::Ok, NotAnEvent> {
        Ok(variant)
    }

    fn serialize_struct(
        self,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeStruct, NotAnEvent> {
        Err(NotAnEvent)
    }
}
