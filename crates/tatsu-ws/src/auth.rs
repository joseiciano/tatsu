use axum::http::{HeaderMap, Uri, header};

pub(crate) fn provided_token(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    let header_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string);
    header_token.or_else(|| uri.query().and_then(|query| query_param(query, "token")))
}

pub(crate) fn token_matches(provided: &[u8], expected: &[u8]) -> bool {
    if expected.is_empty() || provided.len() != expected.len() {
        return false;
    }
    let diff = provided
        .iter()
        .zip(expected)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    std::hint::black_box(diff) == 0
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .find_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(key) == name).then(|| form_decode(value))
        })
}

fn form_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = match bytes.get(i..i + 3) {
            Some([b'%', high, low]) => hex_pair(*high, *low),
            _ => None,
        };
        match (escaped, bytes[i]) {
            (Some(byte), _) => {
                out.push(byte);
                i += 2;
            }
            (None, b'+') => out.push(b' '),
            (None, byte) => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
    let digit = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    Some(digit(high)? << 4 | digit(low)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(authorization: Option<&str>, uri: &str) -> Option<String> {
        let mut headers = HeaderMap::new();
        if let Some(value) = authorization {
            headers.insert(header::AUTHORIZATION, value.parse().unwrap());
        }
        provided_token(&headers, &uri.parse().unwrap())
    }

    #[test]
    fn bearer_header_wins_even_when_the_query_differs_or_the_header_is_empty() {
        assert_eq!(
            token(Some("Bearer abc"), "/?token=xyz").as_deref(),
            Some("abc")
        );
        assert_eq!(token(Some("Bearer "), "/?token=xyz").as_deref(), Some(""));
    }

    #[test]
    fn non_bearer_authorization_falls_back_to_the_query() {
        assert_eq!(
            token(Some("Basic abc"), "/?token=xyz").as_deref(),
            Some("xyz")
        );
        assert_eq!(
            token(Some("bearer abc"), "/?token=xyz").as_deref(),
            Some("xyz")
        );
        assert_eq!(token(None, "/"), None);
    }

    #[test]
    fn query_decoding_matches_url_search_params() {
        assert_eq!(token(None, "/?token=a&token=b").as_deref(), Some("a"));
        assert_eq!(
            token(None, "/x?a=1&token=a+b%20c").as_deref(),
            Some("a b c")
        );
        assert_eq!(token(None, "/?token=%zz%4").as_deref(), Some("%zz%4"));
        assert_eq!(token(None, "/?%74oken=hi").as_deref(), Some("hi"));
        assert_eq!(token(None, "/?token").as_deref(), Some(""));
    }

    #[test]
    fn token_compare_needs_equal_length_and_bytes() {
        assert!(token_matches(b"secret", b"secret"));
        assert!(!token_matches(b"secreT", b"secret"));
        assert!(!token_matches(b"secret!", b"secret"));
        assert!(!token_matches(b"", b"secret"));
    }

    #[test]
    fn an_empty_configured_token_accepts_nothing() {
        assert!(!token_matches(b"", b""));
        assert!(!token_matches(b"x", b""));
    }
}
