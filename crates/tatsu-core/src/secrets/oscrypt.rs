use aes::Aes128;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};

use crate::data_dir::Platform;

pub const SALT: &[u8] = b"saltysalt";
pub const IV: [u8; 16] = [b' '; 16];
pub const MAC_ITERATIONS: u32 = 1003;
pub const LINUX_ITERATIONS: u32 = 1;
pub const V10: &[u8; 3] = b"v10";
pub const V11: &[u8; 3] = b"v11";
pub const LINUX_V10_PASSWORD: &[u8] = b"peanuts";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecryptError {
    NotEncrypted,
    Failed,
}

impl DecryptError {
    pub fn electron_message(self) -> &'static str {
        match self {
            Self::NotEncrypted => {
                "Error while decrypting the ciphertext provided to safeStorage.decryptString. Ciphertext does not appear to be encrypted."
            }
            Self::Failed => {
                "Error while decrypting the ciphertext provided to safeStorage.decryptString."
            }
        }
    }
}

pub struct OsCrypt {
    platform: Platform,
    key: [u8; 16],
}

impl OsCrypt {
    pub fn new(platform: Platform, password: &[u8]) -> Self {
        let key = match platform {
            Platform::MacOs => derive_key(password, MAC_ITERATIONS),
            Platform::Linux => derive_key(password, LINUX_ITERATIONS),
        };
        Self { platform, key }
    }

    pub fn encrypt(&self, plain: &[u8]) -> Vec<u8> {
        if plain.is_empty() {
            return Vec::new();
        }
        let prefix = match self.platform {
            Platform::MacOs => V10,
            Platform::Linux => V11,
        };
        let mut blob = prefix.to_vec();
        blob.extend(cbc_encrypt(&self.key, plain));
        blob
    }

    pub fn decrypt(&self, blob: &[u8]) -> Result<Vec<u8>, DecryptError> {
        if blob.is_empty() {
            return Ok(Vec::new());
        }
        let (prefix, body) = blob.split_at(blob.len().min(3));
        let keys = match (self.platform, prefix) {
            (Platform::MacOs, p) if p == V10 => vec![self.key],
            (Platform::Linux, p) if p == V10 => vec![
                derive_key(LINUX_V10_PASSWORD, LINUX_ITERATIONS),
                derive_key(b"", LINUX_ITERATIONS),
            ],
            (Platform::Linux, p) if p == V11 => {
                vec![self.key, derive_key(b"", LINUX_ITERATIONS)]
            }
            _ => return Err(DecryptError::NotEncrypted),
        };
        keys.iter()
            .find_map(|key| cbc_decrypt(key, body))
            .ok_or(DecryptError::Failed)
    }
}

pub fn derive_key(password: &[u8], iterations: u32) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, SALT, iterations, &mut key);
    key
}

fn cbc_encrypt(key: &[u8; 16], plain: &[u8]) -> Vec<u8> {
    cbc::Encryptor::<Aes128>::new(key.into(), &IV.into()).encrypt_padded_vec_mut::<Pkcs7>(plain)
}

