use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::RwLock;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::store::{PerfSink, TimerMs};

#[cfg(test)]
mod tests;

pub const SLOW_IPC_MS: f64 = 50.0;
pub const PANIC_MESSAGE: &str = "handler panicked";

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ClientId(pub String);

impl ClientId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnCtx {
    pub client_id: ClientId,
}

pub type Guard = Box<dyn Any + Send>;

pub enum Reply {
    Value(Value),
    NoValue,
    WithGuard(Box<Reply>, Guard),
}

#[derive(Clone, Debug, PartialEq)]
pub enum RouterReply {
    Value(Value),
    NoValue,
    Error(String),
}

pub struct Routed {
    pub reply: RouterReply,
    pub guard: Option<Guard>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RegisterError {
    Duplicate(String),
}

impl std::fmt::Display for RegisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegisterError::Duplicate(name) => write!(f, "handler already registered for '{name}'"),
        }
    }
}

impl std::error::Error for RegisterError {}

pub type ReplyFuture = Pin<Box<dyn Future<Output = Result<Reply, String>> + Send>>;
type RequestHandler = Arc<dyn Fn(ConnCtx, Vec<Value>) -> ReplyFuture + Send + Sync>;
type SignalHandler = Arc<dyn Fn(ConnCtx, Vec<Value>) -> Result<(), String> + Send + Sync>;
pub type DebugSink = Box<dyn Fn(&str, &str, &Value) + Send + Sync>;

pub trait Args: Sized {
    fn decode(args: &[Value]) -> Result<Self, String>;
}

fn arg<T: DeserializeOwned>(args: &[Value], i: usize) -> Result<T, String> {
    T::deserialize(args.get(i).unwrap_or(&Value::Null)).map_err(|e| e.to_string())
}

macro_rules! impl_args {
    ($($t:ident $i:tt),*) => {
        impl<$($t: DeserializeOwned),*> Args for ($($t,)*) {
            #[allow(unused_variables)]
            fn decode(args: &[Value]) -> Result<Self, String> {
                Ok(($(arg::<$t>(args, $i)?,)*))
            }
        }
    };
}

impl_args!();
impl_args!(A 0);
impl_args!(A 0, B 1);
impl_args!(A 0, B 1, C 2);
impl_args!(A 0, B 1, C 2, D 3);
impl_args!(A 0, B 1, C 2, D 3, E 4);
impl_args!(A 0, B 1, C 2, D 3, E 4, F 5);
impl_args!(A 0, B 1, C 2, D 3, E 4, F 5, G 6);
impl_args!(A 0, B 1, C 2, D 3, E 4, F 5, G 6, H 7);

pub struct RouterOptions {
    pub timer_ms: TimerMs,
    pub perf: PerfSink,
    pub debug: DebugSink,
}

impl Default for RouterOptions {
    fn default() -> Self {
        let start = Instant::now();
        Self {
            timer_ms: Box::new(move || start.elapsed().as_secs_f64() * 1000.0),
            perf: Box::new(|category, message, data| {
                crate::logs::perf_with(category, message, data)
            }),
            debug: Box::new(|category, message, data| {
                crate::logs::log_with(category, message, data)
            }),
        }
    }
}

pub struct Router {
    requests: RwLock<HashMap<String, RequestHandler>>,
    signals: RwLock<HashMap<String, SignalHandler>>,
    options: RouterOptions,
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

impl Router {
    pub fn new() -> Self {
        Self::with_options(RouterOptions::default())
    }

    pub fn with_options(options: RouterOptions) -> Self {
        let router = Self {
            requests: RwLock::new(HashMap::new()),
            signals: RwLock::new(HashMap::new()),
            options,
        };
        router
            .request("transport:getClientId", |ctx, _args| async move {
                Ok(Reply::Value(Value::String(ctx.client_id.0)))
            })
            .expect("fresh router has no handlers");
        router
    }

