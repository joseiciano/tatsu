use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::{Value, json};
use tatsu_core::{BootOptions, CoreBuilder, Env, Hub, PreRuntime, Reply, Router, Runtime, Store};
use tatsu_state::StateEvent;

const USAGE: &str = "usage: tatsu-core-testserver --data-dir <dir> --token <token> [--port <port>] [--host <host>] [--test-hooks]";
const NESTED_PREFIX: &str = "nested:";
pub const FAIL_MESSAGE: &str = "test failure";

struct Args {
    data_dir: PathBuf,
    token: String,
    host: IpAddr,
    port: u16,
    test_hooks: bool,
}

fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut data_dir = None;
    let mut token = None;
    let mut host: IpAddr = [127, 0, 0, 1].into();
    let mut port = 0;
    let mut test_hooks = false;
    while let Some(flag) = argv.next() {
        let mut value = || argv.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(value()?)),
            "--token" => token = Some(value()?),
            "--host" => host = value()?.parse().map_err(|e| format!("--host: {e}"))?,
            "--port" => port = value()?.parse().map_err(|e| format!("--port: {e}"))?,
            "--test-hooks" => test_hooks = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(Args {
        data_dir: data_dir.ok_or("--data-dir is required")?,
        token: token
            .filter(|t| !t.is_empty())
            .ok_or("--token is required")?,
        host,
        port,
        test_hooks,
    })
}

fn event(value: Value) -> Result<StateEvent, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}

fn register_test_hooks(store: &Arc<Store>, router: &Arc<Router>, hub: &Arc<Hub>) {
    let dispatch_store = store.clone();
    router
        .request("test:dispatch", move |_ctx, args| {
            let store = dispatch_store.clone();
            async move {
                let ev = event(args.into_iter().next().unwrap_or(Value::Null))?;
                store.dispatch(ev);
                Ok(Reply::NoValue)
            }
        })
        .expect("test:dispatch registers once");
    router
        .request("test:null", |_ctx, _args| async {
            Ok(Reply::Value(Value::Null))
        })
        .expect("test:null registers once");
    router
        .request("test:fail", |_ctx, _args| async {
            Err(FAIL_MESSAGE.to_string())
        })
        .expect("test:fail registers once");
    let echo_hub = Arc::downgrade(hub);
    router
        .signal("test:echo", move |_ctx, args| {
            if let Some(hub) = echo_hub.upgrade() {
                hub.broadcast_signal("test:echo", args);
            }
            Ok(())
        })
        .expect("test:echo registers once");

    let nested_store = Arc::downgrade(store);
    store.subscribe(move |ev, _seq| {
        let Some(count) = nested_count(ev) else {
            return;
        };
        let Some(store) = nested_store.upgrade() else {
            return;
        };
        for i in 0..count {
            let nested =
                json!({"type": "settings/themeDarkChanged", "payload": format!("nested-{i}")});
            if let Ok(nested) = event(nested) {
                store.dispatch(nested);
            }
        }
    });
}

fn nested_count(ev: &StateEvent) -> Option<u32> {
    let value = serde_json::to_value(ev).ok()?;
    if value.get("type")?.as_str()? != "settings/themeLightChanged" {
        return None;
    }
    value
        .get("payload")?
        .as_str()?
        .strip_prefix(NESTED_PREFIX)?
        .parse()
        .ok()
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let env = match Env::from_process() {
        Ok(env) => Env {
            harness_data_dir: Some(args.data_dir.clone().into()),
            ..env
        },
        Err(err) => {
            eprintln!("environment: {err}");
            return ExitCode::FAILURE;
        }
    };
    let pre = match CoreBuilder::new(Runtime::Headless, env).pre_runtime() {
        Ok(pre) => pre,
        Err(err) => {
            eprintln!("data dir {}: {err}", args.data_dir.display());
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(serve(pre, args))
}

async fn serve(pre: PreRuntime, args: Args) -> ExitCode {
    let core = match pre.boot(Vec::new(), BootOptions::default()) {
        Ok(core) => core,
        Err(err) => {
            eprintln!("boot: {err}");
            return ExitCode::FAILURE;
        }
    };
    if args.test_hooks {
        register_test_hooks(core.store(), core.router(), core.hub());
    }

    let server = match tatsu_ws::listen(
        SocketAddr::new(args.host, args.port),
        core.hub().clone(),
        args.token,
    )
    .await
    {
        Ok(server) => server,
        Err(err) => {
            eprintln!("listen: {err}");
            return ExitCode::FAILURE;
        }
    };
    let addr = server.local_addr();
    core.set_ws_bound(addr.ip().to_string(), addr.port());
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "ws://{}:{}", addr.ip(), addr.port());
    let _ = stdout.flush();
    drop(stdout);

    let _ = tokio::signal::ctrl_c().await;
    core.shutdown().await;
    server.shutdown().await;
    ExitCode::SUCCESS
}
