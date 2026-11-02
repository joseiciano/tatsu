use serde::Serialize;
use specta::{Type, Types};
use tatsu_state::export_typescript;

#[derive(Type, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct CostSummaryReply {
    session_id: String,
    total_tokens: u64,
    cost_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    raw_usage: serde_json::Value,
}

#[derive(Type, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(dead_code)]
enum CostSummaryRequest {
    ForSession { session_id: String, since: i64 },
    All,
}

#[test]
fn exports_another_crates_types_with_the_shared_config() {
    let ts = export_typescript(
        Types::default()
            .register::<CostSummaryReply>()
            .register::<CostSummaryRequest>(),
    )
    .unwrap();

    assert!(ts.contains("export type CostSummaryReply = {"), "{ts}");
    assert!(ts.contains("\ttotalTokens: number,\n"), "{ts}");
    assert!(ts.contains("\tcostUsd: number,\n"), "{ts}");
    assert!(ts.contains("\tmodel?: string,\n"), "{ts}");
    assert!(ts.contains("\trawUsage: unknown,\n"), "{ts}");
    assert!(ts.contains("export type CostSummaryRequest ="), "{ts}");
    assert!(ts.contains("since: number"), "{ts}");
    assert!(!ts.contains("bigint"), "{ts}");
    assert!(!ts.contains("JsonValue"), "{ts}");
    assert!(!ts.contains("export type Value"), "{ts}");
    assert!(!ts.contains("| null"), "{ts}");
}
