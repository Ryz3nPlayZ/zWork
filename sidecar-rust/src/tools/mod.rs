use serde_json::{json, Value};
use tokio::sync::mpsc;
use std::convert::Infallible;
use futures_util::stream::Stream;
use futures_util::StreamExt;
use tokio_stream::wrappers::ReceiverStream;

pub mod fs;
pub mod shell;
pub mod search;
pub mod doc_extract;
pub mod stock;

// Risk evaluation for permission checking
pub enum Risk {
    Safe,
    Destructive { reason: String },
}

pub fn evaluate_tool_risk(name: &str, params: &Value) -> Risk {
    match name {
        "run_command" => {
            let cmd = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if targets_zwork_backend(cmd) {
                Risk::Destructive {
                    reason: "Refusing to run a command that kills the zWork local backend on port 8787. Restart or inspect the backend instead of killing the app's own service.".to_string(),
                }
            } else {
                let cmd_lower = cmd.to_lowercase();
                // Check for obviously destructive patterns
                if cmd_lower.contains("rm -rf")
                    || cmd_lower.contains("format ")
                    || cmd_lower.contains("dropdb")
                    || cmd_lower.contains("shutdown")
                    || cmd_lower.contains("kill -9")
                {
                    Risk::Destructive {
                        reason: format!("Executing potentially destructive command: '{}'", cmd),
                    }
                } else {
                    Risk::Safe
                }
            }
        }
        "write_file" => {
            let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
            // Writing to settings or credentials directly can be risky
            if path.contains("settings.json") || path.contains("secrets.json") {
                Risk::Destructive {
                    reason: format!("Writing to sensitive backend configuration file: '{}'", path),
                }
            } else {
                Risk::Safe
            }
        }
        _ => Risk::Safe,
    }
}

fn targets_zwork_backend(command: &str) -> bool {
    let c = command.to_lowercase();
    if !c.contains("8787") {
        return false;
    }
    
    // Check for patterns like lsof/kill or pkill/killall containing 8787
    let lsof_kill = regex::Regex::new(r"\blsof\b[^;&|]*(?::8787|-i\s*:8787)").unwrap();
    let kill_cmd = regex::Regex::new(r"\b(?:xargs\s+)?kill(?:all)?\b").unwrap();
    let direct_kill = regex::Regex::new(r"\b(?:kill|pkill|killall)\b[^;&|]*8787").unwrap();
    
    (lsof_kill.is_match(&c) && kill_cmd.is_match(&c)) || direct_kill.is_match(&c)
}

