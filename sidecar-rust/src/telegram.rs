use serde_json::{json, Value};

const TELEGRAM_API_BASE: &str = "https://api.telegram.org";

/// Send a plain text message via a Telegram bot.
///
/// `bot_token` is the full token from @BotFather.
/// `chat_id` can be a numeric user/group ID or a channel username (@channel).
pub async fn send_message(bot_token: &str, chat_id: &str, text: &str) -> Result<String, String> {
    if bot_token.is_empty() {
        return Err("Telegram bot token is not configured.".to_string());
    }
    if chat_id.is_empty() {
        return Err("Telegram chat ID is not configured.".to_string());
    }

    let url = format!("{}/bot{}/sendMessage", TELEGRAM_API_BASE, bot_token);
    let body = json!({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Telegram request failed: {}", e))?;

    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Telegram response: {}", e))?;

    if status.is_success() && payload.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok("Message sent via Telegram.".to_string())
    } else {
        let desc = payload
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        Err(format!("Telegram API error: {}", desc))
    }
}

/// Quick helper that pulls config from settings.
pub async fn send_message_from_settings(text: &str) -> Result<String, String> {
    let s = crate::settings::load();
    let token = s.api_keys.get("telegram").cloned().unwrap_or_default();
    send_message(&token, &s.telegram_chat_id, text).await
}
