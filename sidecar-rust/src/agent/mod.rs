use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio::io::AsyncBufReadExt;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::convert::Infallible;
use tokio_stream::wrappers::ReceiverStream;
use chrono::Utc;
use crate::settings;
use crate::chatstore;

fn log_agent_event(chat_id: &str, run_id: &str, event: &str, payload: Value) {
    let record = json!({
        "ts": Utc::now().to_rfc3339(),
        "chat_id": chat_id,
        "run_id": run_id,
        "event": event,
        "payload": payload,
    });
    if let Ok(line) = serde_json::to_string(&record) {
        let path = crate::paths::agent_log_path();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap_or_else(|_| std::fs::File::create("/dev/null").unwrap());
        use std::io::Write;
        let _ = writeln!(file, "{}", line);
    }
}

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

pub fn sse_senders() -> &'static Mutex<HashMap<String, mpsc::Sender<Result<Value, Infallible>>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, mpsc::Sender<Result<Value, Infallible>>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
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
    run_id: String,
    model_id: String,
    user_message: String,
    attachments: Vec<crate::server::Attachment>,
    project_id: String,
    plan_mode: bool,
    auto_approve: bool,
) -> impl futures_util::Stream<Item = Result<Value, Infallible>> {
    let (tx, rx) = mpsc::channel(100);
    
    // Register SSE sender for this chat
    {
        let mut senders = sse_senders().lock().unwrap();
        senders.insert(chat_id.clone(), tx.clone());
    }

    tokio::spawn(async move {
        let s = settings::load();
        let run_id = if run_id.is_empty() { chat_id.clone() } else { run_id };
        log_agent_event(&chat_id, &run_id, "turn_start", json!({
            "model_id": model_id,
            "project_id": project_id,
            "plan_mode": plan_mode,
            "auto_approve": auto_approve,
            "attachment_count": attachments.len(),
        }));
        
        // Load or create the chat history
        let mut chat = match chatstore::get(&chat_id) {
            Some(c) => c,
            None => {
                chatstore::create("New chat", &model_id, &project_id)
            }
        };

        // Append user message if not duplicate
        let user_display = user_message.clone();
        let is_dup = chat.messages.last().map_or(false, |m| {
            m.role == "user" && chatstore::content_to_text(&m.content) == user_display
        });
        if !is_dup && (!user_message.is_empty() || !attachments.is_empty()) {
            chatstore::append_message(&chat.id, "user", json!(user_display));
            chat = chatstore::get(&chat.id).unwrap();
        }

        // Emit chat reconciliation event
        let _ = tx.send(Ok(json!({
            "type": "chat",
            "id": chat.id,
            "title": chat.title
        }))).await;
        
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
            let real_model = if model_id.contains("vision") {
                "zwork-vision".to_string()
            } else if model_id.contains("pro") {
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

        log_agent_event(&chat_id, &run_id, "provider_resolved", json!({
            "provider": provider_display_name,
            "base_url": base_url,
            "shape": shape,
            "real_model_id": real_model_id,
        }));
        let _ = tx.send(Ok(json!({
            "type": "meta",
            "provider": provider_display_name,
            "resolved_model": real_model_id,
            "upstream_provider": provider_display_name,
        }))).await;

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

        let browser_connected = crate::browser_bridge::extension_connected().await;
        let system_prompt = format!(
            "{system_prompt}\n\n## Live environment status\n{}",
            if browser_connected {
                "- Chrome browser bridge: CONNECTED. Your browser_* tools are LIVE and drive the user's real Chrome (signed-in sessions, no login walls). For ANY task involving a website, web app, web form, login-gated page, or anything browser-based, USE the browser_* tools (browser_navigate / browser_snapshot / browser_click / browser_type / browser_eval). Do not claim you cannot browse, and do not guess URLs from memory — navigate to a real URL or snapshot and click real links."
            } else {
                "- Chrome browser bridge: NOT connected. browser_* tools will fail until the user opens Chrome with the zbctl extension loaded and zWork running. If the task needs the browser, tell the user to connect it rather than guessing."
            }
        );

        // Write the system prompt to a temporary file
        let sys_prompt_path = std::env::temp_dir().join(format!("{}_system.txt", chat_id));
        let _ = std::fs::write(&sys_prompt_path, &system_prompt);

        // Get path to self binary for the MCP bridge subcommand
        let self_exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "sidecar-rust".to_string());
        let extension_cmd = format!("{} mcp {}", self_exe, chat_id);

        let mut cmd = tokio::process::Command::new("/Users/zemuliu/.local/bin/goose");
        cmd.arg("run")
            .arg("--session-id").arg(&chat_id)
            .arg("--resume")
            .arg("--no-profile")
            .arg("--output-format").arg("stream-json")
            .arg("--with-extension").arg(&extension_cmd)
            .arg("--text").arg(&user_message);

        // Map shape to goose provider
        let goose_provider = if shape == "anthropic" {
            "anthropic"
        } else {
            "openai"
        };
        cmd.arg("--provider").arg(goose_provider);
        cmd.arg("--model").arg(&real_model_id);

        // Set environments
        cmd.env("GOOSE_SYSTEM_PROMPT_FILE_PATH", &sys_prompt_path);
        if shape == "anthropic" {
            cmd.env("ANTHROPIC_API_KEY", &api_key);
            if !base_url.is_empty() && base_url != "https://api.anthropic.com" {
                cmd.env("ANTHROPIC_HOST", &base_url);
            }
        } else {
            cmd.env("OPENAI_API_KEY", &api_key);
            if !base_url.is_empty() && base_url != "https://api.tryzwork.app/api" && base_url != "https://api.openai.com/v1" {
                cmd.env("OPENAI_BASE_URL", &base_url);
            }
        }

        // Initialize empty assistant message in chatstore so real-time updates function properly
        let assistant_msg = chatstore::append_message(&chat_id, "assistant", json!(""));
        let assistant_msg_id = assistant_msg.map(|m| m.id).unwrap_or_default();

        let _ = tx.send(Ok(json!({
            "type": "status",
            "text": "Thinking"
        }))).await;

        log_agent_event(&chat_id, &run_id, "goose_spawn", json!({
            "provider": goose_provider,
            "model": real_model_id,
            "base_url": base_url,
        }));

        let mut child = match cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn() {
                Ok(c) => c,
                Err(e) => {
                    log_agent_event(&chat_id, &run_id, "goose_spawn_error", json!({ "error": e.to_string() }));
                    let _ = tx.send(Ok(json!({
                        "type": "error",
                        "text": format!("Failed to spawn goose process: {}", e)
                    }))).await;
                    let _ = std::fs::remove_file(&sys_prompt_path);
                    return;
                }
            };

        let pid = child.id().unwrap_or(0);
        if pid > 0 {
            crate::watchdog::register_process(&chat_id, pid);
        }

        let stdout = child.stdout.take().unwrap();
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        let mut accumulated_text = String::new();

        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(evt) = serde_json::from_str::<Value>(&line) {
                let type_str = evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                log_agent_event(&chat_id, &run_id, "goose_event", json!({ "type": type_str, "raw": evt }));
                match type_str {
                    "message" => {
                        if let Some(msg_val) = evt.get("message") {
                            let role = msg_val.get("role").and_then(|v| v.as_str()).unwrap_or("");
                            if role == "assistant" {
                                if let Some(content_arr) = msg_val.get("content").and_then(|v| v.as_array()) {
                                    let mut total_text = String::new();
                                    for block in content_arr {
                                        match block.get("type").and_then(|v| v.as_str()) {
                                            Some("text") => {
                                                if let Some(txt) = block.get("text").and_then(|v| v.as_str()) {
                                                    total_text.push_str(txt);
                                                }
                                            }
                                            Some("tool_use") => {
                                                if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                                                    let _ = tx.send(Ok(json!({
                                                        "type": "tool_start",
                                                        "tool": name,
                                                        "input": block.get("input").cloned().unwrap_or(json!(null)),
                                                    }))).await;
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                    if total_text.len() > accumulated_text.len() {
                                        let delta = &total_text[accumulated_text.len()..];
                                        accumulated_text = total_text.clone();
                                        let _ = tx.send(Ok(json!({
                                            "type": "delta",
                                            "text": delta
                                        }))).await;

                                        // Update database in real-time
                                        let _ = chatstore::update_message(&chat_id, &assistant_msg_id, Some(json!(accumulated_text)), None);
                                    }
                                }
                            }
                        }
                    }
                    "tool_result" | "tool.complete" => {
                        let tool = evt.get("tool").and_then(|v| v.as_str())
                            .or_else(|| evt.pointer("/tool/name").and_then(|v| v.as_str()))
                            .unwrap_or("unknown");
                        let ok = evt.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
                        let message = evt.get("message").and_then(|v| v.as_str())
                            .or_else(|| evt.get("result").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        let _ = tx.send(Ok(json!({
                            "type": "tool_complete",
                            "tool": tool,
                            "ok": ok,
                            "message": message,
                        }))).await;
                    }
                    "usage" => {
                        let prompt_tokens = evt.get("prompt_tokens").or_else(|| evt.get("input_tokens")).and_then(|v| v.as_u64());
                        let completion_tokens = evt.get("completion_tokens").or_else(|| evt.get("output_tokens")).and_then(|v| v.as_u64());
                        let total_tokens = evt.get("total_tokens").and_then(|v| v.as_u64());
                        let _ = tx.send(Ok(json!({
                            "type": "usage",
                            "prompt_tokens": prompt_tokens,
                            "completion_tokens": completion_tokens,
                            "total_tokens": total_tokens,
                        }))).await;
                    }
                    "error" => {
                        if let Some(err_txt) = evt.get("error").and_then(|v| v.as_str()) {
                            log_agent_event(&chat_id, &run_id, "goose_error", json!({ "error": err_txt }));
                            let _ = tx.send(Ok(json!({
                                "type": "error",
                                "text": err_txt
                            }))).await;
                        }
                    }
                    _ => {}
                }
            }
        }

        let exit = child.wait().await;
        log_agent_event(&chat_id, &run_id, "goose_exit", json!({ "exit_code": exit.ok().and_then(|s| s.code()) }));
        if pid > 0 {
            crate::watchdog::unregister_process(&chat_id, pid);
        }
        let _ = std::fs::remove_file(&sys_prompt_path);

        let _ = tx.send(Ok(json!({
            "type": "done"
        }))).await;

        let _ = tx.send(Ok(json!({
            "type": "end"
        }))).await;

        // Cleanup SSE sender
        {
            let mut senders = sse_senders().lock().unwrap();
            senders.remove(&chat_id);
        }
    });

    ReceiverStream::new(rx)
}
