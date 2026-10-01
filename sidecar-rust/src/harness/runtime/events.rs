//! Port of pi `harness/agent-harness.ts` event vocabulary — `HarnessEvent`
//! and the lane queue item shape.
//!
//! Deviations from pi: `run_suspend` (deferred generation) is excluded with
//! the deferred feature, `message_update`'s durable `frame` stays raw JSON
//! until the generation procedure pins the frame type, and events are
//! delivered through a sync channel (no delivery backpressure) rather than
//! pi's awaited event listeners.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::harness::agent_types::{AgentMessage, AgentToolResult};
use crate::harness::compaction::CompactionSettings;
use crate::harness::session::types::{
    HarnessStreamOptionsSnapshot, InboxItemKind, OperationError, TerminalStatus, UsageRow,
};
use crate::harness::types::{AssistantMessageEvent, ThinkingLevel, Usage};

use super::types::{ModelIdentity, RetryPolicySnapshot};

/// One queued inbox item as observed by clients (pi `LaneQueuedItem`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum LaneQueuedItem {
    Message { entry_id: String, kind: InboxItemKind, message: AgentMessage },
    Custom {
        entry_id: String,
        kind: InboxItemKind,
        custom_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Json>,
    },
}

/// Why a compaction or branch summary ran.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StructuralReason {
    Manual,
    Threshold,
    Overflow,
}

/// Terminal outcome of a structural operation surfaced in end events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StructuralOutcome {
    Completed { entry_id: Option<String> },
    Declined,
    Aborted,
    Failed { error: OperationError },
}

/// `value_update` payload: durable named values clients can observe.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "value", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ValueUpdate {
    SessionName { name: Option<String> },
    EntryLabel { target_id: String, label: Option<String> },
}

/// Queue mode as it appears on the wire (pi uses "one-at-a-time").
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum QueueModeUpdate {
    All,
    #[serde(rename = "one-at-a-time")]
    OneAtATime,
}

/// `config_update` payload (pi `ConfigEventPayload`). The lane-scoped
/// properties (model/thinking level/active tools) carry the lane; the rest
/// are harness-global.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "property", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ConfigUpdateProperty {
    Model { value: ModelIdentity, previous: Json },
    ThinkingLevel { value: ThinkingLevel, previous: ThinkingLevel },
    ActiveTools { value: Vec<String>, previous: Vec<String> },
    Tools,
    Resources,
    StreamOptions { value: HarnessStreamOptionsSnapshot, previous: HarnessStreamOptionsSnapshot },
    RetryPolicy { value: RetryPolicySnapshot, previous: RetryPolicySnapshot },
    CompactionSettings { value: CompactionSettings, previous: CompactionSettings },
    SteeringMode { value: QueueModeUpdate, previous: QueueModeUpdate },
    FollowUpMode { value: QueueModeUpdate, previous: QueueModeUpdate },
}

/// `handler_error` payload: a hook or event listener failed; the harness
/// kept going.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum HandlerErrorSource {
    Hook { hook: String },
    Event { event: String },
}

