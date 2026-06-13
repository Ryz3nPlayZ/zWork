use serde_json::{json, Value};

const COMPACT_THRESHOLD_CHARS: usize = 120_000;
const KEEP_RECENT: usize = 4;

/// Estimate total character count across all messages.
pub fn estimate_chars(messages: &[Value]) -> usize {
    messages.iter().map(|m| {
        m.get("content").map(|c| {
            if let Some(s) = c.as_str() { s.len() }
            else { c.to_string().len() }
        }).unwrap_or(0)
    }).sum()
}

/// Determine if compaction should occur.
pub fn should_compact(messages: &[Value]) -> bool {
    let count = messages.len();
    count > KEEP_RECENT + 2 && estimate_chars(messages) > COMPACT_THRESHOLD_CHARS
}

/// Plan compaction: split messages into head (keep), middle (compact), tail (keep).
/// Returns (head_count, middle_messages, tail_count).
pub fn plan_compaction(messages: &[Value]) -> (usize, Vec<Value>, usize) {
    let total = messages.len();
    let tail = KEEP_RECENT.min(total);
    let head = 1; // Keep the system message (first message)
    let middle_count = total.saturating_sub(head + tail);

    let middle: Vec<Value> = messages[head..head + middle_count].to_vec();
    (head, middle, tail)
}

/// Build a synthetic assistant message that summarizes the middle section.
pub fn render_summary_message(summary: &str) -> Value {
    json!({
        "role": "assistant",
        "content": format!("[Conversation summary]\n\n{}", summary),
    })
}

/// Build the summarization prompt for the LLM.
pub fn summarization_prompt(middle_messages: &[Value]) -> String {
    let mut msg_text = String::new();
    for m in middle_messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
        let content = m.get("content").map(|c| {
            if let Some(s) = c.as_str() { s.to_string() }
            else { c.to_string() }
        }).unwrap_or_default();

        // Truncate individual messages to keep the prompt manageable
        let truncated = if content.len() > 2000 {
            format!("{}...[truncated]", &content[..2000])
        } else {
            content
        };

        msg_text.push_str(&format!("[{}] {}\n\n", role, truncated));
    }

    format!(
        "Summarize this conversation excerpt in 3-8 short markdown paragraphs.\n\
         Preserve: goals, decisions made, files created/modified, tool results worth remembering, promises to the user.\n\
         Drop: pleasantries, draft iterations, verbatim tool output, repetition.\n\
         Be concise and factual.\n\n\
         ---\n\n{}",
        msg_text
    )
}

/// Build the compacted message history: system + summary + recent tail.
pub fn build_compacted_history(
    messages: &[Value],
    summary: &str,
    head: usize,
    tail: usize,
) -> Vec<Value> {
    let mut result = Vec::new();

    // Keep head (system message)
    if head > 0 {
        result.extend_from_slice(&messages[..head]);
    }

    // Add synthetic summary message
    // Insert as user→assistant pair so the LLM context is coherent
    result.push(json!({
        "role": "user",
        "content": "[System: Earlier conversation was summarized]"
    }));
    result.push(render_summary_message(summary));

    // Keep tail
    let tail_start = messages.len().saturating_sub(tail);
    result.extend_from_slice(&messages[tail_start..]);

    result
}
