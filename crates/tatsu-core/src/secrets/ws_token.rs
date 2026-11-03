use super::{RandomSource, Secrets};

pub const SECRET_KEY: &str = "wsAuthToken";

pub fn get_or_create(secrets: &dyn Secrets, random: &dyn RandomSource) -> String {
    match secrets.get(SECRET_KEY) {
        Some(token) if !token.is_empty() => token,
        _ => rotate(secrets, random),
    }
}

pub fn rotate(secrets: &dyn Secrets, random: &dyn RandomSource) -> String {
    let mut bytes = [0u8; 32];
    random.fill(&mut bytes);
    let token = hex::encode(bytes);
    secrets.set(SECRET_KEY, &token);
    token
}
