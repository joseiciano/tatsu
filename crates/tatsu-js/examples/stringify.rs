use std::io::{BufRead, Write};

fn main() {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin is UTF-8 text");
        let record = match tatsu_js::parse_lenient(&line) {
            Ok(value) => format!(
                "={}\n{}\n\n",
                tatsu_js::stringify(&value),
                tatsu_js::stringify_pretty(&value)
            ),
            Err(_) => "!\n\n".to_string(),
        };
        out.write_all(record.as_bytes())
            .expect("stdout is writable");
        out.flush().expect("stdout is writable");
    }
}
