//! Unified LLM streaming layer.
//!
//! Layered like opencode's `packages/llm`: a transport+SSE-framing seam
//! ([`sse`]) feeds one state-machine parser per provider wire format
//! ([`anthropic`] / [`openai_chat`]) that emits a single unified event
//! vocabulary ([`event::LlmEvent`]). [`trace`] writes a durable per-turn log.
//!
//! This replaces the old `stream_upstream`, which did everything in one
//! `is_anthropic` branch with two silent failure paths: `Err(_) => continue`
//! on unparseable frames, and `unwrap_or(json!({}))` on malformed tool args.
//! Here, a malformed frame surfaces a loud [`LlmEvent::ProviderError`] and a
//! bad tool-call JSON never becomes a phantom empty-args call.

pub mod anthropic;
pub mod event;
pub mod openai_chat;
pub mod sse;
pub mod tool_stream;
pub mod trace;

use std::convert::Infallible;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

pub use event::LlmEvent;
pub use trace::trace;

/// One protocol parser = a pure state machine over JSON-decoded SSE frames.
/// Implemented once per provider wire format.
pub trait ProtocolParser: Send {
    /// Identifier for tracing (e.g. `"anthropic-messages"`, `"openai-chat"`).
    fn route(&self) -> &'static str;
    /// Consume one decoded SSE frame; return the unified events it produced.
    /// A returned [`LlmEvent::ProviderError`] is treated as terminal by the
    /// caller (the stream is aborted after it is forwarded).
    fn step(&mut self, event: Value) -> Vec<LlmEvent>;
    /// Emit terminal events at stream end (flush + [`LlmEvent::Finish`]).
    fn finish(&mut self) -> Vec<LlmEvent>;
}

/// Stream a chat completion from `endpoint` and yield unified [`LlmEvent`]s.
///
/// Replaces `stream_upstream`. `shape` is `"anthropic"` (Messages API) or
/// anything else (treated as OpenAI Chat Completions — the path DeepSeek uses).
/// `turn`/`chat_id` scope the durable trace lines.
pub fn stream_llm(
    endpoint: String,
    headers: reqwest::header::HeaderMap,
    body: Value,
    shape: String,
    turn: u32,
    chat_id: String,
) -> impl Stream<Item = Result<LlmEvent, Infallible>> {
    let (tx, rx) = mpsc::channel(100);

    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_default();

        let resp = match client.post(&endpoint).headers(headers).json(&body).send().await {
            Ok(r) => r,
            Err(e) => {
                emit_error(&tx, &chat_id, turn, format!("upstream connect failed: {e}"), None).await;
                let _ = tx.send(LlmEvent::Done).await;
                return;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let body_txt = resp.text().await.unwrap_or_default();
            emit_error(
                &tx,
                &chat_id,
                turn,
                format!("upstream HTTP {status}"),
                Some(body_txt),
            )
            .await;
            let _ = tx.send(LlmEvent::Done).await;
            return;
        }

        let mut parser: Box<dyn ProtocolParser> = if shape == "anthropic" {
            Box::new(anthropic::AnthropicParser::new())
        } else {
            Box::new(openai_chat::OpenAIChatParser::new())
        };
        let route_name = parser.route();
        let mut decoder = sse::SseDecoder::new();
        let trace_sse = trace::trace_sse_enabled();
        let mut stream = resp.bytes_stream();
        let mut aborted = false;

        loop {
            let chunk = match stream.next().await {
                Some(Ok(c)) => c,
                Some(Err(e)) => {
                    emit_error(&tx, &chat_id, turn, format!("stream read error: {e}"), None).await;
                    break;
                }
                None => break,
            };

            let text = String::from_utf8_lossy(&chunk);
            for frame in decoder.push(&text) {
                if trace_sse {
                    trace(
                        &chat_id,
                        turn,
                        "sse_frame",
                        json!({ "route": route_name, "data": frame }),
                    );
                }
                // LOUD: never silently drop a malformed frame.
                let val = match serde_json::from_str::<Value>(&frame) {
                    Ok(v) => v,
                    Err(e) => {
                        emit_error(
                            &tx,
                            &chat_id,
                            turn,
                            format!("malformed SSE JSON frame: {e}"),
                            Some(frame),
                        )
                        .await;
                        aborted = true;
                        break;
                    }
                };
                let (to_send, abort) = process_events(parser.step(val), &chat_id, turn, route_name);
                for ev in to_send {
                    let _ = tx.send(ev).await;
                }
                if abort {
                    aborted = true;
                    break;
                }
            }
            if aborted {
                break;
            }
        }

        // Flush any payload the server emitted without a trailing blank line,
        // then finalize the parser — unless we aborted on a hard error.
        if !aborted {
            for frame in decoder.finish() {
                if trace_sse {
                    trace(
                        &chat_id,
                        turn,
                        "sse_frame",
                        json!({ "route": route_name, "data": frame }),
                    );
                }
                if let Ok(val) = serde_json::from_str::<Value>(&frame) {
                    let (to_send, _) = process_events(parser.step(val), &chat_id, turn, route_name);
                    for ev in to_send {
                        let _ = tx.send(ev).await;
                    }
                }
            }
            let (to_send, _) = process_events(parser.finish(), &chat_id, turn, route_name);
            for ev in to_send {
                let _ = tx.send(ev).await;
            }
        }

        let _ = tx.send(LlmEvent::Done).await;
    });

    ReceiverStream::new(rx).map(Ok)
}

/// Trace + collect a batch of parser events. Returns the events to forward and
/// whether the batch contained a terminal [`LlmEvent::ProviderError`].
fn process_events(
    evs: Vec<LlmEvent>,
    chat_id: &str,
    turn: u32,
    route: &'static str,
) -> (Vec<LlmEvent>, bool) {
    let mut out = Vec::with_capacity(evs.len());
    let mut aborted = false;
    for ev in evs {
        match &ev {
            LlmEvent::ToolCall { name, input, .. } => {
                trace(
                    chat_id,
                    turn,
                    "tool_call",
                    json!({ "route": route, "name": name, "input": input }),
                );
            }
            LlmEvent::ProviderError { message, raw } => {
                trace(
                    chat_id,
                    turn,
                    "error",
                    json!({ "route": route, "message": message, "raw": raw }),
                );
                aborted = true;
            }
            LlmEvent::Finish { reason, usage } => {
                trace(
                    chat_id,
                    turn,
                    "finish",
                    json!({
                        "route": route,
                        "reason": format!("{reason:?}"),
                        "usage": usage.as_ref().map(|u| u.to_summary()),
                    }),
                );
            }
            _ => {}
        }
        out.push(ev);
    }
    (out, aborted)
}

async fn emit_error(
    tx: &mpsc::Sender<LlmEvent>,
    chat_id: &str,
    turn: u32,
    message: String,
    raw: Option<String>,
) {
    trace(
        chat_id,
        turn,
        "error",
        json!({ "message": message, "raw": raw }),
    );
    let _ = tx.send(LlmEvent::ProviderError { message, raw }).await;
}
