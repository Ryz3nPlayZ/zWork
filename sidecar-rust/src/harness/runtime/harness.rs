//! Port of pi `runtime/harness.ts` — the `AgentHarness` facade.
//!
//! The harness manages lanes but is not itself a lane: it owns the shared
//! runtime config, the hook registry, the event fan-out (with a replay
//! ring so detached clients can re-attach from a cursor), session-scoped
//! values, and lane lifecycle including startup restore.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::RwLock;

use crate::harness::agent_types::AgentMessage;
use crate::harness::session::session::Session;
use crate::harness::session::types::{LaneConfiguration, SessionError};
use crate::harness::session::commit::Write;
use crate::harness::session::values::{
    branch_tip, lane_config, lane_state as lane_state_value, set_value,
};
use crate::harness::types::{ThinkingLevel, Usage};

use super::events::{ConfigUpdateProperty, HarnessEvent, QueueModeUpdate, ValueUpdate};
use super::hooks::HookRegistry;
use super::lane::{
    AbortRequest, CancelledQueued, Lane, LaneError, LaneResult, NavigationRequest,
    OperationAdmission, QueueKind, RunRequest,
};
use super::restore::{self, OpenOperation};
use crate::harness::session::types::OperationResultRecord;
use super::types::{DriveOutcome, RuntimeConfig};

/// Retained harness events for cursor-based re-attach (one SSE screen).
const EVENT_REPLAY_CAPACITY: usize = 512;

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

struct BusInner {
    next_seq: u64,
    ring: VecDeque<(u64, HarnessEvent)>,
    subscribers: Vec<tokio::sync::mpsc::UnboundedSender<(u64, HarnessEvent)>>,
}

/// Fan-out for harness events: lanes push into an intake channel; a pump
/// task stamps each event with a monotonic sequence number, retains a
/// bounded replay ring, and forwards to every subscriber. Subscribers that
/// attach with a cursor first receive the retained suffix — the basis for
/// SSE re-attach (`GET /api/chats/:id/run/live`).
pub struct HarnessEventBus {
    inner: Mutex<BusInner>,
}

impl HarnessEventBus {
    /// Create the bus and its intake handle (clone one per lane). The pump
    /// task lives until every intake sender is dropped.
    pub fn new() -> (std::sync::Arc<Self>, tokio::sync::mpsc::UnboundedSender<HarnessEvent>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<HarnessEvent>();
        let bus = std::sync::Arc::new(HarnessEventBus {
            inner: Mutex::new(BusInner { next_seq: 0, ring: VecDeque::new(), subscribers: Vec::new() }),
        });
        let pump = std::sync::Arc::clone(&bus);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                pump.push(event);
            }
            // Intake closed (harness and every lane dropped): no further
            // events can arrive, so release subscribers — their receivers
            // resolve and dependent tasks (event mappers) can exit.
            pump.inner.lock().unwrap().subscribers.clear();
        });
        (bus, tx)
    }

    fn push(self: &std::sync::Arc<Self>, event: HarnessEvent) {
        let mut inner = self.inner.lock().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.ring.push_back((seq, event.clone()));
        while inner.ring.len() > EVENT_REPLAY_CAPACITY {
            inner.ring.pop_front();
        }
        inner.subscribers.retain(|subscriber| subscriber.send((seq, event.clone())).is_ok());
    }

    /// Latest stamped sequence number (0 before any event).
    pub fn latest_seq(&self) -> u64 {
        self.inner.lock().unwrap().next_seq.saturating_sub(1)
    }

    /// Subscribe to live events; with a cursor, retained events after the
    /// cursor are replayed first in order.
    pub fn subscribe(
        &self,
        cursor: Option<u64>,
    ) -> tokio::sync::mpsc::UnboundedReceiver<(u64, HarnessEvent)> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(cursor) = cursor {
                for (seq, event) in inner.ring.iter().filter(|(seq, _)| *seq > cursor) {
                    let _ = tx.send((*seq, event.clone()));
                }
            }
            inner.subscribers.push(tx);
        }
        rx
    }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/// Lane-creation inputs (pi `AgentHarnessOptions` seed subset).
#[derive(Debug, Clone)]
pub struct HarnessOptions {
    pub provider: String,
    pub model_id: String,
    pub thinking_level: ThinkingLevel,
    pub active_tool_names: Vec<String>,
    /// Everything shared across lanes (tools, stream, retry, compaction,
    /// queue modes, model source…). The seed above derives the initial
    /// per-lane configuration.
    pub config: RuntimeConfig,
}

/// One lane as listed by [`Harness::lanes`] (pi `LaneInfo`).
#[derive(Debug, Clone)]
pub struct LaneInfo {
    pub name: String,
    pub tip_id: Option<String>,
    pub operation: Option<CurrentOperationInfo>,
}

/// The lane's current operation (pi `CurrentOperationInfo`).
#[derive(Debug, Clone)]
pub struct CurrentOperationInfo {
    pub operation_id: String,
    pub kind: &'static str,
    pub started_at: u64,
    /// `open` while running, `aborting` once cancellation is requested.
    pub aborting: bool,
}

