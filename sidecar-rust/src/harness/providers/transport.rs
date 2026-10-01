//! Shared HTTP + SSE transport for every wire adapter.
//!
//! Each adapter owns only its protocol: request body, headers, and the
//! event → block state machine. Opening the request (with pi's retry policy),
//! framing the byte stream into SSE `data:` payloads, honouring the abort
//! signal, and emitting the terminal `Done` / `Error` event are identical
//! across protocols and live here.

use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::harness::retry::{retry_provider_request, ProviderError};
use crate::harness::sse::SseDecoder;
use crate::harness::types::{AbortSignal, AssistantMessage, AssistantMessageEvent, Model, StopReason, StreamOptions};

pub const USER_AGENT: &str = concat!("zwork/", env!("CARGO_PKG_VERSION"));

pub type Tx = mpsc::Sender<AssistantMessageEvent>;

pub async fn push(tx: &Tx, ev: AssistantMessageEvent) {
    let _ = tx.send(ev).await;
}

/// Fail fast when neither an API key nor an auth-ish header is present.
pub fn require_api_key(model: &Model, options: &StreamOptions, auth_headers: &[&str]) -> Result<String, ProviderError> {
    let key = options.api_key.clone().unwrap_or_default();
    let has_auth = options
        .headers
        .keys()
        .any(|k| auth_headers.iter().any(|h| k.eq_ignore_ascii_case(h)));
    if key.is_empty() && !has_auth {
        return Err(ProviderError::new(None, format!("No API key for provider: {}", model.provider)));
    }
    Ok(key)
}

/// Model headers, then per-call option headers (last wins), lower-cased.
pub fn merge_headers(base: BTreeMap<String, String>, model: &Model, options: &StreamOptions) -> BTreeMap<String, String> {
    let mut h = base;
    for (k, v) in model.headers.iter().flatten().chain(options.headers.iter()) {
        h.insert(k.to_lowercase(), v.clone());
    }
    h
}

type ByteStream = Pin<Box<dyn Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>;

/// A live SSE response: yields complete `data:` payloads in order.
pub struct SseStream {
    decoder: SseDecoder,
    bytes: ByteStream,
    signal: Option<AbortSignal>,
    ready: VecDeque<String>,
    eof: bool,
}

impl SseStream {
    /// Next complete payload, `Ok(None)` at end of stream.
    pub async fn next(&mut self) -> Result<Option<String>, ProviderError> {
        loop {
            if let Some(frame) = self.ready.pop_front() {
                return Ok(Some(frame));
            }
            if self.eof {
                return Ok(None);
            }
            let next = match &self.signal {
                Some(sig) => tokio::select! {
                    n = self.bytes.next() => n,
                    _ = sig.cancelled() => return Err(ProviderError::new(None, "Request was aborted")),
                },
                None => self.bytes.next().await,
            };
            match next {
                Some(Ok(chunk)) => self.ready.extend(self.decoder.push(&String::from_utf8_lossy(&chunk))),
                Some(Err(e)) => return Err(ProviderError::new(None, format!("stream read error: {e}"))),
                None => {
                    self.eof = true;
                    self.ready.extend(self.decoder.finish());
                }
            }
        }
    }

    /// Next payload that parses as JSON; `[DONE]` sentinels are skipped.
    pub async fn next_json(&mut self) -> Result<Option<Value>, ProviderError> {
        while let Some(frame) = self.next().await? {
            if frame.trim() == "[DONE]" {
                continue;
            }
            return serde_json::from_str::<Value>(&frame).map(Some).map_err(|e| {
                ProviderError::new(None, format!("malformed SSE frame: {e}: {}", truncate(&frame, 300)))
            });
        }
        Ok(None)
    }
}

/// POST `body` to `endpoint` with pi's retry policy and open it as SSE.
pub async fn open_sse(
    endpoint: &str,
    headers: &BTreeMap<String, String>,
    body: &Value,
    options: &StreamOptions,
) -> Result<SseStream, ProviderError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| ProviderError::new(None, format!("http client: {e}")))?;
    let signal = options.signal.clone();
    let response = retry_provider_request(
        || {
            let client = client.clone();
            let signal = signal.clone();
            async move {
                let mut req = client.post(endpoint);
                for (k, v) in headers {
                    req = req.header(k.as_str(), v.as_str());
                }
                let send = req.json(body).send();
                let resp = match signal {
                    Some(sig) => tokio::select! {
                        r = send => r,
                        _ = sig.cancelled() => return Err(ProviderError::new(None, "Request aborted")),
                    },
                    None => send.await,
                }
                .map_err(|e| ProviderError::new(None, format!("request failed: {e}")))?;
                let status = resp.status();
                if !status.is_success() {
                    let hdrs = resp
                        .headers()
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                        .collect();
                    let body_txt = resp.text().await.unwrap_or_default();
                    return Err(ProviderError {
                        status: Some(status.as_u16()),
                        message: status.canonical_reason().unwrap_or("HTTP error").to_string(),
                        headers: hdrs,
                        body: Some(body_txt),
                    });
                }
                Ok(resp)
            }
        },
        options.max_retries,
        options.max_retry_delay_ms,
        options.signal.as_ref(),
    )
    .await?;
    Ok(SseStream {
        decoder: SseDecoder::new(),
        bytes: Box::pin(response.bytes_stream()),
        signal: options.signal.clone(),
        ready: VecDeque::new(),
        eof: false,
    })
}

/// Emit the terminal event for a finished stream. Every adapter ends here, so
/// a stream never fails out-of-band: errors become an `Error` event carrying
/// the partial message with `stopReason` `error` or `aborted`.
pub async fn finish(tx: &Tx, output: &mut AssistantMessage, result: Result<(), ProviderError>, options: &StreamOptions) {
    let aborted = options.signal.as_ref().map_or(false, |s| s.is_aborted());
    let result = match result {
        Ok(()) if aborted => Err(ProviderError::new(None, "Request was aborted")),
        Ok(()) if output.stop_reason == StopReason::Pending => {
            Err(ProviderError::new(None, "Stream ended without a stop reason"))
        }
        Ok(()) if matches!(output.stop_reason, StopReason::Error | StopReason::Aborted) => Err(ProviderError::new(
            None,
            output.error_message.clone().unwrap_or_else(|| "An unknown error occurred".into()),
        )),
        other => other,
    };
    match result {
        Ok(()) => {
            push(tx, AssistantMessageEvent::Done { reason: output.stop_reason, message: output.clone() }).await;
        }
        Err(err) => {
            output.stop_reason = if aborted { StopReason::Aborted } else { StopReason::Error };
            output.error_message = Some(err.format());
            push(tx, AssistantMessageEvent::Error { reason: output.stop_reason, error: output.clone() }).await;
        }
    }
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// FNV-1a 64-bit hex. Stable across runs; only needs to be unique-ish.
pub fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub fn sanitize_surrogates(s: &str) -> String {
    // Rust strings cannot hold lone surrogates; kept for parity with pi's call sites.
    s.to_string()
}
