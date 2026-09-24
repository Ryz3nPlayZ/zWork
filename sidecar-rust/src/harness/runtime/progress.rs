//! Port of pi `harness/runtime/progress.ts` — durable progress channels.
//!
//! A progress channel appends bounded partials (assistant frames, staged
//! tool output) through lane commands while its operation still owns the
//! durable state they belong to; ownership checks make late writes no-ops
//! after settlement. Writes chain through tasks so frames land in stream
//! order (pi relies on the single-threaded mutation line for the same
//! guarantee).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::task::JoinHandle;

use crate::harness::assistant_frame::AssistantMessageFrame;
use crate::harness::session::commit::Write;
use crate::harness::session::values::{append_list, set_value};
use crate::harness::session::session::SessionMutator;
use crate::harness::session::types::{
    OperationState, SessionError, SessionResult, ToolCallStatus,
};
use crate::harness::session::values::{pending_assistant_frames, pending_tool_output, Addr};

use super::lane::Lane;
use super::types::{Drive, RuntimeLaneState};

/// Read the durable frames of one in-flight assistant response (pi
/// `readAssistantFrames`), paging through the bounded list.
pub fn read_assistant_frames(
    reader: &SessionMutator<'_>,
    operation_id: &str,
    response_entry_id: &str,
) -> SessionResult<Vec<AssistantMessageFrame>> {
    let address = pending_assistant_frames(operation_id, response_entry_id);
    let mut frames = Vec::new();
    let mut cursor: Option<u64> = None;
    loop {
        let page = reader.read_list(
            &address,
            crate::harness::session::values::ListReadOptions { cursor, desc: false, limit: Some(1_000) },
        )?;
        let page_len = page.len();
        for element in page {
            cursor = Some(element.seq);
            let frame: AssistantMessageFrame = serde_json::from_value(element.value).map_err(|e| {
                SessionError::Storage(format!("assistant frame decode failed: {e}"))
            })?;
            frames.push(frame);
        }
        if page_len < 1_000 {
            return Ok(frames);
        }
    }
}

/// One durable progress append (pi `ProgressChannel`).
pub struct ProgressChannel<T> {
    lane: Arc<Lane>,
    address: Addr,
    build_write: Arc<dyn Fn(&Addr, T) -> Write + Send + Sync>,
    still_owns: Arc<dyn Fn(&RuntimeLaneState) -> bool + Send + Sync>,
    sealed: AtomicBool,
    latest: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl<T> ProgressChannel<T>
where
    T: Send + 'static,
{
    /// Queue one progress item; ownership is re-checked at commit time, so
    /// writes racing settlement become no-ops.
    pub async fn write(&self, item: T) {
        if self.sealed.load(Ordering::SeqCst) {
            return;
        }
        let lane = Arc::clone(&self.lane);
        let address = self.address.clone();
        let build_write = Arc::clone(&self.build_write);
        let still_owns = Arc::clone(&self.still_owns);
        let previous = { self.latest.lock().await.take() };
        let task = tokio::spawn(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            let _ = lane
                .command(move |state, _| {
                    if !still_owns(state) {
                        return Ok(super::types::LaneCommand::Return { result: () });
                    }
                    Ok(super::types::LaneCommand::Commit {
                        decision: super::types::CommitDecision {
                            writes: vec![build_write(&address, item)],
                            materialize: Box::new(|_| ()),
                            events: None,
                        },
                        next: state.clone(),
                    })
                })
                .await;
        });
        *self.latest.lock().await = Some(task);
    }

    /// Stop accepting writes (pi `seal`).
    pub fn seal(&self) {
        self.sealed.store(true, Ordering::SeqCst);
    }

    /// Wait for the last queued write to land (pi `drain`).
    pub async fn drain(&self) {
        if let Some(task) = self.latest.lock().await.take() {
            let _ = task.await;
        }
    }
}

fn owns_effect_pending(response_entry_id: &str) -> impl Fn(&RuntimeLaneState) -> bool + Clone + Send + Sync + 'static {
    let response_entry_id = response_entry_id.to_string();
    move |state: &RuntimeLaneState| match &state.operation {
        None => false,
        Some(operation) => match &operation.state {
            OperationState::AssistantEffectPending { response_entry_id: id, .. }
            | OperationState::DeferredEffectPending { response_entry_id: id, .. } => {
                id == &response_entry_id
            }
            _ => false,
        },
    }
}

fn owns_tool_call(turn_id: &str, source_index: usize, invocation_id: &str) -> impl Fn(&RuntimeLaneState) -> bool + Send + Sync + 'static {
    let turn_id = turn_id.to_string();
    let invocation_id = invocation_id.to_string();
    move |state: &RuntimeLaneState| match &state.operation {
        None => false,
        Some(operation) => match &operation.state {
            OperationState::Tools { batch, .. } => {
                batch.turn_id == turn_id
                    && batch.calls.iter().any(|call| {
                        call.source_index == source_index
                            && call.result_entry_id == invocation_id
                            && call.status == ToolCallStatus::EffectPending
                    })
            }
            _ => false,
        },
    }
}

/// Durable assistant frames for one response entry (pi `openFrameProgress`).
pub fn open_frame_progress(lane: &Arc<Lane>, drive: &Arc<Drive>, response_entry_id: &str) -> ProgressChannel<AssistantMessageFrame> {
    ProgressChannel {
        lane: Arc::clone(lane),
        address: pending_assistant_frames(&drive.operation_id, response_entry_id),
        build_write: Arc::new(|address: &Addr, frame: AssistantMessageFrame| {
            let json = serde_json::to_value(&frame).expect("assistant frame serializes");
            Write::List(append_list(address, json))
        }),
        still_owns: Arc::new(owns_effect_pending(response_entry_id)),
        sealed: AtomicBool::new(false),
        latest: tokio::sync::Mutex::new(None),
    }
}

/// Staged tool-output snapshots for one invocation (pi `openToolProgress`).
pub fn open_tool_progress<T>(
    lane: &Arc<Lane>,
    drive: &Arc<Drive>,
    turn_id: &str,
    source_index: usize,
    invocation_id: &str,
) -> ProgressChannel<T>
where
    T: serde::Serialize + Send + 'static,
{
    ProgressChannel {
        lane: Arc::clone(lane),
        address: pending_tool_output(&drive.operation_id, invocation_id),
        build_write: Arc::new(|address: &Addr, snapshot: T| {
            let json = serde_json::to_value(&snapshot).expect("tool output snapshot serializes");
            Write::Value(set_value(address, json))
        }),
        still_owns: Arc::new(owns_tool_call(turn_id, source_index, invocation_id)),
        sealed: AtomicBool::new(false),
        latest: tokio::sync::Mutex::new(None),
    }
}
