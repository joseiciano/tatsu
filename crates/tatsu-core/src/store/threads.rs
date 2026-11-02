use std::sync::{Arc, Mutex};
use std::thread;

use tatsu_state::AppState;

use super::Store;
use super::tests::theme_dark;

#[test]
fn eight_threads_dispatching_give_a_gap_free_seq() {
    let store = Arc::new(Store::new(AppState::default()));
    let hub_seqs = Arc::new(Mutex::new(Vec::new()));
    let sub_seqs = Arc::new(Mutex::new(Vec::new()));
    let h = hub_seqs.clone();
    store.set_hub_sink(move |_, seq| h.lock().unwrap().push(seq));
    let s = sub_seqs.clone();
    store.subscribe(move |_, seq| s.lock().unwrap().push(seq));

    let workers: Vec<_> = (0..8)
        .map(|t| {
            let store = store.clone();
            thread::spawn(move || {
                for i in 0..1000 {
                    store.dispatch(theme_dark(&format!("{t}-{i}")));
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }

    let expected: Vec<u64> = (1..=8000).collect();
    assert_eq!(*hub_seqs.lock().unwrap(), expected);
    assert_eq!(*sub_seqs.lock().unwrap(), expected);
    assert_eq!(store.seq(), 8000);
}
