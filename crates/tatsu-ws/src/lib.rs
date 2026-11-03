//! WebSocket adapter for the tatsu-core connection hub.
//!
//! [`upgrade_route`] returns an `axum::Router` that accepts the upgrade on any
//! path (a fallback route, like the Node transport). A host with its own HTTP
//! listener can `merge` it, mount it with `fallback_service`, or nest it under
//! a path. [`listen`] binds a stand-alone listener that serves only this route.
//!
//! A host that mounts the route itself shuts its sockets down with
//! `hub.shutdown(SHUTDOWN_CODE, SHUTDOWN_REASON)`.

mod auth;

use std::io;
use std::net::SocketAddr;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
pub use tatsu_core::hub::{SHUTDOWN_CODE, SHUTDOWN_REASON};
use tatsu_core::{CloseCause, ConnHandle, FrameError, Hub, Outbound, OverflowPolicy};
use tokio::net::TcpListener;
use tokio::sync::{Notify, oneshot};
use tokio::task::JoinHandle;

pub const CATEGORY: &str = "ws-transport";
pub const CLOSE_ABOVE_BYTES: usize = 8 * 1024 * 1024;
pub const OVERFLOW_CODE: u16 = 1013;
pub const OVERFLOW_REASON: &str = "client too slow";
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_HANDSHAKE_GRACE: Duration = Duration::from_secs(1);

pub type DebugSink = Arc<dyn Fn(&str, Option<&str>) + Send + Sync>;

#[derive(Clone)]
pub struct WsOptions {
    pub debug: DebugSink,
    pub write_timeout: Duration,
}

impl Default for WsOptions {
    fn default() -> Self {
        Self {
            debug: Arc::new(|message, data| match data {
                Some(data) => tatsu_core::logs::log_with(CATEGORY, message, data),
                None => tatsu_core::logs::log(CATEGORY, message),
            }),
            write_timeout: WRITE_TIMEOUT,
        }
    }
}

struct Shared {
    hub: Arc<Hub>,
    token: String,
    debug: DebugSink,
    write_timeout: Duration,
    live: AtomicUsize,
    idle: Notify,
}

impl Shared {
    fn new(hub: Arc<Hub>, token: String, options: WsOptions) -> Arc<Self> {
        Arc::new(Self {
            hub,
            token,
            debug: options.debug,
            write_timeout: options.write_timeout,
            live: AtomicUsize::new(0),
            idle: Notify::new(),
        })
    }

    fn log(&self, message: &str) {
        (self.debug)(message, None);
    }

    fn log_data(&self, message: &str, data: &str) {
        (self.debug)(message, Some(data));
    }

    fn authorized(&self, headers: &HeaderMap, uri: &Uri) -> bool {
        auth::provided_token(headers, uri)
            .is_some_and(|provided| auth::token_matches(provided.as_bytes(), self.token.as_bytes()))
    }

    async fn wait_idle(&self, limit: Duration) {
        let _ = tokio::time::timeout(limit, async {
            loop {
                let mut notified = pin!(self.idle.notified());
                notified.as_mut().enable();
                if self.live.load(Ordering::SeqCst) == 0 {
                    return;
                }
                notified.await;
            }
        })
        .await;
    }
}

pub fn upgrade_route(hub: Arc<Hub>, token: impl Into<String>) -> Router {
    upgrade_route_with(hub, token, WsOptions::default())
}

pub fn upgrade_route_with(hub: Arc<Hub>, token: impl Into<String>, options: WsOptions) -> Router {
    route_for(Shared::new(hub, token.into(), options))
}

fn route_for(shared: Arc<Shared>) -> Router {
    Router::new().fallback(upgrade).with_state(shared)
}

async fn upgrade(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    uri: Uri,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    if !shared.authorized(&headers, &uri) {
        shared.log("rejected unauth ws handshake");
        return unauthorized();
    }
    let on_error = shared.clone();
    ws.on_failed_upgrade(move |err: axum::Error| {
        on_error.log_data("socket error", &err.to_string())
    })
    .on_upgrade(move |socket| serve_socket(shared, socket))
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [
            (header::CONTENT_TYPE, "text/html"),
            (header::CONNECTION, "close"),
        ],
        "unauthorized",
    )
        .into_response()
}

