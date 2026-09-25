//! Live-run state addressable by chat: the run registry (the harness event
//! bus and lane behind a live turn, for SSE re-attach after a dropped
//! stream) and the permission-gate registry (polling, so a re-attached UI
//! can still answer a destructive-action prompt instead of eating the
//! silent 10-minute auto-deny).
//!
//! The run registry also gives Stop a durable path: `request_stop` records
//! `CancelRequested` on the open operation, so a killed task reconciles as
//! cancelled at startup instead of auto-resuming.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::harness::runtime::events::HarnessEvent;
use crate::harness::runtime::harness::HarnessEventBus;
use crate::harness::runtime::lane::Lane;
use crate::sync_util::Unpoison;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

/// The live harness behind a chat's current turn (or startup recovery).
#[derive(Clone)]
pub struct LiveRun {
    pub run_id: String,
    pub session_id: String,
    pub bus: Arc<HarnessEventBus>,
    pub lane: Arc<Lane>,
    pub started_at: u64,
}

fn runs() -> &'static Mutex<HashMap<String, LiveRun>> {
    static RUNS: OnceLock<Mutex<HashMap<String, LiveRun>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register (or replace) the chat's live run. An overflow-retry attempt
/// supersedes its predecessor's entry; the predecessor's unregister is a
/// no-op because its session no longer matches.
pub fn register_run(chat_id: &str, run: LiveRun) {
    runs().lock_unpoisoned().insert(chat_id.to_string(), run);
}

/// Register only when the chat has no live run — startup recovery racing a
/// fresh user turn must not steal the registry slot from the user's turn.
pub fn try_register_run(chat_id: &str, run: LiveRun) -> bool {
    let mut map = runs().lock_unpoisoned();
    if map.contains_key(chat_id) {
        return false;
    }
    map.insert(chat_id.to_string(), run);
    true
}

/// Remove the chat's entry, but only if it still points at `session_id` —
/// otherwise a superseding attempt would be unregistered by its
/// predecessor's cleanup.
pub fn unregister_run(chat_id: &str, session_id: &str) {
    let mut map = runs().lock_unpoisoned();
    if map.get(chat_id).map(|r| r.session_id.as_str()) == Some(session_id) {
        map.remove(chat_id);
    }
}

pub fn live_run(chat_id: &str) -> Option<LiveRun> {
    runs().lock_unpoisoned().get(chat_id).cloned()
}

