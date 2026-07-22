use serde_json::{json, Value};
use std::collections::HashMap;

/// Tool results bigger than this (chars) are treated as bulky captures /
/// snapshots and evicted from history once a fresher one exists. AX trees and
/// large page snapshots routinely hit 5–50 KB each; uncapped, they dominate the
/// per-turn token cost because every turn re-sends the full history.
const LARGE_RESULT_THRESHOLD: usize = 2_000;

/// Index `tool_use_id` → (tool name, tool input) from the assistant
/// `tool_use` blocks, so an eviction stub can name the tool — and the file or
/// skill — that produced the bulky result instead of handing out
/// one-size-fits-all recovery advice.
fn tool_use_index(history: &[Value]) -> HashMap<String, (String, Value)> {
    let mut map = HashMap::new();
    for m in history {
        if m.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let arr = match m.get("content").and_then(|c| c.as_array()) {
            Some(a) => a,
            None => continue,
        };
        for item in arr {
            if item.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                continue;
            }
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input = item.get("input").cloned().unwrap_or(Value::Null);
            map.insert(id.to_string(), (name, input));
        }
    }
    map
}

/// Per-tool eviction stub. Captures/snapshots get the re-capture advice (they
/// really are stale after any state change); file reads name the path; skill
/// playbooks name the slug; everything else gets a neutral stub with no
/// (wrong) recovery instructions.
fn eviction_stub(tool_name: &str, input: &Value, len: usize) -> String {
    let lower = tool_name.to_ascii_lowercase();
    if lower.contains("capture") || lower.contains("snapshot") || lower.contains("screenshot") {
        return format!(
            "[earlier {tool_name} output omitted to save context — was {len} chars. \
             Re-capture (desktop_capture / browser_snapshot) if you need the \
             current screen state.]"
        );
    }
    if matches!(tool_name, "read_file" | "list_dir" | "grep_search") {
        let path = input.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let target = if path.is_empty() {
            String::new()
        } else {
            format!(" for `{path}`")
        };
        return format!(
            "[earlier {tool_name} output{target} omitted to save context — was {len} chars. \
             Re-read with read_file if you need it again.]"
        );
    }
    if tool_name == "read_skill" {
        let slug = input.get("slug").and_then(|v| v.as_str()).unwrap_or("");
        let target = if slug.is_empty() {
            String::new()
        } else {
            format!(" for `{slug}`")
        };
        return format!(
            "[earlier read_skill playbook{target} omitted to save context — was {len} chars. \
             Re-load with read_skill if you need it again.]"
        );
    }
    if tool_name.is_empty() {
        format!("[earlier tool output omitted to save context — was {len} chars.]")
    } else {
        format!("[earlier {tool_name} output omitted to save context — was {len} chars.]")
    }
}

/// Evict bulky `tool_result` contents from history, sparing the final
/// `role:"user"` message (the freshest batch). Per the iron workflow the agent
/// re-captures after every state change, so prior captures/snapshots are stale
/// — their `element_index` tags no longer match the live UI — and only the
/// latest is ever needed. Small results (click acks, command output) are
/// preserved verbatim so working memory survives. The matching `tool_use_id`
/// is left intact, so the assistant/tool_result pairing required by the
/// Anthropic API stays valid.
pub fn evict_stale_bulky_results(history: &mut Vec<Value>) {
    let last_user_idx = history
        .iter()
        .rposition(|m| m.get("role").and_then(|v| v.as_str()) == Some("user"));
    let preserve_from = match last_user_idx {
        Some(idx) => idx,
        None => return,
    };

    let tool_index = tool_use_index(history);

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
                let id = item.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                let (name, input) = tool_index.get(id).cloned().unwrap_or_default();
                item["content"] = Value::String(eviction_stub(&name, &input, len));
                evicted += 1;
            }
        }
    }

    if evicted > 0 {
        tracing::debug!("[compaction] evicted {evicted} bulky prior tool result(s)");
    }
}