enum HarnessStatus {
    Open,
    Faulted(String),
    Closed(String),
}

/// Runtime harness facade: owns lanes, shared config, hooks, and events
/// (pi `Harness`). Not itself a lane.
pub struct Harness {
    pub session: Session,
    pub hooks: std::sync::Arc<HookRegistry>,
    pub events: std::sync::Arc<HarnessEventBus>,
    config: std::sync::Arc<RwLock<RuntimeConfig>>,
    seed: LaneConfiguration,
    lanes: Mutex<HashMap<String, std::sync::Arc<Lane>>>,
    status: Mutex<HarnessStatus>,
    event_tx: tokio::sync::mpsc::UnboundedSender<HarnessEvent>,
}

impl Harness {
    /// Attach the runtime to one open session without starting provider,
    /// tool, hook, or timer effects (pi `createAgentHarness`). Returns the
    /// harness plus every open operation found in durable storage — the
    /// caller decides whether to resume or reconcile them.
    pub fn create(
        session: Session,
        options: HarnessOptions,
    ) -> LaneResult<(std::sync::Arc<Harness>, Vec<OpenOperation>)> {
        let restored = restore::restore_session(&session).map_err(LaneError::Session)?;
        let open = restore::open_operations(&restored);
        let seed = LaneConfiguration {
            provider: options.provider,
            model_id: options.model_id,
            thinking_level: options.thinking_level,
            active_tool_names: options.active_tool_names,
        };
        let hooks = std::sync::Arc::new(HookRegistry::new());
        let (events, event_tx) = HarnessEventBus::new();
        let config = std::sync::Arc::new(RwLock::new(options.config));
        let mut lanes = HashMap::new();
        for (name, snapshot) in restored {
            let lane = Lane::new(
                name.clone(),
                session.clone(),
                std::sync::Arc::clone(&hooks),
                std::sync::Arc::clone(&config),
                snapshot,
                event_tx.clone(),
            )?;
            lanes.insert(name, lane);
        }
        Ok((
            std::sync::Arc::new(Harness {
                session,
                hooks,
                events,
                config,
                seed,
                lanes: Mutex::new(lanes),
                status: Mutex::new(HarnessStatus::Open),
                event_tx,
            }),
            open,
        ))
    }

    fn assert_open(&self) -> LaneResult<()> {
        match &*self.status.lock().unwrap() {
            HarnessStatus::Open => Ok(()),
            HarnessStatus::Faulted(message) | HarnessStatus::Closed(message) => {
                Err(LaneError::Closed("harness".into(), message.clone()))
            }
        }
    }

    fn emit(&self, event: HarnessEvent) {
        let _ = self.event_tx.send(event);
    }

    /// Acquire a lane by name, creating it (seeded from the harness
    /// options) when absent, restoring it when durable values exist (pi
    /// `harness.lane`). Repeated calls return the same lane.
    pub async fn lane(self: &std::sync::Arc<Self>, name: &str) -> LaneResult<std::sync::Arc<Lane>> {
        self.lane_at(name, None).await
    }

