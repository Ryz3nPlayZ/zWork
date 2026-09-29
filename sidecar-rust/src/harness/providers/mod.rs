//! Provider adapters. Each exposes `stream(model, context, options)` returning
//! an `AssistantMessageEventStream` whose last event is `Done` or `Error`.

pub mod anthropic_messages;
pub mod google_generative_ai;
pub mod openai_completions;
pub mod openai_responses;
pub mod transport;

use super::types::{Api, AssistantMessageEventStream, Model, StreamOptions, TranscriptContext};

/// Dispatch on `model.api`.
pub fn stream(model: Model, context: TranscriptContext, options: StreamOptions) -> AssistantMessageEventStream {
    match model.api {
        Api::OpenAICompletions => openai_completions::stream(model, context, options),
        Api::OpenAIResponses => openai_responses::stream(model, context, options),
        Api::AnthropicMessages => anthropic_messages::stream(model, context, options),
        Api::GoogleGenerativeAI => google_generative_ai::stream(model, context, options),
    }
}
