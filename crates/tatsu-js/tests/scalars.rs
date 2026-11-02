use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use proptest::prelude::*;
use proptest::test_runner::Config;
use serde_json::{Value, json};
use tatsu_js::{
    encode_uri_component, number_to_string, parse_int, parse_lenient, stringify, to_fixed,
    to_js_string, to_number, trim, truthy, utf16_len,
};

struct Oracle {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Debug, Clone)]
enum Outcome {
    Number(f64),
    Bool(bool),
    Json(String),
    Thrown,
}

impl PartialEq for Outcome {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Outcome::Number(a), Outcome::Number(b)) => {
                (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
            }
            (Outcome::Bool(a), Outcome::Bool(b)) => a == b,
            (Outcome::Json(a), Outcome::Json(b)) => a == b,
            (Outcome::Thrown, Outcome::Thrown) => true,
            _ => false,
        }
    }
}

fn oracle() -> &'static Mutex<Oracle> {
    static ORACLE: OnceLock<Mutex<Oracle>> = OnceLock::new();
    ORACLE.get_or_init(|| {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/core/json-oracle.mjs");
        let mut child = Command::new("node")
            .arg(&script)
            .arg("scalars")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| {
                panic!("cannot start `node` for the scalar oracle ({error}); install Node 20 and put `node` on PATH")
            });
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        Mutex::new(Oracle {
            _child: child,
            stdin,
            stdout,
        })
    })
}

fn node_number(text: &str) -> f64 {
    match text {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => text
            .parse()
            .unwrap_or_else(|_| panic!("bad oracle number {text}")),
    }
}

fn node(request: &str) -> Outcome {
    assert!(
        !request.contains(['\n', '\r']),
        "oracle input must be one line"
    );
    let mut oracle = oracle()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    writeln!(oracle.stdin, "{request}").expect("write to node");
    oracle.stdin.flush().expect("flush to node");

    let mut record = String::new();
    oracle
        .stdout
        .read_line(&mut record)
        .expect("read from node");
    let mut blank = String::new();
    oracle.stdout.read_line(&mut blank).expect("read from node");
    assert!(
        blank == "\n",
        "malformed oracle record: {record:?} {blank:?}"
    );
    let record = record.strip_suffix('\n').expect("node answered");
    match record.split_once(':') {
        Some(("n", n)) => Outcome::Number(node_number(n)),
        Some(("b", b)) => Outcome::Bool(b == "true"),
        Some(("s", s)) => Outcome::Json(s.to_string()),
        _ if record == "!" => Outcome::Thrown,
        _ => panic!("malformed oracle record: {record:?}"),
    }
}

fn text(s: String) -> Outcome {
    Outcome::Json(stringify(&Value::String(s)))
}

fn rust(request: &str) -> Outcome {
    let request = parse_lenient(request).expect("generated request parses");
    let input = &request["input"];
    let string = || input.as_str().expect("string input");
    match request["op"].as_str().expect("op") {
        "number" => Outcome::Number(to_number(input)),
        "truthy" => Outcome::Bool(truthy(input)),
        "string" => text(to_js_string(input)),
        "trim" => text(trim(string()).to_string()),
        "parseInt" => {
            let radix = request["radix"].as_u64().expect("radix") as u32;
            Outcome::Number(parse_int(string(), radix))
        }
        "encodeURIComponent" => encode_uri_component(string()).map_or(Outcome::Thrown, text),
        "utf16Length" => Outcome::Number(utf16_len(string()) as f64),
        "toFixed" => {
            let x: f64 = string().parse().expect("toFixed input is a JS number");
            let digits = request["digits"].as_u64().expect("digits") as u32;
            text(to_fixed(x, digits))
        }
        op => panic!("unknown op {op}"),
    }
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn render_string(units: &[u16], out: &mut String) {
    out.push('"');
    for &unit in units {
        match unit {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x20..=0x7E => out.push(char::from(unit as u8)),
            _ => out.push_str(&format!("\\u{unit:04x}")),
        }
    }
    out.push('"');
}

fn quoted(units: &[u16]) -> String {
    let mut out = String::new();
    render_string(units, &mut out);
    out
}

#[derive(Debug, Clone)]
enum Doc {
    Null,
    Bool(bool),
    Number(String),
    String(Vec<u16>),
    Array(Vec<Doc>),
    Object(Vec<(Vec<u16>, Doc)>),
}

fn render(doc: &Doc, out: &mut String) {
    match doc {
        Doc::Null => out.push_str("null"),
        Doc::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Doc::Number(text) => out.push_str(text),
        Doc::String(units) => render_string(units, out),
        Doc::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render(item, out);
            }
            out.push(']');
        }
        Doc::Object(entries) => {
            out.push('{');
            for (i, (key, value)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render_string(key, out);
                out.push(':');
                render(value, out);
            }
            out.push('}');
        }
    }
}