    /// [`Harness::lane`] with an explicit attach point for fresh lanes (pi
    /// `AcquireLaneOptions.createAt`).
    pub async fn lane_at(
        self: &std::sync::Arc<Self>,
        name: &str,
        create_at: Option<String>,
    ) -> LaneResult<std::sync::Arc<Lane>> {
        self.assert_open()?;
        if name.is_empty() || name.contains('\u{0}') {
            return Err(LaneError::InvalidLane {
                lane: name.to_string(),
                reason: if name.is_empty() { "empty" } else { "nul_byte" },
            });
        }
        if let Some(lane) = self.lanes.lock().unwrap().get(name) {
            return Ok(std::sync::Arc::clone(lane));
        }

        let tip = self
            .session
            .get_value_raw(&branch_tip(name))
            .map_err(LaneError::Session)?
            .and_then(|stored| stored.value.as_str().map(String::from));
        let configuration = self
            .session
            .get_value_raw(&lane_config(name))
            .map_err(LaneError::Session)?
            .map(|stored| serde_json::from_value::<LaneConfiguration>(stored.value))
            .transpose()
            .map_err(|e| SessionError::Storage(format!("lane config decode failed: {e}")))
            .map_err(LaneError::Session)?;
        let durable_state = self
            .session
            .get_value_raw(&lane_state_value(name))
            .map_err(LaneError::Session)?
            .map(|stored| serde_json::from_value::<crate::harness::session::types::LaneState>(stored.value))
            .transpose()
            .map_err(|e| SessionError::Storage(format!("lane state decode failed: {e}")))
            .map_err(LaneError::Session)?;

        let (snapshot, created) = match (tip, configuration, durable_state) {
            (None, None, None) => {
                let attach = create_at;
                if let Some(target) = &attach {
                    if self.session.get_entry(target).map_err(LaneError::Session)?.is_none() {
                        return Err(LaneError::UnknownTarget(target.clone()));
                    }
                }
                let configuration = self.seed.clone();
                let durable = crate::harness::session::types::LaneState::default();
                let write_configuration = configuration.clone();
                let write_durable = durable.clone();
                let write_attach = attach.clone();
                self.session
                    .mutate(move |mutator| {
                        mutator.commit(vec![
                            Write::Value(set_value(&branch_tip(name), serde_json::json!(write_attach))),
                            Write::Value(set_value(
                                &lane_config(name),
                                serde_json::to_value(&write_configuration)
                                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                            )),
                            Write::Value(set_value(
                                &lane_state_value(name),
                                serde_json::to_value(&write_durable)
                                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                            )),
                        ])?;
                        Ok(())
                    })
                    .await
                    .map_err(LaneError::Session)?;
                (
                    LaneSnapshotForCreate { tip_id: attach, configuration, durable }.into_snapshot(),
                    true,
                )
            }
            // A bare branch tip or partially written lane cannot host a
            // runtime lane; restore validates complete storage.
            (Some(tip), None, None) => {
                // Branch-only names attach a fresh configured lane at the tip.
                let configuration = self.seed.clone();
                let durable = crate::harness::session::types::LaneState::default();
                let write_configuration = configuration.clone();
                let write_durable = durable.clone();
                self.session
                    .mutate(move |mutator| {
                        mutator.commit(vec![
                            Write::Value(set_value(
                                &lane_config(name),
                                serde_json::to_value(&write_configuration)
                                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                            )),
                            Write::Value(set_value(
                                &lane_state_value(name),
                                serde_json::to_value(&write_durable)
                                    .map_err(|e| SessionError::Storage(e.to_string()))?,
                            )),
                        ])?;
                        Ok(())
                    })
                    .await
                    .map_err(LaneError::Session)?;
                (
                    LaneSnapshotForCreate { tip_id: Some(tip), configuration, durable }.into_snapshot(),
                    true,
                )
            }
            _ => {
                let snapshot = Lane::read_snapshot(&self.session, name).map_err(LaneError::Session)?;
                restore::validate_restored_operation(name, &snapshot).map_err(LaneError::Session)?;
                (snapshot, false)
            }
        };

        let lane = Lane::new(
            name.to_string(),
            self.session.clone(),
            std::sync::Arc::clone(&self.hooks),
            std::sync::Arc::clone(&self.config),
            snapshot,
            self.event_tx.clone(),
        )?;
        let mut lanes = self.lanes.lock().unwrap();
        if let Some(existing) = lanes.get(name) {
            // A concurrent lane() call won the insert race.
            return Ok(std::sync::Arc::clone(existing));
        }
        lanes.insert(name.to_string(), std::sync::Arc::clone(&lane));
        drop(lanes);
        if created {
            self.emit(HarnessEvent::LaneCreated { at: lane.tip_id().ok().flatten() });
        }
        Ok(lane)
    }

    /// List lanes with their tips and current operations (pi `lanes`).
    pub fn lanes(&self) -> LaneResult<Vec<LaneInfo>> {
        self.assert_open()?;
        let lanes = self.lanes.lock().unwrap();
        let mut infos = Vec::new();
        for (name, lane) in lanes.iter() {
            let operation = match lane.operation_snapshot() {
                Some(operation) => Some(CurrentOperationInfo {
                    operation_id: operation.meta.operation_id.clone(),
                    kind: restore::intent_kind(&operation.meta.intent),
                    started_at: operation.meta.started_at,
                    aborting: matches!(
                        operation.state.scope().control,
                        crate::harness::session::types::Control::CancelRequested { .. }
                    ),
                }),
                None => None,
            };
            infos.push(LaneInfo { name: name.clone(), tip_id: lane.tip_id()?, operation });
        }
        Ok(infos)
    }

    // -- session-scoped values --

    pub fn get_name(&self) -> LaneResult<Option<String>> {
        self.assert_open()?;
        self.session.get_name().map_err(LaneError::Session)
    }

    pub async fn set_name(&self, name: Option<String>) -> LaneResult<()> {
        self.assert_open()?;
        self.session
            .set_name(name.clone())
            .await
            .map_err(LaneError::Session)?;
        self.emit(HarnessEvent::ValueUpdate {
            value: ValueUpdate::SessionName { name },
        });
        Ok(())
    }

    pub fn get_label(&self, target_id: &str) -> LaneResult<Option<String>> {
        self.assert_open()?;
        self.session.get_label(target_id).map_err(LaneError::Session)
    }

    pub async fn set_label(&self, target_id: &str, label: Option<String>) -> LaneResult<()> {
        self.assert_open()?;
        self.session
            .set_label(target_id, label.clone())
            .await
            .map_err(LaneError::Session)?;
        self.emit(HarnessEvent::ValueUpdate {
            value: ValueUpdate::EntryLabel { target_id: target_id.to_string(), label },
        });
        Ok(())
    }

