//! zWork agent harness: a Rust port of pi (pi-agent-core + pi-ai, MIT,
//! Mario Zechner). Landed behind `ZWORK_HARNESS=pi`; the legacy loop in
//! `crate::agent` stays until this reaches parity.
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

pub mod agent;
pub mod agent_loop;
pub mod agent_types;
pub mod estimate;
pub mod json_parse;
pub mod providers;
pub mod retry;
pub mod sse;
pub mod transcript;
pub mod transform_messages;
pub mod types;
pub mod validation;
