use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::convert::Infallible;
use futures_util::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use crate::settings;
use crate::chatstore;
mod prompts;
mod stream;
mod compaction;

use prompts::convert_input_messages;
use stream::stream_upstream;
use crate::tools::{execute_tool, evaluate_tool_risk, get_tool_schemas, Risk};

fn pending_permission_gates() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn approve_gate(gate_id: &str) -> bool {
    let mut map = pending_permission_gates().lock().unwrap();
    if let Some(tx) = map.remove(gate_id) {
        let _ = tx.send(true);
        true
    } else {
        false
    }
}

pub fn reject_gate(gate_id: &str) -> bool {
    let mut map = pending_permission_gates().lock().unwrap();
    if let Some(tx) = map.remove(gate_id) {
        let _ = tx.send(false);
        true
    } else {
        false
    }
}

pub fn run_agent_turn(
    chat_id: String,
    model_id: String,
    user_message: String,
    attachments: Vec<crate::server::Attachment>,
    project_id: String,
    plan_mode: bool,
    auto_approve: bool,
) -> impl futures_util::Stream<Item = Result<Value, Infallible>> {
    let (tx, rx) = mpsc::channel(100);
    
    tokio::spawn(async move {
        let s = settings::load();
        
        // Load the chat history
        let mut chat = match chatstore::get(&chat_id) {
            Some(c) => c,
            None => {
                // Initialize the chat if missing
                chatstore::create("New chat", &model_id, &project_id)
            }
        };

        // Emit chat reconciliation event so the frontend can map its
        // provisional tmp_ ID to the real server-assigned chat ID.
        let _ = tx.send(json!({
            "type": "chat",
            "id": chat.id,
            "title": chat.title
        })).await;

        // Append user message if not already appended
        let user_content = prompts::build_user_content(&user_message, &attachments);
        let is_dup = chat.messages.last().map_or(false, |m| {
            m.role == "user" && m.content == user_content
        });
        if !is_dup && (!user_message.is_empty() || !attachments.is_empty()) {
            chatstore::append_message(&chat.id, "user", user_content);
            chat = chatstore::get(&chat.id).unwrap();
        }
        
        // 1. Resolve credentials
        let (api_key, base_url, shape, real_model_id, provider_display_name) = if model_id == "__claude_code__" {
            let cc_model = crate::server::read_claude_code_model().unwrap_or_default();
            let real_model = if cc_model.is_empty() || cc_model == "(default)" {
                "claude-3-5-sonnet-latest".to_string()
            } else {
                cc_model
            };
            if let Some(cred) = crate::server::resolve("claude_code", &s, "") {
                (cred.api_key, cred.base_url, cred.shape, real_model, "local credentials".to_string())
            } else {
                ("".to_string(), "https://api.anthropic.com".to_string(), "anthropic".to_string(), real_model, "local credentials".to_string())
            }
        } else if let Some(m) = s.custom_models.iter().find(|m| m.id == model_id) {
            let real_model = if m.model_id == "(default)" || m.model_id.is_empty() {
                "claude-3-5-sonnet-latest".to_string()
            } else {
                m.model_id.clone()
            };
            let provider_name = m.credential.clone();
            if let Some(cred) = crate::server::resolve(&m.credential, &s, &m.base_url_override) {
                (cred.api_key, cred.base_url, cred.shape, real_model, provider_name)
            } else {
                ("".to_string(), m.base_url_override.clone(), m.shape.clone(), real_model, provider_name)
            }
        } else {
            // Fallback: zwork_router default models
            let real_model = if model_id.contains("pro") {
                "deepseek-v4-pro".to_string()
            } else {
                "deepseek-v4-flash".to_string()
            };
            if let Some(cred) = crate::server::resolve("zwork_router", &s, "") {
                (cred.api_key, cred.base_url, cred.shape, real_model, "zWork Cloud Router".to_string())
            } else {
                ("".to_string(), "https://api.tryzwork.app/api".to_string(), "anthropic".to_string(), real_model, "zWork Cloud Router".to_string())
            }
        };

        // 2. Build system prompt
        let user_name = crate::server::display_name();
        let os_name = std::env::consts::OS.to_string();
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        let skills_list = crate::skills::format_for_system_prompt();
        let skills = crate::skills::list_skills();
        let example_slug = skills.first().map(|s| s.slug.as_str()).unwrap_or("frontend-design");

        let system_prompt = settings::build_system_prompt(
            &real_model_id,
            &provider_display_name,
            &user_name,
            &os_name,
            &cwd,
            "", // Project name optional
            "", // Project context optional
            plan_mode,
            auto_approve,
            &skills_list,
            example_slug
        );

        let mut history_messages = Vec::new();
        // Insert system prompt first
        history_messages.push(json!({
            "role": "system",
            "content": system_prompt
        }));
        for msg in &chat.messages {
            history_messages.push(json!({
                "role": msg.role,
                "content": msg.content
            }));
        }
            
        // Main multi-turn executor loop. A "turn" is one model inference + its
        // tool executions. Multi-step desktop/browser work (capture → act →
        // re-capture → …) routinely needs 15–30+ turns, and long tasks can run
        // for hundreds. The loop terminates *naturally* when the model stops
        // emitting tool calls (task done) or the user hits Stop — there is no
        // hard turn cap, because a fixed ceiling would abort legitimate long
        // work. ZWORK_MAX_TURNS opts in a runaway-only cost backstop for anyone
        // who wants one; when unset the loop runs unbounded.
        let mut turn = 0u32;
        let max_turns: Option<u32> = std::env::var("ZWORK_MAX_TURNS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&n| n > 0);
        
        // Initialize the assistant response message
        let assistant_msg = chatstore::append_message(&chat.id, "assistant", json!(""));
        let assistant_msg_id = assistant_msg.map(|m| m.id).unwrap_or_default();
        
        let mut accumulated_text = String::new();
        let mut accumulated_activities = Vec::new();
        
        while max_turns.map_or(true, |cap| turn < cap) {
            turn += 1;
            let _ = tx.send(json!({
                "type": "status",
                "text": "Thinking"
            })).await;
            
            let endpoint = if shape == "anthropic" {
                format!("{}/v1/messages", base_url)
            } else {
                format!("{}/chat/completions", base_url)
            };

            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("content-type", reqwest::header::HeaderValue::from_static("application/json"));

            use reqwest::header::HeaderValue;
            if shape == "anthropic" {
                let x_api_key = HeaderValue::try_from(api_key.clone()).unwrap_or_else(|_| HeaderValue::from_static(""));
                headers.insert("x-api-key", x_api_key);
                headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
                if !api_key.starts_with("sk-ant-") && !api_key.is_empty() {
                    let auth_str = format!("Bearer {}", api_key);
                    let auth_val = HeaderValue::try_from(auth_str).unwrap_or_else(|_| HeaderValue::from_static(""));
                    headers.insert("authorization", auth_val);
                }
            } else {
                let auth_str = format!("Bearer {}", api_key);
                let auth_val = HeaderValue::try_from(auth_str).unwrap_or_else(|_| HeaderValue::from_static(""));
                headers.insert("authorization", auth_val);
            }

            // Evict stale bulky tool results (old captures/snapshots) before
            // formatting the request. This is cost + latency hygiene, not
            // context survival: the model has a 1M-token window and captures
            // won't come close to exhausting it, but every turn re-sends the
            // full history, and the iron workflow re-captures after every state
            // change — so old captures/snapshots are stale (their
            // element_index tags no longer match the live UI), useless, and
            // expensive. Evicting them keeps each turn fast/cheap and stops the
            // model from acting on a stale index.
            compaction::evict_stale_bulky_results(&mut history_messages);

            // Format messages and tools payload
            let (system, convo) = convert_input_messages(&history_messages);
            
            let tools_payload = if shape == "anthropic" {
                let mut out = Vec::new();
                for t in get_tool_schemas(plan_mode) {
                    out.push(json!({
                        "name": t["name"],
                        "description": t["description"],
                        "input_schema": t["parameters"]
                    }));
                }
                out
            } else {
                let mut out = Vec::new();
                for t in get_tool_schemas(plan_mode) {
                    out.push(json!({
                        "type": "function",
                        "function": {
                            "name": t["name"],
                            "description": t["description"],
                            "parameters": t["parameters"]
                        }
                    }));
                }
                out
            };
            
            let body = if shape == "anthropic" {
                json!({
                    "model": real_model_id,
                    "system": system,
                    "messages": convo,
                    "stream": true,
                    "tools": tools_payload
                })
            } else {
                let mut messages_payload = vec![json!({"role": "system", "content": system})];
                let converted_convo = prompts::convert_convo_for_openai(&convo);
                messages_payload.extend(converted_convo);
                json!({
                    "model": real_model_id,
                    "messages": messages_payload,
                    "stream": true,
                    "tools": tools_payload
                })
            };
            
            // Call upstream token stream
            let mut stream = stream_upstream(endpoint, headers, body, shape.clone());
            let mut assistant_content_blocks: Vec<serde_json::Value> = Vec::new();
            let mut tool_calls = Vec::new();
            
            while let Some(evt_res) = stream.next().await {
                let evt = match evt_res {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                
                let et = evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if et == "delta" {
                    let text = evt.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    accumulated_text.push_str(text);
                    
                    if !text.is_empty() {
                        let mut merged = false;
                        if let Some(last_block) = assistant_content_blocks.last_mut() {
                            if last_block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                if let Some(last_text) = last_block.get_mut("text") {
                                    if let Some(t_str) = last_text.as_str() {
                                        *last_text = json!(format!("{}{}", t_str, text));
                                        merged = true;
                                    }
                                }
                            }
                        }
                        if !merged {
                            assistant_content_blocks.push(json!({
                                "type": "text",
                                "text": text
                            }));
                        }
                    }
                    
                    // Update chat storage and stream to frontend
                    let _ = chatstore::update_message(
                        &chat_id,
                        &assistant_msg_id,
                        Some(json!(accumulated_text)),
                        Some(accumulated_activities.clone())
                    );
                    let _ = tx.send(evt).await;
                } else if et == "tool_call" {
                    tool_calls.push(evt.clone());
                    assistant_content_blocks.push(json!({
                        "type": "tool_use",
                        "id": evt.get("id"),
                        "name": evt.get("name"),
                        "input": evt.get("input")
                    }));
                } else if et == "error" {
                    let _ = tx.send(evt).await;
                }
            }
            
            // Append assistant response to history
            history_messages.push(json!({
                "role": "assistant",
                "content": assistant_content_blocks
            }));

            // If no structured tool_calls came through, check if the model
            // output tool call syntax as plain text (common for providers
            // that don't support the `tools` API parameter).
            if tool_calls.is_empty() && !accumulated_text.is_empty() {
                if let Some(parsed) = parse_text_tool_calls(&accumulated_text) {
                    tool_calls = parsed;
                }
            }

            if tool_calls.is_empty() {
                break; // No more tool calls: loop completed
            }
            
            // Execute tool calls and collect results
            let mut tool_results = Vec::new();
            for tc in tool_calls {
                let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let params = tc.get("input").cloned().unwrap_or(json!({}));
                let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                
                // Safety permissions gate check
                let risk = evaluate_tool_risk(name, &params);
                let mut execute_allowed = true;
                
                if let Risk::Destructive { reason } = risk {
                    if !auto_approve {
                        let gate_id = format!("gate_{}", uuid::Uuid::new_v4().simple());

                        // Yield permission request
                        let _ = tx.send(json!({
                            "type": "permission",
                            "tool": name,
                            "reason": reason,
                            "blocked": true,
                            "gate_id": gate_id
                        })).await;
                        
                        let (gate_tx, gate_rx) = oneshot::channel();
                        {
                            let mut map = pending_permission_gates().lock().unwrap();
                            map.insert(gate_id.clone(), gate_tx);
                        }
                        
                        // Wait for user approval, with a long safety timeout so
                        // an unanswered prompt (UI closed, SSE stream dropped)
                        // can't hang the agent loop forever. On expiry we
                        // auto-deny and surface it to the user.
                        const GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
                        match tokio::time::timeout(GATE_TIMEOUT, gate_rx).await {
                            Ok(Ok(approved)) => {
                                execute_allowed = approved;
                            }
                            Ok(Err(_)) => {
                                // Gate dropped without a decision — deny.
                                execute_allowed = false;
                            }
                            Err(_) => {
                                let _ = tx.send(json!({
                                    "type": "status",
                                    "text": "Permission request timed out after 10 minutes and was auto-denied."
                                })).await;
                                execute_allowed = false;
                            }
                        }
                    }
                }
                
                if execute_allowed {
                    // Stream executing events
                    let mut tool_stream = execute_tool(name, params, &chat_id);
                    let mut final_result_txt = String::new();
                    let mut final_result_ok = true;
                    
                    while let Some(t_evt_res) = tool_stream.next().await {
                        let t_evt = match t_evt_res {
                            Ok(e) => e,
                            Err(_) => continue,
                        };
                        let type_str = t_evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if type_str == "activity" {
                            // Update activity block
                            let act_id = t_evt.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let act_label = t_evt.get("label").and_then(|v| v.as_str()).unwrap_or("");
                            let act_done = t_evt.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
                            
                            let entry = json!({
                                "id": act_id,
                                "label": act_label,
                                "done": act_done
                            });
                            
                            if let Some(pos) = accumulated_activities.iter().position(|x| x["id"] == act_id) {
                                accumulated_activities[pos] = entry;
                            } else {
                                accumulated_activities.push(entry);
                            }
                            
                            let _ = chatstore::update_message(
                                &chat_id,
                                &assistant_msg_id,
                                Some(json!(accumulated_text)),
                                Some(accumulated_activities.clone())
                            );
                            let _ = tx.send(t_evt).await;
                        } else if type_str == "tool_result" {
                            final_result_txt = t_evt.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            final_result_ok = t_evt.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
                            let _ = tx.send(t_evt).await;
                        } else {
                            let _ = tx.send(t_evt).await;
                        }
                    }
                    
                    tool_results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tc_id,
                        "content": final_result_txt,
                        "is_error": !final_result_ok
                    }));
                } else {
                    let refusal_msg = "Permission denied by user. Action aborted.";
                    let _ = tx.send(json!({
                        "type": "tool_result",
                        "tool": name,
                        "ok": false,
                        "message": refusal_msg
                    })).await;
                    
                    tool_results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tc_id,
                        "content": refusal_msg,
                        "is_error": true
                    }));
                }
            }
            
            // Append tool results to history messages for next completion turn
            history_messages.push(json!({
                "role": "user",
                "content": tool_results
            }));
        }
        
        let _ = tx.send(json!({
            "type": "done"
        })).await;

        let _ = tx.send(json!({
            "type": "end"
        })).await;
    });
    
    ReceiverStream::new(rx).map(Ok)
}