    // -- harness-global config (pi get/set on the facade) --

    pub fn read_config(&self) -> RuntimeConfig {
        self.config.read().unwrap().clone()
    }

    pub fn config_handle(&self) -> std::sync::Arc<RwLock<RuntimeConfig>> {
        std::sync::Arc::clone(&self.config)
    }

    fn update_config(
        &self,
        apply: impl FnOnce(&mut RuntimeConfig),
        event: impl FnOnce(&RuntimeConfig, &RuntimeConfig) -> Option<ConfigUpdateProperty>,
    ) -> LaneResult<()> {
        self.assert_open()?;
        let property = {
            let mut config = self.config.write().unwrap();
            let previous = config.clone();
            apply(&mut config);
            event(&previous, &config)
        };
        if let Some(property) = property {
            self.emit(HarnessEvent::ConfigUpdateGlobal { property });
        }
        Ok(())
    }

    pub fn set_tools(
        &self,
        tools: Vec<std::sync::Arc<super::tool_exec::RuntimeTool>>,
    ) -> LaneResult<()> {
        self.update_config(
            move |config| config.tools = std::sync::Arc::new(tools),
            |_, _| Some(ConfigUpdateProperty::Tools),
        )
    }

    pub fn set_resources(&self, resources: super::types::Resources) -> LaneResult<()> {
        self.update_config(
            move |config| config.resources = resources,
            |_, _| Some(ConfigUpdateProperty::Resources),
        )
    }

    pub fn set_stream_options(
        &self,
        options: crate::harness::session::types::HarnessStreamOptionsSnapshot,
    ) -> LaneResult<()> {
        self.update_config(
            move |config| config.stream_options = options,
            |previous, next| {
                Some(ConfigUpdateProperty::StreamOptions {
                    value: next.stream_options.clone(),
                    previous: previous.stream_options.clone(),
                })
            },
        )
    }

    pub fn set_retry_policy(
        &self,
        policy: super::types::RetryPolicySnapshot,
    ) -> LaneResult<()> {
        self.update_config(
            move |config| config.retry_policy = policy,
            |previous, next| {
                Some(ConfigUpdateProperty::RetryPolicy {
                    value: next.retry_policy.clone(),
                    previous: previous.retry_policy.clone(),
                })
            },
        )
    }

    pub fn set_compaction_settings(
        &self,
        settings: crate::harness::compaction::CompactionSettings,
    ) -> LaneResult<()> {
        self.update_config(
            move |config| config.compaction = settings,
            |previous, next| {
                Some(ConfigUpdateProperty::CompactionSettings {
                    value: next.compaction.clone(),
                    previous: previous.compaction.clone(),
                })
            },
        )
    }

    pub fn set_steering_mode(&self, mode: QueueModeUpdate) -> LaneResult<()> {
        self.update_config(
            move |config| config.steering_mode = queue_mode_from_update(mode),
            |previous, next| {
                Some(ConfigUpdateProperty::SteeringMode {
                    value: queue_mode_update(&next.steering_mode),
                    previous: queue_mode_update(&previous.steering_mode),
                })
            },
        )
    }

    pub fn set_follow_up_mode(&self, mode: QueueModeUpdate) -> LaneResult<()> {
        self.update_config(
            move |config| config.follow_up_mode = queue_mode_from_update(mode),
            |previous, next| {
                Some(ConfigUpdateProperty::FollowUpMode {
                    value: queue_mode_update(&next.follow_up_mode),
                    previous: queue_mode_update(&previous.follow_up_mode),
                })
            },
        )
    }

    // -- lifecycle --

    /// Irreversibly seal the harness after a storage/invariant fault; all
    /// lanes seal and a `fault` event is emitted (pi `fault`).
    pub async fn fault(self: &std::sync::Arc<Self>, message: String) {
        {
            let mut status = self.status.lock().unwrap();
            if !matches!(&*status, HarnessStatus::Open) {
                return;
            }
            *status = HarnessStatus::Faulted(message.clone());
        }
        let lanes: Vec<std::sync::Arc<Lane>> =
            self.lanes.lock().unwrap().values().cloned().collect();
        for lane in lanes {
            lane.seal(message.clone()).await;
        }
        self.emit(HarnessEvent::Fault { code: "harness_fault".into(), message });
    }

    /// Graceful close: seal lanes, mark closed (pi `close`).
    pub async fn close(self: &std::sync::Arc<Self>) {
        {
            let mut status = self.status.lock().unwrap();
            if !matches!(&*status, HarnessStatus::Open) {
                return;
            }
            *status = HarnessStatus::Closed("harness closed".into());
        }
        let lanes: Vec<std::sync::Arc<Lane>> =
            self.lanes.lock().unwrap().values().cloned().collect();
        for lane in lanes {
            lane.seal("harness closed".into()).await;
        }
        let _ = self.session.close().await;
    }

    // -- convenience lane operations (pi AgentLane wrappers) --

