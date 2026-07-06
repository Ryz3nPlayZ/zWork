use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Build a user message content value from text plus file attachments.
///
/// Images are read from disk, base64-encoded, and formatted as Anthropic-style
/// content blocks (`{ "type": "image", "source": { "type": "base64", ... }}`).
/// Non-image files are included as text blocks with their path/mime so the model
/// knows they were attached.
pub fn build_user_content(text: &str, attachments: &[crate::server::Attachment]) -> Value {
    let mut blocks = Vec::new();

    if !text.is_empty() {
        blocks.push(json!({
            "type": "text",
            "text": text
        }));
    }

    for att in attachments {
        let mime = att.mime.as_str();

        if mime.starts_with("image/") {
            let image_bytes = if let Some(ref data_url) = att.data_url {
                extract_base64_from_data_url(data_url).and_then(|b64| BASE64.decode(b64).ok())
            } else {
                std::fs::read(PathBuf::from(&att.path)).ok()
            };

            match image_bytes {
                Some(bytes) => {
                    let data = BASE64.encode(&bytes);
                    blocks.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime,
                            "data": data
                        }
                    }));
                }
                None => {
                    blocks.push(json!({
                        "type": "text",
                        "text": format!("[Attached image {} could not be read]", att.name)
                    }));
                }
            }
        } else {
            // For non-image attachments, include a reference block. The agent
            // can use read_file or extract_document to access the contents.
            blocks.push(json!({
                "type": "text",
                "text": format!("[Attached file: {} (path: {}, mime: {})]", att.name, att.path, mime)
            }));
        }
    }

    if blocks.is_empty() {
        json!("")
    } else {
        // Always return an array when blocks are present. This keeps the
        // conversation format consistent and lets the OpenAI-path converter
        // reliably detect and translate image blocks.
        Value::Array(blocks)
    }
}

fn extract_base64_from_data_url(data_url: &str) -> Option<&str> {
    let comma_idx = data_url.find(',');
    let header_end = data_url.find(";base64,");
    if header_end.is_some() && comma_idx.is_some() {
        data_url.get(comma_idx.unwrap() + 1..)
    } else {
        None
    }
}

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
                    // Separate tool results from normal content blocks.
                    let mut tool_results = Vec::new();
                    let mut normal_blocks = Vec::new();

                    for item in arr {
                        if item.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                            let tool_use_id = item.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let content_val = item.get("content").cloned().unwrap_or(Value::Null);

                            let content_str = match content_val {
                                Value::String(s) => s,
                                other => other.to_string(),
                            };

                            tool_results.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": content_str,
                            }));
                        } else {
                            normal_blocks.push(item.clone());
                        }
                    }

                    // Anthropic image blocks need to be translated to OpenAI
                    // image_url blocks for providers that expect OpenAI format.
                    let openai_blocks: Vec<Value> = normal_blocks
                        .into_iter()
                        .map(|block| {
                            if block.get("type").and_then(|v| v.as_str()) == Some("image") {
                                if let Some(source) = block.get("source") {
                                    let media_type = source.get("media_type").and_then(|v| v.as_str()).unwrap_or("image/png");
                                    let data = source.get("data").and_then(|v| v.as_str()).unwrap_or("");
                                    return json!({
                                        "type": "image_url",
                                        "image_url": {
                                            "url": format!("data:{};base64,{}", media_type, data)
                                        }
                                    });
                                }
                            }
                            block
                        })
                        .collect();

                    if !openai_blocks.is_empty() {
                        out.push(json!({
                            "role": "user",
                            "content": openai_blocks
                        }));
                    }
                    out.extend(tool_results);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::Attachment;

    #[test]
    fn test_build_user_content_with_data_url() {
        let png_header = "iVBORw0KGgo="; // base64 for PNG header bytes
        let data_url = format!("data:image/png;base64,{}", png_header);
        let att = Attachment {
            client_id: None,
            name: "test.png".to_string(),
            path: "/nonexistent/path.png".to_string(),
            mime: "image/png".to_string(),
            kind: "image".to_string(),
            size: None,
            data_url: Some(data_url),
        };
        let content = build_user_content("describe this", &[att]);
        let arr = content.as_array().expect("content should be an array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[1]["type"], "image");
        assert_eq!(arr[1]["source"]["type"], "base64");
        assert_eq!(arr[1]["source"]["media_type"], "image/png");
        assert!(!arr[1]["source"]["data"].as_str().unwrap().is_empty());
    }

    #[test]
    fn test_build_user_content_image_only() {
        let png_header = "iVBORw0KGgo=";
        let data_url = format!("data:image/png;base64,{}", png_header);
        let att = Attachment {
            client_id: None,
            name: "test.png".to_string(),
            path: "/nonexistent/path.png".to_string(),
            mime: "image/png".to_string(),
            kind: "image".to_string(),
            size: None,
            data_url: Some(data_url),
        };
        let content = build_user_content("", &[att]);
        let arr = content.as_array().expect("content should be an array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "image");
        assert_eq!(arr[0]["source"]["type"], "base64");
    }

    #[test]
    fn test_extract_base64_from_data_url() {
        assert_eq!(
            extract_base64_from_data_url("data:image/png;base64,SGVsbG8="),
            Some("SGVsbG8=")
        );
        assert_eq!(extract_base64_from_data_url("not-a-data-url"), None);
        assert_eq!(extract_base64_from_data_url("data:text/plain,hello"), None);
    }
}