/// Known tool names that the text parser is allowed to match.
/// Anything else is ignored to prevent false positives from normal English text.
const KNOWN_TOOLS: &[&str] = &[
    "read_file", "list_dir", "write_file", "run_command",
    "extract_document", "web_search", "search_papers", "format_citation",
    "save_memory", "deploy_web_app", "read_skill", "spawn_agent",
    "ask_question", "ask_user", "ask_user_for_permission", "detect_hardware",
    "manage_tasks", "manage_events", "get_stock_data",
    "desktop_capture", "desktop_click", "desktop_type", "desktop_set_value",
    "desktop_scroll", "desktop_key", "desktop_launch_app", "desktop_list_apps",
    "desktop_wait", "desktop_start_session", "desktop_end_session",
    "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
    "browser_eval", "browser_scroll", "browser_screenshot", "browser_tabs",
];

/// Parse tool calls that a model outputted as plain text instead of
/// structured tool_use blocks. Handles patterns like:
///   ```json\n{"name": "read_file", "arguments": {"path": "foo.rs"}}\n```
///   read_file(path="foo.rs")
///
/// STRICT mode: only matches known tool names, caps at 3 calls max,
/// and requires arguments to contain key=value or JSON syntax.
fn parse_text_tool_calls(text: &str) -> Option<Vec<Value>> {
    let mut calls = Vec::new();

    // Pattern 1: JSON code blocks with "name" field referencing a known tool
    // e.g. ```json\n{"name": "read_file", "arguments": {"path": "foo.rs"}}\n```
    if let Some(start) = text.find("```json") {
        if let Some(end) = text[start + 7..].find("```") {
            let json_str = &text[start + 7..start + 7 + end];
            if let Ok(parsed) = serde_json::from_str::<Value>(json_str.trim()) {
                let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if KNOWN_TOOLS.contains(&name) {
                    let args = parsed.get("arguments")
                        .or_else(|| parsed.get("parameters"))
                        .cloned()
                        .unwrap_or(json!({}));
                    calls.push(json!({
                        "id": format!("text_tc_{}", calls.len()),
                        "name": name,
                        "input": args
                    }));
                }
            }
        }
    }

    // Pattern 2: bare function_call syntax BUT only for known tool names.
    // Matches: tool_name(key="value", ...) or tool_name({"json": "args"})
    for tool_name in KNOWN_TOOLS {
        if calls.len() >= 3 { break; } // Cap at 3 text-parsed calls
        // Look for `tool_name(` in the text — the opening paren after the exact tool name
        let needle = format!("{}(", tool_name);
        let mut search_from = 0;
        while let Some(pos) = text[search_from..].find(&needle) {
            if calls.len() >= 3 { break; }
            let abs_pos = search_from + pos;
            // Make sure it's not part of a longer word (e.g. "deploy_web_app" shouldn't match inside "my_deploy_web_app")
            if abs_pos > 0 {
                let prev_char = text.as_bytes()[abs_pos - 1];
                if prev_char.is_ascii_alphanumeric() || prev_char == b'_' {
                    search_from = abs_pos + needle.len();
                    continue;
                }
            }
            // Extract the content between the parentheses (balanced)
            let open_paren = abs_pos + tool_name.len();
            if let Some((args_str, _end)) = extract_balanced_parens(text, open_paren) {
                let args = parse_tool_args(&args_str);
                calls.push(json!({
                    "id": format!("text_tc_{}", calls.len()),
                    "name": tool_name,
                    "input": args
                }));
            }
            search_from = abs_pos + needle.len();
        }
    }

    if calls.is_empty() { None } else { Some(calls) }
}

