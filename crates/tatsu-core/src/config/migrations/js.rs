use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Map, Number, Value};

use super::MigrationError;

#[derive(Clone)]
pub(crate) enum Js {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Rc<RefCell<Vec<Js>>>),
    Object(Rc<RefCell<JsObject>>),
}

#[derive(Default)]
pub(crate) struct JsObject(Vec<(String, Js)>);

impl JsObject {
    pub(crate) fn get(&self, key: &str) -> Option<&Js> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub(crate) fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub(crate) fn insert(&mut self, key: impl Into<String>, value: Js) {
        let key = key.into();
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some((_, slot)) => *slot = value,
            None => self.0.push((key, value)),
        }
    }

    pub(crate) fn shift_remove(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn ordered(&self) -> Vec<(String, Js)> {
        let mut indexed = Vec::new();
        let mut named = Vec::with_capacity(self.0.len());
        for (key, value) in &self.0 {
            match array_index(key) {
                Some(index) => indexed.push((index, key.clone(), value.clone())),
                None => named.push((key.clone(), value.clone())),
            }
        }
        indexed.sort_unstable_by_key(|(index, _, _)| *index);
        indexed
            .into_iter()
            .map(|(_, key, value)| (key, value))
            .chain(named)
            .collect()
    }

    pub(crate) fn from_map(map: Map<String, Value>) -> Self {
        Self(
            map.into_iter()
                .map(|(k, v)| (k, Js::from_value(v)))
                .collect(),
        )
    }

    pub(crate) fn to_map(&self) -> Map<String, Value> {
        self.0
            .iter()
            .map(|(k, v)| (k.clone(), v.to_value()))
            .collect()
    }
}

impl Js {
    pub(crate) fn from_value(value: Value) -> Self {
        match value {
            Value::Null => Js::Null,
            Value::Bool(b) => Js::Bool(b),
            Value::Number(n) => Js::Number(n),
            Value::String(s) => Js::String(s),
            Value::Array(items) => Js::array(items.into_iter().map(Js::from_value).collect()),
            Value::Object(map) => Js::Object(Rc::new(RefCell::new(JsObject::from_map(map)))),
        }
    }

    pub(crate) fn to_value(&self) -> Value {
        match self {
            Js::Null => Value::Null,
            Js::Bool(b) => Value::Bool(*b),
            Js::Number(n) => Value::Number(n.clone()),
            Js::String(s) => Value::String(s.clone()),
            Js::Array(items) => Value::Array(items.borrow().iter().map(Js::to_value).collect()),
            Js::Object(map) => Value::Object(map.borrow().to_map()),
        }
    }

    pub(crate) fn array(items: Vec<Js>) -> Self {
        Js::Array(Rc::new(RefCell::new(items)))
    }

    pub(crate) fn object(object: JsObject) -> Self {
        Js::Object(Rc::new(RefCell::new(object)))
    }

    pub(crate) fn str(s: impl Into<String>) -> Self {
        Js::String(s.into())
    }

    pub(crate) fn truthy(&self) -> bool {
        match self {
            Js::Null => false,
            Js::Bool(b) => *b,
            Js::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
            Js::String(s) => !s.is_empty(),
            Js::Array(_) | Js::Object(_) => true,
        }
    }

    pub(crate) fn is_object(&self) -> bool {
        matches!(self, Js::Array(_) | Js::Object(_))
    }

    pub(crate) fn is_str(&self, expected: &str) -> bool {
        matches!(self, Js::String(s) if s == expected)
    }

    pub(crate) fn has_own(&self, key: &str) -> bool {
        matches!(self, Js::Object(map) if map.borrow().contains_key(key))
    }

    pub(crate) fn entries(&self) -> Result<Vec<(String, Js)>, MigrationError> {
        Ok(match self {
            Js::Null => return Err(MigrationError("Object.entries on null")),
            Js::Object(map) => map.borrow().ordered(),
            Js::Array(items) => items
                .borrow()
                .iter()
                .enumerate()
                .map(|(i, item)| (i.to_string(), item.clone()))
                .collect(),
            Js::String(s) => s
                .chars()
                .enumerate()
                .map(|(i, c)| (i.to_string(), Js::String(c.to_string())))
                .collect(),
            Js::Bool(_) | Js::Number(_) => Vec::new(),
        })
    }

    pub(crate) fn values(&self) -> Vec<Js> {
        self.entries()
            .unwrap_or_default()
            .into_iter()
            .map(|(_, v)| v)
            .collect()
    }

    pub(crate) fn prop(&self, key: &str) -> Option<Js> {
        match self {
            Js::Object(map) => map.borrow().get(key).cloned(),
            Js::Array(items) if key == "length" => Some(Js::Number(items.borrow().len().into())),
            Js::Array(items) => {
                array_index(key).and_then(|i| items.borrow().get(i as usize).cloned())
            }
            Js::String(s) if key == "length" => Some(Js::Number(tatsu_js::utf16_len(s).into())),
            Js::String(s) => array_index(key)
                .and_then(|i| s.chars().nth(i as usize))
                .map(|c| Js::String(c.to_string())),
            _ => None,
        }
    }
}

pub(crate) fn truthy(value: Option<&Js>) -> bool {
    value.is_some_and(Js::truthy)
}

fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    let canonical = !bytes.is_empty()
        && bytes.iter().all(u8::is_ascii_digit)
        && (bytes[0] != b'0' || bytes.len() == 1);
    if !canonical {
        return None;
    }
    key.parse::<u32>().ok().filter(|&index| index != u32::MAX)
}
