use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_stream::StreamExt;

#[derive(Deserialize, Serialize, Debug)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

pub async fn run_stdio_mcp_server(chat_id: String) {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin).lines();

    while let Ok(Some(line)) = reader.next_line().await {
        let req: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: None,
                    result: None,
                    error: Some(json!({
                        "code": -32700,
                        "message": format!("Parse error: {}", e)
                    })),
                };
                if let Ok(resp_str) = serde_json::to_string(&err_resp) {
                    let _ = stdout.write_all(format!("{}\n", resp_str).as_bytes()).await;
                    let _ = stdout.flush().await;
                }
                continue;
            }
        };

        let response = handle_mcp_request(req, &chat_id).await;
        if let Ok(resp_str) = serde_json::to_string(&response) {
            let _ = stdout.write_all(format!("{}\n", resp_str).as_bytes()).await;
            let _ = stdout.flush().await;
        }
    }
}

async fn handle_mcp_request(req: JsonRpcRequest, chat_id: &str) -> JsonRpcResponse {
    let id = req.id.clone();
    match req.method.as_str() {
        "initialize" => {
            JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "zwork-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                })),
                error: None,
            }
        }
        "notifications/initialized" => {
            JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: None,
                result: None,
                error: None,
            }
        }
        "tools/list" => {
            let schemas = crate::tools::get_tool_schemas(false);
            let mcp_tools: Vec<Value> = schemas
                .into_iter()
                .map(|mut t| {
                    let input_schema = t.get_mut("parameters").cloned().unwrap_or(json!({
                        "type": "object",
                        "properties": {}
                    }));
                    json!({
                        "name": t["name"],
                        "description": t["description"],
                        "inputSchema": input_schema
                    })
                })
                .collect();

            JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(json!({
                    "tools": mcp_tools
                })),
                error: None,
            }
        }
        "tools/call" => {
            let params_val = req.params.unwrap_or(Value::Null);
            let tool_name = params_val.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let arguments = params_val.get("arguments").cloned().unwrap_or(json!({}));

            let mut tool_stream = crate::tools::execute_tool(&tool_name, arguments, chat_id);
            let mut final_result_txt = String::new();
            let mut final_result_ok = true;
            let mut found_result = false;

            while let Some(Ok(evt)) = tool_stream.next().await {
                let type_str = evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if type_str == "activity" {
                    if let Some(sender) = crate::agent::sse_senders().lock().unwrap().get(chat_id) {
                        let _ = sender.send(Ok(evt.clone())).await;
                    }
                    
                    // Update database in real-time
                    if let Some(mut chat) = crate::chatstore::get(chat_id) {
                        if let Some(last_msg) = chat.messages.last_mut() {
                            if last_msg.role == "assistant" {
                                let act_id = evt.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                let act_label = evt.get("label").and_then(|v| v.as_str()).unwrap_or("");
                                let act_done = evt.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
                                
                                let entry = json!({
                                    "id": act_id,
                                    "label": act_label,
                                    "done": act_done
                                });
                                
                                if let Some(pos) = last_msg.activities.iter().position(|x| x["id"] == act_id) {
                                    last_msg.activities[pos] = entry;
                                } else {
                                    last_msg.activities.push(entry);
                                }
                                
                                let _ = crate::chatstore::update_message(
                                    chat_id,
                                    &last_msg.id,
                                    None,
                                    Some(last_msg.activities.clone())
                                );
                            }
                        }
                    }
                } else if type_str == "tool_result" {
                    final_result_txt = evt.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    final_result_ok = evt.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
                    found_result = true;
                }
            }

            if found_result {
                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: Some(json!({
                        "content": [
                            {
                                "type": "text",
                                "text": final_result_txt
                            }
                        ],
                        "isError": !final_result_ok
                    })),
                    error: None,
                }
            } else {
                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: None,
                    error: Some(json!({
                        "code": -32603,
                        "message": format!("Tool execution failed: no result returned for tool {}", tool_name)
                    })),
                }
            }
        }
        _ => {
            JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: None,
                error: Some(json!({
                    "code": -32601,
                    "message": format!("Method not found: {}", req.method)
                })),
            }
        }
    }
}