/// Pick the model id used for compaction summarization. Summarization is a
/// background chore that re-runs whenever the conversation crosses ~200k tokens,
/// so it should always run on a **cheap tier** rather than whatever expensive
/// model the user is driving the chat with. The endpoint/headers passed to
/// `compact_conversation_history` are provider-level (one base_url + api_key
/// serves every model on that provider), so swapping only the model id lands the
/// request on the same provider's cheap tier — no new auth path, no new failure
/// mode.
///
/// Resolution order:
/// 1. `ZWORK_COMPACTION_MODEL` env override — pin an exact id if you want full
///    control (e.g. only one model is provisioned).
/// 2. The cheap tier of the main model's *family*, matched by keyword:
///    - deepseek / zwork-router → `deepseek-v4-flash`
///    - claude / anthropic      → `claude-haiku-4-5-20251001`
///    - gemini                  → `gemini-2.5-flash`
///    - gpt                     → `gpt-4.1-mini`
/// 3. Unknown family → fall back to the main model unchanged (compaction still
///    works; it's just not cheaper). We never invent an id that might 404 on a
///    provider we don't recognize.
pub fn compaction_model_id(shape: &str, main_model: &str) -> String {
    if let Ok(pinned) = std::env::var("ZWORK_COMPACTION_MODEL") {
        let pinned = pinned.trim();
        if !pinned.is_empty() {
            return pinned.to_string();
        }
    }
    let m = main_model.to_ascii_lowercase();
    if m.contains("deepseek") || m.contains("v4-pro") || m.contains("v4-flash") {
        "deepseek-v4-flash".to_string()
    } else if m.contains("claude") || shape == "anthropic" && m.is_empty() {
        "claude-haiku-4-5-20251001".to_string()
    } else if m.contains("gemini") {
        "gemini-2.5-flash".to_string()
    } else if m.contains("gpt") {
        "gpt-4.1-mini".to_string()
    } else {
        // Unknown provider: keep the main model so the request can't 404 on
        // a guessed id. Still correct, just not cheaper.
        main_model.to_string()
    }
}

