//! Port of pi `harness/execution/effect-gate.ts`.
//!
//! Every hook/provider/tool invocation passes `admit()` synchronously
//! before starting; abort/close flips the gate so new effects fail
//! deterministically instead of racing the cancellation path. This is how
//! cancellation wins races without tearing in-flight settlements.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::harness::types::AbortSignal;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GateError {
    /// Cancellation won admission; reconcile the operation.
    #[error("abort requested")]
    AbortRequested,
    /// The gate (or its session/harness) was closed.
    #[error("gate closed: {0}")]
    Closed(String),
}

enum GateState {
    Open,
    Aborting,
    Closed(String),
}

pub struct EffectGate {
    state: Mutex<GateState>,
    signal: AbortSignal,
    aborted: AtomicBool,
}

impl Default for EffectGate {
    fn default() -> Self {
        Self::new()
    }
}

impl EffectGate {
    pub fn new() -> Self {
        EffectGate { state: Mutex::new(GateState::Open), signal: AbortSignal::new(), aborted: AtomicBool::new(false) }
    }

    /// Shared view for procedures.
    pub fn signal(&self) -> &AbortSignal {
        &self.signal
    }

    /// Synchronously admit one effect. Fails without invoking `invoke`
    /// when cancellation or close already won.
    pub fn admit<T>(&self, invoke: impl FnOnce() -> T) -> Result<T, GateError> {
        self.check()?;
        Ok(invoke())
    }

    pub fn check(&self) -> Result<(), GateError> {
        match &*self.state.lock().unwrap() {
            GateState::Open => Ok(()),
            GateState::Aborting => Err(GateError::AbortRequested),
            GateState::Closed(error) => Err(GateError::Closed(error.clone())),
        }
    }

    // -- owner-facing controls (pi GateControl) --

    /// Request abort; further admissions fail with `AbortRequested` while
    /// the in-flight effect is reconciled.
    pub fn begin_abort(&self) {
        let mut state = self.state.lock().unwrap();
        if matches!(*state, GateState::Open) {
            *state = GateState::Aborting;
        }
    }

    /// Signal the shared abort signal. Only meaningful while aborting.
    pub fn signal_abort(&self) {
        let aborting = matches!(&*self.state.lock().unwrap(), GateState::Aborting);
        if aborting && !self.aborted.load(Ordering::SeqCst) {
            self.aborted.store(true, Ordering::SeqCst);
            self.signal.abort();
        }
    }

    /// Close permanently; every later admission fails with `error`.
    pub fn close(&self, error: String) {
        let mut state = self.state.lock().unwrap();
        if matches!(*state, GateState::Closed(_)) {
            return;
        }
        *state = GateState::Closed(error);
        drop(state);
        if !self.aborted.swap(true, Ordering::SeqCst) {
            self.signal.abort();
        }
    }
}

/// Shared gate handle (procedures see `admit`/`signal`; the lane owns the
/// controls through the same handle — module discipline, as in pi's split
/// `Gate`/`GateControl` views).
pub type SharedGate = Arc<EffectGate>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_gate_admits() {
        let gate = EffectGate::new();
        assert_eq!(gate.admit(|| 7), Ok(7));
    }

    #[test]
    fn abort_wins_admission_without_invoking() {
        let gate = EffectGate::new();
        gate.begin_abort();
        let mut invoked = false;
        let err = gate.admit(|| {
            invoked = true;
        });
        assert_eq!(err, Err(GateError::AbortRequested));
        assert!(!invoked);
        gate.signal_abort();
        assert!(gate.signal().is_aborted());
    }

    #[test]
    fn close_beats_abort_and_is_final() {
        let gate = EffectGate::new();
        gate.begin_abort();
        gate.close("session closed".into());
        assert_eq!(gate.admit(|| ()), Err(GateError::Closed("session closed".into())));
        // A second close does not overwrite the first reason.
        gate.close("other".into());
        assert_eq!(gate.check(), Err(GateError::Closed("session closed".into())));
        assert!(gate.signal().is_aborted());
    }
}
