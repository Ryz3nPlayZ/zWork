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

