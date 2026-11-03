use std::collections::HashMap;

use secret_service::EncryptionType;
use secret_service::blocking::SecretService;

use super::desktop::KeyStore;

pub struct LibsecretPassword {
    application: String,
}

impl LibsecretPassword {
    pub fn for_app(app_name: &str) -> Self {
        Self {
            application: app_name.to_owned(),
        }
    }
}

impl KeyStore for LibsecretPassword {
    fn password(&self) -> Option<Vec<u8>> {
        let service = SecretService::connect(EncryptionType::Dh).ok()?;
        let found = service
            .search_items(HashMap::from([("application", self.application.as_str())]))
            .ok()?;
        found.unlocked.first()?.get_secret().ok()
    }
}
