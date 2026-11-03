pub(super) fn dirname(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return ".".into();
    }
    let has_root = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for i in (1..bytes.len()).rev() {
        if bytes[i] == b'/' {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None if has_root => "/".into(),
        None => ".".into(),
        Some(1) if has_root => "//".into(),
        Some(end) => path[..end].into(),
    }
}

pub(super) fn basename(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut start = 0;
    let mut end = None;
    let mut matched_slash = true;
    for i in (0..bytes.len()).rev() {
        if bytes[i] == b'/' {
            if !matched_slash {
                start = i + 1;
                break;
            }
        } else if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
    }
    end.map_or_else(String::new, |end| path[start..end].into())
}

pub(super) fn join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return ".".into();
    }
    normalize(&joined)
}

fn normalize(path: &str) -> String {
    let is_absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut out = normalize_string(path, !is_absolute);
    if out.is_empty() {
        return match (is_absolute, trailing) {
            (true, _) => "/".into(),
            (false, true) => "./".into(),
            (false, false) => ".".into(),
        };
    }
    if trailing {
        out.push('/');
    }
    if is_absolute { format!("/{out}") } else { out }
}

fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let bytes = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code = 0u8;
    for i in 0..=bytes.len() {
        if i < bytes.len() {
            code = bytes[i];
        } else if code == b'/' {
            break;
        } else {
            code = b'/';
        }
        let at = i as isize;
        if code == b'/' {
            if last_slash == at - 1 || dots == 1 {
            } else if dots == 2 {
                if res.len() < 2 || last_segment_length != 2 || !res.ends_with("..") {
                    if res.len() > 2 {
                        match res.rfind('/') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(index) => {
                                res.truncate(index);
                                let previous = res.rfind('/').map_or(-1, |p| p as isize);
                                last_segment_length = (res.len() as isize - 1 - previous) as usize;
                            }
                        }
                        last_slash = at;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = at;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    res.push_str(if res.is_empty() { ".." } else { "/.." });
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..i];
                if !res.is_empty() {
                    res.push('/');
                }
                res.push_str(segment);
                last_segment_length = (at - last_slash - 1) as usize;
            }
            last_slash = at;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_node_posix_path() {
        for (input, dir, base) in [
            ("/repo/a", "/repo", "a"),
            ("/repo/a/", "/repo", "a"),
            ("relative", ".", "relative"),
            ("", ".", ""),
            ("/", "/", ""),
            ("//a", "//", "a"),
            ("a/b//", "a", "b"),
        ] {
            assert_eq!(dirname(input), dir, "dirname({input:?})");
            assert_eq!(basename(input), base, "basename({input:?})");
        }
        for (parts, joined) in [
            (&["/repo", "a-worktrees"][..], "/repo/a-worktrees"),
            (&[".", "relative-worktrees"][..], "relative-worktrees"),
            (&[".", "-worktrees"][..], "-worktrees"),
            (&["/", "-worktrees"][..], "/-worktrees"),
            (&["/a/../../b", "./c//d/"][..], "/b/c/d/"),
            (&["a/..", ".."][..], ".."),
            (&["../x", "../../y"][..], "../../y"),
            (&["", ""][..], "."),
        ] {
            assert_eq!(join(parts), joined, "join({parts:?})");
        }
    }
}