    /// Accept a prompt and drive it to settlement (pi `prompt`). Retries
    /// are waited out; the returned record carries the terminal status.
    pub async fn prompt(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        messages: Vec<AgentMessage>,
    ) -> LaneResult<OperationResultRecord> {
        self.drive_run_request(lane_name, RunRequest::Prompt { messages }).await
    }

    /// Accept a skill invocation and drive it to settlement (pi `skill`).
    pub async fn skill(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        name: String,
        additional_instructions: Option<String>,
    ) -> LaneResult<OperationResultRecord> {
        self.drive_run_request(lane_name, RunRequest::Skill { name, additional_instructions }).await
    }

    /// Accept a prompt-template invocation and drive it (pi
    /// `promptFromTemplate`).
    pub async fn prompt_from_template(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        name: String,
        args: Vec<String>,
    ) -> LaneResult<OperationResultRecord> {
        self.drive_run_request(lane_name, RunRequest::PromptTemplate { name, args }).await
    }

    async fn drive_run_request(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        request: RunRequest,
    ) -> LaneResult<OperationResultRecord> {
        let lane = self.lane(lane_name).await?;
        let admission = lane.accept(request).await?;
        self.drive_admission(&lane, &admission).await
    }

    async fn drive_admission(
        self: &std::sync::Arc<Self>,
        lane: &std::sync::Arc<Lane>,
        admission: &OperationAdmission,
    ) -> LaneResult<OperationResultRecord> {
        match lane.drive(&admission.operation_id, true).await? {
            DriveOutcome::Settled { outcome } => Ok(outcome),
            DriveOutcome::WaitingRetry { not_before, .. } => Err(LaneError::Other(format!(
                "operation {} returned an unwaited retry (not before {not_before})",
                admission.operation_id
            ))),
            DriveOutcome::Failed { code, message } => Err(LaneError::Other(format!(
                "operation {} failed: {code}: {message}",
                admission.operation_id
            ))),
        }
    }

    /// Drive the lane's open operation to settlement — the resume path for
    /// operations restored at startup or suspended runs (pi `resume`).
    pub async fn resume(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
    ) -> LaneResult<OperationResultRecord> {
        self.assert_open()?;
        let lane = self.lane(lane_name).await?;
        let operation_id = lane
            .current_operation_id()?
            .ok_or_else(|| LaneError::NoActiveOperation(lane_name.to_string()))?;
        match lane.drive(&operation_id, true).await? {
            DriveOutcome::Settled { outcome } => Ok(outcome),
            DriveOutcome::WaitingRetry { not_before, .. } => Err(LaneError::Other(format!(
                "operation {operation_id} returned an unwaited retry (not before {not_before})"
            ))),
            DriveOutcome::Failed { code, message } => Err(LaneError::Other(format!(
                "operation {operation_id} failed: {code}: {message}"
            ))),
        }
    }

    /// Abort the lane's active operation and drive the cancellation to
    /// settlement, returning the unconsumed steer/follow-up messages (pi
    /// `abort`).
    pub async fn abort(self: &std::sync::Arc<Self>, lane_name: &str) -> LaneResult<AbortRequest> {
        self.assert_open()?;
        let lane = self.lane(lane_name).await?;
        let operation_id = lane
            .current_operation_id()?
            .ok_or_else(|| LaneError::NoActiveOperation(lane_name.to_string()))?;
        let request = lane.request_operation_abort(&operation_id).await?;
        match lane.drive(&operation_id, false).await {
            Ok(_) | Err(LaneError::OperationMismatch { .. }) => {}
            Err(error) => return Err(error),
        }
        Ok(request)
    }

    /// Queue a steering message on a busy lane (pi `steer`).
    pub async fn steer(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        message: AgentMessage,
    ) -> LaneResult<String> {
        let lane = self.lane(lane_name).await?;
        lane.enqueue(QueueKind::Steer, message).await
    }

    /// Queue a follow-up message (pi `followUp`).
    pub async fn follow_up(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        message: AgentMessage,
    ) -> LaneResult<String> {
        let lane = self.lane(lane_name).await?;
        lane.enqueue(QueueKind::FollowUp, message).await
    }

    /// Queue a whole next run (pi `nextRun`).
    pub async fn next_run(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        message: AgentMessage,
    ) -> LaneResult<String> {
        let lane = self.lane(lane_name).await?;
        lane.enqueue(QueueKind::NextRun, message).await
    }

    /// Cancel one queued item (pi `cancelQueued`).
    pub async fn cancel_queued(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        entry_id: &str,
    ) -> LaneResult<CancelledQueued> {
        let lane = self.lane(lane_name).await?;
        lane.cancel_queued(entry_id).await
    }

    /// Record an adjustment usage row on the lane (pi `recordUsage`).
    pub async fn record_usage(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        usage: Usage,
        entry_id: Option<String>,
        details: Option<serde_json::Value>,
    ) -> LaneResult<String> {
        let lane = self.lane(lane_name).await?;
        lane.record_usage(usage, entry_id, details).await
    }

