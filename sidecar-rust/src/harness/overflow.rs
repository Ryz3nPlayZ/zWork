//! Port of pi-ai `utils/overflow.ts` — context-overflow detection.
//!
//! A context overflow is the one "permanent" 400 that is recoverable by
//! compacting history, so it must be told apart from real 400s. Providers
//! phrase it two dozen different ways; worse, some *succeed* with a usage
//! total beyond the window (z.ai) or truncate the input and stop on "length"
//! with zero output (Xiaomi MiMo). Detection here covers all three shapes.

use std::sync::LazyLock;

use regex::Regex;

use super::types::{AssistantMessage, StopReason};

static OVERFLOW_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)prompt (?:is )?too long",                                       // Anthropic, z.ai
        r"(?i)request_too_large",                                             // Anthropic HTTP 413 body
        r"(?i)input is too long for requested model",                         // Amazon Bedrock
        r"(?i)exceeds the context window",                                    // OpenAI (Completions & Responses)
        r"(?i)exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))", // LiteLLM-style proxies
        r"(?i)input token count.*exceeds the maximum",                        // Google (Gemini)
        r"(?i)maximum prompt length is \d+",                                  // xAI (Grok)
        r"(?i)reduce the length of the messages",                             // Groq
        r"(?i)maximum context length is \d+ tokens",                          // OpenRouter (most backends)
        r"(?i)exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?", // OpenRouter/Poolside
        r"(?i)input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)", // Together AI
        r"(?i)exceeds the limit of \d+",                                      // GitHub Copilot
        r"(?i)exceeds the available context size",                            // llama.cpp server
        r"(?i)greater than the context length",                               // LM Studio
        r"(?i)context window exceeds limit",                                  // MiniMax
        r"(?i)exceeded model token limit",                                    // Kimi For Coding
        r"(?i)too large for model with \d+ maximum context length",           // Mistral
        r"(?i)prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?", // DS4
        r"(?i)model_context_window_exceeded",                                 // z.ai finish_reason surfaced as text
        r"(?i)prompt too long; exceeded (?:max )?context length",             // Ollama explicit
        r"(?i)range of input length should be",                               // DashScope / Qwen
        r"(?i)context[_ ]length[_ ]exceeded",                                 // generic fallback
        r"(?i)too many tokens",                                               // generic fallback
        r"(?i)token limit exceeded",                                          // generic fallback
    ]
    .iter()
    .map(|p| Regex::new(p).expect("static overflow pattern compiles"))
    .collect()
});

/// Errors that look like overflow but aren't (rate limiting, server trouble).
/// Bedrock in particular formats throttling as "Throttling error: Too many
/// tokens, please wait" — which the generic fallback pattern would match.
static NON_OVERFLOW_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)^(Throttling error|Service unavailable):",
        r"(?i)rate limit",
        r"(?i)too many requests",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("static non-overflow pattern compiles"))
    .collect()
});

static CEREBRAS_BODYLESS_OVERFLOW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^4(?:00|13)\s*(?:status code)?\s*\(no body\)").unwrap());

/// True if an assistant message represents a context-overflow error. Three
/// shapes are recognized:
/// 1. Error text matching a provider overflow phrasing (and not a
///    rate-limit/non-overflow phrasing).
/// 2. Silent overflow — a "successful" stop whose `input + cache_read` exceeds
///    `context_window` (z.ai).
/// 3. Length-stop overflow — stop reason "length" with zero output while the
///    input fills ≥99% of the window (Xiaomi MiMo truncates oversized input,
///    leaving no room to generate).
pub fn is_context_overflow(message: &AssistantMessage, context_window: Option<u64>) -> bool {
    if message.stop_reason == StopReason::Error {
        if let Some(err) = &message.error_message {
            let is_non_overflow = NON_OVERFLOW_PATTERNS.iter().any(|p| p.is_match(err));
            if !is_non_overflow {
                if OVERFLOW_PATTERNS.iter().any(|p| p.is_match(err)) {
                    return true;
                }
                if message.provider.eq_ignore_ascii_case("cerebras") && CEREBRAS_BODYLESS_OVERFLOW.is_match(err) {
                    return true;
                }
            }
        }
    }

    if let Some(window) = context_window {
        let input_tokens = message.usage.input + message.usage.cache_read;
        if message.stop_reason == StopReason::Stop && input_tokens > window {
            return true;
        }
        if message.stop_reason == StopReason::Length
            && message.usage.output == 0
            && input_tokens >= (window as f64 * 0.99) as u64
        {
            return true;
        }
    }

    false
}

