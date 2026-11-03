mod doc;
mod handle;
mod load;
mod save;
mod view;

pub use doc::ConfigDoc;
pub use handle::{ConfigHandle, SAVE_DEBOUNCE};
pub use load::{CONFIG_FILE, MIGRATIONS, Migration, SCHEMA_VERSION, load, run_migrations};
pub use save::save_sync;
pub use view::ConfigView;

#[cfg(test)]
mod handle_tests;
#[cfg(test)]
mod tests;
