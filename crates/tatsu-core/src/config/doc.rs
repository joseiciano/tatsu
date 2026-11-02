use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigDoc {
    map: Map<String, Value>,
}

impl ConfigDoc {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_map(map: Map<String, Value>) -> Self {
        Self { map }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.map.get(key)
    }

    pub fn set(&mut self, key: impl Into<String>, value: Value) {
        self.map.insert(key.into(), value);
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.map.shift_remove(key)
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.map.keys().map(String::as_str)
    }

    pub fn as_map(&self) -> &Map<String, Value> {
        &self.map
    }

    pub fn to_json(&self) -> String {
        tatsu_js::stringify_pretty(&Value::Object(self.map.clone()))
    }
}