/// True when a length stop ended below the caller's intended output limit —
/// possibly caused by context pressure, so the caller may make one bounded
/// compact-and-retry attempt. `desired_max_output` must be the original limit
/// before any context-based clamping.
pub fn is_recoverable_length(message: &AssistantMessage, desired_max_output: u64) -> bool {
    message.stop_reason == StopReason::Length
        && desired_max_output > 0
        && message.usage.output < desired_max_output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::types::{Api, Usage};

    fn msg(stop: StopReason, error: Option<&str>, usage: Usage, provider: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![],
            api: Api::OpenAICompletions,
            provider: provider.to_string(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            usage,
            stop_reason: stop,
            error_message: error.map(String::from),
            raw_stop_reason: None,
            end_turn: None,
            timestamp: 0,
        }
    }

    #[test]
    fn detects_provider_overflow_phrasings() {
        for text in [
            "Prompt is too long: 213462 tokens > 200000 maximum",
            "Your input exceeds the context window of this model",
            "Input length (265330) exceeds model's maximum context length (262144).",
            "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
            "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
            "Please reduce the length of the messages or completion",
            "{\"code\":\"1261\",\"message\":\"Prompt too long\"}",
        ] {
            assert!(
                is_context_overflow(&msg(StopReason::Error, Some(text), Usage::default(), "x"), None),
                "should detect: {text}"
            );
        }
    }

    #[test]
    fn rate_limit_is_not_overflow() {
        let m = msg(
            StopReason::Error,
            Some("Throttling error: Too many tokens, please wait before trying again."),
            Usage::default(),
            "bedrock",
        );
        assert!(!is_context_overflow(&m, None));
        let m = msg(StopReason::Error, Some("Rate limit reached: too many tokens per minute"), Usage::default(), "x");
        assert!(!is_context_overflow(&m, None));
    }

    #[test]
    fn silent_overflow_via_usage() {
        let mut usage = Usage::default();
        usage.input = 210_000;
        usage.cache_read = 5_000;
        assert!(is_context_overflow(&msg(StopReason::Stop, None, usage.clone(), "zai"), Some(200_000)));
        assert!(!is_context_overflow(&msg(StopReason::Stop, None, usage, "zai"), None));
    }

    #[test]
    fn length_stop_overflow() {
        let mut usage = Usage::default();
        usage.input = 199_000;
        assert!(is_context_overflow(&msg(StopReason::Length, None, usage, "mimo"), Some(200_000)));
        let mut usage = Usage::default();
        usage.input = 100_000;
        usage.output = 500;
        assert!(!is_context_overflow(&msg(StopReason::Length, None, usage, "mimo"), Some(200_000)));
    }

    #[test]
    fn recoverable_length() {
        let mut usage = Usage::default();
        usage.output = 400;
        assert!(is_recoverable_length(&msg(StopReason::Length, None, usage, "x"), 8192));
        let mut usage = Usage::default();
        usage.output = 8192;
        assert!(!is_recoverable_length(&msg(StopReason::Length, None, usage, "x"), 8192));
        let mut usage = Usage::default();
        usage.output = 10;
        assert!(!is_recoverable_length(&msg(StopReason::Stop, None, usage, "x"), 8192));
    }
}