async fn serve_socket(shared: Arc<Shared>, mut socket: WebSocket) {
    let ConnHandle {
        client_id,
        mut outbound,
    } = shared.hub.open(OverflowPolicy::CloseAbove {
        bytes: CLOSE_ABOVE_BYTES,
    });
    let total = shared.live.fetch_add(1, Ordering::SeqCst) + 1;
    shared.log(&format!(
        "client connected id={} (total={total})",
        client_id.as_str()
    ));

    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => match shared.hub.on_frame(&client_id, text.as_str()) {
                    Ok(()) => {}
                    Err(FrameError::Malformed) => shared.log("dropped malformed frame"),
                    Err(FrameError::UnknownClient) => {
                        shared.log("frame arrived for unknown socket — dropping")
                    }
                },
                Some(Ok(Message::Close(_))) => {
                    finish_close_handshake(&mut socket).await;
                    break;
                }
                Some(Ok(_)) => {}
                Some(Err(err)) => {
                    shared.log_data("socket error", &err.to_string());
                    break;
                }
                None => break,
            },
            out = outbound.recv() => match out {
                Some(Outbound::Frame(text)) => {
                    if !send_within(&shared, &mut socket, Message::Text(text.as_ref().into())).await {
                        break;
                    }
                }
                Some(Outbound::Close(cause)) => {
                    let (code, reason) = match cause {
                        CloseCause::Overflow => {
                            shared.log(&format!(
                                "closed slow client id={} queued={}",
                                client_id.as_str(),
                                outbound.queued_bytes()
                            ));
                            (OVERFLOW_CODE, OVERFLOW_REASON.to_string())
                        }
                        CloseCause::Shutdown { code, reason } => (code, reason),
                    };
                    let frame = CloseFrame { code, reason: reason.into() };
                    if send_within(&shared, &mut socket, Message::Close(Some(frame))).await {
                        finish_close_handshake(&mut socket).await;
                    }
                    break;
                }
                None => break,
            },
        }
    }

    shared.hub.close(&client_id);
    let total = shared.live.fetch_sub(1, Ordering::SeqCst) - 1;
    shared.log(&format!(
        "client disconnected id={} (total={total})",
        client_id.as_str()
    ));
    if total == 0 {
        shared.idle.notify_waiters();
    }
}

async fn send_within(shared: &Shared, socket: &mut WebSocket, message: Message) -> bool {
    match tokio::time::timeout(shared.write_timeout, socket.send(message)).await {
        Ok(Ok(())) => true,
        Ok(Err(err)) => {
            shared.log_data("socket error", &err.to_string());
            false
        }
        Err(_) => {
            shared.log_data("socket error", "write timed out");
            false
        }
    }
}

async fn finish_close_handshake(socket: &mut WebSocket) {
    let _ = tokio::time::timeout(CLOSE_HANDSHAKE_GRACE, async {
        while let Some(Ok(_)) = socket.recv().await {}
    })
    .await;
}

pub struct BoundServer {
    local_addr: SocketAddr,
    shared: Arc<Shared>,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl BoundServer {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.shared.hub.shutdown(SHUTDOWN_CODE, SHUTDOWN_REASON);
        if tokio::time::timeout(SHUTDOWN_GRACE, &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
        }
        self.shared.wait_idle(SHUTDOWN_GRACE).await;
    }
}

pub async fn listen(
    addr: SocketAddr,
    hub: Arc<Hub>,
    token: impl Into<String>,
) -> io::Result<BoundServer> {
    listen_with(addr, hub, token, WsOptions::default()).await
}

pub async fn listen_with(
    addr: SocketAddr,
    hub: Arc<Hub>,
    token: impl Into<String>,
    options: WsOptions,
) -> io::Result<BoundServer> {
    let shared = Shared::new(hub, token.into(), options);
    let listener = match TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            shared.log_data("server error", &err.to_string());
            return Err(err);
        }
    };
    let local_addr = listener.local_addr()?;
    let (stop, stopped) = oneshot::channel::<()>();
    let app = route_for(shared.clone());
    let on_error = shared.clone();
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = stopped.await;
        });
        if let Err(err) = serve.await {
            on_error.log_data("server error", &err.to_string());
        }
    });
    shared.log(&format!(
        "listening on ws://{}:{}",
        local_addr.ip(),
        local_addr.port()
    ));
    Ok(BoundServer {
        local_addr,
        shared,
        stop: Some(stop),
        task,
    })
}
