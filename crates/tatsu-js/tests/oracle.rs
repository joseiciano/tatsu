use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use proptest::prelude::*;
use proptest::test_runner::Config;
use tatsu_js::{parse_lenient, stringify, stringify_pretty};

struct Oracle {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    Written { compact: String, pretty: String },
    Rejected,
}

fn oracle() -> &'static Mutex<Oracle> {
    static ORACLE: OnceLock<Mutex<Oracle>> = OnceLock::new();
    ORACLE.get_or_init(|| {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/core/json-oracle.mjs");
        let mut child = Command::new("node")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| {
                panic!("cannot start `node` for the JSON oracle ({error}); install Node 20 and put `node` on PATH")
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

fn node(text: &str) -> Outcome {
    assert!(
        !text.contains(['\n', '\r']),
        "oracle input must be one line"
    );
    let mut oracle = oracle()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    writeln!(oracle.stdin, "{text}").expect("write to node");
    oracle.stdin.flush().expect("flush to node");

    let mut lines = Vec::new();
    loop {
        let mut line = String::new();
        let read = oracle.stdout.read_line(&mut line).expect("read from node");
        assert!(read > 0, "node exited before answering");
        let line = line.strip_suffix('\n').unwrap_or(&line).to_string();
        if line.is_empty() {
            break;
        }
        lines.push(line);
    }
    match lines.split_first() {
        Some((first, rest)) if first.starts_with('=') => Outcome::Written {
            compact: first[1..].to_string(),
            pretty: rest.join("\n"),
        },
        Some((first, _)) if first == "!" => Outcome::Rejected,
        _ => panic!("malformed oracle record: {lines:?}"),
    }
}

fn rust(text: &str) -> Outcome {
    match parse_lenient(text) {
        Ok(value) => Outcome::Written {
            compact: stringify(&value),
            pretty: stringify_pretty(&value),
        },
        Err(_) => Outcome::Rejected,
    }
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

fn render_string(units: &[u16], out: &mut String) {
    out.push('"');
    for &unit in units {
        match unit {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x0A => out.push_str("\\n"),
            0x20..=0x7E => out.push(char::from(unit as u8)),
            _ => out.push_str(&format!("\\u{unit:04x}")),
        }
    }
    out.push('"');
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn code_units() -> impl Strategy<Value = Vec<u16>> {
    let piece = prop_oneof![
        4 => (0x20u16..0x7F).prop_map(|u| vec![u]),
        1 => (0u16..0x20).prop_map(|u| vec![u]),
        1 => Just(vec![0x7F]),
        1 => prop_oneof![Just(vec![0x2028]), Just(vec![0x2029])],
        1 => (0x80u16..0xD800).prop_map(|u| vec![u]),
        1 => (0xE000u16..=0xFFFF).prop_map(|u| vec![u]),
        2 => (0xD800u16..=0xDFFF).prop_map(|u| vec![u]),
        1 => ((0xD800u16..0xDC00), (0xDC00u16..=0xDFFF)).prop_map(|(h, l)| vec![h, l]),
        1 => Just(vec![0xFDD0]),
        1 => Just(units("\u{F0000}")),
        1 => (0u16..0x800).prop_map(|offset| {
            let mut v = vec![0xFDD0];
            v.extend(units(&char::from_u32(0xF0000 + u32::from(offset)).unwrap().to_string()));
            v
        }),
    ];
    prop::collection::vec(piece, 0..8).prop_map(|pieces| pieces.concat())
}

fn keys() -> impl Strategy<Value = Vec<u16>> {
    const POOL: &[&str] = &[
        "a",
        "b",
        "z",
        "0",
        "1",
        "2",
        "10",
        "01",
        "-1",
        "1.5",
        "4294967294",
        "4294967295",
        "__proto__",
        "",
    ];
    prop_oneof![
        2 => prop::sample::select(POOL).prop_map(units),
        1 => code_units(),
    ]
}

fn number_texts() -> impl Strategy<Value = String> {
    const FIXED: &[&str] = &[
        "0",
        "-0",
        "-0.0",
        "0.0",
        "1e21",
        "1e-7",
        "1e400",
        "-1e400",
        "1e-400",
        "12345678901234567890",
        "9007199254740993",
        "-9007199254740993",
        "0.30000000000000004",
        "1E+2",
        "5e-324",
    ];
    prop_oneof![
        1 => prop::sample::select(FIXED).prop_map(str::to_string),
        2 => any::<i64>().prop_map(|n| n.to_string()),
        2 => any::<f64>()
            .prop_filter("finite", |f| f.is_finite())
            .prop_map(|f| format!("{f:e}")),
        1 => any::<f64>()
            .prop_filter("finite", |f| f.is_finite())
            .prop_map(|f| format!("{f}")),
        2 => (any::<bool>(), 1u64..100_000_000_000, -330i32..330)
            .prop_map(|(neg, digits, exp)| format!("{}{digits}e{exp}", if neg { "-" } else { "" })),
        1 => (-30i32..30, 1u32..1000).prop_map(|(int, frac)| format!("{int}.{frac}")),
    ]
}

fn docs() -> impl Strategy<Value = Doc> {
    let leaf = prop_oneof![
        Just(Doc::Null),
        any::<bool>().prop_map(Doc::Bool),
        number_texts().prop_map(Doc::Number),
        code_units().prop_map(Doc::String),
    ];
    leaf.prop_recursive(4, 64, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Doc::Array),
            prop::collection::vec((keys(), inner), 0..6).prop_map(Doc::Object),
        ]
    })
}

fn json_ish() -> impl Strategy<Value = String> {
    "[\\[\\]{}\":,0-9eE.+\\-tfnrulasx \t\\\\/]{0,40}"
}

fn mutated_documents() -> impl Strategy<Value = String> {
    const EDITS: &[char] = &[
        '0', '1', '-', '+', '.', 'e', 'E', '"', '\\', ',', ':', '[', ']', '{', '}', ' ', '\t', 'u',
        'x',
    ];
    (
        docs(),
        any::<prop::sample::Index>(),
        0u8..3,
        prop::sample::select(EDITS),
    )
        .prop_map(|(doc, at, op, edit)| {
            let mut text = String::new();
            render(&doc, &mut text);
            let mut chars: Vec<char> = text.chars().collect();
            let i = at.index(chars.len() + 1);
            match op {
                0 if i < chars.len() => {
                    chars.remove(i);
                }
                1 if i < chars.len() => chars[i] = edit,
                _ => chars.insert(i, edit),
            }
            chars.into_iter().collect()
        })
}

proptest! {
    #![proptest_config(Config { cases: 2000, failure_persistence: None, ..Config::default() })]

    #[test]
    fn writers_match_json_stringify(doc in docs()) {
        let mut text = String::new();
        render(&doc, &mut text);

        let expected = node(&text);
        prop_assert_eq!(rust(&text), expected.clone());

        let Outcome::Written { compact, pretty } = expected else {
            return Err(TestCaseError::fail(format!("node rejected generated JSON: {text}")));
        };
        let reparsed = parse_lenient(&pretty).expect("pretty output parses");
        prop_assert_eq!(stringify_pretty(&reparsed), pretty);
        let reparsed = parse_lenient(&compact).expect("compact output parses");
        prop_assert_eq!(stringify(&reparsed), compact);
    }

    #[test]
    fn parser_accepts_exactly_what_json_parse_accepts(text in json_ish()) {
        prop_assert_eq!(rust(&text), node(&text));
    }

    #[test]
    fn parser_matches_json_parse_on_mutated_documents(text in mutated_documents()) {
        prop_assert_eq!(rust(&text), node(&text));
    }
}
