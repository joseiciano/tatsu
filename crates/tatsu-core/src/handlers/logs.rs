use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};

use super::upgrade;
use crate::lifecycle::Core;
use crate::logs;
use crate::router::Reply;

const DEFAULT_MAX_LINES: f64 = 200.0;

pub(super) fn register(core: &Arc<Core>) {
    let weak = Arc::downgrade(core);
    core.router()
        .request("debug:readRecentLog", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let max_lines = args.first().map_or(DEFAULT_MAX_LINES, tatsu_js::to_number);
                let path = core.data_dir().path().join("debug.log");
                Ok(Reply::Value(Value::String(read_recent(&path, max_lines))))
            }
        })
        .expect("debug:readRecentLog registers once");

    core.router()
        .request("debug:logError", |_ctx, args| async move {
            let part = |i: usize| {
                args.get(i)
                    .map_or_else(|| "undefined".to_owned(), tatsu_js::to_js_string)
            };
            logs::log(
                "renderer-error",
                &format!(
                    "[{}] {}: {}\nStack:\n{}\nComponent stack:\n{}",
                    part(0),
                    part(1),
                    part(2),
                    part(3),
                    part(4)
                ),
            );
            Ok(Reply::Value(Value::Bool(true)))
        })
        .expect("debug:logError registers once");

    core.router()
        .signal("perf:logSlowRender", |_ctx, args| {
            log_slow_render(&args);
            Ok(())
        })
        .expect("perf:logSlowRender registers once");
}

fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => tatsu_js::to_js_string(v),
    }
}

fn log_slow_render(args: &[Value]) {
    let id = string_or_empty(args.first());
    let ms = match args.get(1) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    };
    let phase = string_or_empty(args.get(2));
    let rounded = tatsu_js::to_number(&Value::String(tatsu_js::to_fixed(ms, 2)));
    logs::perf_with(
        "render-slow",
        &format!("{id} {}ms {phase}", tatsu_js::to_fixed(ms, 1)),
        &json!({ "id": id, "ms": rounded, "phase": phase }),
    );
}

fn read_recent(path: &Path, max_lines: f64) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    let content = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = content.split('\n').collect();
    let start = slice_start(lines.len(), -js_max_one(max_lines));
    tatsu_js::trim(&lines[start..].join("\n")).to_owned()
}

fn js_max_one(x: f64) -> f64 {
    if x.is_nan() { x } else { x.max(1.0) }
}

fn slice_start(len: usize, relative: f64) -> usize {
    if relative.is_nan() {
        return 0;
    }
    let back = (-relative.trunc()).min(len as f64) as usize;
    len - back
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_log_reads_as_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(read_recent(&dir.path().join("debug.log"), 200.0), "");
    }
}
