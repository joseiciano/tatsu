use std::path::PathBuf;

fn main() {
    let package_json =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    let text = std::fs::read_to_string(&package_json)
        .unwrap_or_else(|e| panic!("read {}: {e}", package_json.display()));
    let doc: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("parse {}: {e}", package_json.display()));
    let version = doc["version"]
        .as_str()
        .unwrap_or_else(|| panic!("{} has no string `version`", package_json.display()));
    println!("cargo:rustc-env=TATSU_APP_VERSION={version}");
}
