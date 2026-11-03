use serde_json::Value;

use crate::config::ConfigView;
use crate::data_dir::Runtime;

#[cfg(test)]
mod tests;

pub const DEFAULT_WS_PORT: f64 = 37291.0;
pub const DEFAULT_WS_HOST: &str = "127.0.0.1";
pub const ENV_TRANSPORT: &str = "HARNESS_WS_TRANSPORT";
pub const ENV_PORT: &str = "HARNESS_WS_PORT";
pub const ENV_HOST: &str = "HARNESS_WS_HOST";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WsCli {
    pub port: Option<i64>,
    pub host: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WsSettings {
    pub enabled: bool,
    pub port: f64,
    pub host: String,
}

pub fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

pub fn resolve(
    runtime: Runtime,
    cli: WsCli,
    env: &dyn Fn(&str) -> Option<String>,
    config: &ConfigView,
) -> WsSettings {
    let enabled = runtime == Runtime::Headless
        || config.get_raw("wsTransportEnabled") == Some(&Value::Bool(true))
        || env(ENV_TRANSPORT).as_deref() == Some("1");

    let env_port = tatsu_js::parse_int(&env(ENV_PORT).unwrap_or_default(), 10);
    let port = match cli.port {
        Some(port) if port >= 0 => port as f64,
        _ if env_port.is_finite() && env_port > 0.0 => env_port,
        _ => match config.get_raw("wsTransportPort") {
            None | Some(Value::Null) => DEFAULT_WS_PORT,
            Some(value) => tatsu_js::to_number(value),
        },
    };

    let host = cli
        .host
        .filter(|h| !h.is_empty())
        .or_else(|| env(ENV_HOST).filter(|h| !h.is_empty()))
        .or_else(|| {
            config
                .get_raw("wsTransportHost")
                .filter(|v| tatsu_js::truthy(v))
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => tatsu_js::to_js_string(other),
                })
        })
        .unwrap_or_else(|| DEFAULT_WS_HOST.to_owned());

    WsSettings {
        enabled,
        port,
        host,
    }
}