pub fn get_tool_schemas(plan_mode: bool) -> Vec<Value> {
    let mut schemas = vec![
        json!({
            "name": "read_file",
            "description": "Read and return the UTF-8 contents of a file. Use this to inspect files before editing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative or absolute file path" }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "list_dir",
            "description": "List immediate children of a directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path (default: '.')" }
                }
            }
        }),
        json!({
            "name": "grep_search",
            "description": "Search recursively inside a directory for matching queries. Returns paths, line numbers, and matching line content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The query string or regex pattern to search for" },
                    "path": { "type": "string", "description": "Search directory path (default: '.')" },
                    "is_regex": { "type": "boolean", "description": "Treat query as regex (default: false)" },
                    "case_insensitive": { "type": "boolean", "description": "Perform case-insensitive search (default: false)" }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "web_search",
            "description": "Search the web/news for current information without opening a browser.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" },
                    "max_results": { "type": "integer", "description": "Max results (default 6, max 10)" }
                }
            }
        }),
        json!({
            "name": "search_papers",
            "description": "Search academic literature across databases. Returns ranked papers with DOIs, citation counts, and PDF links.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" },
                    "max_results": { "type": "integer", "description": "Max results to return" },
                    "year_min": { "type": "integer", "description": "Filter by minimum publication year" },
                    "year_max": { "type": "integer", "description": "Filter by maximum publication year" }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "format_citation",
            "description": "Format a paper metadata from search_papers into a proper citation string.",
            "parameters": {
                "type": "object",
                "properties": {
                    "paper": { "type": "object", "description": "Paper result object from search_papers" },
                    "style": { "type": "string", "description": "Style format ('apa', 'mla', 'chicago'); default 'apa'" }
                },
                "required": ["paper"]
            }
        }),
        json!({
            "name": "read_skill",
            "description": "Load the playbook for a domain-specific skill by slug.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": { "type": "string", "description": "Skill slug" }
                },
                "required": ["slug"]
            }
        }),
        json!({
            "name": "extract_document",
            "description": "Extract text and metadata from PDF, DOCX, XLSX, PPTX, or TXT files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path to document" },
                    "format": { "type": "string", "description": "Output format ('markdown' or 'text')" },
                    "pages": { "type": "string", "description": "1-based page range for PDFs, e.g., '1-5'" }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "detect_hardware",
            "description": "Query CPU/GPU count and hardware profile.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": "get_stock_data",
            "description": "Get stock price data and technical indicators (SMA, EMA, RSI, MACD) for a given ticker.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ticker": { "type": "string", "description": "Stock ticker symbol (e.g. AAPL, GOOGL)" },
                    "range": { "type": "string", "description": "Time range: 5d, 1mo, 3mo, 6mo, 1y, 2y, ytd, max", "default": "3mo" }
                },
                "required": ["ticker"]
            }
        }),
        json!({
            "name": "ask_question",
            "description": "Ask the user a clarifying question with multiple choice options. Blocks until response.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The question to ask" },
                    "options": { "type": "array", "items": { "type": "string" }, "description": "Choice options" }
                },
                "required": ["question", "options"]
            }
        }),
        json!({
            "name": "ask_user",
            "description": "Ask the user a question with choices when preferences or requirements are ambiguous. Blocks until response.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "Clarification question" },
                    "options": { "type": "array", "items": { "type": "string" }, "description": "Options" }
                },
                "required": ["question", "options"]
            }
        }),
        json!({
            "name": "ask_user_for_permission",
            "description": "Ask for explicit permission before doing a destructive action.",
            "parameters": {
                "type": "object",
                "properties": {
                    "explanation": { "type": "string", "description": "Why permission is needed" },
                    "command": { "type": "string", "description": "Optional terminal command to pre-approve subsequent runs" }
                },
                "required": ["explanation"]
            }
        }),
        json!({
            "name": "write_research_paper",
            "description": "Write a complete academic research paper draft on a topic. Searches literature, creates an outline, drafts all sections, and saves to workspace outputs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": { "type": "string", "description": "Research topic or hypothesis to write about" },
                    "style": { "type": "string", "description": "Writing style: 'academic', 'technical', 'survey'" },
                    "word_count": { "type": "integer", "description": "Target word count per section" }
                },
                "required": ["topic"]
            }
        }),
        json!({
            "name": "review_paper",
            "description": "Review and critique a research paper draft, providing an overall score (0-10) and recommendations.",
            "parameters": {
                "type": "object",
                "properties": {
                    "paper_content": { "type": "string", "description": "The paper text to review" },
                    "review_type": { "type": "string", "description": "Type of review: 'peer_review', 'technical', 'editorial'" }
                },
                "required": ["paper_content"]
            }
        }),
    ];

    if !plan_mode {
        // Add modifying / executing tools
        schemas.push(json!({
            "name": "write_file",
            "description": "Write entire contents to a file. Overwrites existing files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path" },
                    "content": { "type": "string", "description": "Full content" }
                },
                "required": ["path", "content"]
            }
        }));
        schemas.push(json!({
            "name": "replace_file_content",
            "description": "Replace a target substring in a file with a replacement substring. Use start_line and end_line if the target content matches multiple lines in the file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative or absolute file path" },
                    "target_content": { "type": "string", "description": "The exact string block to replace" },
                    "replacement_content": { "type": "string", "description": "The new string block to replace the target block with" },
                    "start_line": { "type": "integer", "description": "Optional 1-based starting line range" },
                    "end_line": { "type": "integer", "description": "Optional 1-based ending line range" }
                },
                "required": ["path", "target_content", "replacement_content"]
            }
        }));
        schemas.push(json!({
            "name": "run_command",
            "description": "Run a shell command. Set background=true to detach servers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run" },
                    "cwd": { "type": "string", "description": "Directory context" },
                    "background": { "type": "boolean", "description": "Run in background" }
                },
                "required": ["command"]
            }
        }));
        schemas.push(json!({
            "name": "save_memory",
            "description": "Save a fact to the agent's persistent memory. Use target='user' for facts about the user (preferences, style, goals, habits, job, family, constraints) and target='memory' for everything else (project facts, conventions, deadlines, things learned).",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The fact to remember" },
                    "target": { "type": "string", "description": "Which memory file to write to. Use 'memory' (default) or 'user'." }
                },
                "required": ["content"]
            }
        }));
        schemas.push(json!({
            "name": "send_telegram_message",
            "description": "Send a plain text message to the user's Telegram. Use for reminders, updates, or anything the user should be notified about when they are away from zWork. Requires Telegram bot token and chat ID to be configured in settings.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Message text to send. Keep it concise. Markdown is supported." }
                },
                "required": ["text"]
            }
        }));
        schemas.push(json!({
            "name": "deploy_web_app",
            "description": "Deploy a local web server (Vite/Python) and return its public URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_path": { "type": "string", "description": "Path to app folder" },
                    "framework": { "type": "string", "description": "Hint on framework" }
                },
                "required": ["project_path"]
            }
        }));
        // ─── Desktop control (cua-driver) ───
        schemas.push(json!({
            "name": "desktop_capture",
            "description": "Capture the accessibility tree of an app window as Markdown with [element_index N] tags on every actionable element. MUST be called before desktop_click/desktop_type/desktop_set_value/desktop_scroll — element indices are only valid from the most recent capture. Verify the returned window_title is the app you intended before acting. The tree is capped at ~100 elements; if `truncated` is true, indices beyond the cap are unavailable — scroll or narrow the target to see more.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app": { "type": "string", "description": "App name to capture, e.g. \"Safari\", \"Google Chrome\", \"Finder\". Required." }
                },
                "required": ["app"]
            }
        }));
        schemas.push(json!({
            "name": "desktop_click",
            "description": "Click an element by its element_index from the last desktop_capture of the app.",
            "parameters": {
                "type": "object",
                "properties": {
                    "element": { "type": "integer", "description": "Element index from desktop_capture's [element_index N] tags" },
                    "app": { "type": "string", "description": "App to click in (optional, defaults to the last captured app)" }
                },
                "required": ["element"]
            }
        }));
        schemas.push(json!({
            "name": "desktop_type",
            "description": "Type text into the focused field, or a specific field if `element` is given. Preferred for free-form text entry. For <select> dropdowns or sliders use desktop_set_value.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Text to type" },
                    "element": { "type": "integer", "description": "Optional element index to direct the text into a specific field" },
                    "app": { "type": "string", "description": "App to type in (optional, defaults to last captured app)" }
                },
                "required": ["text"]
            }
        }));
        schemas.push(json!({
            "name": "desktop_set_value",
            "description": "Set a value on a UI element directly (no keystrokes, no focus reliance). The safe way to pick a <select> dropdown option or set a slider/stepper/date-picker. For free-form web text inputs, use desktop_type instead (WebKit ignores AXValue writes on text fields).",
            "parameters": {
                "type": "object",
                "properties": {
                    "element": { "type": "integer", "description": "Element index (the dropdown/slider) from desktop_capture" },
                    "value": { "type": "string", "description": "Value to set. For dropdowns: the option's visible title, matched case-insensitively." },
                    "app": { "type": "string", "description": "App (optional, defaults to last captured app)" }
                },
                "required": ["element", "value"]
            }
        }));
        schemas.push(json!({
            "name": "desktop_scroll",
            "description": "Scroll the current window in a direction.",
            "parameters": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "Scroll direction" },
                    "amount": { "type": "integer", "description": "Number of ticks (1–50, default 3)" },
                    "app": { "type": "string", "description": "App to scroll in (optional)" }
                },
                "required": ["direction"]
            }
        }));
        schemas.push(json!({
            "name": "desktop_key",
            "description": "Press a key or keyboard shortcut. Navigation: cmd+l (address bar), cmd+t (new tab), cmd+w (close tab), return, escape, tab, space, arrows. Format combos with + : \"cmd+l\", \"cmd+shift+g\", \"return\". Catastrophic combos are blocked: empty Trash (cmd+shift+backspace), log out (cmd+shift+q), force log out (cmd+option+shift+q), lock screen (cmd+ctrl+q).",
            "parameters": {
                "type": "object",
                "properties": {
                    "keys": { "type": "string", "description": "Key combo with + separators: \"cmd+l\", \"cmd+t\", \"return\", \"escape\", \"tab\", \"cmd+shift+g\", \"up\", \"down\"" },
                    "app": { "type": "string", "description": "App to send keys to (optional)" }
                },
                "required": ["keys"]
            }
        }));
        schemas.push(json!({
            "name": "desktop_launch_app",
            "description": "Launch an app (backgrounded) by name, e.g. \"Safari\", \"Calculator\", \"Finder\". Use when the app isn't running yet. After launching, call desktop_capture before interacting with it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app": { "type": "string", "description": "App name to launch" }
                },
                "required": ["app"]
            }
        }));
        schemas.push(json!({
            "name": "desktop_list_apps",
            "description": "List running and installed apps with their process IDs and running state.",
            "parameters": { "type": "object", "properties": {} }
        }));
        schemas.push(json!({
            "name": "desktop_wait",
            "description": "Wait for a specified duration in seconds. Use after navigation or actions that need loading time.",
            "parameters": {
                "type": "object",
                "properties": {
                    "seconds": { "type": "number", "description": "Duration in seconds (e.g. 1.5)" }
                },
                "required": ["seconds"]
            }
        }));
        schemas.push(json!({
            "name": "desktop_start_session",
            "description": "Start a desktop-control session: bring the cua-driver daemon up and connect to it. Call this ONCE, before your first desktop_capture of any task that touches the desktop. Idempotent — safe to call again. The session stays up across all your captures/clicks/types for the whole task.",
            "parameters": { "type": "object", "properties": {} }
        }));
        schemas.push(json!({
            "name": "desktop_end_session",
            "description": "End the desktop-control session: tear the cua-driver daemon down completely, freeing the process. Call this ONCE, after you have finished ALL desktop work for the task and will not interact with the desktop again. Idempotent. Do NOT call it between steps of an ongoing task — keep the session up for the entire task.",
            "parameters": { "type": "object", "properties": {} }
        }));
        // ─── Browser control (zbctl → user's Chrome) ───
        schemas.push(json!({
            "name": "browser_navigate",
            "description": "Open a URL in your Chrome browser using your active session and cookies. No login walls.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Full URL to navigate to" }
                },
                "required": ["url"]
            }
        }));
        schemas.push(json!({
            "name": "browser_snapshot",
            "description": "Get a structured snapshot of the current browser page. Returns interactive elements with stable IDs, roles, labels, and visible page text. Use this to read page content and find elements to interact with.",
            "parameters": {
                "type": "object",
                "properties": {
                    "max_items": { "type": "integer", "description": "Max elements to return (default 80)" }
                }
            }
        }));
        schemas.push(json!({
            "name": "browser_click",
            "description": "Click an element on the current browser page by its element ID from browser_snapshot.",
            "parameters": {
                "type": "object",
                "properties": {
                    "element_id": { "type": "integer", "description": "Element ID from browser_snapshot" }
                },
                "required": ["element_id"]
            }
        }));
        schemas.push(json!({
            "name": "browser_type",
            "description": "Type text into an input field on the current browser page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "element_id": { "type": "integer", "description": "Element ID of input from browser_snapshot" },
                    "text": { "type": "string", "description": "Text to type" }
                },
                "required": ["element_id", "text"]
            }
        }));
        schemas.push(json!({
            "name": "browser_eval",
            "description": "Execute JavaScript in the current browser page and return the result. Use to read DOM content like document.body.innerText or document.title.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": { "type": "string", "description": "JavaScript expression. Example: \"document.body.innerText\"" }
                },
                "required": ["expression"]
            }
        }));
        schemas.push(json!({
            "name": "browser_scroll",
            "description": "Scroll the current browser page.",
            "parameters": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "Scroll direction" },
                    "amount": { "type": "integer", "description": "Pixels to scroll (default 500)" }
                },
                "required": ["direction"]
            }
        }));
        schemas.push(json!({
            "name": "browser_screenshot",
            "description": "Take a screenshot of the current browser tab. Returns base64-encoded PNG.",
            "parameters": { "type": "object", "properties": {} }
        }));
        schemas.push(json!({
            "name": "browser_tabs",
            "description": "List all open tabs in the connected Chrome browser.",
            "parameters": { "type": "object", "properties": {} }
        }));
        schemas.push(json!({
            "name": "spawn_agent",
            "description": "Spawn a sub-agent for parallel independent work. Returns a task ID to track progress.",
            "parameters": {
                "type": "object",
                "properties": {
                    "description": { "type": "string", "description": "Short description of the task for the sub-agent" },
                    "model_id": { "type": "string", "description": "Optional model override for the sub-agent" }
                },
                "required": ["description"]
            }
        }));
        schemas.push(json!({
            "name": "manage_tasks",
            "description": "List, create, update, or delete user tasks. Tasks have columns: inbox, todo, doing, done.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "update", "delete"], "description": "Action to perform" },
                    "task_id": { "type": "string", "description": "Task ID (for update/delete)" },
                    "title": { "type": "string", "description": "Task title (for create/update)" },
                    "column": { "type": "string", "enum": ["inbox", "todo", "doing", "done"], "description": "Column to move task to" },
                    "description": { "type": "string", "description": "Task description" },
                    "priority": { "type": "string", "enum": ["low", "medium", "high"], "description": "Task priority" },
                    "due_date": { "type": "string", "description": "Due date YYYY-MM-DD" }
                },
                "required": ["action"]
            }
        }));
        schemas.push(json!({
            "name": "manage_events",
            "description": "List, create, or delete calendar events.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "delete"], "description": "Action to perform" },
                    "event_id": { "type": "string", "description": "Event ID (for delete)" },
                    "title": { "type": "string", "description": "Event title" },
                    "date": { "type": "string", "description": "Event date YYYY-MM-DD" },
                    "start_time": { "type": "string", "description": "Start time HH:MM" },
                    "end_time": { "type": "string", "description": "End time HH:MM" }
                },
                "required": ["action"]
            }
        }));
    }

    schemas
}

