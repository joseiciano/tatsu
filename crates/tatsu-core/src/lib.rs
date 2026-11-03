pub mod activity;
pub mod agent_kind;
pub mod agent_registry;
pub mod config;
pub mod data_dir;
pub mod handlers;
pub mod hub;
pub mod initial_state;
pub mod lifecycle;
pub mod logs;
pub mod net;
pub mod path_fix;
pub mod repo_config;
pub mod resources;
pub mod router;
pub mod secrets;
pub mod shell_quote;
pub mod store;
pub mod terminal_history;
pub mod themes;
pub mod user_shell;
pub mod ws_settings;

pub const APP_VERSION: &str = env!("TATSU_APP_VERSION");

pub use config::ConfigDoc;
pub use data_dir::{DataDir, Env, Platform, Runtime};
pub use hub::{CloseCause, ConnHandle, FrameError, Hub, Outbound, OutboundRx, OverflowPolicy};
pub use initial_state::{SeedHook, build_initial_state};
pub use lifecycle::{
    BootOptions, BootSlot, Clock, Core, CoreBuilder, HooksInstaller, IdSource, PreRuntime,
    UuidV4Ids, WsBound,
};
pub use router::{
    Args, ClientId, ConnCtx, RegisterError, Reply, Routed, Router, RouterOptions, RouterReply,
};
pub use store::{Store, StoreOptions, SubscriptionId};
