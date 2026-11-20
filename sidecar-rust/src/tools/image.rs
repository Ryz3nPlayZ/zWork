//! `generate_image`: one image from a prompt, made by the zWork cloud
//! (`POST /api/images/generate`, billed to the user's plan) and saved to the
//! workspace outputs folder.

use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

/// Same list the cloud accepts.
pub const ASPECTS: &[&str] = &["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

pub async fn execute(params: &Value, chat_id: &str) -> Result<String, String> {
    let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("").trim();
    if prompt.is_empty() {
        return Err("Say what the image should show.".into());
    }
    let aspect = params.get("aspect").and_then(|v| v.as_str()).filter(|a| ASPECTS.contains(a)).unwrap_or("1:1");

    let settings = crate::settings::load();
    let token = settings.api_keys.get("zwork_router").cloned().unwrap_or_default();
    if token.trim().is_empty() {
        return Err("Making images needs a zWork account. Sign in from Settings, then try again.".into());
    }
    let base = settings.provider_config.get("zwork_router").and_then(|m| m.get("base_url")).filter(|b| !b.is_empty()).cloned()
        .unwrap_or_else(|| "https://api.tryzwork.app/api".into());

    let resp = reqwest::Client::new()
        .post(format!("{}/images/generate", base.trim_end_matches('/')))
        .bearer_auth(token.trim())
        .header("x-zwork-chat-id", chat_id)
        .timeout(Duration::from_secs(120))
        .json(&json!({ "prompt": prompt, "aspect": aspect }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach zWork to make the image: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = body.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error");
        return Err(match status.as_u16() {
            401 => "Making images needs a zWork account. Sign in from Settings, then try again.".into(),
            429 => "You've used this period's allowance. It refills soon; nothing was charged for this one.".into(),
            _ => format!("The image couldn't be made ({detail}). Nothing was charged."),
        });
    }

    let image = body.get("image").and_then(|v| v.as_str()).unwrap_or("");
    let (bytes, ext) = decode(image).await?;
    let path = crate::paths::workspace_outputs_dir().join(format!("{}.{ext}", file_stem(prompt)));
    std::fs::write(&path, &bytes).map_err(|e| format!("The image was made but couldn't be saved: {e}"))?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "aspect": aspect,
        "note": "The image is shown to the user in the chat. Don't repeat the path unless asked.",
    })
    .to_string())
}

/// The cloud returns a data URL, or (some models) an https link.
async fn decode(image: &str) -> Result<(Vec<u8>, &'static str), String> {
    if let Some(rest) = image.strip_prefix("data:image/") {
        let (meta, data) = rest.split_once(',').ok_or("The image came back damaged. Nothing was charged.")?;
        let ext = if meta.starts_with("jpeg") || meta.starts_with("jpg") { "jpg" } else if meta.starts_with("webp") { "webp" } else { "png" };
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "The image came back damaged.".to_string())?;
        return Ok((bytes, ext));
    }
    if image.starts_with("https://") {
        let bytes = reqwest::get(image).await.and_then(|r| r.error_for_status()).map_err(|e| format!("Couldn't download the image: {e}"))?
            .bytes().await.map_err(|e| format!("Couldn't download the image: {e}"))?;
        return Ok((bytes.to_vec(), "png"));
    }
    Err("No image came back. Nothing was charged.".into())
}

/// "A watercolour fox in snow" → "a-watercolour-fox-in-snow-3f9a1c"
fn file_stem(prompt: &str) -> String {
    let words: Vec<String> = prompt
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(6)
        .map(|w| w.to_lowercase())
        .collect();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let lead = if words.is_empty() { "image".to_string() } else { words.join("-") };
    format!("{lead}-{}", &id[..6])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn decodes_data_url_and_names_file() {
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G']);
        let (bytes, ext) = decode(&format!("data:image/png;base64,{png}")).await.unwrap();
        assert_eq!((bytes.len(), ext), (4, "png"));
        assert!(decode("javascript:alert(1)").await.is_err());
        assert!(file_stem("A watercolour fox, in snow!").starts_with("a-watercolour-fox-in-snow-"));
        assert!(file_stem("…").starts_with("image-"));
    }
}
