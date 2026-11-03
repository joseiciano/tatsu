use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::json;

use super::*;

struct Harness {
    _dir: tempfile::TempDir,
    now: Arc<AtomicI64>,
    log: ActivityLog,
}

impl Harness {
    fn new(file_before: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ACTIVITY_FILENAME);
        if let Some(text) = file_before {
            std::fs::write(&path, text).unwrap();
        }
        let now = Arc::new(AtomicI64::new(1_000));
        let clock_now = Arc::clone(&now);
        let log = ActivityLog::new(
            path,
            Handle::current(),
            Arc::new(move || clock_now.load(Ordering::SeqCst)),
        );
        Self {
            _dir: dir,
            now,
            log,
        }
    }

    fn at(&self, t: i64) -> &ActivityLog {
        self.now.store(t, Ordering::SeqCst);
        &self.log
    }

    fn file(&self) -> Option<String> {
        std::fs::read_to_string(self.log.path()).ok()
    }
}

#[tokio::test(start_paused = true)]
async fn legacy_event_lists_load_as_records_with_created_at_from_the_first_event() {
    let h = Harness::new(Some(
        r#"{"/a":[{"t":5,"s":"processing"},{"t":9,"s":"idle"}],"/b":[]}"#,
    ));
    assert_eq!(
        h.log.get(),
        json!({
            "/a": {"events": [{"t": 5, "s": "processing"}, {"t": 9, "s": "idle"}], "createdAt": 5},
            "/b": {"events": []}
        })
    );
}

#[tokio::test(start_paused = true)]
async fn missing_or_unparseable_files_read_as_empty() {
    assert_eq!(Harness::new(None).log.get(), json!({}));
    assert_eq!(Harness::new(Some("{not json")).log.get(), json!({}));
    assert_eq!(Harness::new(Some("42")).log.get(), json!({}));
}

#[tokio::test(start_paused = true)]
async fn record_shape_is_normalized_to_the_ts_field_order_and_unknown_fields_drop() {
    let h = Harness::new(Some(
        r#"{"/a":{"events":[{"t":1,"s":"idle"}],"future":true,"prState":"open","branch":"main"}}"#,
    ));
    let text = tatsu_js::stringify(&h.log.get());
    assert_eq!(
        text,
        r#"{"/a":{"branch":"main","prState":"open","events":[{"t":1,"s":"idle"}]}}"#
    );
}

#[tokio::test(start_paused = true)]
async fn a_normalized_file_serializes_back_to_the_same_bytes() {
    let bytes = r#"{"/w/a":{"branch":"feat","repoRoot":"/w","createdAt":1700000000000,"removedAt":1700000500000,"diffStats":{"added":12,"removed":3,"files":2},"prNumber":41,"prState":"merged","events":[{"t":1700000000000,"s":"processing"},{"t":1700000500000,"s":"merged"}]},"/w/b":{"branch":"x","events":[]}}"#;
    let h = Harness::new(Some(bytes));
    assert_eq!(tatsu_js::stringify(&h.log.get()), bytes);
}

#[tokio::test(start_paused = true)]
async fn the_save_lands_one_second_after_the_first_change_and_later_changes_do_not_push_it_back() {
    let h = Harness::new(None);
    let start = tokio::time::Instant::now();
    h.at(10).record("/a", ActivityState::Processing);
    tokio::time::sleep(Duration::from_millis(600)).await;
    h.at(20).record("/a", ActivityState::Waiting);
    assert_eq!(h.file(), None);

    let mut saves = h.log.saves();
    saves.changed().await.unwrap();

    assert_eq!(start.elapsed(), SAVE_DELAY);
    assert_eq!(
        h.file().as_deref(),
        Some(
            r#"{"/a":{"events":[{"t":10,"s":"processing"},{"t":20,"s":"waiting"}],"createdAt":10}}"#
        )
    );
}

#[tokio::test(start_paused = true)]
async fn a_change_after_the_save_fires_schedules_a_new_save() {
    let h = Harness::new(None);
    h.at(10).record("/a", ActivityState::Processing);
    h.log.settled().await;
    h.at(20).record("/a", ActivityState::Idle);
    h.log.settled().await;
    assert_eq!(
        h.file().as_deref(),
        Some(r#"{"/a":{"events":[{"t":10,"s":"processing"},{"t":20,"s":"idle"}],"createdAt":10}}"#)
    );
}

#[tokio::test(start_paused = true)]
async fn repeating_the_last_state_is_not_recorded() {
    let h = Harness::new(None);
    h.at(10).record("/a", ActivityState::Idle);
    h.at(20).record("/a", ActivityState::Idle);
    assert_eq!(h.log.get()["/a"]["events"], json!([{"t": 10, "s": "idle"}]));
}

#[tokio::test(start_paused = true)]
async fn only_the_newest_events_are_kept() {
    let events: Vec<Value> = (0..MAX_EVENTS_PER_WORKTREE + 3)
        .map(|i| json!({"t": i, "s": if i % 2 == 0 { "idle" } else { "processing" }}))
        .collect();
    let h = Harness::new(Some(&tatsu_js::stringify(&json!({"/a": events}))));
    h.at(99_999).record("/a", ActivityState::Waiting);
    let kept = h.log.get()["/a"]["events"].as_array().unwrap().clone();
    assert_eq!(kept.len(), MAX_EVENTS_PER_WORKTREE);
    assert_eq!(kept[0]["t"], json!(4));
    assert_eq!(kept.last().unwrap(), &json!({"t": 99_999, "s": "waiting"}));
}

#[tokio::test(start_paused = true)]
async fn touch_meta_without_a_change_does_not_save() {
    let h = Harness::new(Some(r#"{"/a":{"branch":"main","events":[]}}"#));
    h.log.touch_meta("/a", Some("main"), Some(""));
    h.log.touch_meta("/a", None, None);
    h.log.settled().await;
    assert_eq!(*h.log.saves().borrow(), 0);
}

#[tokio::test(start_paused = true)]
async fn finalize_of_an_unknown_worktree_writes_nothing() {
    let h = Harness::new(None);
    h.log.finalize("/nope", &FinalizeInfo::default());
    h.log.settled().await;
    assert_eq!(h.file(), None);
}

#[tokio::test(start_paused = true)]
async fn seal_with_no_active_segment_writes_nothing_and_keeps_the_pending_save() {
    let h = Harness::new(Some(
        r#"{"/a":{"events":[{"t":1,"s":"merged"}]},"/b":{"removedAt":5,"events":[{"t":1,"s":"processing"}]},"/c":{"events":[]}}"#,
    ));
    h.log.seal_all();
    assert_eq!(*h.log.saves().borrow(), 0);

    h.at(10).record("/d", ActivityState::Idle);
    h.log.seal_all();
    assert_eq!(*h.log.saves().borrow(), 0);
    h.log.settled().await;
    assert_eq!(*h.log.saves().borrow(), 1);
}

#[tokio::test(start_paused = true)]
async fn seal_writes_at_once_and_cancels_the_pending_save() {
    let h = Harness::new(None);
    h.at(10).record("/a", ActivityState::Processing);
    h.at(20).seal_all();
    let sealed =
        r#"{"/a":{"events":[{"t":10,"s":"processing"},{"t":20,"s":"idle"}],"createdAt":10}}"#;
    assert_eq!(h.file().as_deref(), Some(sealed));
    assert_eq!(*h.log.saves().borrow(), 1);
    tokio::time::sleep(SAVE_DELAY * 2).await;
    h.log.settled().await;
    assert_eq!(*h.log.saves().borrow(), 1);
}
