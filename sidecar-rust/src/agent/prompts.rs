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
