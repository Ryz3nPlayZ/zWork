use serde_json::{json, Value};
use tokio::sync::mpsc;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::ReceiverStream;

pub fn stream_upstream(
    endpoint: String,
    headers: reqwest::header::HeaderMap,
    body: Value,
    shape: String,
) -> impl futures_util::Stream<Item = Result<Value, Infallible>> {
    let (tx, rx) = mpsc::channel(100);
    
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_default();
            
        let resp = match client.post(&endpoint).headers(headers).json(&body).send().await {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(json!({
                    "type": "error",
                    "text": format!("Connection to router failed: {}", e)
                })).await;
                return;
            }
        };
        
        if !resp.status().is_success() {
            let status = resp.status();
            let body_txt = resp.text().await.unwrap_or_default();
            let _ = tx.send(json!({
                "type": "error",
                "text": format!("Router error status={}: {}", status, body_txt)
            })).await;
            return;
        }
        
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();
        let is_anthropic = shape == "anthropic";
        
        // Assembled tool call arguments
        let mut anthropic_blocks: HashMap<usize, Value> = HashMap::new();
        let mut openai_tool_calls: Vec<Value> = Vec::new();
        
        while let Some(chunk_res) = stream.next().await {
            let chunk = match chunk_res {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(json!({
                        "type": "error",
                        "text": format!("Stream read error: {}", e)
                    })).await;
                    break;
                }
            };
            
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();
                
                if line.is_empty() {
                    continue;
                }
                
                if line.starts_with("data: ") {
                    let data_str = line[6..].trim();
                    if data_str == "[DONE]" {
                        break;
                    }
                    
                    let chunk_val: Value = match serde_json::from_str(data_str) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    
                    if is_anthropic {
                        let ev_type = chunk_val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match ev_type {
                            "content_block_start" => {
                                let idx = chunk_val.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                if let Some(block) = chunk_val.get("content_block") {
                                    let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    if block_type == "tool_use" {
                                        let tool_id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                        let tool_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                        anthropic_blocks.insert(idx, json!({
                                            "type": "tool_use",
                                            "id": tool_id,
                                            "name": tool_name,
                                            "input_buf": ""
                                        }));
                                    }
                                }
                            }
                            "content_block_delta" => {
                                let idx = chunk_val.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                if let Some(delta) = chunk_val.get("delta") {
                                    let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    if delta_type == "text_delta" {
                                        let txt = delta.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                        let _ = tx.send(json!({
                                            "type": "delta",
                                            "text": txt
                                        })).await;
                                    } else if delta_type == "input_json_delta" {
                                        if let Some(partial) = delta.get("partial_json").and_then(|v| v.as_str()) {
                                            if let Some(b) = anthropic_blocks.get_mut(&idx) {
                                                let mut buf = b["input_buf"].as_str().unwrap_or("").to_string();
                                                buf.push_str(partial);
                                                b["input_buf"] = json!(buf);
                                            }
                                        }
                                    }
                                }
                            }
                            "content_block_stop" => {
                                let idx = chunk_val.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                if let Some(b) = anthropic_blocks.remove(&idx) {
                                    if b["type"] == "tool_use" {
                                        let id = b["id"].as_str().unwrap_or("");
                                        let name = b["name"].as_str().unwrap_or("");
                                        let input_buf = b["input_buf"].as_str().unwrap_or("");
                                        let parsed_args: Value = serde_json::from_str(input_buf).unwrap_or(json!({}));
                                        let _ = tx.send(json!({
                                            "type": "tool_call",
                                            "id": id,
                                            "name": name,
                                            "input": parsed_args
                                        })).await;
                                    }
                                }
                            }
                            _ => {}
                        }
                    } else {
                        // OpenAI shape parsing
                        if let Some(choices) = chunk_val.get("choices").and_then(|v| v.as_array()) {
                            if let Some(first) = choices.first() {
                                if let Some(delta) = first.get("delta") {
                                    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                                        let _ = tx.send(json!({
                                            "type": "delta",
                                            "text": content
                                        })).await;
                                    }
                                    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                                        for tc in tool_calls {
                                            let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                            while openai_tool_calls.len() <= idx {
                                                openai_tool_calls.push(json!({
                                                    "id": "",
                                                    "name": "",
                                                    "arguments_buf": ""
                                                }));
                                            }
                                            let current_tc = &mut openai_tool_calls[idx];
                                            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                                                current_tc["id"] = json!(id);
                                            }
                                            if let Some(func) = tc.get("function") {
                                                if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                                    current_tc["name"] = json!(name);
                                                }
                                                if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                                    let mut buf = current_tc["arguments_buf"].as_str().unwrap_or("").to_string();
                                                    buf.push_str(args);
                                                    current_tc["arguments_buf"] = json!(buf);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Flush remaining OpenAI tool calls if any
        if !openai_tool_calls.is_empty() {
            for tc in openai_tool_calls {
                let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let buf = tc.get("arguments_buf").and_then(|v| v.as_str()).unwrap_or("");
                let parsed_args: Value = serde_json::from_str(buf).unwrap_or(json!({}));
                let _ = tx.send(json!({
                    "type": "tool_call",
                    "id": id,
                    "name": name,
                    "input": parsed_args
                })).await;
            }
        }
        
        let _ = tx.send(json!({
            "type": "done"
        })).await;
    });
    
    ReceiverStream::new(rx).map(Ok)
}