/// Durable stop: record `CancelRequested` on the open operation so the run
/// reconciles as cancelled (never resumes) even if the task is killed
/// before it settles. Returns whether an abort was requested.
pub async fn request_stop(chat_id: &str) -> bool {
    let Some(run) = live_run(chat_id) else { return false };
    match run.lane.current_operation_id() {
        Ok(Some(operation_id)) => run.lane.request_operation_abort(&operation_id).await.is_ok(),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Permission-gate registry
// ---------------------------------------------------------------------------

/// Just past the tool-side 10-minute gate timeout: entries older than this
/// can never be answered (the tool already auto-denied), so listing prunes
/// them instead of showing ghosts.
const GATE_STALE_MS: u64 = 11 * 60 * 1000;

struct GateEntry {
    chat_id: String,
    tool: String,
    reason: String,
    tool_use_id: String,
    created_at: u64,
    tx: oneshot::Sender<bool>,
}

fn gates() -> &'static Mutex<HashMap<String, GateEntry>> {
    static GATES: OnceLock<Mutex<HashMap<String, GateEntry>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Open a permission gate and return its id plus the answer receiver.
pub fn open_gate(
    chat_id: &str,
    tool: &str,
    reason: &str,
    tool_use_id: &str,
) -> (String, oneshot::Receiver<bool>) {
    prune_stale_gates();
    let gate_id = format!("gate_{}", uuid::Uuid::new_v4().simple());
    let (tx, rx) = oneshot::channel();
    gates().lock_unpoisoned().insert(
        gate_id.clone(),
        GateEntry {
            chat_id: chat_id.to_string(),
            tool: tool.to_string(),
            reason: reason.to_string(),
            tool_use_id: tool_use_id.to_string(),
            created_at: now_ms(),
            tx,
        },
    );
    (gate_id, rx)
}

/// Deliver the user's answer (approve/reject endpoint). False when the gate
/// is unknown or already resolved.
pub fn resolve_gate(gate_id: &str, approved: bool) -> bool {
    prune_stale_gates();
    match gates().lock_unpoisoned().remove(gate_id) {
        Some(entry) => entry.tx.send(approved).is_ok(),
        None => false,
    }
}

/// Remove a gate without answering (the tool side gave up: timeout, dropped
/// receiver, aborted run).
pub fn drop_gate(gate_id: &str) {
    gates().lock_unpoisoned().remove(gate_id);
}

/// Snapshot of a chat's unanswered gates for polling.
pub fn chat_gates(chat_id: &str) -> Vec<Value> {
    prune_stale_gates();
    gates()
        .lock_unpoisoned()
        .iter()
        .filter(|(_, g)| g.chat_id == chat_id)
        .map(|(gate_id, g)| {
            json!({
                "gate_id": gate_id,
                "tool": g.tool,
                "reason": g.reason,
                "tool_use_id": g.tool_use_id,
                "created_at": g.created_at,
            })
        })
        .collect()
}

fn prune_stale_gates() {
    let cutoff = now_ms().saturating_sub(GATE_STALE_MS);
    gates().lock_unpoisoned().retain(|_, g| g.created_at > cutoff);
}

// ---------------------------------------------------------------------------
// Re-attach projection
// ---------------------------------------------------------------------------

/// Stateless projection of one harness event onto the zWork wire — the same
/// event shapes the live mapper emits, minus every side effect (the live
/// mapper already persists text, traces and usage; re-attach is read-only).
pub fn project_harness_event(event: &HarnessEvent) -> Option<Value> {
    use crate::harness::types::AssistantMessageEvent;
    match event {
        HarnessEvent::TurnStart { .. } => Some(json!({ "type": "status", "text": "Thinking" })),
        HarnessEvent::MessageUpdate { event, .. } => match event {
            AssistantMessageEvent::TextDelta { delta, .. } if !delta.is_empty() => {
                Some(json!({ "type": "delta", "text": delta }))
            }
            AssistantMessageEvent::ThinkingDelta { delta, .. } if !delta.is_empty() => {
                Some(json!({ "type": "thinking_delta", "text": delta }))
            }
            AssistantMessageEvent::ThinkingEnd { .. } => Some(json!({ "type": "thinking_end" })),
            AssistantMessageEvent::ToolcallEnd { tool_call, .. } => Some(json!({
                "type": "tool_use",
                "id": tool_call.id,
                "name": tool_call.name,
                "input": tool_call.arguments
            })),
            _ => None,
        },
        HarnessEvent::ToolEnd { tool_call_id, tool_name, result, is_error, .. } => Some(json!({
            "type": "tool_result",
            "tool": tool_name,
            "ok": !is_error,
            "message": result.text_content(),
            "tool_use_id": tool_call_id
        })),
        HarnessEvent::Usage { totals, .. } => Some(json!({
            "type": "usage",
            "prompt_tokens": totals.input + totals.cache_read + totals.cache_write,
            "completion_tokens": totals.output,
            "total_tokens": totals.total_tokens,
            "cost_usd": totals.cost.total,
            "cache_read_tokens": totals.cache_read,
            "cache_write_tokens": totals.cache_write,
        })),
        HarnessEvent::RunEnd { status, .. } => Some(json!({
            "type": "done",
            "status": status,
        })),
        _ => None,
    }
}

/// SSE body for `GET /api/chats/:id/run/live`: a `run_state` header (with
/// the bus cursor, so the client can re-attach from where it got off),
/// then either the live projection until the run ends, or a single
/// not-live event.
pub fn attach_or_idle(
    chat_id: &str,
    cursor: Option<u64>,
) -> Pin<Box<dyn futures_util::Stream<Item = Value> + Send>> {
    use tokio_stream::wrappers::ReceiverStream;

    let Some(run) = live_run(chat_id) else {
        return Box::pin(futures_util::stream::iter(vec![json!({
            "type": "run_state", "live": false
        })]));
    };
    let header = json!({
        "type": "run_state",
        "live": true,
        "run_id": run.run_id,
        "cursor": run.bus.latest_seq(),
        "started_at": run.started_at,
    });
    let mut events = run.bus.subscribe(cursor);
    let (tx, rx) = tokio::sync::mpsc::channel::<Value>(64);
    tokio::spawn(async move {
        if tx.send(header).await.is_err() {
            return;
        }
        while let Some((_seq, event)) = events.recv().await {
            let ended = matches!(event, HarnessEvent::RunEnd { .. });
            if let Some(wire) = project_harness_event(&event) {
                if tx.send(wire).await.is_err() {
                    break;
                }
            }
            if ended {
                break;
            }
        }
    });
    Box::pin(ReceiverStream::new(rx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::agent_types::AgentMessage;
    use crate::harness::session::memory::MemoryStorage;
    use crate::harness::session::types::TerminalStatus;
    use crate::harness::session::SessionMetadata;
    use crate::harness::types::{AssistantMessage, AssistantMessageEvent, Message, Usage};

    fn default_model() -> crate::harness::types::Model {
        crate::harness::test_support::default_model()
    }

    fn text_delta(delta: &str) -> HarnessEvent {
        let mut message = AssistantMessage::pending(&default_model());
        message.content.push(crate::harness::types::AssistantContent::Text(
            crate::harness::types::TextContent { text: String::new(), text_signature: None },
        ));
        HarnessEvent::MessageUpdate {
            lane: "main".into(),
            run_id: "r".into(),
            message: AgentMessage::Llm(Message::Assistant(message)),
            event: AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: delta.to_string(),
                partial: AssistantMessage::pending(&default_model()),
            },
            frame: None,
            recovery: None,
        }
    }

    fn tool_end() -> HarnessEvent {
        HarnessEvent::ToolEnd {
            lane: "main".into(),
            run_id: "r".into(),
            turn_id: "t".into(),
            tool_call_id: "tc1".into(),
            tool_name: "bash".into(),
            result: crate::harness::agent_types::AgentToolResult::text("done"),
            is_error: false,
            terminate: false,
            recovery: None,
        }
    }

    fn run_end() -> HarnessEvent {
        HarnessEvent::RunEnd {
            lane: "main".into(),
            run_id: "r".into(),
            status: TerminalStatus::Completed,
            from_tip_id: None,
            tip_id: None,
            ended_at: 0,
            error: None,
            recovery: None,
        }
    }

    async fn test_lane() -> Arc<Lane> {
        use crate::harness::runtime::harness::{Harness, HarnessOptions};
        let storage = Arc::new(MemoryStorage::new());
        let session = crate::harness::session::session::Session::new(
            SessionMetadata {
                id: format!("s{}", uuid::Uuid::new_v4().simple()),
                created_at: 0,
                storage_version: 1,
                cwd: None,
                parent_session_id: None,
            },
            storage,
        );
        let (harness, _open) = Harness::create(
            session,
            HarnessOptions {
                provider: "p".into(),
                model_id: "m".into(),
                thinking_level: crate::harness::types::ThinkingLevel::Off,
                active_tool_names: vec![],
                config: crate::harness::runtime::types::RuntimeConfig::default(),
            },
        )
        .unwrap();
        harness.lane("main").await.unwrap()
    }

    #[test]
    fn projection_covers_wire_shapes() {
        let delta = project_harness_event(&text_delta("hello")).unwrap();
        assert_eq!(delta["type"], "delta");
        assert_eq!(delta["text"], "hello");

        let result = project_harness_event(&tool_end()).unwrap();
        assert_eq!(result["type"], "tool_result");
        assert_eq!(result["ok"], true);
        assert_eq!(result["message"], "done");

        let done = project_harness_event(&run_end()).unwrap();
        assert_eq!(done["type"], "done");

        // Empty deltas (the live mapper drops them) and quiet events
        // project to nothing.
        assert!(project_harness_event(&text_delta("")).is_none());
        assert!(project_harness_event(&HarnessEvent::TurnEnd {
            lane: "main".into(),
            run_id: "r".into(),
            turn_id: "t".into(),
            message: AgentMessage::user_text("x"),
            tool_results: vec![],
            recovery: None,
        })
        .is_none());
    }

    #[tokio::test]
    async fn attach_replays_from_cursor_and_ends_on_run_end() {
        use futures_util::StreamExt;

        let lane = test_lane().await;
        let (event_bus, tx) = HarnessEventBus::new();
        tx.send(text_delta("one")).unwrap();
        tx.send(text_delta("two")).unwrap();
        tx.send(text_delta("three")).unwrap();
        register_run(
            "chat-a",
            LiveRun { run_id: "run-1".into(), session_id: "s1".into(), bus: event_bus.clone(), lane, started_at: 0 },
        );
        // Give the pump a beat to stamp the pushed events.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let mut stream = attach_or_idle("chat-a", Some(0));
        let header = stream.next().await.unwrap();
        assert_eq!(header["type"], "run_state");
        assert_eq!(header["live"], true);
        // Bus seqs are 0-based: three events pushed → latest seq 2.
        assert!(header["cursor"].as_u64().unwrap() >= 2);
        // Only events after cursor 0 replay…
        let d2 = stream.next().await.unwrap();
        let d3 = stream.next().await.unwrap();
        assert_eq!(d2["text"], "two");
        assert_eq!(d3["text"], "three");
        // …then live events until RunEnd ends the attachment.
        tx.send(text_delta("live")).unwrap();
        tx.send(run_end()).unwrap();
        let live = stream.next().await.unwrap();
        assert_eq!(live["text"], "live");
        let done = stream.next().await.unwrap();
        assert_eq!(done["type"], "done");
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn attach_without_live_run_is_idle() {
        use futures_util::StreamExt;

        let mut stream = attach_or_idle("chat-none", None);
        let event = stream.next().await.unwrap();
        assert_eq!(event["type"], "run_state");
        assert_eq!(event["live"], false);
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn unregister_only_matching_session() {
        let lane = test_lane().await;
        let (bus, _tx) = HarnessEventBus::new();
        let make = |session_id: &str| LiveRun {
            run_id: "r".into(),
            session_id: session_id.into(),
            bus: bus.clone(),
            lane: lane.clone(),
            started_at: 0,
        };
        register_run("chat-b", make("s-old"));
        // Overflow retry supersedes the entry…
        register_run("chat-b", make("s-new"));
        // …so the old attempt's cleanup must not remove the new one.
        unregister_run("chat-b", "s-old");
        assert!(live_run("chat-b").is_some());
        unregister_run("chat-b", "s-new");
        assert!(live_run("chat-b").is_none());
    }

    #[tokio::test]
    async fn gates_open_list_resolve() {
        let (gate_id, rx) = open_gate("chat-g", "run_command", "rm -rf", "tc9");
        let listed = chat_gates("chat-g");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["gate_id"], gate_id.as_str());
        assert_eq!(listed[0]["tool"], "run_command");
        assert_eq!(listed[0]["reason"], "rm -rf");
        assert_eq!(listed[0]["tool_use_id"], "tc9");
        assert!(chat_gates("chat-other").is_empty());

        assert!(resolve_gate(&gate_id, true));
        assert_eq!(rx.await.unwrap(), true);
        assert!(chat_gates("chat-g").is_empty());
        // Second resolve is a no-op.
        assert!(!resolve_gate(&gate_id, true));
    }

    #[tokio::test]
    async fn gates_drop_removes_without_answering() {
        let (gate_id, rx) = open_gate("chat-g2", "write_file", "overwrite", "tc1");
        drop_gate(&gate_id);
        assert!(chat_gates("chat-g2").is_empty());
        drop(rx);
    }

    #[test]
    fn usage_projection_totals() {
        let mut totals = Usage::empty();
        totals.input = 10;
        totals.output = 5;
        totals.cache_read = 2;
        totals.total_tokens = 17;
        let wire = project_harness_event(&HarnessEvent::Usage {
            row: crate::harness::session::types::UsageRow {
                id: "u".into(),
                seq: 0,
                usage: Usage::empty(),
                entry_id: None,
                adjustment: false,
                details: None,
            },
            totals,
            recovery: None,
        })
        .unwrap();
        assert_eq!(wire["type"], "usage");
        assert_eq!(wire["prompt_tokens"], 12);
        assert_eq!(wire["completion_tokens"], 5);
        assert_eq!(wire["total_tokens"], 17);
    }
}
