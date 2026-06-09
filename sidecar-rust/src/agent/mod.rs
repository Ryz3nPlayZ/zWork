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
        
        // Append user message if not already appended
        let is_dup = chat.messages.last().map_or(false, |m| {
            m.role == "user" && m.content.as_str().unwrap_or("").trim() == user_message.trim()
        });
        if !is_dup && !user_message.is_empty() {
            chatstore::append_message(&chat.id, "user", json!(user_message));
            chat = chatstore::get(&chat.id).unwrap();
        }
        
        // Build system prompt template
        let skills_list = crate::skills::format_for_system_prompt();
        let skills = crate::skills::list_skills();
        let example_slug = skills.first().map(|s| s.slug.as_str()).unwrap_or("frontend-design");
        
        let system_prompt = settings::build_system_prompt(
            &model_id,
            "zWork Cloud Router",
            "zWork User",
            "macOS Desktop",
            &crate::paths::repo_root().to_string_lossy(),
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
        
        // Resolve credentials
        let model_meta = s.custom_models.iter().find(|m| m.id == model_id);
        let shape = model_meta.map_or("anthropic".to_string(), |m| m.shape.clone());
        let credential = model_meta.map_or("zwork_router".to_string(), |m| m.credential.clone());
        let api_key = s.api_keys.get(&credential).cloned().unwrap_or_default();
        let base_url = s.provider_config.get(&credential)
            .and_then(|c| c.get("base_url"))
            .cloned()
            .unwrap_or_else(|| "https://api.tryzwork.app/api".to_string());
            
        // Main multi-turn executor loop (max 15 turns)
        let mut turn = 0;
        let max_turns = 15;
        
        // Initialize the assistant response message
        let assistant_msg = chatstore::append_message(&chat.id, "assistant", json!(""));
        let assistant_msg_id = assistant_msg.map(|m| m.id).unwrap_or_default();
        
        let mut accumulated_text = String::new();
        let mut accumulated_activities = Vec::new();
        
        while turn < max_turns {
            turn += 1;
            let _ = tx.send(json!({
                "type": "status",
                "text": "Thinking"
            })).await;
            
            // Format messages and tools payload
            let (system, convo) = convert_input_messages(&history_messages);
            let endpoint = if shape == "anthropic" {
                format!("{}/v1/messages", base_url)
            } else {
                format!("{}/chat/completions", base_url)
            };
            
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("content-type", reqwest::header::HeaderValue::from_static("application/json"));
            
            if shape == "anthropic" {
                headers.insert("x-api-key", reqwest::header::HeaderValue::from_str(&api_key).unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")));
                headers.insert("anthropic-version", reqwest::header::HeaderValue::from_static("2023-06-01"));
                if !api_key.starts_with("sk-ant-") && !api_key.is_empty() {
                    headers.insert("authorization", reqwest::header::HeaderValue::from_str(&format!("Bearer {}", api_key)).unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")));
                }
            } else {
                headers.insert("authorization", reqwest::header::HeaderValue::from_str(&format!("Bearer {}", api_key)).unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")));
            }
            
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
                    "model": model_id,
                    "system": system,
                    "messages": convo,
                    "stream": true,
                    "tools": tools_payload
                })
            } else {
                let mut messages_payload = vec![json!({"role": "system", "content": system})];
                messages_payload.extend(convo);
                json!({
                    "model": model_id,
                    "messages": messages_payload,
                    "stream": true,
                    "tools": tools_payload
                })
            };
            
            // Call upstream token stream
            let mut stream = stream_upstream(endpoint, headers, body, shape.clone());
            let mut assistant_content_blocks = Vec::new();
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
                    assistant_content_blocks.push(json!({
                        "type": "text",
                        "text": text
                    }));
                    
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
                        execute_allowed = false;
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
                        
                        // Wait for user approval
                        if let Ok(approved) = gate_rx.await {
                            execute_allowed = approved;
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
