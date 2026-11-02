mod doc;
mod load;

pub use doc::ConfigDoc;
pub use load::{
    CONFIG_FILE, MIGRATIONS, Migration, SCHEMA_VERSION, load, run_migrations, save_sync,
};

#[cfg(test)]
mod tests;