    /// Unsummarized tree navigation driven to settlement (pi
    /// `navigateTree` without `summarize`); summarized navigation arrives
    /// with the structural procedures (M6).
    pub async fn navigate_tree(
        self: &std::sync::Arc<Self>,
        lane_name: &str,
        target_id: Option<String>,
        label: Option<String>,
    ) -> LaneResult<OperationResultRecord> {
        let lane = self.lane(lane_name).await?;
        let admission = lane.accept_navigation(NavigationRequest { target_id, label }).await?;
        self.drive_admission(&lane, &admission).await
    }
}

/// Helper bundling freshly written lane values into a snapshot.
struct LaneSnapshotForCreate {
    tip_id: Option<String>,
    configuration: LaneConfiguration,
    durable: crate::harness::session::types::LaneState,
}

impl LaneSnapshotForCreate {
    fn into_snapshot(self) -> super::lane::LaneSnapshotState {
        super::lane::LaneSnapshotState {
            configuration: Some(self.configuration),
            tip_id: self.tip_id,
            lane_state: self.durable,
            operation: None,
        }
    }
}

fn queue_mode_update(mode: &crate::harness::session::types::QueueMode) -> QueueModeUpdate {
    match mode {
        crate::harness::session::types::QueueMode::All => QueueModeUpdate::All,
        crate::harness::session::types::QueueMode::OneAtATime => QueueModeUpdate::OneAtATime,
    }
}

