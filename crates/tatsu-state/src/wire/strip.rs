use crate::StateSnapshot;

pub fn strip_snapshot_for_wire(mut snapshot: StateSnapshot) -> StateSnapshot {
    for session in snapshot.state.json_claude.sessions.values_mut() {
        session.entries = Vec::new();
        session.entries_hydrated = false;
    }
    snapshot
}