const EDGE_STRINGS: &[&str] = &[
    "",
    " ",
    "  ",
    " 12 ",
    "1_000",
    "0b11",
    "0B102",
    "0o17",
    "0O8",
    "0x1f",
    "0X1F",
    "-0x1f",
    "+0x1f",
    "0x",
    "08",
    "007",
    "-0",
    "+0",
    "Infinity",
    "-Infinity",
    "+Infinity",
    "infinity",
    "inf",
    "NaN",
    ".5",
    "5.",
    ".",
    "+.5",
    "-.e1",
    "1e",
    "e5",
    "1e+5",
    "1E-5",
    "1.2.3",
    "12px",
    "  -12.5e1xyz",
    "\u{00A0}12\u{2028}",
    "\u{FEFF}7",
    "\u{0085}7",
    "\u{200B}7",
    "\u{0661}\u{0662}",
    "9007199254740993",
    "1e400",
    "-1e-400",
    "123456789012345678901234567890",
    "0x1fffffffffffff",
    "0x20000000000001",
    "0x20000000000003",
    "0x1fffffffffffff8000000000000000000000",
    "zz",
    "ZZZZZZZZZ",
    "a b&c=d/e?f#g",
    "-_.!~*'()",
    "\u{E9}\u{20AC}\u{1F600}",
    "\u{FDD0}",
];

fn code_units() -> impl Strategy<Value = Vec<u16>> {
    const PIECES: &[&str] = &[
        "0",
        "1",
        "5",
        "7",
        "8",
        "9",
        "a",
        "f",
        "z",
        "Z",
        "x",
        "X",
        "o",
        "b",
        "B",
        "e",
        "E",
        ".",
        "+",
        "-",
        "_",
        " ",
        "\t",
        "\n",
        "%",
        "&",
        "=",
        "/",
        "?",
        "#",
        "~",
        "'",
        "(",
        "Infinity",
        "\u{00A0}",
        "\u{2028}",
        "\u{3000}",
        "\u{FEFF}",
        "\u{0085}",
        "\u{E9}",
        "\u{1F600}",
        "\u{FDD0}",
    ];
    let piece = prop_oneof![
        6 => prop::sample::select(PIECES).prop_map(units),
        1 => (0u16..0x20).prop_map(|u| vec![u]),
        1 => (0x80u16..0xD800).prop_map(|u| vec![u]),
        2 => (0xD800u16..=0xDFFF).prop_map(|u| vec![u]),
        1 => ((0xD800u16..0xDC00), (0xDC00u16..=0xDFFF)).prop_map(|(h, l)| vec![h, l]),
        1 => (0u16..0x800).prop_map(|offset| {
            let mut v = vec![0xFDD0];
            v.extend(units(&char::from_u32(0xF0000 + u32::from(offset)).unwrap().to_string()));
            v
        }),
    ];
    prop::collection::vec(piece, 0..8).prop_map(|pieces| pieces.concat())
}