/// Extract balanced parenthesized content starting at `start` (which should point to '(').
/// Returns the inner content and the position after the closing ')'.
fn extract_balanced_parens(text: &str, start: usize) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    if start >= bytes.len() || bytes[start] != b'(' { return None; }
    let mut depth = 1;
    let mut i = start + 1;
    let mut inner = String::new();
    while i < bytes.len() && depth > 0 {
        let ch = bytes[i];
        if ch == b'(' { depth += 1; }
        else if ch == b')' { depth -= 1; }
        if depth > 0 { inner.push(ch as char); }
        i += 1;
    }
    if depth == 0 { Some((inner, i)) } else { None }
}

/// Parse tool arguments from a string like `key="value", key2="value2"` or JSON.
fn parse_tool_args(args_str: &str) -> Value {
    let trimmed = args_str.trim();

    // Try JSON first
    if trimmed.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return parsed;
        }
    }

    // Fall back to key=value pair parsing
    let mut args = serde_json::Map::new();
    for pair in trimmed.split(',') {
        let pair = pair.trim();
        if let Some(eq) = pair.find('=') {
            let key = pair[..eq].trim().trim_matches('"').trim();
            let val = pair[eq + 1..].trim()
                .trim_matches('"')
                .to_string();
            if !key.is_empty() {
                args.insert(key.to_string(), json!(val));
            }
        }
    }
    Value::Object(args)
}
