use std::any::Any;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::{Mutex, RwLock};
use serde_json::json;
use tokio::runtime::Handle;
use tokio::sync::watch;

use crate::config::{self, CONFIG_FILE, ConfigHandle};
use crate::data_dir::{DataDir, Env, Runtime};
use crate::handlers::{register_core_handlers, reload_custom_themes};
use crate::hub::{Hub, SHUTDOWN_CODE, SHUTDOWN_REASON};
use crate::initial_state::{SeedHook, build_initial_state};
use crate::logs;
use crate::router::Router;
use crate::secrets::{self, OsRandom, RandomSource, Secrets};
use crate::store::{Store, StoreOptions};

#[cfg(test)]
mod tests;

pub const SHUTDOWN_STEP_TIMEOUT: Duration = Duration::from_secs(5);
const CATEGORY: &str = "lifecycle";
const GITHUB_TOKEN_KEY: &str = "githubToken";
const APP_CATEGORY: &str = "app";
const DEBUG_LOG_FILE: &str = "debug.log";

pub trait HooksInstaller: Send + Sync {
    fn install(&self) -> Result<(), String>;
    fn uninstall(&self) -> Result<(), String>;
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub trait IdSource: Send + Sync {
    fn next_id(&self) -> String;
}

pub struct UuidV4Ids;

impl IdSource for UuidV4Ids {
    fn next_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsBound {
    pub host: String,
    pub port: u16,
}

pub struct BootOptions {
    pub secrets: Option<Arc<dyn Secrets>>,
    pub random: Arc<dyn RandomSource>,
    pub ids: Arc<dyn IdSource>,
    pub clock: Clock,
}

impl Default for BootOptions {
    fn default() -> Self {
        Self {
            secrets: None,
            random: Arc::new(OsRandom),
            ids: Arc::new(UuidV4Ids),
            clock: Arc::new(system_now_ms),
        }
    }
}

fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreRuntimeSlot {
    PathFix,
}

pub const PRE_RUNTIME_SLOTS: &[PreRuntimeSlot] = &[PreRuntimeSlot::PathFix];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootSlot {
    ThemeScan,
    CoreHandlers,
    RepoConfigsLoaded,
}

pub const BOOT_SLOTS: &[BootSlot] = &[
    BootSlot::ThemeScan,
    BootSlot::CoreHandlers,
    BootSlot::RepoConfigsLoaded,
];

pub struct CoreBuilder {
    runtime: Runtime,
    env: Env,
}

impl CoreBuilder {
    pub fn new(runtime: Runtime, env: Env) -> Self {
        Self { runtime, env }
    }

    pub fn pre_runtime(self) -> io::Result<PreRuntime> {
        let data_dir = DataDir::resolve(self.runtime, &self.env)?;
        logs::init(&data_dir);
        for slot in PRE_RUNTIME_SLOTS {
            match slot {
                PreRuntimeSlot::PathFix => {}
            }
        }
        Ok(PreRuntime {
            runtime: self.runtime,
            data_dir,
        })
    }
}

pub struct PreRuntime {
    runtime: Runtime,
    data_dir: DataDir,
}

impl PreRuntime {
    pub fn data_dir(&self) -> &DataDir {
        &self.data_dir
    }

    pub fn boot(self, seed_hooks: Vec<SeedHook>, options: BootOptions) -> io::Result<Arc<Core>> {
        let handle = Handle::try_current().map_err(io::Error::other)?;
        let config_path = self.data_dir.path().join(CONFIG_FILE);
        let doc = config::load(&config_path, (options.clock)());
        let config = ConfigHandle::new(config_path, doc, handle.clone());
        let secrets = match options.secrets {
            Some(secrets) => secrets,
            None => match self.runtime {
                Runtime::Headless => {
                    secrets::open_headless(&self.data_dir, options.random.clone())?
                }
                Runtime::DesktopPackaged | Runtime::DesktopDev => {
                    secrets::open_desktop(&self.data_dir, self.runtime)
                }
            },
        };
        let initial =
            build_initial_state(&config.view(), secrets.has(GITHUB_TOKEN_KEY), &seed_hooks);
        let clock = options.clock.clone();
        let store = Arc::new(Store::with_options(
            initial,
            StoreOptions {
                now_ms: Box::new(move || clock()),
                ..StoreOptions::default()
            },
        ));
        let router = Arc::new(Router::new());
        let hub = Hub::new(store.clone(), router.clone(), handle.clone());
        let core = Arc::new(Core {
            runtime: self.runtime,
            data_dir: self.data_dir,
            handle,
            store,
            router,
            hub,
            config,
            secrets,
            random: options.random,
            ids: options.ids,
            clock: options.clock,
            hooks_installer: RwLock::new(None),
            resources_dir: RwLock::new(None),
            ws_bound: RwLock::new(None),
            module_steps: Mutex::new(Vec::new()),
            core_steps: Mutex::new(Vec::new()),
            shutdown_done: Mutex::new(None),
        });
        logs::log(
            APP_CATEGORY,
            &format!(
                "started, log file: {}",
                core.data_dir.path().join(DEBUG_LOG_FILE).display()
            ),
        );
        for slot in BOOT_SLOTS {
            match slot {
                BootSlot::ThemeScan => {
                    if let Err(message) = reload_custom_themes(&core) {
                        logs::log("themes", &format!("initial scan failed: {message}"));
                    }
                }
                BootSlot::RepoConfigsLoaded => {}
                BootSlot::CoreHandlers => register_core_handlers(&core),
            }
        }
        Ok(core)
    }
}

type StepFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

struct ShutdownStep {
    name: String,
    run: Box<dyn FnOnce() -> StepFuture + Send>,
}

impl ShutdownStep {
    fn new<F, Fut>(name: impl Into<String>, step: F) -> Self
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Self {
            name: name.into(),
            run: Box::new(move || Box::pin(step())),
        }
    }
}

pub struct Core {
    runtime: Runtime,
    data_dir: DataDir,
    handle: Handle,
    store: Arc<Store>,
    router: Arc<Router>,
    hub: Arc<Hub>,
    config: ConfigHandle,
    secrets: Arc<dyn Secrets>,
    random: Arc<dyn RandomSource>,
    ids: Arc<dyn IdSource>,
    clock: Clock,
    hooks_installer: RwLock<Option<Arc<dyn HooksInstaller>>>,
    resources_dir: RwLock<Option<PathBuf>>,
    ws_bound: RwLock<Option<WsBound>>,
    module_steps: Mutex<Vec<ShutdownStep>>,
    core_steps: Mutex<Vec<ShutdownStep>>,
    shutdown_done: Mutex<Option<watch::Receiver<bool>>>,
}

impl Core {
    pub fn runtime(&self) -> Runtime {
        self.runtime
    }