fn cbc_decrypt(key: &[u8; 16], body: &[u8]) -> Option<Vec<u8>> {
    cbc::Decryptor::<Aes128>::new(key.into(), &IV.into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .ok()
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    use super::*;

    const MAC_PASSWORD: &[u8] = b"dGVzdC1rZXljaGFpbi1wd2Q=";
    const LINUX_PASSWORD: &[u8] = b"linux-secret-service-pw";
    const TOKEN: &str = "ghp_example-token-é";

    const NODE_MAC_V10: &str = "djEwjCiPTwDsG5mZxkS1FT7qkm2Ob9Yz7uWUOirlRfsuTQY=";
    const NODE_MAC_V10_FULL_BLOCK: &str = "djEwA/Bm6aDqVSKYeVL+V3fxgkPbBcy12lDmtN9j90cPiT4=";
    const NODE_LINUX_V11: &str = "djExgqfdqhS3ua9tvONciRd3N6T/DFY7lFyJh/eHzSbZENc=";
    const NODE_LINUX_V10_PEANUTS: &str = "djEwA5GX4M+UZcAP8Rf7B3P5+o6YTcP/hjqq5T3Ft2vnab0=";
    const NODE_LINUX_V11_EMPTY_KEY: &str = "djExe5XpL/AO+anDMbJXDLfXqg==";

    fn b64(text: &str) -> Vec<u8> {
        STANDARD.decode(text).unwrap()
    }

    fn mac() -> OsCrypt {
        OsCrypt::new(Platform::MacOs, MAC_PASSWORD)
    }

    fn linux() -> OsCrypt {
        OsCrypt::new(Platform::Linux, LINUX_PASSWORD)
    }

    #[test]
    fn mac_encrypt_matches_the_node_reference_blob() {
        assert_eq!(
            STANDARD.encode(mac().encrypt(TOKEN.as_bytes())),
            NODE_MAC_V10
        );
        assert_eq!(
            STANDARD.encode(mac().encrypt(b"0123456789abcdef")),
            NODE_MAC_V10_FULL_BLOCK
        );
    }

    #[test]
    fn mac_decrypts_node_reference_blobs() {
        assert_eq!(mac().decrypt(&b64(NODE_MAC_V10)).unwrap(), TOKEN.as_bytes());
        assert_eq!(
            mac().decrypt(&b64(NODE_MAC_V10_FULL_BLOCK)).unwrap(),
            b"0123456789abcdef"
        );
    }

    #[test]
    fn linux_encrypts_v11_matching_the_node_reference_blob() {
        assert_eq!(
            STANDARD.encode(linux().encrypt(TOKEN.as_bytes())),
            NODE_LINUX_V11
        );
    }

    #[test]
    fn linux_decrypts_v11_and_the_peanuts_v10_blob() {
        assert_eq!(
            linux().decrypt(&b64(NODE_LINUX_V11)).unwrap(),
            TOKEN.as_bytes()
        );
        assert_eq!(
            linux().decrypt(&b64(NODE_LINUX_V10_PEANUTS)).unwrap(),
            TOKEN.as_bytes()
        );
    }

    #[test]
    fn linux_falls_back_to_the_empty_password_key_like_chromium() {
        assert_eq!(
            linux().decrypt(&b64(NODE_LINUX_V11_EMPTY_KEY)).unwrap(),
            b"empty-key"
        );
    }

    #[test]
    fn empty_plaintext_is_an_empty_blob_both_ways() {
        assert!(mac().encrypt(b"").is_empty());
        assert_eq!(mac().decrypt(b"").unwrap(), b"");
    }

    #[test]
    fn unknown_prefixes_are_not_encrypted() {
        let mut blob = b64(NODE_MAC_V10);
        blob[2] = b'9';
        assert_eq!(mac().decrypt(&blob), Err(DecryptError::NotEncrypted));
        assert_eq!(mac().decrypt(b"ghp_plain"), Err(DecryptError::NotEncrypted));
        assert_eq!(mac().decrypt(b"v1"), Err(DecryptError::NotEncrypted));
        assert_eq!(
            mac().decrypt(&b64(NODE_LINUX_V11)),
            Err(DecryptError::NotEncrypted)
        );
    }

    #[test]
    fn bad_padding_or_a_wrong_password_fails() {
        let mut tampered = b64(NODE_MAC_V10);
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert_eq!(mac().decrypt(&tampered), Err(DecryptError::Failed));

        let wrong = OsCrypt::new(Platform::MacOs, b"another-password");
        assert_eq!(wrong.decrypt(&b64(NODE_MAC_V10)), Err(DecryptError::Failed));
    }

    #[test]
    fn truncated_bodies_fail() {
        let full = b64(NODE_MAC_V10);
        assert_eq!(mac().decrypt(&full[..3]), Err(DecryptError::Failed));
        assert_eq!(
            mac().decrypt(&full[..full.len() - 5]),
            Err(DecryptError::Failed)
        );
    }
}
