use std::path::PathBuf;

// TS always returns a path (derived from the packaged or repo layout). The
// layout belongs to the host here, so a host that sets no resources folder
// gets `None`, and `chat` reads that as an absent manifest, the same outcome
// as the TS headless build where the file never exists.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resources {
    dir: Option<PathBuf>,
}

impl Resources {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir }
    }

    pub fn mcp_script(&self, name: &str) -> Option<PathBuf> {
        Some(self.dir.as_ref()?.join(name))
    }

    pub fn runtime_manifest_path(&self) -> Option<PathBuf> {
        Some(self.dir.as_ref()?.join("runtime-manifest.json"))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::Resources;

    #[test]
    fn with_a_dir_paths_join_onto_it() {
        let r = Resources::new(Some(PathBuf::from("/fake/res")));
        assert_eq!(
            r.runtime_manifest_path(),
            Some(PathBuf::from("/fake/res/runtime-manifest.json"))
        );
        assert_eq!(
            r.mcp_script("harness-mcp.js"),
            Some(PathBuf::from("/fake/res/harness-mcp.js"))
        );
    }

    #[test]
    fn without_a_dir_both_are_none() {
        let r = Resources::default();
        assert_eq!(r.runtime_manifest_path(), None);
        assert_eq!(r.mcp_script("harness-mcp.js"), None);
    }
}
