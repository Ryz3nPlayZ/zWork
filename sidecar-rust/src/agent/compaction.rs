use serde_json::Value;

/// Tool results bigger than this (chars) are treated as bulky captures /
/// snapshots and evicted from history once a fresher one exists. AX trees and
/// large page snapshots routinely hit 5–50 KB each; uncapped, they dominate the
/// per-turn token cost because every turn re-sends the full history.
const LARGE_RESULT_THRESHOLD: usize = 2_000;

/// Evict bulky `tool_result` contents from history, sparing the final
/// `role:"user"` message (the freshest batch). Per the iron workflow the agent
/// re-captures after every state change, so prior captures/snapshots are stale
/// — their `element_index` tags no longer match the live UI — and only the
/// latest is ever needed. Small results (click acks, command output) are
/// preserved verbatim so working memory survives. The matching `tool_use_id`
/// is left intact, so the assistant/tool_result pairing required by the
/// Anthropic API stays valid.
///
/// This is cost + latency hygiene, not context survival. The model has a
/// 1M-token window and captures will not come close to exhausting it; but they
/// make every subsequent turn slower and more expensive, and a stale index
/// could mislead the model into clicking the wrong element.
pub fn evict_stale_bulky_results(history: &mut Vec<Value>) {
    let last_user_idx = history
        .iter()
        .rposition(|m| m.get("role").and_then(|v| v.as_str()) == Some("user"));
    let preserve_from = match last_user_idx {
        Some(idx) => idx,
        None => return,
    };

    let mut evicted = 0usize;
    for (i, m) in history.iter_mut().enumerate() {
        if i >= preserve_from {
            break;
        }
        if m.get("role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        let arr = match m.get_mut("content").and_then(|c| c.as_array_mut()) {
            Some(a) => a,
            None => continue,
        };
        for item in arr.iter_mut() {
            if item.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                continue;
            }
            let len = item
                .get("content")
                .and_then(|c| c.as_str())
                .map(|s| s.len())
                .unwrap_or(0);
            if len > LARGE_RESULT_THRESHOLD {
                let stub = format!(
                    "[earlier tool output omitted to save context — was {len} chars. \
                     Re-capture (desktop_capture / browser_snapshot) if you need the \
                     current screen state.]"
                );
                item["content"] = Value::String(stub);
                evicted += 1;
            }
        }
    }

    if evicted > 0 {
        tracing::debug!("[compaction] evicted {evicted} bulky prior tool result(s)");
    }
}