    pub fn request<F, Fut>(&self, name: &str, f: F) -> Result<(), RegisterError>
    where
        F: Fn(ConnCtx, Vec<Value>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Reply, String>> + Send + 'static,
    {
        let handler: RequestHandler = Arc::new(move |ctx, args| Box::pin(f(ctx, args)));
        insert(&self.requests, name, handler)
    }

    pub fn request_typed<A, F, Fut>(&self, name: &str, f: F) -> Result<(), RegisterError>
    where
        A: Args + 'static,
        F: Fn(ConnCtx, A) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Reply, String>> + Send + 'static,
    {
        let handler: RequestHandler = Arc::new(move |ctx, args| match A::decode(&args) {
            Ok(decoded) => Box::pin(f(ctx, decoded)),
            Err(message) => Box::pin(async move { Err(message) }),
        });
        insert(&self.requests, name, handler)
    }

    pub fn signal<F>(&self, name: &str, f: F) -> Result<(), RegisterError>
    where
        F: Fn(ConnCtx, Vec<Value>) -> Result<(), String> + Send + Sync + 'static,
    {
        insert(&self.signals, name, Arc::new(f))
    }

    pub fn has_request(&self, name: &str) -> bool {
        self.requests.read().contains_key(name)
    }

    pub fn has_signal(&self, name: &str) -> bool {
        self.signals.read().contains_key(name)
    }

    pub async fn dispatch_request(&self, ctx: ConnCtx, name: &str, args: Vec<Value>) -> Routed {
        let Some(handler) = self.requests.read().get(name).cloned() else {
            return Routed {
                reply: RouterReply::Error(format!("no handler registered for '{name}'")),
                guard: None,
            };
        };
        let arg_count = args.len();
        let t0 = (self.options.timer_ms)();
        let joined = tokio::spawn(async move { handler(ctx, args).await }).await;
        let routed = match joined {
            Ok(Ok(reply)) => flatten(reply),
            Ok(Err(message)) => Routed {
                reply: RouterReply::Error(message),
                guard: None,
            },
            Err(_) => Routed {
                reply: RouterReply::Error(PANIC_MESSAGE.to_string()),
                guard: None,
            },
        };
        self.log_slow(name, t0, arg_count, false);
        routed
    }

    pub fn dispatch_signal(&self, ctx: ConnCtx, name: &str, args: Vec<Value>) {
        let Some(handler) = self.signals.read().get(name).cloned() else {
            return;
        };
        let arg_count = args.len();
        let t0 = (self.options.timer_ms)();
        let outcome = catch_unwind(AssertUnwindSafe(|| handler(ctx, args)))
            .unwrap_or_else(|_| Err(PANIC_MESSAGE.to_string()));
        if let Err(message) = outcome {
            (self.options.debug)(
                "ws-transport",
                &format!("signal handler '{name}' threw"),
                &Value::String(message),
            );
        }
        self.log_slow(name, t0, arg_count, true);
    }

    fn log_slow(&self, name: &str, t0: f64, arg_count: usize, signal: bool) {
        let ms = (self.options.timer_ms)() - t0;
        if ms < SLOW_IPC_MS {
            return;
        }
        let rounded: f64 = tatsu_js::to_fixed(ms, 1).parse().unwrap_or(f64::NAN);
        let whole = tatsu_js::to_fixed(ms, 0);
        if signal {
            (self.options.perf)(
                "ipc-slow",
                &format!("{name} {whole}ms (signal)"),
                &json!({"name": name, "ms": rounded, "argCount": arg_count, "signal": true}),
            );
        } else {
            (self.options.perf)(
                "ipc-slow",
                &format!("{name} {whole}ms"),
                &json!({"name": name, "ms": rounded, "argCount": arg_count}),
            );
        }
    }
}

fn insert<H>(
    map: &RwLock<HashMap<String, H>>,
    name: &str,
    handler: H,
) -> Result<(), RegisterError> {
    let mut map = map.write();
    if map.contains_key(name) {
        return Err(RegisterError::Duplicate(name.to_string()));
    }
    map.insert(name.to_string(), handler);
    Ok(())
}

fn flatten(reply: Reply) -> Routed {
    match reply {
        Reply::Value(value) => Routed {
            reply: RouterReply::Value(value),
            guard: None,
        },
        Reply::NoValue => Routed {
            reply: RouterReply::NoValue,
            guard: None,
        },
        Reply::WithGuard(inner, guard) => {
            let routed = flatten(*inner);
            let guard: Guard = match routed.guard {
                Some(inner_guard) => Box::new((inner_guard, guard)),
                None => guard,
            };
            Routed {
                reply: routed.reply,
                guard: Some(guard),
            }
        }
    }
}
