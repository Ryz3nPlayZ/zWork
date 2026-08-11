//! Poison-tolerant mutex helpers.
//!
//! `std::sync::Mutex` poisons on panic: once a thread panics while holding the
//! lock, every subsequent `.lock().unwrap()` panics too — cascading a single
//! failure into a permanent process-wide deadlock. The agent loop holds several
//! shared mutexes (permission gates, pending questions, approved commands, the
//! desktop-action cache, the process registry) across `await` points and spawned
//! tasks, so a single panicked task used to take the whole sidecar down forever.
//!
//! Poisoning carries no useful information here — the guarded maps are append-only
//! registries, not invariant-protecting resources — so we recover the inner
//! guard and keep serving. A `tracing::error!` records the event so it is still
//! visible in `backend.log` and any future crash-reporting sink.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Extension trait so call sites read `.lock_unpoisoned()` instead of a verbose
/// closure. Implemented for the concrete `std::sync::Mutex` only — `parking_lot`
/// and `tokio` mutexes don't poison and don't need this.
pub trait Unpoison<T> {
    fn lock_unpoisoned(&self) -> MutexGuard<'_, T>;
}

impl<T> Unpoison<T> for Mutex<T> {
    fn lock_unpoisoned(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|err: PoisonError<MutexGuard<'_, T>>| {
            tracing::error!(
                target: "sync_util",
                "mutex was poisoned by a panicked thread; recovering guard to stay alive"
            );
            err.into_inner()
        })
    }
}
