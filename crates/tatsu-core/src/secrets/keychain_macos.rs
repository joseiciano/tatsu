use security_framework::passwords::{PasswordOptions, generic_password};

use super::desktop::KeyStore;

pub struct KeychainPassword {
    service: String,
    account: String,
}

impl KeychainPassword {
    pub fn for_app(app_name: &str) -> Self {
        Self {
            service: format!("{app_name} Safe Storage"),
            account: app_name.to_owned(),
        }
    }
}

impl KeyStore for KeychainPassword {
    fn password(&self) -> Option<Vec<u8>> {
        generic_password(PasswordOptions::new_generic_password(
            &self.service,
            &self.account,
        ))
        .ok()
    }
}