/// One observation published by the harness (pi `HarnessEvent`). Lane-scoped
/// variants carry `lane` plus an optional `recovery` marker for replayed
/// events; `fault`, `value_update`, `lane_created`, and global config
/// updates do not.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum HarnessEvent {
    RunStart {
        lane: String,
        run_id: String,
        started_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    RunResume {
        lane: String,
        run_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    OperationAbort {
        lane: String,
        operation_id: String,
        steer: Vec<AgentMessage>,
        follow_up: Vec<AgentMessage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    RunEnd {
        lane: String,
        run_id: String,
        status: TerminalStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_tip_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tip_id: Option<String>,
        ended_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<OperationError>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    /// A lane-scoped config change (model / thinking level / active tools).
    ConfigUpdateLane {
        lane: String,
        property: ConfigUpdateProperty,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    /// A harness-global config change.
    ConfigUpdateGlobal { property: ConfigUpdateProperty },
    Fault { code: String, message: String },
    HandlerError {
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stack: Option<String>,
        source: HandlerErrorSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lane: Option<String>,
    },
    TurnStart {
        lane: String,
        run_id: String,
        turn_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    TurnEnd {
        lane: String,
        run_id: String,
        turn_id: String,
        message: AgentMessage,
        tool_results: Vec<AgentMessage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    RetryScheduled {
        lane: String,
        run_id: String,
        step: String,
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        not_before: u64,
        error_message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    RetryStart {
        lane: String,
        run_id: String,
        step: String,
        attempt: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    RetryEnd {
        lane: String,
        run_id: String,
        step: String,
        attempt: u32,
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        final_error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    MessageStart {
        lane: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        message: AgentMessage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    MessageUpdate {
        lane: String,
        run_id: String,
        message: AgentMessage,
        event: AssistantMessageEvent,
        /// Durable partial frame; typed by the generation procedure.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame: Option<Json>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    MessageEnd {
        lane: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        message: AgentMessage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    ToolStart {
        lane: String,
        run_id: String,
        turn_id: String,
        tool_call_id: String,
        tool_name: String,
        args: Json,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    ToolUpdate {
        lane: String,
        run_id: String,
        turn_id: String,
        tool_call_id: String,
        tool_name: String,
        partial_result: AgentToolResult,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    ToolEnd {
        lane: String,
        run_id: String,
        turn_id: String,
        tool_call_id: String,
        tool_name: String,
        result: AgentToolResult,
        is_error: bool,
        terminate: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    EntryAdded {
        lane: String,
        entry: crate::harness::session::types::Entry,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    QueueUpdate {
        lane: String,
        queues: Vec<LaneQueuedItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    ValueUpdate {
        #[serde(flatten)]
        value: ValueUpdate,
    },
    CompactionStart {
        lane: String,
        run_id: String,
        reason: StructuralReason,
        started_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    CompactionEnd {
        lane: String,
        run_id: String,
        reason: StructuralReason,
        outcome: StructuralOutcome,
        ended_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    NavigationStart {
        lane: String,
        run_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_id: Option<String>,
        started_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    NavigationEnd {
        lane: String,
        run_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_tip_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tip_id: Option<String>,
        outcome: StructuralOutcome,
        ended_at: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
    LaneCreated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
    },
    Usage {
        row: UsageRow,
        totals: Usage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery: Option<bool>,
    },
}

impl HarnessEvent {
    /// The wire `type` string (matches pi's event names).
    pub fn event_type(&self) -> &'static str {
        match self {
            HarnessEvent::RunStart { .. } => "run_start",
            HarnessEvent::RunResume { .. } => "run_resume",
            HarnessEvent::OperationAbort { .. } => "operation_abort",
            HarnessEvent::RunEnd { .. } => "run_end",
            HarnessEvent::ConfigUpdateLane { .. } | HarnessEvent::ConfigUpdateGlobal { .. } => "config_update",
            HarnessEvent::Fault { .. } => "fault",
            HarnessEvent::HandlerError { .. } => "handler_error",
            HarnessEvent::TurnStart { .. } => "turn_start",
            HarnessEvent::TurnEnd { .. } => "turn_end",
            HarnessEvent::RetryScheduled { .. } => "retry_scheduled",
            HarnessEvent::RetryStart { .. } => "retry_start",
            HarnessEvent::RetryEnd { .. } => "retry_end",
            HarnessEvent::MessageStart { .. } => "message_start",
            HarnessEvent::MessageUpdate { .. } => "message_update",
            HarnessEvent::MessageEnd { .. } => "message_end",
            HarnessEvent::ToolStart { .. } => "tool_start",
            HarnessEvent::ToolUpdate { .. } => "tool_update",
            HarnessEvent::ToolEnd { .. } => "tool_end",
            HarnessEvent::EntryAdded { .. } => "entry_added",
            HarnessEvent::QueueUpdate { .. } => "queue_update",
            HarnessEvent::ValueUpdate { .. } => "value_update",
            HarnessEvent::CompactionStart { .. } => "compaction_start",
            HarnessEvent::CompactionEnd { .. } => "compaction_end",
            HarnessEvent::NavigationStart { .. } => "navigation_start",
            HarnessEvent::NavigationEnd { .. } => "navigation_end",
            HarnessEvent::LaneCreated { .. } => "lane_created",
            HarnessEvent::Usage { .. } => "usage",
        }
    }

    /// The lane this event belongs to, if any.
    pub fn lane(&self) -> Option<&str> {
        match self {
            HarnessEvent::RunStart { lane, .. }
            | HarnessEvent::RunResume { lane, .. }
            | HarnessEvent::OperationAbort { lane, .. }
            | HarnessEvent::RunEnd { lane, .. }
            | HarnessEvent::ConfigUpdateLane { lane, .. }
            | HarnessEvent::TurnStart { lane, .. }
            | HarnessEvent::TurnEnd { lane, .. }
            | HarnessEvent::RetryScheduled { lane, .. }
            | HarnessEvent::RetryStart { lane, .. }
            | HarnessEvent::RetryEnd { lane, .. }
            | HarnessEvent::MessageStart { lane, .. }
            | HarnessEvent::MessageUpdate { lane, .. }
            | HarnessEvent::MessageEnd { lane, .. }
            | HarnessEvent::ToolStart { lane, .. }
            | HarnessEvent::ToolUpdate { lane, .. }
            | HarnessEvent::ToolEnd { lane, .. }
            | HarnessEvent::EntryAdded { lane, .. }
            | HarnessEvent::QueueUpdate { lane, .. }
            | HarnessEvent::CompactionStart { lane, .. }
            | HarnessEvent::CompactionEnd { lane, .. }
            | HarnessEvent::NavigationStart { lane, .. }
            | HarnessEvent::NavigationEnd { lane, .. } => Some(lane),
            HarnessEvent::HandlerError { lane, .. } => lane.as_deref(),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_pi_wire_names() {
        let event = HarnessEvent::RunStart {
            lane: "main".into(),
            run_id: "op1".into(),
            started_at: 42,
            recovery: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "run_start");
        assert_eq!(json["lane"], "main");
        assert_eq!(json["runId"], "op1");
        assert!(json.get("recovery").is_none());

        let event = HarnessEvent::ValueUpdate {
            value: ValueUpdate::SessionName { name: Some("chat".into()) },
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "value_update");
        assert_eq!(json["value"], "session_name");
        assert_eq!(json["name"], "chat");
    }

    #[test]
    fn compaction_end_outcome_is_nested_tagged() {
        let event = HarnessEvent::CompactionEnd {
            lane: "main".into(),
            run_id: "op2".into(),
            reason: StructuralReason::Threshold,
            outcome: StructuralOutcome::Completed { entry_id: Some("e1".into()) },
            ended_at: 7,
            recovery: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "compaction_end");
        assert_eq!(json["outcome"]["status"], "completed");
        assert_eq!(json["outcome"]["entryId"], "e1");
    }
}