fn strings() -> impl Strategy<Value = Vec<u16>> {
    prop_oneof![
        1 => prop::sample::select(EDGE_STRINGS).prop_map(units),
        1 => (prop::sample::select(EDGE_STRINGS), code_units())
            .prop_map(|(edge, tail)| [units(edge), tail].concat()),
        2 => code_units(),
    ]
}

fn finite() -> impl Strategy<Value = f64> {
    any::<f64>().prop_filter("finite", |f| f.is_finite())
}

fn number_texts() -> impl Strategy<Value = String> {
    prop_oneof![
        1 => prop::sample::select(&["0", "-0", "0.5", "-1", "1e21", "1e-7"][..]).prop_map(str::to_string),
        2 => any::<i32>().prop_map(|n| n.to_string()),
        2 => finite().prop_map(|f| format!("{f:e}")),
    ]
}

fn docs() -> impl Strategy<Value = Doc> {
    let leaf = prop_oneof![
        Just(Doc::Null),
        any::<bool>().prop_map(Doc::Bool),
        number_texts().prop_map(Doc::Number),
        strings().prop_map(Doc::String),
    ];
    leaf.prop_recursive(3, 24, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(Doc::Array),
            prop::collection::vec((code_units(), inner), 0..4).prop_map(Doc::Object),
        ]
    })
}

fn tie_heavy_doubles() -> impl Strategy<Value = f64> {
    prop_oneof![
        2 => finite(),
        2 => (-100_000i64..100_000, 0u32..12).prop_map(|(n, k)| n as f64 / f64::from(1u32 << k)),
        1 => (-1000i64..1000, 0u32..6).prop_map(|(n, k)| n as f64 / 10f64.powi(k as i32)),
        1 => prop::sample::select(&[1.005, 2.5, -2.5, 0.000001, -1.5, 1e21, -1e21, 999999999999999999999.0, 1e20, -0.0, 0.0][..]),
    ]
}

fn radix_cases() -> impl Strategy<Value = (Vec<u16>, u32)> {
    let any_base = "[0-9a-zA-Z]{1,30}".prop_map(|s| units(&s));
    let long = "[0-9a-fA-F]{1,40}".prop_map(|s| units(&s));
    prop_oneof![
        3 => (strings(), prop::sample::select(&[0u32, 0, 10, 16, 1, 37, 100][..])),
        1 => (long, prop::sample::select(&[0u32, 2, 4, 8, 10, 16, 32][..])),
        2 => (any_base, 2u32..=36),
    ]
}

proptest! {
    #![proptest_config(Config { cases: 1500, failure_persistence: None, ..Config::default() })]

    #[test]
    fn value_coercions_match_node(doc in docs()) {
        let mut input = String::new();
        render(&doc, &mut input);
        for op in ["number", "truthy", "string"] {
            let request = format!(r#"{{"op":"{op}","input":{input}}}"#);
            prop_assert_eq!(rust(&request), node(&request), "{}", request);
        }
    }

    #[test]
    fn string_helpers_match_node(s in strings()) {
        let input = quoted(&s);
        for op in ["number", "trim", "encodeURIComponent", "utf16Length", "parseInt"] {
            let request = format!(r#"{{"op":"{op}","input":{input},"radix":0}}"#);
            prop_assert_eq!(rust(&request), node(&request), "{}", request);
        }
    }

    #[test]
    fn parse_int_matches_node((s, radix) in radix_cases()) {
        let request = format!(r#"{{"op":"parseInt","input":{},"radix":{radix}}}"#, quoted(&s));
        prop_assert_eq!(rust(&request), node(&request), "{}", request);
    }

    #[test]
    fn to_fixed_matches_node(x in tie_heavy_doubles(), digits in 0u32..=3) {
        let request = json!({"op": "toFixed", "input": number_to_string(x), "digits": digits});
        let request = stringify(&request);
        prop_assert_eq!(rust(&request), node(&request), "{}", request);
    }
}
