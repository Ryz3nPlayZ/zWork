//! Port of pi `core/tools/file-mutation-queue.ts`: serialize mutations to
//! the same file so concurrent edit/write calls never interleave.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::future::BoxFuture;

static QUEUES: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();

fn lock_for(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let map = QUEUES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.entry(path.to_path_buf()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
}

/// Run `f` while holding the per-path mutation lock.
pub async fn with_file_mutation_queue<'f, T>(path: &Path, f: impl FnOnce() -> BoxFuture<'f, T>) -> T {
    let lock = lock_for(path);
    let _guard = lock.lock().await;
    f().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn serializes_same_path() {
        let active = Arc::new(AtomicUsize::new(0));
        let max = Arc::new(AtomicUsize::new(0));
        let path = PathBuf::from("/tmp/zwork-fmq-test");
        let mut handles = Vec::new();
        for _ in 0..8 {
            let (active, max, path) = (active.clone(), max.clone(), path.clone());
            handles.push(tokio::spawn(async move {
                with_file_mutation_queue(&path, || {
                    Box::pin(async move {
                        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max.fetch_max(n, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                    })
                })
                .await
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(max.load(Ordering::SeqCst), 1);
    }
}
