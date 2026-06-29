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
mod llm;
mod compaction;

use prompts::convert_input_messages;
use llm::{stream_llm, trace as llm_trace, LlmEvent};
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

fn check_desktop_browser_active(user_message: &str, messages: &[crate::chatstore::ChatMessage]) -> bool {
    let msg_lower = user_message.to_lowercase();
    let keywords = &[
        "desktop", "click", "type", "capture", "safari", "chrome",
        "browser", "navigate", "website", "http", "window", "screen",
        "scroll", "keypress", "key combo", "double click", "right click",
        "app name", "launch app"
    ];
    if keywords.iter().any(|k| msg_lower.contains(k)) {
        return true;
    }

    for m in messages {
        if m.role == "assistant" {
            if let Some(arr) = m.content.as_array() {
                for block in arr {
                    if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                            if name.starts_with("desktop_") || name.starts_with("browser_") {
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }
    false
}

fn check_academic_finance_active(user_message: &str, messages: &[crate::chatstore::ChatMessage]) -> bool {
    let msg_lower = user_message.to_lowercase();
    let keywords = &[
        "paper", "citation", "research", "stock", "ticker", "extract",
        "pdf", "arxiv", "financial", "share price", "moving average",
        "technical indicator"
    ];
    if keywords.iter().any(|k| msg_lower.contains(k)) {
        return true;
    }

    for m in messages {
        if m.role == "assistant" {
            if let Some(arr) = m.content.as_array() {
                for block in arr {
                    if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                            let academic_tools = &[
                                "search_papers", "format_citation", "write_research_paper",
                                "review_paper", "extract_document", "get_stock_data"
                            ];
                            if academic_tools.contains(&name) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }
    false
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

        // Append the user message. We store the plain display text as the
        // message `content` — the frontend renders `message.content` as a
        // string, so storing Anthropic content blocks here crashed it (React
        // #31: "object with keys {text,type}"). The multimodal content-blocks
        // form is built separately below, only for the model payload.
        let user_display = user_message.clone();
        let is_dup = chat.messages.last().map_or(false, |m| {
            m.role == "user" && chatstore::content_to_text(&m.content) == user_display
        });
        if !is_dup && (!user_message.is_empty() || !attachments.is_empty()) {
            chatstore::append_message(&chat.id, "user", json!(user_display));
            chat = chatstore::get(&chat.id).unwrap();
        }

        // Emit chat reconciliation event AFTER appending so the title — which
        // append_message auto-derives from the first user message — is current.
        // (Still the first event on the stream, so the frontend can map its
        // provisional tmp_ ID to the real server-assigned chat ID before any
        // tokens arrive.)
        let _ = tx.send(json!({
            "type": "chat",
            "id": chat.id,
            "title": chat.title
        })).await;
        
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

        let include_desktop = check_desktop_browser_active(&user_message, &chat.messages);
        let include_academic = check_academic_finance_active(&user_message, &chat.messages);

        let get_scoped_schemas = |plan_mode_val: bool| -> Vec<Value> {
            let all = get_tool_schemas(plan_mode_val);
            all.into_iter().filter(|t| {
                let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name.starts_with("desktop_") || name.starts_with("browser_") {
                    return include_desktop;
                }
                let academic_tools = &[
                    "search_papers", "format_citation", "write_research_paper",
                    "review_paper", "extract_document", "get_stock_data", "detect_hardware"
                ];
                if academic_tools.contains(&name) {
                    return include_academic;
                }
                if name == "manage_tasks" || name == "manage_events" || name == "send_telegram_message" {
                    return include_academic || include_desktop;
                }
                true
            }).collect::<Vec<_>>()
        };

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
            example_slug,
            include_desktop,
            include_academic,
        );

        // Inject the LIVE environment status so the model actually knows its
        // browser/desktop tools are connected and ready. The tool schemas are
        // always advertised, but without this signal a model will often avoid
        // the browser_* tools ("not sure they're available") and fall back to
        // guessing URLs or claiming it can't browse — even when the zbctl
        // bridge shows Connected in Settings.
        let browser_connected = crate::browser_bridge::extension_connected().await;
        let system_prompt = format!(
            "{system_prompt}\n\n## Live environment status\n{}",
            if browser_connected {
                "- Chrome browser bridge: CONNECTED. Your browser_* tools are LIVE and drive the user's real Chrome (signed-in sessions, no login walls). For ANY task involving a website, web app, web form, login-gated page, or anything browser-based, USE the browser_* tools (browser_navigate / browser_snapshot / browser_click / browser_type / browser_eval). Do not claim you cannot browse, and do not guess URLs from memory — navigate to a real URL or snapshot and click real links."
            } else {
                "- Chrome browser bridge: NOT connected. browser_* tools will fail until the user opens Chrome with the zbctl extension loaded and zWork running. If the task needs the browser, tell the user to connect it rather than guessing."
            }
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
        // The current user turn may carry attachments (e.g. images) that the
        // stored display-string content cannot represent. When attachments are
        // present, replace the last user message's content with the full
        // content-block payload so the model actually receives them.
        if !attachments.is_empty() {
            let user_blocks = prompts::build_user_content(&user_message, &attachments);
            if let Some(last) = history_messages.last_mut() {
                if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                    last["content"] = user_blocks;
                }
            }
        }
        
        repair_history_alternation(&mut history_messages);
        let mut doom_loop_detector = DoomLoopDetector::new();
            
        // Main multi-turn executor loop. A "turn" is one model inference + its
        // tool executions. Multi-step desktop/browser work (capture → act →
        // re-capture → …) routinely needs 15–30+ turns. The loop terminates
        // *naturally* when the model stops emitting tool calls (task done), the
        // DoomLoopDetector halts exact-repeat loops, the user hits Stop, or a
        // stream error ends the turn.
        //
        // On top of those, a hard runaway cap is the last line of defense: a
        // buggy fallback or a model that never converges once burned the user's
        // entire request quota (199 turns → HTTP 429) before any guard fired.
        // 80 turns is generous headroom over what real tasks need. Override
        // with ZWORK_MAX_TURNS; set it to 0 for the old unbounded behaviour.
        let mut turn = 0u32;
        const DEFAULT_MAX_TURNS: u32 = 80;
        let max_turns: u32 = match std::env::var("ZWORK_MAX_TURNS") {
            Ok(v) => v
                .trim()
                .parse::<u32>()
                .ok()
                .filter(|&n| n > 0)
                .unwrap_or(DEFAULT_MAX_TURNS),
            Err(_) => DEFAULT_MAX_TURNS,
        };
        let mut hit_turn_cap = false;
        
        // Initialize the assistant response message
        let assistant_msg = chatstore::append_message(&chat.id, "assistant", json!(""));
        let assistant_msg_id = assistant_msg.map(|m| m.id).unwrap_or_default();
        
        let mut accumulated_text = String::new();
        let mut accumulated_activities = Vec::new();
        
        loop {
            turn += 1;
            if turn > max_turns {
                hit_turn_cap = true;
                break;
            }
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
                for t in get_scoped_schemas(plan_mode) {
                    out.push(json!({
                        "name": t["name"],
                        "description": t["description"],
                        "input_schema": t["parameters"]
                    }));
                }
                out
            } else {
                let mut out = Vec::new();
                for t in get_scoped_schemas(plan_mode) {
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
            
            // Trace the outgoing request: model, message count, advertised
            // tools, and live browser status — so any later failure can be
            // correlated to exactly what the model was asked to do.
            {
                let schemas = get_scoped_schemas(plan_mode);
                let tool_names: Vec<&str> = schemas
                    .iter()
                    .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
                    .collect();
                llm_trace(
                    &chat_id,
                    turn,
                    "request",
                    json!({
                        "model": real_model_id,
                        "shape": shape,
                        "messages": convo.len(),
                        "tools": tool_names,
                        "browser_connected": browser_connected,
                        "plan_mode": plan_mode,
                    }),
                );
            }

            // Call upstream via the unified streaming layer: one parser per
            // provider wire format, loud errors, no silent frame/arg drops.
            let mut stream = stream_llm(endpoint, headers, body, shape.clone(), turn, chat_id.clone());
            let mut assistant_content_blocks: Vec<serde_json::Value> = Vec::new();
            let mut tool_calls = Vec::new();
            let mut turn_error: Option<String> = None;

            while let Some(evt_res) = stream.next().await {
                let evt = match evt_res {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                match evt {
                    LlmEvent::TextDelta { text } => {
                        accumulated_text.push_str(&text);

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
                        let _ = tx.send(json!({ "type": "delta", "text": text })).await;
                    }
                    LlmEvent::ReasoningDelta { .. } => {
                        // Model chain-of-thought: surfaced to the SSE frame log
                        // only when ZWORK_TRACE_SSE=1; never shown to the UI.
                    }
                    LlmEvent::ToolCall { id, name, input } => {
                        tool_calls.push(json!({
                            "id": id.clone(),
                            "name": name.clone(),
                            "input": input.clone()
                        }));
                        assistant_content_blocks.push(json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input
                        }));
                    }
                    LlmEvent::Usage(_) | LlmEvent::Finish { .. } => {
                        // Diagnostic only; already traced inside stream_llm.
                    }
                    LlmEvent::ProviderError { message, .. } => {
                        turn_error = Some(message.clone());
                        let _ = tx.send(json!({ "type": "error", "text": message })).await;
                    }
                    LlmEvent::Done => break,
                }
            }

            // A hard stream error ends the turn/task rather than executing any
            // partially-collected tool calls.
            if turn_error.is_some() {
                break;
            }

            // Append assistant response to history
            history_messages.push(json!({
                "role": "assistant",
                "content": assistant_content_blocks
            }));

            // Text-parsed tool calls are a FALLBACK for providers that genuinely
            // lack the `tools` API. Every provider zWork ships (DeepSeek,
            // Anthropic, OpenAI-shape) emits structured tool calls — and
            // scraping a tool name out of the model's PROSE narration turns
            // innocent text ("I'll grab a browser_snapshot first") into a
            // phantom tool call that loops forever: one real run executed
            // browser_snapshot 190× in a row until the request quota 429'd.
            // Default OFF; opt in with ZWORK_TEXT_TOOL_FALLBACK=1 for a
            // raw-completion model that can't call tools natively.
            if tool_calls.is_empty()
                && !accumulated_text.is_empty()
                && std::env::var("ZWORK_TEXT_TOOL_FALLBACK")
                    .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                    .unwrap_or(false)
            {
                if let Some(parsed) = parse_text_tool_calls(&accumulated_text) {
                    tool_calls = parsed;
                }
            }

            if tool_calls.is_empty() {
                break; // No more tool calls: loop completed
            }
            
            // Doom Loop Check
            let mut is_doomed = false;
            for tc in &tool_calls {
                let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let params = tc.get("input").cloned().unwrap_or(json!({}));
                if doom_loop_detector.push(name, &params) {
                    is_doomed = true;
                    break;
                }
            }

            if is_doomed {
                let err_msg = "Doom loop detected: consecutive duplicate tool calls. Halting execution.";
                let _ = tx.send(json!({
                    "type": "error",
                    "text": err_msg
                })).await;
                break;
            }

            // Execute tool calls and collect results concurrently
            let mut tool_results = Vec::new();
            let accumulated_activities_arc = std::sync::Arc::new(std::sync::Mutex::new(accumulated_activities));
            let db_lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
            
            let mut tasks = Vec::new();
            for tc in tool_calls {
                let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let params = tc.get("input").cloned().unwrap_or(json!({}));
                let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                
                let tx = tx.clone();
                let accumulated_activities = accumulated_activities_arc.clone();
                let db_lock = db_lock.clone();
                let chat_id = chat_id.clone();
                let assistant_msg_id = assistant_msg_id.clone();
                let accumulated_text = accumulated_text.clone();
                let auto_approve = auto_approve;
                
                tasks.push(tokio::spawn(async move {
                    llm_trace(
                        &chat_id,
                        turn,
                        "tool_dispatch",
                        json!({ "id": tc_id, "name": name, "input": params }),
                    );

                    // Safety permissions gate check
                    let risk = evaluate_tool_risk(&name, &params);
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
                    
                    let mut final_result_txt = String::new();
                    let mut final_result_ok = true;
                    
                    if execute_allowed {
                        // Stream executing events
                        let mut tool_stream = execute_tool(&name, params, &chat_id);
                        
                        while let Some(t_evt_res) = tool_stream.next().await {
                            let t_evt = match t_evt_res {
                                Ok(e) => e,
                                Err(_) => continue,
                            };
                            let type_str = t_evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if type_str == "activity" {
                                // Update activity block under mutex
                                let act_id = t_evt.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                let act_label = t_evt.get("label").and_then(|v| v.as_str()).unwrap_or("");
                                let act_done = t_evt.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
                                
                                let entry = json!({
                                    "id": act_id,
                                    "label": act_label,
                                    "done": act_done
                                });
                                
                                let current_activities = {
                                    let mut act_lock = accumulated_activities.lock().unwrap();
                                    if let Some(pos) = act_lock.iter().position(|x| x["id"] == act_id) {
                                        act_lock[pos] = entry;
                                    } else {
                                        act_lock.push(entry);
                                    }
                                    act_lock.clone()
                                };
                                
                                // Serialize database updates using db_lock to avoid SQLite locks
                                {
                                    let _guard = db_lock.lock().await;
                                    let _ = chatstore::update_message(
                                        &chat_id,
                                        &assistant_msg_id,
                                        Some(json!(accumulated_text)),
                                        Some(current_activities)
                                    );
                                }
                                let _ = tx.send(t_evt).await;
                            } else if type_str == "tool_result" {
                                final_result_txt = t_evt.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                final_result_ok = t_evt.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
                                let _ = tx.send(t_evt).await;
                            } else {
                                let _ = tx.send(t_evt).await;
                            }
                        }

                        llm_trace(
                            &chat_id,
                            turn,
                            "tool_result",
                            json!({
                                "name": name,
                                "ok": final_result_ok,
                                "len": final_result_txt.len(),
                                "preview": final_result_txt.chars().take(200).collect::<String>(),
                            }),
                        );
                    } else {
                        final_result_txt = "Permission denied by user. Action aborted.".to_string();
                        final_result_ok = false;
                        
                        let _ = tx.send(json!({
                            "type": "tool_result",
                            "tool": name,
                            "ok": false,
                            "message": final_result_txt
                        })).await;

                        llm_trace(
                            &chat_id,
                            turn,
                            "tool_result",
                            json!({ "name": name, "ok": false, "len": final_result_txt.len(), "preview": final_result_txt, "denied": true }),
                        );
                    }
                    
                    json!({
                        "type": "tool_result",
                        "tool_use_id": tc_id,
                        "content": final_result_txt,
                        "is_error": !final_result_ok
                    })
                }));
            }
            
            // Await all tasks concurrently
            let completed_results = futures_util::future::join_all(tasks).await;
            for res in completed_results {
                if let Ok(result_val) = res {
                    tool_results.push(result_val);
                }
            }
            
            // Extract accumulated_activities back to local variable
            accumulated_activities = {
                let lock = accumulated_activities_arc.lock().unwrap();
                lock.clone()
            };
            
            // Append tool results to history messages for next completion turn
            history_messages.push(json!({
                "role": "user",
                "content": tool_results
            }));
        }

        if hit_turn_cap {
            let _ = tx.send(json!({
                "type": "error",
                "text": format!("Reached the {}-turn runaway cap and stopped to protect your request quota — the task wasn't converging on its own. Try rephrasing, switching models, or set ZWORK_MAX_TURNS (0 = unbounded).", max_turns)
            })).await;
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
    "read_file", "list_dir", "write_file", "replace_file_content", "grep_search", "run_command",
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

struct DoomLoopDetector {
    last_calls: Vec<(String, Value)>,
}

impl DoomLoopDetector {
    fn new() -> Self {
        Self {
            last_calls: Vec::new(),
        }
    }

    fn push(&mut self, name: &str, input: &Value) -> bool {
        self.last_calls.push((name.to_string(), input.clone()));
        if self.last_calls.len() > 3 {
            self.last_calls.remove(0);
        }
        if self.last_calls.len() == 3 {
            let first = &self.last_calls[0];
            let second = &self.last_calls[1];
            let third = &self.last_calls[2];
            if first.0 == second.0 && second.0 == third.0 && first.1 == second.1 && second.1 == third.1 {
                return true;
            }
        }
        false
    }
}

fn repair_history_alternation(messages: &mut Vec<Value>) {
    if messages.is_empty() {
        return;
    }
    let mut system_messages = Vec::new();
    let mut conversational = Vec::new();
    for msg in messages.drain(..) {
        if msg.get("role").and_then(|r| r.as_str()) == Some("system") {
            system_messages.push(msg);
        } else {
            conversational.push(msg);
        }
    }
    let mut repaired: Vec<Value> = Vec::new();
    for msg in conversational {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user").to_string();
        let content = msg.get("content").cloned().unwrap_or(json!(""));
        if let Some(last) = repaired.last_mut() {
            let last_role = last.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            if last_role == role {
                if role == "user" {
                    let mut merged_arr = Vec::new();
                    if let Some(arr) = last.get("content").and_then(|c| c.as_array()) {
                        merged_arr.extend(arr.clone());
                    } else {
                        merged_arr.push(json!({
                            "type": "text",
                            "text": last.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string()
                        }));
                    }
                    if let Some(arr) = content.as_array() {
                        merged_arr.extend(arr.clone());
                    } else {
                        merged_arr.push(json!({
                            "type": "text",
                            "text": content.as_str().unwrap_or("").to_string()
                        }));
                    }
                    last["content"] = json!(merged_arr);
                } else {
                    let last_str = last.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
                    let new_str = content.as_str().unwrap_or("").to_string();
                    last["content"] = json!(format!("{}\n\n{}", last_str, new_str));
                }
                continue;
            }
        }
        repaired.push(msg);
    }
    messages.extend(system_messages);
    messages.extend(repaired);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_repair_history_alternation() {
        let mut messages = vec![
            json!({
                "role": "system",
                "content": "sys-1"
            }),
            json!({
                "role": "user",
                "content": "user-1"
            }),
            json!({
                "role": "user",
                "content": "user-2"
            }),
            json!({
                "role": "assistant",
                "content": "assistant-1"
            }),
            json!({
                "role": "assistant",
                "content": "assistant-2"
            }),
            json!({
                "role": "user",
                "content": "user-3"
            }),
        ];

        repair_history_alternation(&mut messages);

        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[3]["role"], "user");

        // The user messages should be merged as content array blocks:
        let user1_2_content = &messages[1]["content"];
        assert!(user1_2_content.is_array());
        assert_eq!(user1_2_content[0]["text"], "user-1");
        assert_eq!(user1_2_content[1]["text"], "user-2");

        // The assistant messages should be merged as a single text:
        let assistant_content = messages[2]["content"].as_str().unwrap();
        assert!(assistant_content.contains("assistant-1"));
        assert!(assistant_content.contains("assistant-2"));
    }

    #[test]
    fn test_doom_loop_detector() {
        let mut detector = DoomLoopDetector::new();
        
        // Push different calls
        assert!(!detector.push("read_file", &json!({"path": "a.rs"})));
        assert!(!detector.push("read_file", &json!({"path": "b.rs"})));
        assert!(!detector.push("read_file", &json!({"path": "a.rs"})));
        
        // Push duplicate calls consecutively
        let mut detector = DoomLoopDetector::new();
        assert!(!detector.push("read_file", &json!({"path": "a.rs"})));
        assert!(!detector.push("read_file", &json!({"path": "a.rs"})));
        // The third duplicate call must trigger a doom loop!
        assert!(detector.push("read_file", &json!({"path": "a.rs"})));
    }

    /// Regression guard for the catastrophic loop that burned a user's quota.
    /// `parse_text_tool_calls` WILL scrape a tool name out of the model's prose
    /// narration — which is exactly why the agent loop gates it behind
    /// ZWORK_TEXT_TOOL_FALLBACK (default OFF). This test documents the danger:
    /// given innocent narration containing `browser_snapshot()`, the parser
    /// fabricates a tool call. If this ever stops fabricating, the gate can be
    /// reconsidered; until then the gate MUST stay default-off.
    #[test]
    fn test_text_parser_fabricates_from_prose() {
        let prose = "Let me look at the page. I'll call browser_snapshot() \
                     first to see what's there, then decide what to click.";
        let parsed = parse_text_tool_calls(prose).expect("parser should match the bare call");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["name"], "browser_snapshot");
        // Fabricated id, not a real provider tool_use id:
        assert!(parsed[0]["id"].as_str().unwrap().starts_with("text_tc_"));
    }
}
