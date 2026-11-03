mod doc;
mod handle;
mod load;
mod migrations;
mod save;
mod view;

pub use doc::ConfigDoc;
pub use handle::{ConfigHandle, SAVE_DEBOUNCE};
pub use load::{CONFIG_FILE, SCHEMA_VERSION, load, load_with, run_migrations};
pub use migrations::{MigrationCtx, MigrationError};
pub use save::save_sync;
pub use view::ConfigView;

#[cfg(test)]
mod handle_tests;
#[cfg(test)]
mod tests;
