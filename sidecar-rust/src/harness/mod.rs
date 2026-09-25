//! zWork agent harness: a Rust port of pi (pi-agent-core + pi-ai, MIT,
//! Mario Zechner). This is the only agent loop; `crate::agent::harness_turn`
//! bridges it to zWork's wire events, chat store, permission gates and tools.
//!
//! Layout mirrors pi-mono:
//! - `types`              — message/model/event contracts (`packages/ai/src/types.ts`)
//! - `transcript`         — system-message + tool-declaration resolution
//! - `transform_messages` — cross-model normalization
//! - `json_parse`         — streaming/partial JSON for tool arguments
//! - `validation`         — JSON-schema argument validation
//! - `retry`              — provider retry/backoff
//! - `providers`          — wire adapters (OpenAI Completions, Anthropic Messages)

#![allow(dead_code)]

#[cfg(test)]
pub(crate) mod test_support;
pub mod agent_types;
pub mod assistant_frame;
pub mod compaction;
pub mod estimate;
pub mod json_parse;
pub mod messages;
pub mod overflow;
pub mod pricing;
pub mod prompt_templates;
pub mod providers;
pub mod retry;
pub mod runtime;
pub mod session;
pub mod skills;
pub mod sse;
pub mod system_prompt;
pub mod tools;
pub mod transcript;
pub mod transform_messages;
pub mod types;
pub mod validation;
