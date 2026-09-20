//! Provider request retry with abortable backoff.
//!
//! Port of pi-mono `packages/ai/src/utils/provider-retry.ts`. Retries on
//! 408/409/429/5xx (or `x-should-retry: true`), honours `retry-after` /
//! `retry-after-ms`, and fails fast when the server asks for a delay above
//! `max_retry_delay_ms` (60s default).

use std::time::Duration;

use rand::Rng;

use super::types::AbortSignal;

const DEFAULT_MAX_RETRY_DELAY_MS: u64 = 60_000;

/// A failed HTTP round trip. `status == None` means the request never got a
/// response (connect/timeout), which is retryable.
#[derive(Debug, Clone)]
pub struct ProviderError {
    pub status: Option<u16>,
    pub message: String,
    pub headers: Vec<(String, String)>,
    /// Raw response body, when one was read.
    pub body: Option<String>,
}

impl ProviderError {
    pub fn new(status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// One-line human-readable form (`formatProviderError`).
    pub fn format(&self) -> String {
        let mut s = match self.status {
            Some(code) => format!("{} {}", code, self.message),
            None => self.message.clone(),
        };
        if let Some(b) = &self.body {
            let b = b.trim();
            if !b.is_empty() && !s.contains(b) {
                s.push_str(": ");
                s.push_str(&truncate(b, 2000));
            }
        }
        s
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.format())
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

fn is_retryable(err: &ProviderError) -> bool {
    match err.header("x-should-retry") {
        Some("true") => return true,
        Some("false") => return false,
        _ => {}
    }
    match err.status {
        None => true,
        Some(s) => s == 408 || s == 409 || s == 429 || s >= 500,
    }
}

fn validate_server_delay(delay_ms: u64, max_ms: Option<u64>, message: &str) -> Result<u64, ProviderError> {
    let max = max_ms.unwrap_or(DEFAULT_MAX_RETRY_DELAY_MS);
    if max > 0 && delay_ms > max {
        return Err(ProviderError::new(
            None,
            format!(
                "Server requested {}s retry delay (max: {}s). {}",
                (delay_ms + 999) / 1000,
                (max + 999) / 1000,
                message
            ),
        ));
    }
    Ok(delay_ms)
}

fn retry_delay_ms(err: &ProviderError, retry_index: u32, max_ms: Option<u64>) -> Result<u64, ProviderError> {
    if let Some(v) = err.header("retry-after-ms").and_then(|v| v.trim().parse::<f64>().ok()) {
        return validate_server_delay(v.max(0.0) as u64, max_ms, &err.message);
    }
    if let Some(v) = err.header("retry-after") {
        let delay = match v.trim().parse::<f64>() {
            Ok(secs) => (secs * 1000.0).max(0.0) as u64,
            Err(_) => match chrono::DateTime::parse_from_rfc2822(v.trim()) {
                Ok(dt) => (dt.timestamp_millis() - chrono::Utc::now().timestamp_millis()).max(0) as u64,
                Err(_) => 0,
            },
        };
        return validate_server_delay(delay, max_ms, &err.message);
    }
    let exp = (0.5 * 2f64.powi(retry_index as i32)).min(8.0) * 1000.0;
    let jitter: f64 = rand::thread_rng().gen_range(0.0..0.25);
    Ok((exp * (1.0 - jitter)) as u64)
}

async fn abortable_sleep(ms: u64, signal: Option<&AbortSignal>) -> Result<(), ProviderError> {
    match signal {
        None => {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(())
        }
        Some(sig) => {
            if sig.is_aborted() {
                return Err(ProviderError::new(None, "Request aborted"));
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(ms)) => Ok(()),
                _ = sig.cancelled() => Err(ProviderError::new(None, "Request aborted")),
            }
        }
    }
}

/// Run `request` up to `max_retries + 1` times with the SDK-style backoff.
pub async fn retry_provider_request<T, F, Fut>(
    mut request: F,
    max_retries: u32,
    max_retry_delay_ms: Option<u64>,
    signal: Option<&AbortSignal>,
) -> Result<T, ProviderError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, ProviderError>>,
{
    let mut remaining = max_retries;
    loop {
        match request().await {
            Ok(v) => return Ok(v),
            Err(err) => {
                if signal.map_or(false, |s| s.is_aborted()) {
                    return Err(ProviderError::new(None, "Request aborted"));
                }
                if remaining == 0 || !is_retryable(&err) {
                    return Err(err);
                }
                let retry_index = max_retries - remaining;
                remaining -= 1;
                let delay = retry_delay_ms(&err, retry_index, max_retry_delay_ms)?;
                tracing::info!(target: "harness", status = ?err.status, delay_ms = delay, "retrying provider request");
                abortable_sleep(delay, signal).await?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn retries_on_5xx_then_succeeds() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let out = retry_provider_request(
            move || {
                let c = c.clone();
                async move {
                    let n = c.fetch_add(1, Ordering::SeqCst);
                    if n < 2 {
                        Err(ProviderError {
                            status: Some(503),
                            message: "down".into(),
                            headers: vec![("retry-after-ms".into(), "1".into())],
                            body: None,
                        })
                    } else {
                        Ok(42)
                    }
                }
            },
            3,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(out, 42);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn does_not_retry_4xx() {
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let err = retry_provider_request(
            move || {
                let c = c.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Err::<(), _>(ProviderError::new(Some(400), "bad"))
                }
            },
            3,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, Some(400));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rejects_huge_server_delay() {
        let err = retry_provider_request(
            || async {
                Err::<(), _>(ProviderError {
                    status: Some(429),
                    message: "slow down".into(),
                    headers: vec![("retry-after".into(), "600".into())],
                    body: None,
                })
            },
            1,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("retry delay"));
    }
}
