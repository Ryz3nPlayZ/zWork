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
        json!({
            "name": "check_novelty",
            "description": "Check the novelty of a research topic and its hypotheses against existing literature. Returns a novelty rating (Low/Medium/High), max similarity score, and the most similar papers found.",
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": { "type": "string", "description": "The research topic to check" },
                    "hypotheses": { "type": "string", "description": "The hypotheses to check for novelty (optional)" }
                },
                "required": ["topic"]
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
            "description": "Run a shell command. Set background=true to detach servers. Set timeout (seconds, default 180, 0=unbounded) for long-running commands.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run" },
                    "cwd": { "type": "string", "description": "Directory context" },
                    "background": { "type": "boolean", "description": "Run in background" },
                    "timeout": { "type": "integer", "description": "Max seconds before the command is killed. Default 180. Use 0 for no timeout (servers, watchers)." }
                },
                "required": ["command"]
            }
        }));
        schemas.push(json!({
            "name": "save_memory",
            "description": "Save a fact to the agent's persistent memory. Use target='user' for facts about the user (preferences, style, goals, habits, job, family, constraints) and target='memory' for everything else (project facts, conventions, deadlines, things learned). Use target='task' ONLY inside a scheduled-task run to save findings for future runs of that task.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The fact to remember" },
                    "target": { "type": "string", "description": "Which memory file to write to. Use 'memory' (default), 'user', or 'task' (scheduled tasks only)." }
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
        schemas.push(json!({
            "name": "desktop_office",
            "description": "Semantic Word (.docx) and Excel (.xlsx) editing without a GUI. Read paragraphs, append text, replace content, read sheets, write cells/ranges, or locate cells.",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["word", "excel", "libreoffice"], "description": "Document backend" },
                    "action": { "type": "string", "enum": ["read", "inspect", "paragraphs", "append", "set-paragraph", "replace", "sheets", "write-cell", "write-range", "fill-table", "locate-cell", "fill-cell"], "description": "Editing action" },
                    "path": { "type": "string", "description": "Path to the .docx or .xlsx file" },
                    "text": { "type": "string", "description": "Text to insert/append" },
                    "index": { "type": "integer", "description": "Paragraph index (for set-paragraph)" },
                    "sheet": { "type": "string", "description": "Sheet name (Excel)" },
                    "cell": { "type": "string", "description": "Cell reference e.g. 'A1'" },
                    "value": { "type": "string", "description": "Value to write (string for cells, JSON array-of-arrays for write-range/fill-table)" },
                    "find": { "type": "string", "description": "Search text or row label" },
                    "replace": { "type": "string", "description": "Replacement text" }
                },
                "required": ["type", "action", "path"]
            }
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
        schemas.push(json!({
            "name": "manage_schedules",
            "description": "Create, list, update, or delete recurring scheduled tasks. A scheduled task runs the agent automatically on a schedule (every N minutes, or daily at a specific time on specific weekdays) and posts findings to the user's inbox. Use this when the user wants to AUTOMATE something on a recurring basis (e.g. 'every morning check my email for invoices'). Free-tier users are limited to 3 enabled tasks and a 15-minute minimum interval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["create", "list", "update", "delete", "enable", "disable"], "description": "Action to perform" },
                    "task_id": { "type": "string", "description": "Scheduled task ID (for update/delete/enable/disable)" },
                    "title": { "type": "string", "description": "Short human-readable name for the task (e.g. 'Email invoice check')" },
                    "prompt": { "type": "string", "description": "The full objective the agent should complete on each run. Be specific and self-contained — the agent has no memory of this conversation during a scheduled run (e.g. 'Check the Gmail inbox for invoices received since the last run. For each new invoice, extract the vendor, amount, and due date. Flag any amount over $1000. Post a summary of new invoices to the inbox.')" },
                    "interval_minutes": { "type": "integer", "description": "Run every N minutes. Mutually exclusive with daily_time. Minimum 15." },
                    "daily_time": { "type": "string", "description": "Run daily at HH:MM (24h, local time). Mutually exclusive with interval_minutes." },
                    "daily_weekdays": { "type": "array", "items": { "type": "integer" }, "description": "Weekdays to run (0=Sun..6=Sat). Omit for every day." },
                    "enabled": { "type": "boolean", "description": "Whether the task is active (for update). Defaults to true on create." }
                },
                "required": ["action"]
            }
        }));
        schemas.push(json!({
            "name": "post_to_inbox",
            "description": "Post a message to the user's inbox. The inbox is how the agent talks to the user UNPROMPTED — the user sees these messages without initiating a chat. Use during a scheduled task to surface a finding, flag, or question (e.g. 'Found an invoice over $1000', 'Your 9am meeting was moved'). Also usable in interactive chat to leave a note the user will see later. Be concise: a clear title and a short body.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short headline the user sees in the inbox list (e.g. 'Invoice anomaly: Acme $4,200')." },
                    "body": { "type": "string", "description": "1-3 sentences of detail. Include what was found and any recommended action." },
                    "kind": { "type": "string", "enum": ["summary", "flag", "question"], "description": "summary = routine result; flag = something looks off / needs attention; question = you need a decision from the user." }
                },
                "required": ["title", "body"]
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
            "check_novelty" => {
                let topic = params.get("topic").and_then(|v| v.as_str()).unwrap_or("");
                let hypotheses = params.get("hypotheses").and_then(|v| v.as_str()).unwrap_or("");
                crate::academic::check_novelty(topic, hypotheses).await
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

                // Per-task memory: only valid inside a scheduled-task run. We
                // resolve the owning task by matching this chat against the
                // scheduled task's last_chat_id (set when the run starts).
                // Interactive chats have no task context, so "task" is rejected.
                if target_str.eq_ignore_ascii_case("task") {
                    let task = crate::schedulestore::get_all()
                        .into_iter()
                        .find(|t| t.last_chat_id.as_deref() == Some(chat_id.as_str()));
                    match task {
                        Some(t) => match crate::memory::append_task(&t.id, content) {
                            Ok(msg) => Ok(msg),
                            Err(e) => Ok(format!("Could not save task memory: {}", e)),
                        },
                        None => Ok(
                            "Task memory is only available inside a scheduled-task run. \
                             Use `target: \"memory\"` for general memory."
                                .to_string(),
                        ),
                    }
                } else {
                    let target = target_str
                        .parse::<crate::memory::MemoryTarget>()
                        .unwrap_or(crate::memory::MemoryTarget::Memory);
                    match crate::memory::append(target, content) {
                        Ok(msg) => Ok(msg),
                        Err(e) => Ok(format!("Could not save memory: {}", e)),
                    }
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
                let profile = detect_hardware_profile();
                Ok(serde_json::to_string_pretty(&profile).unwrap_or_default())
            }
            "get_stock_data" => stock::execute_get_stock_data(&params).await,
            "deploy_web_app" => {
                let project_path = params.get("project_path").and_then(|v| v.as_str()).unwrap_or(".");
                let framework = params.get("framework").and_then(|v| v.as_str()).unwrap_or("");
                let res = crate::deploy::deploy(project_path, framework).await;
                let ok = res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                let message = res.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if ok { Ok(message) } else { Err(message) }
            }
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
            "desktop_office" => crate::office::execute(&params).await,
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
                let desc = params.get("description").and_then(|v| v.as_str()).unwrap_or("task").to_string();
                // Use the model the caller specified, else the configured default.
                let model_id = params.get("model_id").and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        let s = crate::settings::load();
                        if !s.default_model.is_empty() { s.default_model } else { "deepseek-v4-flash".to_string() }
                    });
                match crate::agent::spawn_subagent(&chat_id, &chat_id, &desc, &model_id, &tx).await {
                    Ok(result) => Ok(format!("Sub-agent completed the task. Result:\n\n{}", result)),
                    Err(e) => Err(format!("Sub-agent failed: {}", e)),
                }
            }
            "ask_question" | "ask_user" => {
                // Interactive flow: emit an ask_question card to the UI, then
                // block on a pending-question oneshot until the user answers
                // via /api/chats/:id/answer-question.
                let question = params.get("question").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let options: Vec<String> = params.get("options")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|o| o.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let (qtx, qrx) = tokio::sync::oneshot::channel::<String>();
                crate::agent::register_pending_question(&chat_id, qtx);
                // Surface the question card to the frontend.
                let _ = tx.send(json!({
                    "type": "ask_question",
                    "chat_id": chat_id,
                    "question": question,
                    "options": options,
                })).await;
                // Block until answered or a 5-minute timeout (so the run can't
                // hang forever if the user walks away).
                match tokio::time::timeout(std::time::Duration::from_secs(300), qrx).await {
                    Ok(Ok(answer)) => Ok(format!("User responded with: {}", answer)),
                    _ => {
                        // Timed out or the sender was dropped (run cancelled).
                        crate::agent::clear_pending_question(&chat_id);
                        Err("User did not respond to the question.".to_string())
                    }
                }
            }
            "ask_user_for_permission" => {
                // Approval card for a (typically destructive) action. On
                // "Approve", the command is added to the run's approved list
                // so subsequent identical calls skip the gate.
                let explanation = params.get("explanation").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let question = format!("Permission Required:\n\n{}\n\nDo you want to proceed?", explanation);
                let options = vec![
                    "Approve".to_string(),
                    "Deny".to_string(),
                    "Tell me what to do instead".to_string(),
                ];
                let (qtx, qrx) = tokio::sync::oneshot::channel::<String>();
                crate::agent::register_pending_question(&chat_id, qtx);
                let _ = tx.send(json!({
                    "type": "ask_question",
                    "chat_id": chat_id,
                    "question": question,
                    "options": options,
                })).await;
                let answer = match tokio::time::timeout(std::time::Duration::from_secs(300), qrx).await {
                    Ok(Ok(a)) => a,
                    _ => {
                        crate::agent::clear_pending_question(&chat_id);
                        "Deny".to_string()
                    }
                };
                match answer.trim().to_lowercase().as_str() {
                    "approve" => {
                        // Pre-approve the command for the rest of this run.
                        if let Some(cmd) = params.get("command").and_then(|v| v.as_str()) {
                            crate::agent::approve_command(&chat_id, cmd);
                        }
                        Ok("Permission granted by user.".to_string())
                    }
                    _ => Err(format!("Permission denied by user. They said: {}", answer)),
                }
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
            "manage_schedules" => {
                let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("list");
                manage_schedules(action, &params)
            }
            "post_to_inbox" => {
                let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let body = params.get("body").and_then(|v| v.as_str()).unwrap_or("");
                if title.is_empty() {
                    Err("title is required".to_string())
                } else {
                    let kind = params
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("summary")
                        .to_string();
                    // Link the inbox item to this chat so the UI can deep-link
                    // into the transcript. If this chat belongs to a scheduled
                    // task, stamp the task_id too.
                    let (task_id, linked_chat) = match crate::chatstore::get(chat_id.as_str()) {
                        Some(c) if c.kind == "automation" => {
                            let tid = crate::schedulestore::get_all()
                                .into_iter()
                                .find(|t| t.last_chat_id.as_deref() == Some(chat_id.as_str()))
                                .map(|t| t.id);
                            (tid, Some(chat_id.clone()))
                        }
                        _ => (None, Some(chat_id.clone())),
                    };
                    let item = crate::inboxstore::create(crate::inboxstore::CreateParams {
                        task_id,
                        chat_id: linked_chat,
                        kind: Some(kind),
                        title: title.to_string(),
                        body: Some(body.to_string()),
                    });
                    Ok(format!("Posted to inbox: {} (id={})", item.title, item.id))
                }
            }
            t if t.starts_with("mcp__") => {
                // Forward to the configured MCP server's tools/call.
                let res = crate::mcp::call_tool(&name, params.clone()).await;
                let is_error = res.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
                let text = res.get("content")
                    .and_then(|c| c.as_array())
                    .map(|blocks| blocks.iter()
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n"))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| res.to_string());
                if is_error { Err(text) } else { Ok(text) }
            }
            t if t.starts_with("composio__") => {
                // Forward to the zWork cloud Composio proxy (see composio.rs).
                let res = crate::composio::call_tool(&name, params.clone()).await;
                let is_error = res.get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                // Pull the text out of the content[] blocks the proxy returns.
                let text = res.get("content")
                    .and_then(|c| c.as_array())
                    .map(|blocks| {
                        blocks.iter()
                            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| res.to_string());
                if is_error {
                    Err(text)
                } else {
                    Ok(text)
                }
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

/// Detect the local hardware profile for research/local-runtime decisions.
/// Probes for an NVIDIA GPU via `nvidia-smi`, then falls back to Apple
/// Silicon MPS, then reports CPU-only. Mirrors the Python
/// `_detect_hardware_profile`.
fn detect_hardware_profile() -> serde_json::Value {
    let mut has_gpu = false;
    let mut gpu_type = "cpu".to_string();
    let mut gpu_name = "CPU only".to_string();
    let mut vram_mb: Option<u32> = None;

    // 1. NVIDIA GPU via nvidia-smi
    if let Ok(out) = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output()
    {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(first_line) = stdout.trim().lines().next() {
                let parts: Vec<&str> = first_line.split(',').map(|p| p.trim()).collect();
                if parts.len() >= 2 {
                    gpu_name = parts[0].to_string();
                    gpu_type = "cuda".to_string();
                    has_gpu = true;
                    vram_mb = parts[1].parse::<f64>().ok().map(|v| v as u32);
                }
            }
        }
    }

    // 2. Apple Silicon MPS
    if !has_gpu && cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        has_gpu = true;
        gpu_type = "mps".to_string();
        gpu_name = "Apple Silicon (MPS)".to_string();
    }

    serde_json::json!({
        "has_gpu": has_gpu,
        "gpu_type": gpu_type,
        "gpu_name": gpu_name,
        "vram_mb": vram_mb,
        "cpu_count": num_cpus::get(),
        "os": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
    })
}

// ─── Scheduled-task management ────────────────────────────────────────────────

const SCHED_MIN_INTERVAL_MINUTES: u32 = 15;
const SCHED_FREE_MAX_ENABLED: usize = 3;

fn tier_lifts_cap() -> bool {
    let tier = crate::settings::load().account_tier;
    tier == "pro" || tier == "max"
}

/// Public wrapper for HTTP handlers that need the same tier check.
pub fn tier_lifts_cap_pub() -> bool {
    tier_lifts_cap()
}

/// Backing logic for the `manage_schedules` tool. Returns a human-readable
/// result string (shown to the model) on success, or an error string on failure.
fn manage_schedules(action: &str, params: &Value) -> Result<String, String> {
    match action {
        "list" => {
            let tasks = crate::schedulestore::get_all();
            if tasks.is_empty() {
                Ok("No scheduled tasks yet.".to_string())
            } else {
                let mut out = String::from("Scheduled tasks:\n");
                for t in tasks {
                    let status = if t.enabled { "enabled" } else { "disabled" };
                    out.push_str(&format!(
                        "- [{}] {} (id={}): {}\n",
                        status, t.title, t.id, t.prompt
                    ));
                }
                Ok(out)
            }
        }
        "create" => {
            let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            if title.is_empty() {
                return Err("title is required".to_string());
            }
            if prompt.is_empty() {
                return Err("prompt is required — describe what the task should do each run".to_string());
            }

            let interval = params
                .get("interval_minutes")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let daily_time = params
                .get("daily_time")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            // Exactly one trigger kind.
            match (interval, daily_time.as_ref()) {
                (Some(_), Some(_)) => {
                    return Err(
                        "Specify either interval_minutes OR daily_time, not both".to_string()
                    );
                }
                (None, None) => {
                    return Err(
                        "A schedule is required: set interval_minutes or daily_time".to_string()
                    );
                }
                _ => {}
            }

            // Enforce min interval floor (all tiers — bounds worst-case cost).
            if let Some(m) = interval {
                if m < SCHED_MIN_INTERVAL_MINUTES {
                    return Err(format!(
                        "The minimum interval is {} minutes. Got {}.",
                        SCHED_MIN_INTERVAL_MINUTES, m
                    ));
                }
            }

            // Validate daily_time format.
            if let Some(t) = daily_time.as_ref() {
                if !valid_hhmm(t) {
                    return Err(format!(
                        "daily_time must be HH:MM (24h). Got '{}'.",
                        t
                    ));
                }
            }

            // Free-tier task cap.
            let enabled_new = params.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            if enabled_new && !tier_lifts_cap() {
                let current = crate::schedulestore::count_enabled();
                if current >= SCHED_FREE_MAX_ENABLED {
                    return Err(format!(
                        "Free tier is limited to {} enabled scheduled tasks (you have {}). \
                         Disable an existing task or upgrade to Pro.",
                        SCHED_FREE_MAX_ENABLED, current
                    ));
                }
            }

            let daily_weekdays = params
                .get("daily_weekdays")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_u64().map(|n| n as u32))
                        .collect::<Vec<_>>()
                });

            let task = crate::schedulestore::create(crate::schedulestore::CreateParams {
                title: title.to_string(),
                prompt: prompt.to_string(),
                trigger_type: Some("time".to_string()),
                interval_minutes: interval,
                daily_time,
                daily_weekdays,
                enabled: Some(enabled_new),
                notify_channel: Some("inbox".to_string()),
                model: None,
            });

            Ok(format!(
                "Created scheduled task '{}' (id={}). It will run {}.",
                task.title,
                task.id,
                describe_schedule(&task.interval_minutes, &task.daily_time, &task.daily_weekdays)
            ))
        }
        "update" => {
            let task_id = params.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
            if task_id.is_empty() {
                return Err("task_id is required".to_string());
            }
            let existing = crate::schedulestore::get(task_id)
                .ok_or_else(|| format!("Scheduled task '{}' not found", task_id))?;

            let interval = params
                .get("interval_minutes")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            if let Some(m) = interval {
                if m < SCHED_MIN_INTERVAL_MINUTES {
                    return Err(format!(
                        "The minimum interval is {} minutes. Got {}.",
                        SCHED_MIN_INTERVAL_MINUTES, m
                    ));
                }
            }

            // Resolve the post-update trigger so we can re-validate mutual
            // exclusivity and re-derive next_run_at.
            let new_interval = interval.or(existing.interval_minutes);
            let new_daily_time = params
                .get("daily_time")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or(existing.daily_time.clone());
            if new_interval.is_some() && new_daily_time.is_some() {
                return Err(
                    "Specify either interval_minutes OR daily_time, not both".to_string()
                );
            }
            if let Some(t) = new_daily_time.as_ref() {
                if !valid_hhmm(t) {
                    return Err(format!("daily_time must be HH:MM (24h). Got '{}'.", t));
                }
            }

            let daily_weekdays = params
                .get("daily_weekdays")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_u64().map(|n| n as u32))
                        .collect::<Vec<_>>()
                });

            let updated = crate::schedulestore::update(
                task_id,
                crate::schedulestore::UpdateParams {
                    title: params.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    prompt: params.get("prompt").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    trigger_type: None,
                    interval_minutes: interval.map(Some),
                    daily_time: params
                        .get("daily_time")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .map(Some),
                    daily_weekdays: daily_weekdays.map(Some),
                    enabled: params.get("enabled").and_then(|v| v.as_bool()),
                    notify_channel: None,
                    model: None,
                },
            )
            .ok_or_else(|| format!("Scheduled task '{}' not found", task_id))?;

            // Re-stamp next_run_at since the trigger likely changed. Use 0 as
            // "from" so the next tick picks it up immediately if due.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let _ = crate::schedulestore::set_run_state(
                task_id,
                updated.last_run_at.unwrap_or(0),
                now + 1000, // schedule on the next tick
                &updated.last_chat_id.clone().unwrap_or_default(),
            );

            Ok(format!(
                "Updated scheduled task '{}' (id={}). Now runs {}.",
                updated.title,
                updated.id,
                describe_schedule(&new_interval, &new_daily_time, &updated.daily_weekdays)
            ))
        }
        "delete" => {
            let task_id = params.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
            if task_id.is_empty() {
                return Err("task_id is required".to_string());
            }
            // Best-effort: clean up the task's memory file too.
            let mem_path = crate::paths::task_memory_path(task_id);
            let _ = std::fs::remove_file(mem_path);
            if crate::schedulestore::delete(task_id) {
                Ok(format!("Deleted scheduled task {}", task_id))
            } else {
                Err(format!("Scheduled task '{}' not found", task_id))
            }
        }
        "enable" | "disable" => {
            let task_id = params.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
            if task_id.is_empty() {
                return Err("task_id is required".to_string());
            }
            let enable = action == "enable";

            // Enforce cap on enable.
            if enable && !tier_lifts_cap() {
                let current = crate::schedulestore::count_enabled();
                // count_enabled counts currently-enabled; enabling this one adds 1
                // only if it's currently disabled.
                let currently_enabled =
                    crate::schedulestore::get(task_id).map(|t| t.enabled).unwrap_or(false);
                if !currently_enabled && current >= SCHED_FREE_MAX_ENABLED {
                    return Err(format!(
                        "Free tier is limited to {} enabled scheduled tasks (you have {}). \
                         Disable an existing task or upgrade to Pro.",
                        SCHED_FREE_MAX_ENABLED, current
                    ));
                }
            }

            let updated = crate::schedulestore::update(
                task_id,
                crate::schedulestore::UpdateParams {
                    enabled: Some(enable),
                    ..Default::default()
                },
            )
            .ok_or_else(|| format!("Scheduled task '{}' not found", task_id))?;

            Ok(format!(
                "Scheduled task '{}' is now {}.",
                updated.title,
                if enable { "enabled" } else { "disabled" }
            ))
        }
        _ => Err(format!("Unknown manage_schedules action: {}", action)),
    }
}

fn valid_hhmm(s: &str) -> bool {
    let (h, m) = match s.split_once(':') {
        Some(pair) => pair,
        None => return false,
    };
    let h: u32 = match h.parse() {
        Ok(n) => n,
        Err(_) => return false,
    };
    let m: u32 = match m.parse() {
        Ok(n) => n,
        Err(_) => return false,
    };
    h < 24 && m < 60
}

fn describe_schedule(
    interval: &Option<u32>,
    daily_time: &Option<String>,
    daily_weekdays: &Option<Vec<u32>>,
) -> String {
    if let Some(m) = interval {
        return format!("every {} minutes", m);
    }
    if let Some(t) = daily_time {
        let days = match daily_weekdays {
            Some(d) if !d.is_empty() => {
                let names = d
                    .iter()
                    .map(|i| match i {
                        0 => "Sun", 1 => "Mon", 2 => "Tue", 3 => "Wed",
                        4 => "Thu", 5 => "Fri", 6 => "Sat", _ => "?",
                    })
                    .collect::<Vec<_>>()
                    .join("/");
                format!("on {}", names)
            }
            _ => "every day".to_string(),
        };
        return format!("at {} local ({})", t, days);
    }
    "on a schedule".to_string()
}

