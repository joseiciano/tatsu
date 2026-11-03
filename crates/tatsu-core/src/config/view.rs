use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;

use super::ConfigDoc;

#[derive(Debug, Clone)]
pub struct ConfigView {
    doc: Arc<ConfigDoc>,
}

impl ConfigView {
    pub fn new(doc: ConfigDoc) -> Self {
        Self { doc: Arc::new(doc) }
    }

    pub fn get_raw(&self, key: &str) -> Option<&Value> {
        self.doc.get(key)
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        decode(self.doc.get(key)?)
    }

    pub fn doc(&self) -> &ConfigDoc {
        &self.doc
    }
}

pub(crate) fn decode<T: DeserializeOwned>(value: &Value) -> Option<T> {
    T::deserialize(value).ok()
}
