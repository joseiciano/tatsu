use std::ffi::OsString;
use std::fs::DirBuilder;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Runtime {
    DesktopPackaged,
    DesktopDev,
    Headless,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
}

#[derive(Debug, Clone)]
pub struct Env {
    pub platform: Platform,
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub harness_data_dir: Option<OsString>,
    pub xdg_config_home: Option<OsString>,
}

impl Env {
    pub fn from_process() -> io::Result<Self> {
        let home = std::env::home_dir()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
        Ok(Self {
            platform: if cfg!(target_os = "macos") {
                Platform::MacOs
            } else {
                Platform::Linux
            },
            home,
            cwd: std::env::current_dir()?,
            harness_data_dir: std::env::var_os("HARNESS_DATA_DIR"),
            xdg_config_home: std::env::var_os("XDG_CONFIG_HOME"),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDir {
    root: PathBuf,
}

impl DataDir {
    pub fn resolve(runtime: Runtime, env: &Env) -> io::Result<Self> {
        let name = match runtime {
            Runtime::DesktopPackaged => "Harness",
            Runtime::DesktopDev => "Harness (Dev)",
            Runtime::Headless => {
                let root = match env
                    .harness_data_dir
                    .as_ref()
                    .filter(|v| !v.to_string_lossy().trim().is_empty())
                {
                    Some(dir) => normalize(&env.cwd.join(dir)),
                    None => env.home.join(".harness"),
                };
                return Self::from_path(root);
            }
        };
        let root = electron_app_data(env).join(name);
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn from_path(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        if !root.exists() {
            private_dir_builder().create(&root)?;
        }
        Ok(Self { root })
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn module_dir(&self, name: &str) -> io::Result<PathBuf> {
        let dir = self.root.join(name);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}

fn electron_app_data(env: &Env) -> PathBuf {
    match env.platform {
        Platform::MacOs => env.home.join("Library").join("Application Support"),
        Platform::Linux => match env.xdg_config_home.as_ref().filter(|v| !v.is_empty()) {
            Some(dir) => PathBuf::from(dir),
            None => env.home.join(".config"),
        },
    }
}

fn private_dir_builder() -> DirBuilder {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => out.push(component),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn env(platform: Platform, home: &Path) -> Env {
        Env {
            platform,
            home: home.to_path_buf(),
            cwd: home.to_path_buf(),
            harness_data_dir: None,
            xdg_config_home: None,
        }
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn headless_uses_harness_data_dir_and_creates_it_private() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("nested").join("data");
        let mut e = env(Platform::MacOs, tmp.path());
        e.harness_data_dir = Some(target.clone().into());

        let dir = DataDir::resolve(Runtime::Headless, &e).unwrap();

        assert_eq!(dir.path(), target);
        assert!(target.is_dir());
        #[cfg(unix)]
        assert_eq!(mode(&target), 0o700);
    }

    #[test]
    fn headless_resolves_relative_harness_data_dir_against_cwd() {
        let tmp = TempDir::new().unwrap();
        let mut e = env(Platform::Linux, tmp.path());
        e.cwd = tmp.path().join("work");
        e.harness_data_dir = Some("./a/../data/".into());

        let dir = DataDir::resolve(Runtime::Headless, &e).unwrap();

        assert_eq!(dir.path(), tmp.path().join("work").join("data"));
    }

    #[test]
    fn headless_leaves_an_existing_dir_mode_alone() {
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("existing");
        std::fs::create_dir(&target).unwrap();
        #[cfg(unix)]
        let before = mode(&target);
        let mut e = env(Platform::MacOs, tmp.path());
        e.harness_data_dir = Some(target.clone().into());

        DataDir::resolve(Runtime::Headless, &e).unwrap();

        #[cfg(unix)]
        assert_eq!(mode(&target), before);
    }

    #[test]
    fn headless_falls_back_to_dot_harness_when_env_blank_or_unset() {
        for value in [None, Some(OsString::from("")), Some(OsString::from("  \t"))] {
            let tmp = TempDir::new().unwrap();
            let mut e = env(Platform::MacOs, tmp.path());
            e.harness_data_dir = value;

            let dir = DataDir::resolve(Runtime::Headless, &e).unwrap();

            let expected = tmp.path().join(".harness");
            assert_eq!(dir.path(), expected);
            #[cfg(unix)]
            assert_eq!(mode(&expected), 0o700);
        }
    }

    #[test]
    fn desktop_on_macos_uses_application_support() {
        let tmp = TempDir::new().unwrap();
        let mut e = env(Platform::MacOs, tmp.path());
        e.harness_data_dir = Some("/ignored".into());
        let support = tmp.path().join("Library").join("Application Support");

        let packaged = DataDir::resolve(Runtime::DesktopPackaged, &e).unwrap();
        let dev = DataDir::resolve(Runtime::DesktopDev, &e).unwrap();

        assert_eq!(packaged.path(), support.join("Harness"));
        assert_eq!(dev.path(), support.join("Harness (Dev)"));
    }

    #[cfg(unix)]
    #[test]
    fn desktop_dirs_use_default_permissions() {
        let tmp = TempDir::new().unwrap();
        let reference = tmp.path().join("reference");
        std::fs::create_dir(&reference).unwrap();
        let e = env(Platform::Linux, tmp.path());

        let packaged = DataDir::resolve(Runtime::DesktopPackaged, &e).unwrap();
        let dev = DataDir::resolve(Runtime::DesktopDev, &e).unwrap();

        assert_eq!(mode(packaged.path()), mode(&reference));
        assert_eq!(mode(dev.path()), mode(&reference));
    }

    #[test]
    fn desktop_on_linux_prefers_xdg_config_home() {
        let tmp = TempDir::new().unwrap();
        let xdg = tmp.path().join("xdg");
        let mut e = env(Platform::Linux, tmp.path());
        e.xdg_config_home = Some(xdg.clone().into());

        let packaged = DataDir::resolve(Runtime::DesktopPackaged, &e).unwrap();
        let dev = DataDir::resolve(Runtime::DesktopDev, &e).unwrap();

        assert_eq!(packaged.path(), xdg.join("Harness"));
        assert_eq!(dev.path(), xdg.join("Harness (Dev)"));
    }

    #[test]
    fn desktop_on_linux_falls_back_to_dot_config() {
        let tmp = TempDir::new().unwrap();
        let mut e = env(Platform::Linux, tmp.path());
        e.xdg_config_home = Some("".into());

        let packaged = DataDir::resolve(Runtime::DesktopPackaged, &e).unwrap();
        let dev = DataDir::resolve(Runtime::DesktopDev, &e).unwrap();

        assert_eq!(packaged.path(), tmp.path().join(".config").join("Harness"));
        assert_eq!(dev.path(), tmp.path().join(".config").join("Harness (Dev)"));
    }

    #[test]
    fn module_dir_creates_then_reuses_a_sub_folder() {
        let tmp = TempDir::new().unwrap();
        let dir = DataDir::from_path(tmp.path().join("data")).unwrap();

        let first = dir.module_dir("history").unwrap();
        std::fs::write(first.join("keep.json"), "{}").unwrap();
        let second = dir.module_dir("history").unwrap();

        assert_eq!(first, tmp.path().join("data").join("history"));
        assert_eq!(first, second);
        assert_eq!(
            std::fs::read_to_string(second.join("keep.json")).unwrap(),
            "{}"
        );
    }
}
