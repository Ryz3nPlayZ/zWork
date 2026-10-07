//! Port of pi `harness/hooks.ts` — the ordered hook registry and its
//! per-hook aggregation rules.
//!
//! Deviations from pi: handlers are synchronous (zWork's hooks are sync;
//! async hooks can arrive as `BoxFuture` handlers later if needed), and
//! `before_request` patch semantics collapse to whole-value replacement —
//! zWork owns a single stream-options knob, so there is nothing to patch
//! field-by-field. Fail-open vs fail-closed behavior, ordering, and
//! first/last-wins aggregation match pi exactly.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value as Json;

use crate::harness::agent_types::AgentMessage;
use crate::harness::types::Usage;

use super::effect_gate::{GateError, SharedGate};
use super::events::StructuralReason;
use super::types::{ModelIdentity, Resources};
use crate::harness::session::types::HarnessStreamOptionsSnapshot;

/// All 11 pi hook points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum HookName {
    BeforeRun,
    BeforeDrive,
    BeforeRunEnd,
    TransformContext,
    BeforeRequest,
    BeforePayload,
    AfterResponse,
    BeforeTool,
    AfterTool,
    BeforeCompaction,
    BeforeNavigation,
}

impl HookName {
    pub fn as_str(&self) -> &'static str {
        match self {
            HookName::BeforeRun => "before_run",
            HookName::BeforeDrive => "before_drive",
            HookName::BeforeRunEnd => "before_run_end",
            HookName::TransformContext => "transform_context",
            HookName::BeforeRequest => "before_request",
            HookName::BeforePayload => "before_payload",
            HookName::AfterResponse => "after_response",
            HookName::BeforeTool => "before_tool",
            HookName::AfterTool => "after_tool",
            HookName::BeforeCompaction => "before_compaction",
            HookName::BeforeNavigation => "before_navigation",
        }
    }
}

// ---------------------------------------------------------------------------
// Event and result payloads (pi `HookMap`)
// ---------------------------------------------------------------------------

/// Every hook invocation carries the lane and owning operation.
#[derive(Debug, Clone)]
pub struct HookContext {
    pub lane: String,
    pub run_id: String,
}

pub struct BeforeRunEvent {
    pub prompt: Vec<AgentMessage>,
    pub resources: Resources,
}

pub enum OperationKind {
    Run,
    Compaction,
    Navigation,
}

pub struct BeforeDriveEvent {
    pub operation: OperationKind,
}

pub struct BeforeRunEndEvent {
    pub messages: Vec<AgentMessage>,
}

pub struct TransformContextEvent {
    pub messages: Vec<AgentMessage>,
    pub system_prompt: String,
}

pub enum RequestStep {
    Assistant,
    Compaction,
    BranchSummary,
}

pub struct BeforeRequestEvent {
    pub model: ModelIdentity,
    pub step: RequestStep,
    pub attempt: u32,
    pub stream_options: HarnessStreamOptionsSnapshot,
}

pub struct BeforePayloadEvent {
    pub model: ModelIdentity,
    pub payload: Json,
}

pub struct AfterResponseEvent {
    pub status: Option<u16>,
    pub headers: Vec<(String, String)>,
    /// The settled assistant message.
    pub message: AgentMessage,
}

pub struct BeforeToolEvent {
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Json,
}

pub struct AfterToolEvent {
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Json,
    /// Tool result content (the LLM-visible part).
    pub content: Json,
    pub details: Option<Json>,
    pub is_error: bool,
    pub usage: Option<Usage>,
}

/// `before_compaction` preparation. Opaque until the durable structural
/// unit pins its typed shape (M6); handlers see the JSON projection.
pub struct BeforeCompactionEvent {
    pub reason: StructuralReason,
    pub preparation: Json,
    pub custom_instructions: Option<String>,
}

