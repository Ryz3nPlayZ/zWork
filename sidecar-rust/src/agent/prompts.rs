use serde_json::Value;

pub fn convert_input_messages(messages: &[Value]) -> (String, Vec<Value>) {
    let mut system_parts = Vec::new();
    let mut convo = Vec::new();
    
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let content = m.get("content").unwrap_or(&Value::Null);
        
        if role == "system" {
            if let Some(txt) = content.as_str() {
                system_parts.push(txt.to_string());
            }
        } else if role == "user" || role == "assistant" {
            convo.push(m.clone());
        }
    }
    
    (system_parts.join("\n\n"), convo)
}

pub fn convert_convo_for_openai(convo: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in convo {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let content = m.get("content").unwrap_or(&Value::Null);
        
        match role {
            "user" => {
                if let Some(arr) = content.as_array() {
                    // Check if it's a list of tool results
                    for item in arr {
                        if item.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                            let tool_use_id = item.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let content_val = item.get("content").cloned().unwrap_or(Value::Null);
                            
                            let content_str = match content_val {
                                Value::String(s) => s,
                                other => other.to_string(),
                            };
                            
                            out.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": content_str,
                            }));
                        } else {
                            // General user content block
                            out.push(serde_json::json!({
                                "role": "user",
                                "content": item.clone()
                            }));
                        }
                    }
                } else {
                    out.push(m.clone());
                }
            }
            "assistant" => {
                if let Some(arr) = content.as_array() {
                    let mut text_parts = Vec::new();
                    let mut tool_calls = Vec::new();
                    
                    for item in arr {
                        let itype = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if itype == "text" {
                            if let Some(txt) = item.get("text").and_then(|v| v.as_str()) {
                                text_parts.push(txt.to_string());
                            }
                        } else if itype == "tool_use" {
                            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let input = item.get("input").cloned().unwrap_or(Value::Null);
                            
                            let args_str = match input {
                                Value::String(s) => s,
                                other => serde_json::to_string(&other).unwrap_or_default(),
                            };
                            
                            tool_calls.push(serde_json::json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": args_str,
                                }
                            }));
                        }
                    }
                    
                    let combined_text = text_parts.join("");
                    let mut msg = serde_json::json!({
                        "role": "assistant",
                        "content": combined_text,
                    });
                    if !tool_calls.is_empty() {
                        if let Some(obj) = msg.as_object_mut() {
                            obj.insert("tool_calls".to_string(), Value::Array(tool_calls));
                        }
                    }
                    out.push(msg);
                } else {
                    out.push(m.clone());
                }
            }
            _ => {
                out.push(m.clone());
            }
        }
    }
    out
}

