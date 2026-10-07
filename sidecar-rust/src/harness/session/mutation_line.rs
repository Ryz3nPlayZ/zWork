//! Port of pi `harness/session/mutation-line.ts`.
//!
//! Serializes complete read-modify-write jobs for one session. pi
//! implements this as a promise tail; here a tokio mutex provides the same
//! serialization, with `seal` rejecting jobs queued after close and
//! waiting for the in-flight one to settle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
#[error("mutation line sealed: {0}")]
pub struct SealedError(pub String);

#[derive(Default)]
pub struct MutationLine {
    lock: Mutex<()>,
    sealed: AtomicBool,
    seal_reason: std::sync::Mutex<Option<String>>,
}

impl MutationLine {
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Run `operation` exclusively. Jobs queue in submission order.
    pub async fn run<T, F, Fut>(&self, operation: F) -> Result<T, Arc<SealedError>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        if self.sealed.load(Ordering::SeqCst) {
            return Err(self.sealed_error());
        }
        let _guard = self.lock.lock().await;
        if self.sealed.load(Ordering::SeqCst) {
            return Err(self.sealed_error());
        }
        Ok(operation().await)
    }

    /// Reject future jobs with `reason` and wait for any in-flight job.
    pub async fn seal(&self, reason: String) {
        let first = {
            let mut slot = self.seal_reason.lock().unwrap();
            if slot.is_none() {
                *slot = Some(reason);
                true
            } else {
                false
            }
        };
        if first {
            self.sealed.store(true, Ordering::SeqCst);
        }
        // Wait for the in-flight job (if any) to release the line.
        let _guard = self.lock.lock().await;
    }

    fn sealed_error(&self) -> Arc<SealedError> {
        let reason = self.seal_reason.lock().unwrap().clone().unwrap_or_else(|| "sealed".into());
        Arc::new(SealedError(reason))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serializes_jobs_in_submission_order() {
        let line = MutationLine::shared();
        let l = line.clone();
        let order = Arc::new(std::sync::Mutex::new(Vec::<u32>::new()));
        let o = order.clone();
        let a = tokio::spawn(async move {
            l.run(|| async {
                o.lock().unwrap().push(1);
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                o.lock().unwrap().push(2);
            })
            .await
            .unwrap();
        });
        let l2 = line.clone();
        let o2 = order.clone();
        let b = tokio::spawn(async move {
            l2.run(|| async {
                o2.lock().unwrap().push(3);
            })
            .await
            .unwrap();
        });
        let _ = tokio::join!(a, b);
        assert_eq!(*order.lock().unwrap(), vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn sealed_line_rejects_new_jobs() {
        let line = MutationLine::shared();
        line.seal("closed".into()).await;
        let err = line.run(|| async { () }).await.unwrap_err();
        assert_eq!(err.0, "closed");
    }
}
