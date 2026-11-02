use std::{
    io::{self, Read},
    process::ExitCode,
};

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tatsu_state::{AppState, StateEvent, root_reduce};

fn field<T: DeserializeOwned>(request: &Value, name: &str) -> Result<T, String> {
    let value = request.get(name).ok_or(format!("missing `{name}`"))?;
    serde_json::from_value(value.clone()).map_err(|err| format!("`{name}`: {err}"))
}

fn slice_of(request: &Value) -> Result<String, String> {
    if let Some(slice) = request.get("slice") {
        return slice
            .as_str()
            .map(str::to_string)
            .ok_or("`slice` is not a string".to_string());
    }
    request
        .pointer("/event/type")
        .and_then(Value::as_str)
        .and_then(|kind| kind.split_once('/'))
        .map(|(prefix, _)| prefix.to_string())
        .ok_or("no `slice` given and `event.type` has no `<slice>/` prefix".to_string())
}

fn reduce_case(request: &Value) -> Result<Value, String> {
    let slice = slice_of(request)?;
    let start: Map<String, Value> = request
        .get("before")
        .map(|before| (slice.clone(), before.clone()))
        .into_iter()
        .collect();
    let mut state: AppState =
        serde_json::from_value(Value::Object(start)).map_err(|err| format!("`before`: {err}"))?;
    root_reduce(
        &mut state,
        field::<StateEvent>(request, "event")?,
        field(request, "now")?,
    );
    let mut state = serde_json::to_value(&state).map_err(|err| err.to_string())?;
    match state.get_mut(&slice) {
        Some(after) => Ok(after.take()),
        None => Err(format!("unknown slice `{slice}`")),
    }
}

fn reduce_steps(request: &Value) -> Result<Value, String> {
    let mut state: AppState = field(request, "state")?;
    let steps: Vec<Value> = field(request, "steps")?;
    for (index, step) in steps.iter().enumerate() {
        let event =
            field::<StateEvent>(step, "event").map_err(|err| format!("steps[{index}]: {err}"))?;
        let now = field(step, "now").map_err(|err| format!("steps[{index}]: {err}"))?;
        root_reduce(&mut state, event, now);
    }
    serde_json::to_value(&state).map_err(|err| err.to_string())
}

fn run(input: &str) -> Result<Value, String> {
    let request: Value = serde_json::from_str(input).map_err(|err| format!("request: {err}"))?;
    if request.get("steps").is_some() {
        reduce_steps(&request)
    } else {
        reduce_case(&request)
    }
}

fn main() -> ExitCode {
    let mut input = String::new();
    if let Err(err) = io::stdin().read_to_string(&mut input) {
        eprintln!("reduce: stdin: {err}");
        return ExitCode::FAILURE;
    }
    match run(&input) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("reduce: {err}");
            ExitCode::FAILURE
        }
    }
}
