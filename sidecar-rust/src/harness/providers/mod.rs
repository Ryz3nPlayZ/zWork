//! Provider adapters. Each exposes `stream(model, context, options)` returning
//! an `AssistantMessageEventStream` whose last event is `Done` or `Error`.

pub mod openai_completions;

use super::types::{Api, AssistantMessageEventStream, Model, StreamOptions, TranscriptContext};

/// Dispatch on `model.api`.
pub fn stream(model: Model, context: TranscriptContext, options: StreamOptions) -> AssistantMessageEventStream {
    match model.api {
        Api::OpenAICompletions => openai_completions::stream(model, context, options),
        Api::AnthropicMessages => {
            // Ported next; until then route through the completions adapter
            // so callers never hang. Anthropic-only models fail with a
            // provider error rather than silently mis-encoding.
            openai_completions::stream(model, context, options)
        }
    }
}
