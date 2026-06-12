use serde_json::{json, Value};
use tokio::sync::mpsc;
use std::collections::HashMap;
use std::convert::Infallible;
use futures_util::stream::Stream;
use futures_util::StreamExt;
use tokio_stream::wrappers::ReceiverStream;

pub mod fs;
pub mod shell;
pub mod search;
pub mod doc_extract;
pub mod dctl;

// Risk evaluation for permission checking
pub enum Risk {
    Safe,
    Destructive { reason: String },
}

pub fn evaluate_tool_risk(name: &str, params: &Value) -> Risk {
    match name {
        "run_command" => {
            let cmd = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
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
            "description": "Save a fact to the agent's persistent memory file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The fact to remember" }
                },
                "required": ["content"]
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
        schemas.push(json!({
            "name": "dctl",
            "description": "Desktop control GUI automation client tool. Subcommands: click, type, screenshot, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subcommand": { "type": "string", "description": "dctl action" },
                    "args": { "type": "array", "items": { "type": "string" }, "description": "Subcommand arguments" }
                },
                "required": ["subcommand"]
            }
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
            "read_skill" => {
                let slug = params.get("slug").and_then(|v| v.as_str()).unwrap_or("");
                match crate::skills::read_skill(slug) {
                    Some(content) => Ok(content),
                    None => Err(format!("Skill '{}' not found.", slug)),
                }
            }
            "save_memory" => {
                let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let mem_path = crate::paths::memory_path();
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&mem_path)
                    .and_then(|mut f| {
                        use std::io::Write;
                        writeln!(f, "- {}", content)
                    });
                Ok("Saved to memory.".to_string())
            }
            "extract_document" => doc_extract::execute_extract_document(&params).await,
            "detect_hardware" => {
                let profile = json!({
                    "gpu_name": "Apple M-Series GPU",
                    "cpu_count": num_cpus::get(),
                });
                Ok(serde_json::to_string_pretty(&profile).unwrap_or_default())
            }
            "dctl" => dctl::execute_dctl(&params).await,
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