fn queue_mode_from_update(mode: QueueModeUpdate) -> crate::harness::session::types::QueueMode {
    match mode {
        QueueModeUpdate::All => crate::harness::session::types::QueueMode::All,
        QueueModeUpdate::OneAtATime => crate::harness::session::types::QueueMode::OneAtATime,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::agent_types::StreamFn;
    use crate::harness::session::memory::MemoryStorage;
    use crate::harness::session::types::{Control, LaneState, OperationMeta, OperationScope};
    use crate::harness::session::values::{
        operation_meta as operation_meta_addr, operation_state as operation_state_addr,
    };
    use crate::harness::session::SessionMetadata;
    use crate::harness::types::{
        Api, AssistantContent, AssistantMessageEvent, Model, TextContent,
    };
    use std::sync::Arc;

    fn test_session() -> (Session, Arc<MemoryStorage>) {
        let storage = Arc::new(MemoryStorage::new());
        (
            Session::new(
                SessionMetadata {
                    id: "s".into(),
                    created_at: 0,
                    storage_version: 1,
                    cwd: None,
                    parent_session_id: None,
                },
                storage.clone(),
            ),
            storage,
        )
    }

    fn options() -> HarnessOptions {
        HarnessOptions {
            provider: "test".into(),
            model_id: "scripted".into(),
            thinking_level: ThinkingLevel::Minimal,
            active_tool_names: vec![],
            config: RuntimeConfig::default(),
        }
    }

    fn scripted_model() -> Model {
        Model {
            id: "scripted".into(),
            name: "scripted".into(),
            api: Api::AnthropicMessages,
            provider: "test".into(),
            base_url: String::new(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: Default::default(),
            prompt_cache: None,
            context_window: 200_000,
            max_tokens: 8_192,
            headers: None,
            compat: None,
        }
    }

    /// Stream one plain-text assistant response.
    fn scripted_stream(response: &'static str) -> StreamFn {
        Arc::new(move |model, _ctx, _opts| {
            let (tx, rx) = tokio::sync::mpsc::channel(16);
            tokio::spawn(async move {
                use crate::harness::types::{AssistantMessage, StopReason, Usage};
                let empty = AssistantMessage::pending(&model);
                let _ = tx.send(AssistantMessageEvent::Start { partial: empty.clone() }).await;
                let mut partial = AssistantMessage::pending(&model);
                partial.content =
                    vec![AssistantContent::Text(TextContent { text: response.to_string(), text_signature: None })];
                let _ = tx
                    .send(AssistantMessageEvent::TextStart { content_index: 0, partial: partial.clone() })
                    .await;
                let _ = tx
                    .send(AssistantMessageEvent::TextDelta {
                        content_index: 0,
                        delta: response.to_string(),
                        partial: partial.clone(),
                    })
                    .await;
                let _ = tx
                    .send(AssistantMessageEvent::TextEnd {
                        content_index: 0,
                        content: response.to_string(),
                        partial: partial.clone(),
                    })
                    .await;
                let mut done = partial;
                done.stop_reason = StopReason::Stop;
                done.usage = Usage { input: 3, output: 2, total_tokens: 5, ..Default::default() };
                let _ = tx.send(AssistantMessageEvent::Done { reason: StopReason::Stop, message: done }).await;
            });
            rx
        })
    }

    fn install_scripted(harness: &Harness, response: &'static str) {
        let model = scripted_model();
        let mut config = harness.config.write().unwrap();
        config.context_window = Some(model.context_window);
        let source_model = model.clone();
        config.model_source = Some(Arc::new(move |provider: &str, model_id: &str| {
            (provider == "test" && model_id == "scripted").then(|| source_model.clone())
        }));
        config.stream = Some(scripted_stream(response));
    }

    fn user_message(text: &str) -> AgentMessage {
        AgentMessage::user_text(text)
    }

    /// Collect events until one of `stop_types` arrives (inclusive).
    async fn collect_until(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<(u64, HarnessEvent)>,
        stop_types: &[&'static str],
    ) -> Vec<(u64, HarnessEvent)> {
        let mut seen = Vec::new();
        loop {
            let event = match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
                Ok(Some(event)) => event,
                Ok(None) => panic!("event channel closed after {} events", seen.len()),
                Err(_) => panic!("timeout after {} events waiting for {stop_types:?}", seen.len()),
            };
            let done = stop_types.contains(&event.1.event_type());
            seen.push(event);
            if done {
                return seen;
            }
        }
    }

    async fn expect_events(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<(u64, HarnessEvent)>,
        count: usize,
    ) -> Vec<(u64, HarnessEvent)> {
        let mut seen = Vec::new();
        for _ in 0..count {
            match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
                Ok(Some(event)) => seen.push(event),
                Ok(None) => panic!("event channel closed after {}", seen.len()),
                Err(_) => panic!("timeout waiting for event {}", seen.len()),
            }
        }
        seen
    }

    #[tokio::test]
    async fn lane_lifecycle_creates_restores_and_deduplicates() {
        let (session, _storage) = test_session();
        let (harness, open) = Harness::create(session, options()).unwrap();
        assert!(open.is_empty());

        let first = harness.lane("main").await.unwrap();
        let second = harness.lane("main").await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        let mut rx = harness.events.subscribe(None);
        let _ = harness.lane("side").await.unwrap();
        let events = expect_events(&mut rx, 1).await;
        assert!(matches!(events[0].1, HarnessEvent::LaneCreated { .. }));

        let lanes = harness.lanes().unwrap();
        assert!(lanes.iter().any(|info| info.name == "main" && info.operation.is_none()));

        // A second harness over the same storage restores the lane.
        let (harness2, _open2) = Harness::create(harness.session.clone(), options()).unwrap();
        let restored = harness2.lane("main").await.unwrap();
        assert!(restored.tip_id().unwrap().is_none());
    }

    #[tokio::test]
    async fn lane_name_validation_rejects_empty_and_nul() {
        let (session, _) = test_session();
        let (harness, _) = Harness::create(session, options()).unwrap();
        assert!(matches!(
            harness.lane("").await,
            Err(LaneError::InvalidLane { reason: "empty", .. })
        ));
        assert!(matches!(
            harness.lane("bad\u{0}lane").await,
            Err(LaneError::InvalidLane { reason: "nul_byte", .. })
        ));
    }

    #[tokio::test]
    async fn prompt_settles_and_events_stream_with_sequence() {
        let (session, _) = test_session();
        let (harness, open) = Harness::create(session, options()).unwrap();
        assert!(open.is_empty());
        install_scripted(&harness, "hello there");
        let _ = harness.lane("main").await.unwrap();
        let mut rx = harness.events.subscribe(None);

        let record = harness
            .prompt("main", vec![user_message("say hi")])
            .await
            .unwrap();
        assert_eq!(record.status, crate::harness::session::types::TerminalStatus::Completed);

        let events = collect_until(&mut rx, &["run_end"]).await;
        let types: Vec<&'static str> = events
            .iter()
            .map(|(_, e)| e.event_type())
            .skip_while(|kind| *kind == "lane_created")
            .collect();
        assert_eq!(types[0], "run_start");
        assert!(types.contains(&"entry_added"));
        assert!(types.contains(&"turn_end"));
        assert_eq!(*types.last().unwrap(), "run_end");
        // Sequence numbers are dense from zero.
        for (index, (seq, _)) in events.iter().enumerate() {
            assert_eq!(*seq, index as u64);
        }

        // Cursor replay: a re-attached subscriber sees the same suffix.
        let cursor = 2;
        let expected: Vec<(u64, &'static str)> = events
            .iter()
            .filter(|(seq, _)| *seq > cursor)
            .map(|(seq, event)| (*seq, event.event_type()))
            .collect();
        let mut reattach = harness.events.subscribe(Some(cursor));
        let replayed = expect_events(&mut reattach, expected.len()).await;
        let replayed_types: Vec<(u64, &'static str)> =
            replayed.iter().map(|(seq, e)| (*seq, e.event_type())).collect();
        assert_eq!(replayed_types, expected);
    }

    #[tokio::test]
    async fn global_config_updates_reach_lanes_and_events() {
        let (session, _) = test_session();
        let (harness, _) = Harness::create(session, options()).unwrap();
        let lane = harness.lane("main").await.unwrap();
        let mut rx = harness.events.subscribe(None);

        harness.set_steering_mode(QueueModeUpdate::OneAtATime).unwrap();
        let events = collect_until(&mut rx, &["config_update"]).await;
        let config_event = events.last().expect("config_update observed");
        match &config_event.1 {
            HarnessEvent::ConfigUpdateGlobal {
                property: ConfigUpdateProperty::SteeringMode { value, .. },
            } => assert_eq!(*value, QueueModeUpdate::OneAtATime),
            other => panic!("unexpected event {other:?}"),
        }
        assert!(matches!(
            lane.read_config().steering_mode,
            crate::harness::session::types::QueueMode::OneAtATime
        ));
    }

    #[tokio::test]
    async fn session_values_round_trip_with_events() {
        let (session, _) = test_session();
        let (harness, _) = Harness::create(session, options()).unwrap();
        let mut rx = harness.events.subscribe(None);

        harness.set_name(Some("my chat".into())).await.unwrap();
        assert_eq!(harness.get_name().unwrap().as_deref(), Some("my chat"));
        let events = expect_events(&mut rx, 1).await;
        assert!(matches!(
            &events[0].1,
            HarnessEvent::ValueUpdate { value: ValueUpdate::SessionName { name: Some(_) } }
        ));
    }

    #[tokio::test]
    async fn abort_without_operation_reports_none() {
        let (session, _) = test_session();
        let (harness, _) = Harness::create(session, options()).unwrap();
        assert!(matches!(
            harness.abort("main").await,
            Err(LaneError::NoActiveOperation(_))
        ));
    }

    #[tokio::test]
    async fn resume_drives_operation_restored_from_storage() {
        // Simulate a crash: durable storage holds a lane with an open run
        // operation in `starting`. A new harness must list it as open and
        // resume() must drive it to completion.
        let (session, _) = test_session();
        session.create_branch("main", None).await.unwrap();
        let prompt_entry_id = session
            .append_to_branch(
                "main",
                crate::harness::session::types::EntryBody::Message {
                    message: user_message("resume me"),
                    terminate: None,
                },
            )
            .await
            .unwrap();
        session
            .mutate(|mutator| {
                let configuration = LaneConfiguration {
                    provider: "test".into(),
                    model_id: "scripted".into(),
                    thinking_level: ThinkingLevel::Minimal,
                    active_tool_names: vec![],
                };
                let durable = LaneState {
                    current_operation_id: Some("op1".into()),
                    last_operation_id: None,
                    inbox: vec![],
                };
                let meta = OperationMeta {
                    operation_id: "op1".into(),
                    lane: "main".into(),
                    source_tip_id: Some(prompt_entry_id.clone()),
                    started_at: 1,
                    intent: crate::harness::session::types::OperationIntent::Run {
                        prompt_entry_ids: vec![prompt_entry_id.clone()],
                    },
                };
                let state = crate::harness::session::types::OperationState::Starting {
                    scope: OperationScope {
                        control: Control::Running,
                        settings: Default::default(),
                        latest_assistant_entry_id: None,
                    },
                };
                use crate::harness::session::values::set_value as sv;
                mutator.commit(vec![
                    Write::Value(sv(&branch_tip("main"), serde_json::json!(prompt_entry_id.clone()))),
                    Write::Value(sv(&lane_config("main"), serde_json::to_value(&configuration).unwrap())),
                    Write::Value(sv(&lane_state_value("main"), serde_json::to_value(&durable).unwrap())),
                    Write::Value(sv(&operation_meta_addr("op1"), serde_json::to_value(&meta).unwrap())),
                    Write::Value(sv(&operation_state_addr("op1"), serde_json::to_value(&state).unwrap())),
                ])?;
                Ok(())
            })
            .await
            .unwrap();

        let (harness, open) = Harness::create(session, options()).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].operation_id, "op1");
        assert_eq!(open[0].kind, "run");

        install_scripted(&harness, "resumed");
        let record = harness.resume("main").await.unwrap();
        assert_eq!(record.status, crate::harness::session::types::TerminalStatus::Completed);
        assert_eq!(record.operation_id, "op1");
    }

    #[tokio::test]
    async fn close_seals_the_harness() {
        let (session, _) = test_session();
        let (harness, _) = Harness::create(session, options()).unwrap();
        let _ = harness.lane("main").await.unwrap();
        harness.close().await;
        assert!(matches!(
            harness.lane("side").await,
            Err(LaneError::Closed(_, _))
        ));
    }

    #[tokio::test]
    async fn fault_is_idempotent_and_emits() {
        let (session, _) = test_session();
        let (harness, _) = Harness::create(session, options()).unwrap();
        let mut rx = harness.events.subscribe(None);
        harness.fault("boom".into()).await;
        harness.fault("second".into()).await;
        let events = expect_events(&mut rx, 1).await;
        match &events[0].1 {
            HarnessEvent::Fault { code, message } => {
                assert_eq!(code, "harness_fault");
                assert_eq!(message, "boom");
            }
            other => panic!("unexpected event {other:?}"),
        }
        assert!(matches!(harness.lanes(), Err(LaneError::Closed(_, _))));
    }
}