    pub fn handle(&self) -> &Handle {
        &self.handle
    }

    pub fn data_dir(&self) -> &DataDir {
        &self.data_dir
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    pub fn router(&self) -> &Arc<Router> {
        &self.router
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    pub fn config(&self) -> &ConfigHandle {
        &self.config
    }

    pub fn secrets(&self) -> &Arc<dyn Secrets> {
        &self.secrets
    }

    pub fn random(&self) -> &Arc<dyn RandomSource> {
        &self.random
    }

    pub fn new_id(&self) -> String {
        self.ids.next_id()
    }

    pub fn now_ms(&self) -> i64 {
        (self.clock)()
    }

    pub fn set_hooks_installer(&self, installer: Arc<dyn HooksInstaller>) {
        *self.hooks_installer.write() = Some(installer);
    }

    pub fn hooks_installer(&self) -> Option<Arc<dyn HooksInstaller>> {
        self.hooks_installer.read().clone()
    }

    pub fn set_resources_dir(&self, dir: impl Into<PathBuf>) {
        *self.resources_dir.write() = Some(dir.into());
    }

    pub fn resources_dir(&self) -> Option<PathBuf> {
        self.resources_dir.read().clone()
    }

    pub fn set_ws_bound(&self, host: impl Into<String>, port: u16) {
        *self.ws_bound.write() = Some(WsBound {
            host: host.into(),
            port,
        });
    }

    pub fn ws_bound(&self) -> Option<WsBound> {
        self.ws_bound.read().clone()
    }

    pub fn on_shutdown<F, Fut>(&self, name: impl Into<String>, step: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.module_steps.lock().push(ShutdownStep::new(name, step));
    }

    #[cfg(test)]
    pub(crate) fn push_core_step<F, Fut>(&self, name: &str, step: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.core_steps.lock().push(ShutdownStep::new(name, step));
    }

    pub async fn shutdown(self: &Arc<Self>) {
        let mut done = {
            let mut slot = self.shutdown_done.lock();
            slot.get_or_insert_with(|| {
                let (tx, rx) = watch::channel(false);
                let core = self.clone();
                self.handle.spawn(async move {
                    core.run_shutdown().await;
                    let _ = tx.send(true);
                });
                rx
            })
            .clone()
        };
        let _ = done.wait_for(|finished| *finished).await;
    }

    async fn run_shutdown(&self) {
        let module_steps = std::mem::take(&mut *self.module_steps.lock());
        let core_steps = std::mem::take(&mut *self.core_steps.lock());
        for step in module_steps.into_iter().chain(core_steps) {
            self.run_step(step).await;
        }
        self.hub.shutdown(SHUTDOWN_CODE, SHUTDOWN_REASON);
        self.config.flush_sync();
        logs::flush();
    }

    async fn run_step(&self, step: ShutdownStep) {
        let ShutdownStep { name, run } = step;
        let task = self.handle.spawn(async move { run().await });
        let abort = task.abort_handle();
        match tokio::time::timeout(SHUTDOWN_STEP_TIMEOUT, task).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                let error = if err.is_panic() {
                    panic_text(err.into_panic())
                } else {
                    err.to_string()
                };
                logs::log_with(
                    CATEGORY,
                    "shutdown step failed",
                    &json!({ "step": name, "error": error }),
                );
            }
            Err(_) => {
                abort.abort();
                logs::log_with(
                    CATEGORY,
                    "shutdown step timed out",
                    &json!({ "step": name, "timeoutMs": SHUTDOWN_STEP_TIMEOUT.as_millis() as u64 }),
                );
            }
        }
    }
}

fn panic_text(payload: Box<dyn Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(text) => *text,
        Err(payload) => payload
            .downcast_ref::<&str>()
            .map(|text| (*text).to_owned())
            .unwrap_or_else(|| "panic".to_owned()),
    }
}