pub struct BeforeNavigationEvent {
    pub target_id: Option<String>,
    pub preparation: Json,
    pub custom_instructions: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BeforeRunResult {
    pub messages: Vec<AgentMessage>,
}

#[derive(Debug, Clone, Default)]
pub struct BeforeRunEndResult {
    /// Last hook offering a follow-up wins.
    pub follow_up: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TransformContextResult {
    pub messages: Option<Vec<AgentMessage>>,
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BeforeRequestResult {
    pub stream_options: Option<HarnessStreamOptionsSnapshot>,
}

#[derive(Debug, Clone)]
pub struct BeforePayloadResult {
    pub payload: Json,
}

#[derive(Debug, Clone)]
pub struct AfterResponseResult {
    pub message: AgentMessage,
}

#[derive(Debug, Clone, Default)]
pub struct ToolBlock {
    pub reason: String,
    pub terminate: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct BeforeToolResult {
    pub args: Option<Json>,
    pub block: Option<ToolBlock>,
}

#[derive(Debug, Clone, Default)]
pub struct AfterToolResult {
    pub content: Option<Json>,
    pub details: Option<Json>,
    pub is_error: Option<bool>,
    pub usage: Option<Usage>,
    pub terminate: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct BeforeCompactionResult {
    pub decline: bool,
    pub compaction: Option<Json>,
}

#[derive(Debug, Clone, Default)]
pub struct BeforeNavigationResult {
    pub decline: bool,
    pub summary: Option<Json>,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// Report delivered when a handler fails (pi `HookErrorReporter`); the
/// harness maps it to a `handler_error` event.
pub type HookErrorReporter = Arc<dyn Fn(&str, HookName, &str) + Send + Sync>;

type BeforeRunHandler = Arc<dyn Fn(&HookContext, &BeforeRunEvent) -> Result<Option<BeforeRunResult>, String> + Send + Sync>;
type BeforeDriveHandler = Arc<dyn Fn(&HookContext, &BeforeDriveEvent) -> Result<(), String> + Send + Sync>;
type BeforeRunEndHandler = Arc<dyn Fn(&HookContext, &BeforeRunEndEvent) -> Result<Option<BeforeRunEndResult>, String> + Send + Sync>;
type TransformContextHandler = Arc<dyn Fn(&HookContext, &TransformContextEvent) -> Result<Option<TransformContextResult>, String> + Send + Sync>;
type BeforeRequestHandler = Arc<dyn Fn(&HookContext, &BeforeRequestEvent) -> Result<Option<BeforeRequestResult>, String> + Send + Sync>;
type BeforePayloadHandler = Arc<dyn Fn(&HookContext, &BeforePayloadEvent) -> Result<Option<BeforePayloadResult>, String> + Send + Sync>;
type AfterResponseHandler = Arc<dyn Fn(&HookContext, &AfterResponseEvent) -> Result<Option<AfterResponseResult>, String> + Send + Sync>;
type BeforeToolHandler = Arc<dyn Fn(&HookContext, &BeforeToolEvent) -> Result<Option<BeforeToolResult>, String> + Send + Sync>;
type AfterToolHandler = Arc<dyn Fn(&HookContext, &AfterToolEvent) -> Result<Option<AfterToolResult>, String> + Send + Sync>;
type BeforeCompactionHandler = Arc<dyn Fn(&HookContext, &BeforeCompactionEvent) -> Result<Option<BeforeCompactionResult>, String> + Send + Sync>;
type BeforeNavigationHandler = Arc<dyn Fn(&HookContext, &BeforeNavigationEvent) -> Result<Option<BeforeNavigationResult>, String> + Send + Sync>;

/// One registered handler; ids are stable across removals.
#[derive(Clone)]
struct Registration<T> {
    id: u64,
    handler: T,
}

/// Ordered hook registry (pi `HookRegistry`). Registration methods return a
/// detach guard id usable with [`HookRegistry::remove`].
pub struct HookRegistry {
    next_id: AtomicU64,
    before_run: Mutex<Vec<Registration<BeforeRunHandler>>>,
    before_drive: Mutex<Vec<Registration<BeforeDriveHandler>>>,
    before_run_end: Mutex<Vec<Registration<BeforeRunEndHandler>>>,
    transform_context: Mutex<Vec<Registration<TransformContextHandler>>>,
    before_request: Mutex<Vec<Registration<BeforeRequestHandler>>>,
    before_payload: Mutex<Vec<Registration<BeforePayloadHandler>>>,
    after_response: Mutex<Vec<Registration<AfterResponseHandler>>>,
    before_tool: Mutex<Vec<Registration<BeforeToolHandler>>>,
    after_tool: Mutex<Vec<Registration<AfterToolHandler>>>,
    before_compaction: Mutex<Vec<Registration<BeforeCompactionHandler>>>,
    before_navigation: Mutex<Vec<Registration<BeforeNavigationHandler>>>,
    report_error: HookErrorReporter,
}

/// Admission outcome for a gate-run hook aggregate.
pub type HookGateResult<T> = Result<T, GateError>;

/// Fail-closed hook runs surface either gate admission failures or the
/// failing handler's error.
#[derive(Debug)]
pub enum HookFailure {
    Gate(GateError),
    Handler(String),
}

fn sink_error_reporter() -> HookErrorReporter {
    Arc::new(|_message: &str, _hook: HookName, _lane: &str| {})
}

impl HookRegistry {
    pub fn new() -> Self {
        HookRegistry::with_error_reporter(sink_error_reporter())
    }

    pub fn with_error_reporter(report_error: HookErrorReporter) -> Self {
        HookRegistry {
            next_id: AtomicU64::new(1),
            before_run: Mutex::new(Vec::new()),
            before_drive: Mutex::new(Vec::new()),
            before_run_end: Mutex::new(Vec::new()),
            transform_context: Mutex::new(Vec::new()),
            before_request: Mutex::new(Vec::new()),
            before_payload: Mutex::new(Vec::new()),
            after_response: Mutex::new(Vec::new()),
            before_tool: Mutex::new(Vec::new()),
            after_tool: Mutex::new(Vec::new()),
            before_compaction: Mutex::new(Vec::new()),
            before_navigation: Mutex::new(Vec::new()),
            report_error,
        }
    }

    fn allocate_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Remove one registration. pi returns an unsubscribe closure; ids play
    /// that role here.
    pub fn remove(&self, id: u64) {
        fn drop_matching<T>(slot: &Mutex<Vec<Registration<T>>>, id: u64) {
            slot.lock().unwrap().retain(|r| r.id != id);
        }
        drop_matching(&self.before_run, id);
        drop_matching(&self.before_drive, id);
        drop_matching(&self.before_run_end, id);
        drop_matching(&self.transform_context, id);
        drop_matching(&self.before_request, id);
        drop_matching(&self.before_payload, id);
        drop_matching(&self.after_response, id);
        drop_matching(&self.before_tool, id);
        drop_matching(&self.after_tool, id);
        drop_matching(&self.before_compaction, id);
        drop_matching(&self.before_navigation, id);
    }

    pub fn has(&self, name: HookName) -> bool {
        fn slot_len<T>(slot: &Mutex<Vec<Registration<T>>>) -> usize {
            slot.lock().unwrap().len()
        }
        let len = match name {
            HookName::BeforeRun => slot_len(&self.before_run),
            HookName::BeforeDrive => slot_len(&self.before_drive),
            HookName::BeforeRunEnd => slot_len(&self.before_run_end),
            HookName::TransformContext => slot_len(&self.transform_context),
            HookName::BeforeRequest => slot_len(&self.before_request),
            HookName::BeforePayload => slot_len(&self.before_payload),
            HookName::AfterResponse => slot_len(&self.after_response),
            HookName::BeforeTool => slot_len(&self.before_tool),
            HookName::AfterTool => slot_len(&self.after_tool),
            HookName::BeforeCompaction => slot_len(&self.before_compaction),
            HookName::BeforeNavigation => slot_len(&self.before_navigation),
        };
        len != 0
    }

    fn report(&self, error: &str, hook: HookName, ctx: &HookContext) {
        (self.report_error)(error, hook, &ctx.lane);
    }

    // -- registration --

    pub fn on_before_run(&self, handler: BeforeRunHandler) -> u64 {
        let id = self.allocate_id();
        self.before_run.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_before_drive(&self, handler: BeforeDriveHandler) -> u64 {
        let id = self.allocate_id();
        self.before_drive.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_before_run_end(&self, handler: BeforeRunEndHandler) -> u64 {
        let id = self.allocate_id();
        self.before_run_end.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_transform_context(&self, handler: TransformContextHandler) -> u64 {
        let id = self.allocate_id();
        self.transform_context.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_before_request(&self, handler: BeforeRequestHandler) -> u64 {
        let id = self.allocate_id();
        self.before_request.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_before_payload(&self, handler: BeforePayloadHandler) -> u64 {
        let id = self.allocate_id();
        self.before_payload.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_after_response(&self, handler: AfterResponseHandler) -> u64 {
        let id = self.allocate_id();
        self.after_response.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_before_tool(&self, handler: BeforeToolHandler) -> u64 {
        let id = self.allocate_id();
        self.before_tool.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_after_tool(&self, handler: AfterToolHandler) -> u64 {
        let id = self.allocate_id();
        self.after_tool.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_before_compaction(&self, handler: BeforeCompactionHandler) -> u64 {
        let id = self.allocate_id();
        self.before_compaction.lock().unwrap().push(Registration { id, handler });
        id
    }

    pub fn on_before_navigation(&self, handler: BeforeNavigationHandler) -> u64 {
        let id = self.allocate_id();
        self.before_navigation.lock().unwrap().push(Registration { id, handler });
        id
    }

    // -- gated aggregates --

    /// Inject messages ahead of a run. Handlers chain: each sees the
    /// accumulated prompt; injected messages accumulate. Fail-open.
    pub fn run_before_run_with_gate(
        &self,
        ctx: &HookContext,
        event: &BeforeRunEvent,
        gate: &SharedGate,
    ) -> HookGateResult<Option<BeforeRunResult>> {
        gate.admit(|| {
            let registrations = self.before_run.lock().unwrap().clone();
            let mut prompt = event.prompt.clone();
            let mut injected: Vec<AgentMessage> = Vec::new();
            for registration in &registrations {
                let chained = BeforeRunEvent { prompt: prompt.clone(), resources: event.resources.clone() };
                match (registration.handler)(ctx, &chained) {
                    Ok(Some(result)) => {
                        injected.extend(result.messages.iter().cloned());
                        prompt.extend(result.messages.iter().cloned());
                    }
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::BeforeRun, ctx),
                }
            }
            (!injected.is_empty()).then(|| BeforeRunResult { messages: injected })
        })
    }

    /// Fail-closed: the first failing handler aborts the drive pass.
    pub fn run_before_drive_with_gate(
        &self,
        ctx: &HookContext,
        event: &BeforeDriveEvent,
        gate: &SharedGate,
    ) -> Result<(), HookFailure> {
        gate.admit(|| {
            let registrations = self.before_drive.lock().unwrap().clone();
            for registration in &registrations {
                if let Err(error) = (registration.handler)(ctx, event) {
                    self.report(&error, HookName::BeforeDrive, ctx);
                    return Err(error);
                }
            }
            Ok(())
        })
        .map_err(HookFailure::Gate)
        .and_then(|outcome| outcome.map_err(HookFailure::Handler))
    }

    /// Offer a follow-up at run end; the last defined follow-up wins.
    /// Fail-open.
    pub fn run_before_run_end_with_gate(
        &self,
        ctx: &HookContext,
        event: &BeforeRunEndEvent,
        gate: &SharedGate,
    ) -> HookGateResult<Option<BeforeRunEndResult>> {
        gate.admit(|| {
            let registrations = self.before_run_end.lock().unwrap().clone();
            let mut follow_up = None;
            for registration in &registrations {
                match (registration.handler)(ctx, event) {
                    Ok(Some(result)) => {
                        if result.follow_up.is_some() {
                            follow_up = result.follow_up;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::BeforeRunEnd, ctx),
                }
            }
            follow_up.map(|follow_up| BeforeRunEndResult { follow_up: Some(follow_up) })
        })
    }

    /// Chain context and system prompt transforms. Fail-open.
    pub fn run_transform_context_with_gate(
        &self,
        ctx: &HookContext,
        event: &TransformContextEvent,
        gate: &SharedGate,
    ) -> HookGateResult<TransformContextResult> {
        gate.admit(|| {
            let registrations = self.transform_context.lock().unwrap().clone();
            let mut messages = event.messages.clone();
            let mut system_prompt = event.system_prompt.clone();
            for registration in &registrations {
                let chained = TransformContextEvent {
                    messages: messages.clone(),
                    system_prompt: system_prompt.clone(),
                };
                match (registration.handler)(ctx, &chained) {
                    Ok(Some(result)) => {
                        if let Some(next) = result.messages {
                            messages = next;
                        }
                        if let Some(next) = result.system_prompt {
                            system_prompt = next;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::TransformContext, ctx),
                }
            }
            TransformContextResult {
                messages: Some(messages),
                system_prompt: Some(system_prompt),
            }
        })
    }

    /// Adjust stream options per request. Replacement semantics (see module
    /// docs). Fail-open.
    pub fn run_before_request_with_gate(
        &self,
        ctx: &HookContext,
        event: &BeforeRequestEvent,
        gate: &SharedGate,
    ) -> HookGateResult<Option<BeforeRequestResult>> {
        gate.admit(|| {
            let registrations = self.before_request.lock().unwrap().clone();
            let mut stream_options = event.stream_options.clone();
            let mut changed = false;
            for registration in &registrations {
                let chained = BeforeRequestEvent { stream_options: stream_options.clone(), ..same_request_event(event) };
                match (registration.handler)(ctx, &chained) {
                    Ok(Some(result)) => {
                        if let Some(next) = result.stream_options {
                            stream_options = next;
                            changed = true;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::BeforeRequest, ctx),
                }
            }
            changed.then(|| BeforeRequestResult { stream_options: Some(stream_options) })
        })
    }

    /// Rewrite the outgoing provider payload. Fail-open; last write wins.
    pub fn run_before_payload_with_gate(
        &self,
        ctx: &HookContext,
        event: &BeforePayloadEvent,
        gate: &SharedGate,
    ) -> HookGateResult<BeforePayloadResult> {
        gate.admit(|| {
            let registrations = self.before_payload.lock().unwrap().clone();
            let mut payload = event.payload.clone();
            for registration in &registrations {
                let chained = BeforePayloadEvent { payload: payload.clone(), ..same_payload_event(event) };
                match (registration.handler)(ctx, &chained) {
                    Ok(Some(result)) => payload = result.payload,
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::BeforePayload, ctx),
                }
            }
            BeforePayloadResult { payload }
        })
    }

    /// Observe or rewrite a settled assistant response. Fail-open.
    pub fn run_after_response_with_gate(
        &self,
        ctx: &HookContext,
        event: &AfterResponseEvent,
        gate: &SharedGate,
    ) -> HookGateResult<AfterResponseResult> {
        gate.admit(|| {
            let registrations = self.after_response.lock().unwrap().clone();
            let mut message = event.message.clone();
            for registration in &registrations {
                let chained = AfterResponseEvent { message: message.clone(), ..same_response_event(event) };
                match (registration.handler)(ctx, &chained) {
                    Ok(Some(result)) => message = result.message,
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::AfterResponse, ctx),
                }
            }
            AfterResponseResult { message }
        })
    }

    /// Rewrite arguments or block a tool call: the first block wins, and a
    /// failing handler blocks with its error message.
    pub fn run_before_tool_with_gate(
        &self,
        ctx: &HookContext,
        event: &BeforeToolEvent,
        gate: &SharedGate,
    ) -> HookGateResult<BeforeToolResult> {
        gate.admit(|| {
            let registrations = self.before_tool.lock().unwrap().clone();
            let mut args = event.args.clone();
            let mut block: Option<ToolBlock> = None;
            for registration in &registrations {
                let chained = BeforeToolEvent { args: args.clone(), ..same_tool_event(event) };
                match (registration.handler)(ctx, &chained) {
                    Ok(Some(result)) => {
                        if let Some(next) = result.args {
                            args = next;
                        }
                        if let Some(b) = result.block {
                            block = Some(b);
                            break;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        self.report(&error, HookName::BeforeTool, ctx);
                        block = Some(ToolBlock { reason: error, terminate: None });
                        break;
                    }
                }
            }
            let args_changed = args != event.args;
            BeforeToolResult { args: args_changed.then_some(args), block }
        })
    }

    /// Amend a settled tool result: each set field overrides; any set field
    /// makes the aggregate. Fail-open.
    pub fn run_after_tool_with_gate(
        &self,
        ctx: &HookContext,
        event: &AfterToolEvent,
        gate: &SharedGate,
    ) -> HookGateResult<Option<AfterToolResult>> {
        gate.admit(|| {
            let registrations = self.after_tool.lock().unwrap().clone();
            let mut aggregate = AfterToolResult::default();
            let mut content = event.content.clone();
            let mut details = event.details.clone();
            let mut is_error = event.is_error;
            let mut usage = event.usage.clone();
            for registration in &registrations {
                let chained = AfterToolEvent {
                    content: content.clone(),
                    details: details.clone(),
                    is_error,
                    usage: usage.clone(),
                    ..same_after_tool_event(event)
                };
                match (registration.handler)(ctx, &chained) {
                    Ok(Some(result)) => {
                        if let Some(next) = result.content {
                            aggregate.content = Some(next.clone());
                            content = next;
                        }
                        if let Some(next) = result.details {
                            aggregate.details = Some(next.clone());
                            details = Some(next);
                        }
                        if let Some(next) = result.is_error {
                            aggregate.is_error = Some(next);
                            is_error = next;
                        }
                        if let Some(next) = result.usage {
                            aggregate.usage = Some(next.clone());
                            usage = Some(next);
                        }
                        if let Some(next) = result.terminate {
                            aggregate.terminate = Some(next);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::AfterTool, ctx),
                }
            }
            let set = aggregate.content.is_some()
                || aggregate.details.is_some()
                || aggregate.is_error.is_some()
                || aggregate.usage.is_some()
                || aggregate.terminate.is_some();
            set.then_some(aggregate)
        })
    }

    /// First structural decision wins: decline or a prepared result.
    /// Decline plus a result is invalid and skipped. Fail-open.
    pub fn run_before_compaction_with_gate(
        &self,
        ctx: &HookContext,
        event: &BeforeCompactionEvent,
        gate: &SharedGate,
    ) -> HookGateResult<Option<BeforeCompactionResult>> {
        gate.admit(|| {
            let registrations = self.before_compaction.lock().unwrap().clone();
            for registration in &registrations {
                match (registration.handler)(ctx, event) {
                    Ok(Some(result)) => {
                        if result.decline && result.compaction.is_some() {
                            self.report(
                                "before_compaction hook cannot return both decline and compaction",
                                HookName::BeforeCompaction,
                                ctx,
                            );
                            continue;
                        }
                        if result.decline || result.compaction.is_some() {
                            return Some(result);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::BeforeCompaction, ctx),
                }
            }
            None
        })
    }

    pub fn run_before_navigation_with_gate(
        &self,
        ctx: &HookContext,
        event: &BeforeNavigationEvent,
        gate: &SharedGate,
    ) -> HookGateResult<Option<BeforeNavigationResult>> {
        gate.admit(|| {
            let registrations = self.before_navigation.lock().unwrap().clone();
            for registration in &registrations {
                match (registration.handler)(ctx, event) {
                    Ok(Some(result)) => {
                        if result.decline && result.summary.is_some() {
                            self.report(
                                "before_navigation hook cannot return both decline and summary",
                                HookName::BeforeNavigation,
                                ctx,
                            );
                            continue;
                        }
                        if result.decline || result.summary.is_some() {
                            return Some(result);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => self.report(&error, HookName::BeforeNavigation, ctx),
                }
            }
            None
        })
    }
}

fn same_request_event(event: &BeforeRequestEvent) -> BeforeRequestEvent {
    BeforeRequestEvent {
        model: event.model.clone(),
        step: match event.step {
            RequestStep::Assistant => RequestStep::Assistant,
            RequestStep::Compaction => RequestStep::Compaction,
            RequestStep::BranchSummary => RequestStep::BranchSummary,
        },
        attempt: event.attempt,
        stream_options: event.stream_options.clone(),
    }
}

fn same_payload_event(event: &BeforePayloadEvent) -> BeforePayloadEvent {
    BeforePayloadEvent { model: event.model.clone(), payload: event.payload.clone() }
}

fn same_response_event(event: &AfterResponseEvent) -> AfterResponseEvent {
    AfterResponseEvent {
        status: event.status,
        headers: event.headers.clone(),
        message: event.message.clone(),
    }
}

fn same_tool_event(event: &BeforeToolEvent) -> BeforeToolEvent {
    BeforeToolEvent {
        tool_call_id: event.tool_call_id.clone(),
        tool_name: event.tool_name.clone(),
        args: event.args.clone(),
    }
}

fn same_after_tool_event(event: &AfterToolEvent) -> AfterToolEvent {
    AfterToolEvent {
        tool_call_id: event.tool_call_id.clone(),
        tool_name: event.tool_name.clone(),
        args: event.args.clone(),
        content: event.content.clone(),
        details: event.details.clone(),
        is_error: event.is_error,
        usage: event.usage.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn gate() -> SharedGate {
        Arc::new(super::super::effect_gate::EffectGate::new())
    }

    fn ctx() -> HookContext {
        HookContext { lane: "main".into(), run_id: "op1".into() }
    }

    #[test]
    fn before_run_accumulates_injections_across_handlers() {
        let errors = Arc::new(StdMutex::new(Vec::new()));
        let sink = {
            let errors = Arc::clone(&errors);
            Arc::new(move |message: &str, _hook: HookName, _lane: &str| {
                errors.lock().unwrap().push(message.to_string());
            })
        };
        let reporting = HookRegistry::with_error_reporter(sink);
        reporting.on_before_run(Arc::new(|_ctx, _event| {
            Ok(Some(BeforeRunResult { messages: vec![AgentMessage::user_text("one")] }))
        }));
        reporting.on_before_run(Arc::new(|_ctx, _event| Err("boom".into())));
        reporting.on_before_run(Arc::new(|_ctx, _event| {
            Ok(Some(BeforeRunResult { messages: vec![AgentMessage::user_text("two")] }))
        }));

        let result = reporting
            .run_before_run_with_gate(
                &ctx(),
                &BeforeRunEvent { prompt: vec![AgentMessage::user_text("prompt")], resources: Resources::default() },
                &gate(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(result.messages.len(), 2);
        assert_eq!(errors.lock().unwrap().as_slice(), ["boom"]);
    }

    #[test]
    fn before_drive_is_fail_closed() {
        let registry = HookRegistry::new();
        registry.on_before_drive(Arc::new(|_ctx, _event| Err("no".into())));
        let error = registry
            .run_before_drive_with_gate(&ctx(), &BeforeDriveEvent { operation: OperationKind::Run }, &gate())
            .unwrap_err();
        assert!(matches!(error, HookFailure::Handler(ref message) if message == "no"));
    }

    #[test]
    fn before_run_end_last_follow_up_wins() {
        let registry = HookRegistry::new();
        registry.on_before_run_end(Arc::new(|_ctx, _event| {
            Ok(Some(BeforeRunEndResult { follow_up: Some("first".into()) }))
        }));
        registry.on_before_run_end(Arc::new(|_ctx, _event| Ok(None)));
        registry.on_before_run_end(Arc::new(|_ctx, _event| {
            Ok(Some(BeforeRunEndResult { follow_up: Some("second".into()) }))
        }));

        let result = registry
            .run_before_run_end_with_gate(&ctx(), &BeforeRunEndEvent { messages: vec![] }, &gate())
            .unwrap()
            .unwrap();
        assert_eq!(result.follow_up.as_deref(), Some("second"));
    }

    #[test]
    fn before_tool_first_block_wins_and_errors_block() {
        let registry = HookRegistry::new();
        registry.on_before_tool(Arc::new(|_ctx, _event| Ok(None)));
        registry.on_before_tool(Arc::new(|_ctx, _event| {
            Ok(Some(BeforeToolResult { args: None, block: Some(ToolBlock { reason: "not allowed".into(), terminate: Some(true) }) }))
        }));
        // Never reached: the block above breaks the chain.
        registry.on_before_tool(Arc::new(|_ctx, _event| {
            panic!("must not run after a block");
        }));

        let result = registry
            .run_before_tool_with_gate(
                &ctx(),
                &BeforeToolEvent { tool_call_id: "t1".into(), tool_name: "bash".into(), args: serde_json::json!({}) },
                &gate(),
            )
            .unwrap();
        assert_eq!(result.block.as_ref().unwrap().reason, "not allowed");
        assert_eq!(result.block.as_ref().unwrap().terminate, Some(true));

        let failing = HookRegistry::new();
        failing.on_before_tool(Arc::new(|_ctx, _event| Err("kaput".into())));
        let result = failing
            .run_before_tool_with_gate(
                &ctx(),
                &BeforeToolEvent { tool_call_id: "t1".into(), tool_name: "bash".into(), args: serde_json::json!({}) },
                &gate(),
            )
            .unwrap();
        assert_eq!(result.block.as_ref().unwrap().reason, "kaput");
    }

    #[test]
    fn transform_context_chains_fail_open() {
        let registry = HookRegistry::new();
        registry.on_transform_context(Arc::new(|_ctx, _event| {
            Ok(Some(TransformContextResult {
                messages: Some(vec![AgentMessage::user_text("swapped")]),
                system_prompt: None,
            }))
        }));
        registry.on_transform_context(Arc::new(|_ctx, _event| Err("ignored".into())));
        registry.on_transform_context(Arc::new(|_ctx, event| {
            Ok(Some(TransformContextResult {
                messages: None,
                system_prompt: Some(format!("{}+extra", event.system_prompt)),
            }))
        }));

        let result = registry
            .run_transform_context_with_gate(
                &ctx(),
                &TransformContextEvent { messages: vec![AgentMessage::user_text("prompt")], system_prompt: "base".into() },
                &gate(),
            )
            .unwrap();
        assert_eq!(result.messages.unwrap(), vec![AgentMessage::user_text("swapped")]);
        assert_eq!(result.system_prompt.unwrap(), "base+extra");
    }

    #[test]
    fn structural_hooks_first_decision_wins() {
        let registry = HookRegistry::new();
        registry.on_before_compaction(Arc::new(|_ctx, _event| Ok(None)));
        registry.on_before_compaction(Arc::new(|_ctx, _event| {
            Ok(Some(BeforeCompactionResult { decline: true, compaction: None }))
        }));
        registry.on_before_compaction(Arc::new(|_ctx, _event| {
            panic!("a decline already won");
        }));
        let result = registry
            .run_before_compaction_with_gate(
                &ctx(),
                &BeforeCompactionEvent {
                    reason: StructuralReason::Manual,
                    preparation: serde_json::json!({}),
                    custom_instructions: None,
                },
                &gate(),
            )
            .unwrap()
            .unwrap();
        assert!(result.decline);
    }

    #[test]
    fn gated_aggregates_honor_abort() {
        let registry = HookRegistry::new();
        let g = gate();
        g.begin_abort();
        let error = registry
            .run_before_run_with_gate(
                &ctx(),
                &BeforeRunEvent { prompt: vec![], resources: Resources::default() },
                &g,
            )
            .unwrap_err();
        assert!(matches!(error, GateError::AbortRequested));
    }
}