/// Compact conversation history if it grows too large.
/// Format the history from index 1 to history.len() - 3, send a request to the LLM to
/// summarize it, and replace that chunk with a single summary message.
pub async fn compact_conversation_history(
    history: &mut Vec<Value>,
    endpoint: &str,
    headers: &reqwest::header::HeaderMap,
    shape: &str,
    model_id: &str,
) -> Result<(), String> {
    let total_chars: usize = history
        .iter()
        .map(|m| m.get("content").map(|c| c.to_string().len()).unwrap_or(0))
        .sum();

    // Trigger compaction if character count exceeds 800,000 characters (~200,000 tokens)
    // and there are enough messages to compact. We want to preserve system prompt (index 0)
    // and at least the last 3 messages (to preserve immediate conversational context).
    if total_chars <= 800_000 || history.len() <= 4 {
        return Ok(());
    }

    tracing::info!("[compaction] history has {total_chars} chars, triggering compaction pass");

    let end_idx = history.len() - 3;
    let messages_to_compact = &history[1..end_idx];

    let mut text_to_summarize = String::new();
    for m in messages_to_compact {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
        let content_val = m.get("content").unwrap_or(&Value::Null);
        
        let content_str = match content_val {
            Value::String(s) => s.clone(),
            Value::Array(arr) => arr
                .iter()
                .filter_map(|item| {
                    if let Some(txt) = item.get("text").and_then(|v| v.as_str()) {
                        Some(txt.to_string())
                    } else if item.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                        let tool_name = item.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("tool");
                        let res_content = item.get("content").unwrap_or(&Value::Null);
                        let res_str = match res_content {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        let preview: String = res_str.chars().take(200).collect();
                        Some(format!("Tool result [{}]: {}...", tool_name, preview))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
            other => other.to_string(),
        };

        text_to_summarize.push_str(&format!("{}: {}\n\n", role.to_uppercase(), content_str));
    }

    let client = reqwest::Client::new();
    let body = if shape == "anthropic" {
        json!({
            "model": model_id,
            "max_tokens": 1000,
            "system": "You are a concise context compaction engine. Summarize the conversation history.",
            "messages": [
                {
                    "role": "user",
                    "content": format!(
                        "Summarize the following conversation history concisely. Highlight key actions taken, file changes made, current status, and outstanding goals. Keep the summary under 500 words.\n\n### HISTORY:\n{}",
                        text_to_summarize
                    )
                }
            ],
            "stream": false
        })
    } else {
        json!({
            "model": model_id,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a concise context compaction engine. Summarize the conversation history."
                },
                {
                    "role": "user",
                    "content": format!(
                        "Summarize the following conversation history concisely. Highlight key actions taken, file changes made, current status, and outstanding goals. Keep the summary under 500 words.\n\n### HISTORY:\n{}",
                        text_to_summarize
                    )
                }
            ],
            "stream": false
        })
    };

    let resp = client
        .post(endpoint)
        .headers(headers.clone())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to request summarization: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_txt = resp.text().await.unwrap_or_default();
        return Err(format!("Summarization request failed with status {status}: {err_txt}"));
    }

    let resp_json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse summarization JSON: {e}"))?;

    let summary = if shape == "anthropic" {
        resp_json
            .get("content")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|f| f.get("text"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| format!("Invalid Anthropic response structure: {resp_json}"))?
            .to_string()
    } else {
        resp_json
            .get("choices")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|f| f.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or_else(|| format!("Invalid OpenAI response structure: {resp_json}"))?
            .to_string()
    };

    let summary_msg = json!({
        "role": "user",
        "content": format!(
            "[Your context was compacted. Here is a summary of the conversation history so far:\n\n{}\n\nDo not mention that you read a summary. Just continue naturally.]",
            summary
        )
    });

    history.drain(1..end_idx);
    history.insert(1, summary_msg);

    tracing::info!("[compaction] successfully compacted conversation history");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use reqwest::header::HeaderMap;

    #[test]
    fn test_compaction_model_picks_cheap_tier() {
        // Clear any leftover so the default-branch assertions are deterministic.
        // (Env is process-global, so the override check below lives in THIS
        // single test rather than a sibling, avoiding a parallel-test race on
        // the shared var.)
        std::env::remove_var("ZWORK_COMPACTION_MODEL");

        // Each family maps to its cheap tier...
        assert_eq!(compaction_model_id("openai", "deepseek-v4-pro"), "deepseek-v4-flash");
        assert_eq!(compaction_model_id("openai", "deepseek-v4-flash"), "deepseek-v4-flash");
        assert_eq!(compaction_model_id("anthropic", "claude-opus-4-8"), "claude-haiku-4-5-20251001");
        assert_eq!(compaction_model_id("openai", "gemini-2.5-pro"), "gemini-2.5-flash");
        assert_eq!(compaction_model_id("openai", "gpt-4.1"), "gpt-4.1-mini");
        // ...never the expensive main model.
        assert_ne!(compaction_model_id("anthropic", "claude-opus-4-8"), "claude-opus-4-8");
        // Unknown family keeps the main model (no invented id that could 404).
        assert_eq!(compaction_model_id("openai", "grok-4"), "grok-4");

        // Env override wins over family detection, then we restore default.
        std::env::set_var("ZWORK_COMPACTION_MODEL", "custom-flash-id");
        assert_eq!(compaction_model_id("anthropic", "claude-opus-4-8"), "custom-flash-id");
        std::env::remove_var("ZWORK_COMPACTION_MODEL");
    }

    #[tokio::test]
    async fn test_compaction_flow() {
        let app = Router::new().route(
            "/chat/completions",
            post(|Json(payload): Json<Value>| async move {
                let messages = payload.get("messages").unwrap().as_array().unwrap();
                assert_eq!(messages[0]["role"], "system");
                assert!(messages[1]["content"].as_str().unwrap().contains("Pele: uma lenda do futebol"));

                Json(json!({
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "This is a summary of Pele."
                            }
                        }
                    ]
                }))
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let bulky_text = "A".repeat(850_000);
        let mut history = vec![
            json!({
                "role": "system",
                "content": "System Prompt"
            }),
            json!({
                "role": "user",
                "content": format!("Pele: uma lenda do futebol. {}", bulky_text)
            }),
            json!({
                "role": "assistant",
                "content": "Pele was a legendary player."
            }),
            json!({
                "role": "user",
                "content": "This is message 3."
            }),
            json!({
                "role": "assistant",
                "content": "This is message 4."
            }),
            json!({
                "role": "user",
                "content": "Tell me more about Pelé."
            }),
        ];

        let endpoint = format!("http://{}/chat/completions", addr);
        let headers = HeaderMap::new();

        let res = compact_conversation_history(
            &mut history,
            &endpoint,
            &headers,
            "openai",
            "mock-model",
        ).await;

        assert!(res.is_ok());
        assert_eq!(history.len(), 5);
        assert_eq!(history[0]["role"], "system");
        assert_eq!(history[1]["role"], "user");
        assert!(history[1]["content"].as_str().unwrap().contains("This is a summary of Pele."));
        assert_eq!(history[2]["role"], "user");
        assert_eq!(history[2]["content"], "This is message 3.");
        assert_eq!(history[3]["role"], "assistant");
        assert_eq!(history[3]["content"], "This is message 4.");
        assert_eq!(history[4]["role"], "user");
        assert_eq!(history[4]["content"], "Tell me more about Pelé.");
    }
}
