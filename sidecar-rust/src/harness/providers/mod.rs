//! Provider adapters. Each exposes `stream(model, context, options)` returning
//! an `AssistantMessageEventStream` whose last event is `Done` or `Error`.

pub mod anthropic_messages;
pub mod catalog;
pub mod google_generative_ai;
pub mod openai_completions;
pub mod openai_responses;
pub mod transport;

use super::types::{
    Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, StopReason, StreamOptions,
    TranscriptContext,
};

/// Dispatch on `model.api`.
pub fn stream(model: Model, context: TranscriptContext, options: StreamOptions) -> AssistantMessageEventStream {
    match model.api {
        Api::OpenAICompletions => openai_completions::stream(model, context, options),
        Api::OpenAIResponses => openai_responses::stream(model, context, options),
        Api::AnthropicMessages => anthropic_messages::stream(model, context, options),
        Api::GoogleGenerativeAI => google_generative_ai::stream(model, context, options),
    }
}

/// pi `complete()`: one call drained to its final message. Failures come back
/// as a message with `stop_reason` `Error` / `Aborted`, never out-of-band.
pub async fn complete(model: Model, context: TranscriptContext, options: StreamOptions) -> AssistantMessage {
    let fallback = AssistantMessage::pending(&model);
    let mut rx = stream(model, context, options);
    let mut last = None;
    while let Some(event) = rx.recv().await {
        match event {
            AssistantMessageEvent::Done { message, .. } => return message,
            AssistantMessageEvent::Error { error, .. } => return error,
            other => last = Some(other.partial().clone()),
        }
    }
    let mut msg = last.unwrap_or(fallback);
    msg.stop_reason = StopReason::Error;
    msg.error_message = Some("Provider stream ended without a terminal event".into());
    msg
}