// Global dispatcher yielding SSE events via a channel stream
pub fn execute_tool(
    name: &str,
    params: Value,
    chat_id: &str,
) -> impl Stream<Item = Result<Value, Infallible>> {
    let (tx, rx) = mpsc::channel(100);
    let name = name.to_string();
    let chat_id = chat_id.to_string();
    
    tokio::spawn(async move {
        let tool_id = format!("tool_{}_{}", name, uuid::Uuid::new_v4().simple());
        
        // Yield starting activity
        let _ = tx.send(json!({
            "type": "activity",
            "id": tool_id,
            "label": format!("Running {}", name),
            "done": false
        })).await;
        
        let result = match name.as_str() {
            "read_file" => fs::execute_read_file(&params).await,
            "write_file" => fs::execute_write_file(&params).await,
            "replace_file_content" => fs::execute_replace_file_content(&params).await,
            "grep_search" => fs::execute_grep_search(&params).await,
            "list_dir" => fs::execute_list_dir(&params).await,
            "run_command" => shell::execute_run_command(&params, &chat_id, &tx).await,
            "web_search" => search::execute_web_search(&params).await,
            "search_papers" => {
                let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
                let max_results = params.get("max_results").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
                let year_min = params.get("year_min").and_then(|v| v.as_u64()).map(|y| y as u32);
                let year_max = params.get("year_max").and_then(|v| v.as_u64()).map(|y| y as u32);
                let papers = crate::academic::search_academic_literature(query, max_results, year_min, year_max).await;
                Ok(serde_json::to_string_pretty(&papers).unwrap_or_default())
            }
            "format_citation" => {
                let paper = params.get("paper").unwrap_or(&Value::Null);
                let style = params.get("style").and_then(|v| v.as_str()).unwrap_or("apa");
                let cit = crate::academic::format_citation(paper, style);
                Ok(cit)
            }
            "write_research_paper" => {
                let topic = params.get("topic").and_then(|v| v.as_str()).unwrap_or("");
                let style = params.get("style").and_then(|v| v.as_str()).unwrap_or("academic");
                let word_count = params.get("word_count").and_then(|v| v.as_u64()).unwrap_or(500) as u32;
                crate::academic::write_research_paper(topic, style, word_count, &tx).await
            }
            "review_paper" => {
                let paper_content = params.get("paper_content").and_then(|v| v.as_str()).unwrap_or("");
                let review_type = params.get("review_type").and_then(|v| v.as_str()).unwrap_or("peer_review");
                crate::academic::review_paper(paper_content, review_type).await
            }
            "read_skill" => {
                let slug = params.get("slug").and_then(|v| v.as_str()).unwrap_or("");
                match crate::skills::read_skill(slug) {
                    Some(content) => Ok(content),
                    None => Err(format!("Skill '{}' not found.", slug)),
                }
            }
            "save_memory" => {
                let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let target_str = params.get("target").and_then(|v| v.as_str()).unwrap_or("memory");
                let target = target_str.parse::<crate::memory::MemoryTarget>().unwrap_or(crate::memory::MemoryTarget::Memory);
                match crate::memory::append(target, content) {
                    Ok(msg) => Ok(msg),
                    Err(e) => Ok(format!("Could not save memory: {}", e)),
                }
            }
            "send_telegram_message" => {
                let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
                match crate::telegram::send_message_from_settings(text).await {
                    Ok(msg) => Ok(msg),
                    Err(e) => Ok(format!("Could not send Telegram message: {}", e)),
                }
            }
            "extract_document" => doc_extract::execute_extract_document(&params).await,
            "detect_hardware" => {
                let profile = json!({
                    "gpu_name": "Apple M-Series GPU",
                    "cpu_count": num_cpus::get(),
                });
                Ok(serde_json::to_string_pretty(&profile).unwrap_or_default())
            }
            "get_stock_data" => stock::execute_get_stock_data(&params).await,
            // ─── Desktop control (cua-driver) ───
            "desktop_capture" => {
                let app = params.get("app").and_then(|v| v.as_str());
                match crate::cua::capture(app).await {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_click" => {
                let element = params.get("element").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let app = params.get("app").and_then(|v| v.as_str());
                match crate::cua::click(element, app).await {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_type" => {
                let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let element = params.get("element").and_then(|v| v.as_u64()).map(|v| v as u32);
                let app = params.get("app").and_then(|v| v.as_str());
                match crate::cua::type_text(text, element, app).await {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_scroll" => {
                let direction = params.get("direction").and_then(|v| v.as_str()).unwrap_or("down");
                let amount = params.get("amount").and_then(|v| v.as_i64()).unwrap_or(3) as i32;
                let app = params.get("app").and_then(|v| v.as_str());
                match crate::cua::scroll(direction, amount, app).await {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_key" => {
                let keys = params.get("keys").and_then(|v| v.as_str()).unwrap_or("");
                let app = params.get("app").and_then(|v| v.as_str());
                match crate::cua::key(keys, app).await {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_set_value" => {
                let element = params.get("element").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let value = params.get("value").and_then(|v| v.as_str()).unwrap_or("");
                let app = params.get("app").and_then(|v| v.as_str());
                match crate::cua::set_value(element, value, app).await {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_launch_app" => {
                let app = params.get("app").and_then(|v| v.as_str()).unwrap_or("");
                match crate::cua::launch_app(app).await {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_list_apps" => {
                match crate::cua::list_apps().await {
                    Ok(apps) => Ok(serde_json::to_string_pretty(&apps).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_wait" => {
                let seconds = params.get("seconds").and_then(|v| v.as_f64()).unwrap_or(1.0);
                // Clamp to a sane range so a model can't stall the agent loop
                // for minutes on end, and guard against NaN / negatives.
                let seconds = if seconds.is_finite() && seconds > 0.0 {
                    seconds.min(60.0)
                } else {
                    1.0
                };
                match crate::cua::wait(seconds).await {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                }
            }
            "desktop_start_session" => match crate::cua::start_session().await {
                Ok(()) => Ok("desktop-control session started; cua-driver is up.".to_string()),
                Err(e) => Err(e),
            },
            "desktop_end_session" => match crate::cua::end_session().await {
                Ok(()) => Ok("desktop-control session ended; cua-driver torn down.".to_string()),
                Err(e) => Err(e),
            },
            // ─── Browser control (zbctl) ───
            "browser_navigate" => {
                let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let tab_id = params.get("tab_id").and_then(|v| v.as_u64()).map(|v| v as u32);
                crate::zbctl::navigate(url, tab_id).await
            }
            "browser_snapshot" => {
                let max_items = params.get("max_items").and_then(|v| v.as_u64()).unwrap_or(80) as u32;
                crate::zbctl::snapshot(max_items, true).await
            }
            "browser_click" => {
                let element_id = params.get("element_id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                crate::zbctl::click(element_id).await
            }
            "browser_type" => {
                let element_id = params.get("element_id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
                crate::zbctl::type_text(element_id, text).await
            }
            "browser_eval" => {
                let expression = params.get("expression").and_then(|v| v.as_str()).unwrap_or("");
                crate::zbctl::eval(expression).await
            }
            "browser_scroll" => {
                let direction = params.get("direction").and_then(|v| v.as_str()).unwrap_or("down");
                let amount = params.get("amount").and_then(|v| v.as_i64()).map(|v| v as i32);
                crate::zbctl::scroll(direction, amount).await
            }
            "browser_screenshot" => {
                crate::zbctl::screenshot().await
            }
            "browser_tabs" => {
                crate::zbctl::tabs().await
            }
            "spawn_agent" => {
                // Sub-agent spawning is not yet fully implemented in the Rust backend.
                // Return a placeholder so the model knows the tool was received.
                let desc = params.get("description").and_then(|v| v.as_str()).unwrap_or("task");
                Ok(format!("Sub-agent spawned for: {}. (Note: sub-agent execution is not yet available in this build — performing the task inline instead.)", desc))
            }
            "ask_question" | "ask_user" => {
                // Return immediate choice instructions if called programmatically
                Ok("Select from options card in chat UI.".to_string())
            }
            "manage_tasks" => {
                let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("list");
                match action {
                    "list" => {
                        let tasks = crate::taskstore::get_tasks();
                        Ok(serde_json::to_string_pretty(&tasks).unwrap_or_else(|_| "[]".to_string()))
                    }
                    "create" => {
                        let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled task");
                        let task = crate::taskstore::create_task(
                            title.to_string(),
                            params.get("column").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            params.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            params.get("priority").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            params.get("due_date").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            None,
                        );
                        Ok(format!("Created task: {} (id={})", task.title, task.id))
                    }
                    "update" => {
                        let task_id = params.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
                        if task_id.is_empty() {
                            Err("task_id is required for update action".to_string())
                        } else {
                            match crate::taskstore::update_task(
                                task_id,
                                params.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                params.get("column").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                params.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                params.get("priority").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                params.get("due_date").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                None,
                            ) {
                                Some(task) => Ok(format!("Updated task: {} (id={})", task.title, task.id)),
                                None => Err(format!("Task '{}' not found", task_id)),
                            }
                        }
                    }
                    "delete" => {
                        let task_id = params.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
                        if crate::taskstore::delete_task(task_id) {
                            Ok(format!("Deleted task {}", task_id))
                        } else {
                            Err(format!("Task '{}' not found", task_id))
                        }
                    }
                    _ => Err(format!("Unknown manage_tasks action: {}", action)),
                }
            }
            "manage_events" => {
                let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("list");
                match action {
                    "list" => {
                        let events = crate::taskstore::get_events();
                        Ok(serde_json::to_string_pretty(&events).unwrap_or_else(|_| "[]".to_string()))
                    }
                    "create" => {
                        let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled event");
                        let date = params.get("date").and_then(|v| v.as_str()).unwrap_or("");
                        if date.is_empty() {
                            Err("date is required for create action".to_string())
                        } else {
                            let event = crate::taskstore::create_event(
                                title.to_string(),
                                date.to_string(),
                                params.get("start_time").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                params.get("end_time").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            );
                            Ok(format!("Created event: {} on {} (id={})", event.title, event.date, event.id))
                        }
                    }
                    "delete" => {
                        let event_id = params.get("event_id").and_then(|v| v.as_str()).unwrap_or("");
                        if crate::taskstore::delete_event(event_id) {
                            Ok(format!("Deleted event {}", event_id))
                        } else {
                            Err(format!("Event '{}' not found", event_id))
                        }
                    }
                    _ => Err(format!("Unknown manage_events action: {}", action)),
                }
            }
            t if t.starts_with("mcp__") => {
                // MCP tool execution — not yet implemented
                Err(format!("MCP tool '{}' is not yet available in this build.", name))
            }
            t if t.starts_with("composio__") => {
                // Composio tool execution — not yet implemented
                Err(format!("Composio tool '{}' is not yet available in this build.", name))
            }
            _ => Err(format!("Tool '{}' is not implemented.", name)),
        };
        
        let (ok, message) = match result {
            Ok(msg) => (true, msg),
            Err(err) => (false, err),
        };
        
        // Update activity status to finished
        let _ = tx.send(json!({
            "type": "activity",
            "id": tool_id,
            "label": format!("Finished {}", name),
            "done": true
        })).await;
        
        // Yield final tool result
        let _ = tx.send(json!({
            "type": "tool_result",
            "tool": name,
            "ok": ok,
            "message": message
        })).await;
    });
    
    ReceiverStream::new(rx).map(Ok)
}

mod num_cpus {
    pub fn get() -> usize {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
    }
}
