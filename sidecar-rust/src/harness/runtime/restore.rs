//! Port of pi `runtime/restore.ts` — startup lane restoration.
//!
//! `restore_session` reads every configured lane in one coherent pass and
//! validates that each open operation's durable state still matches its
//! declared intent, so a mismatched journal surfaces as an invariant fault
//! at open time instead of misbehaving inside the dispatcher.

use std::collections::BTreeMap;

use crate::harness::runtime::lane::{Lane, LaneSnapshotState};
use crate::harness::session::session::Session;
use crate::harness::session::types::{
    LaneConfiguration, LaneState, Operation, OperationIntent, OperationState, ResultBoundary,
    SessionError, SessionResult, SummaryTask,
};
use crate::harness::session::values::{
    branch_tip_inventory_prefix, lane_config, lane_state as lane_state_value,
};
use crate::harness::session::values::StoredValue;

/// One open operation discovered at restore time (pi `OpenOperation`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenOperation {
    pub lane: String,
    pub operation_id: String,
    pub kind: &'static str,
    pub started_at: u64,
    pub aborting: bool,
}

/// How a lane name's durable storage classifies (pi
/// `ClassifiedLaneStorage`): absent entirely, a bare branch tip, or a
/// fully configured lane.
#[derive(Debug, Clone)]
pub enum ClassifiedLaneStorage {
    Absent,
    Branch { tip: Option<String> },
    Lane { tip: Option<String>, configuration: LaneConfiguration, state: LaneState },
}

pub fn classify_lane_storage(
    lane: &str,
    tip: Option<Option<String>>,
    configuration: Option<LaneConfiguration>,
    state: Option<LaneState>,
) -> SessionResult<ClassifiedLaneStorage> {
    use ClassifiedLaneStorage::*;
    match (tip, configuration, state) {
        (None, None, None) => Ok(Absent),
        (Some(tip), None, None) => Ok(Branch { tip }),
        (None, _, _) => Err(invariant(lane, "is missing branch.tip")),
        (Some(tip), Some(configuration), Some(state)) => {
            Ok(Lane { tip, configuration, state })
        }
        (Some(_), None, Some(_)) => Err(invariant(lane, "is missing lane.config")),
        (Some(_), Some(_), None) => Err(invariant(lane, "is missing lane.state")),
    }
}

fn invariant(lane: &str, what: &str) -> SessionError {
    SessionError::Invariant(format!("lane {lane:?} {what}"))
}

fn summary_task(state: &OperationState) -> Option<&SummaryTask> {
    match state {
        OperationState::SummaryDeciding { task, .. }
        | OperationState::SummaryReady { task, .. }
        | OperationState::SummaryEffectPending { task, .. }
        | OperationState::SummaryRetryWait { task, .. } => Some(task),
        _ => None,
    }
}

fn is_summary_state(state: &OperationState) -> bool {
    summary_task(state).is_some()
}

/// Does this durable state belong to this declared intent? (pi
/// `stateMatchesIntent`.) Guards restore against cross-kind corruption —
/// e.g. a run intent pointing at a compaction's summary procedure.
pub fn state_matches_intent(intent: &OperationIntent, state: &OperationState) -> bool {
    match intent {
        OperationIntent::Compaction { .. } => {
            summary_task(state).is_some_and(|task| task.boundary == ResultBoundary::Finish)
        }
        OperationIntent::Navigation { target_id, summarize, label, custom_instructions } => {
            match state {
                OperationState::NavigationReadyToCommit { target_id: state_target, label: state_label, .. } => {
                    !summarize && state_target == target_id && state_label == label
                }
                _ => {
                    *summarize
                        && summary_task(state).is_some_and(|task| {
                            matches!(
                                &task.boundary,
                                ResultBoundary::CommitNavigation {
                                    target_id: boundary_target,
                                    label: boundary_label,
                                } if boundary_target == target_id && boundary_label == label
                            ) && task.custom_instructions == *custom_instructions
                        })
                }
            }
        }
        OperationIntent::Run { .. } => {
            !matches!(state, OperationState::NavigationReadyToCommit { .. })
                && summary_task(state)
                    .is_none_or(|task| matches!(task.boundary, ResultBoundary::ResumeCheckpoint { .. }))
        }
    }
}

/// Validate one restored operation against its lane and intent.
pub fn validate_restored_operation(lane: &str, snapshot: &LaneSnapshotState) -> SessionResult<()> {
    let Some(operation) = &snapshot.operation else {
        return Ok(());
    };
    let Operation { meta, state } = operation;
    if let Some(current) = &snapshot.lane_state.current_operation_id {
        if current != &meta.operation_id {
            return Err(SessionError::Invariant(format!(
                "operation {current:?} metadata names operation {:?}",
                meta.operation_id
            )));
        }
    }
    if meta.lane != lane {
        return Err(SessionError::Invariant(format!(
            "operation {:?} belongs to lane {:?}, not {lane:?}",
            meta.operation_id, meta.lane
        )));
    }
    if !state_matches_intent(&meta.intent, state) {
        return Err(SessionError::Invariant(format!(
            "operation {:?} intent {} does not match state {}",
            meta.operation_id,
            intent_kind(&meta.intent),
            state.at()
        )));
    }
    Ok(())
}

pub fn intent_kind(intent: &OperationIntent) -> &'static str {
    match intent {
        OperationIntent::Run { .. } => "run",
        OperationIntent::Compaction { .. } => "compaction",
        OperationIntent::Navigation { .. } => "navigation",
    }
}

/// Restore every fully configured lane in one coherent session read
/// (pi `restoreSession`). Bare branch tips and absent names are skipped.
pub fn restore_session(
    session: &Session,
) -> SessionResult<Vec<(String, LaneSnapshotState)>> {
    let tips: BTreeMap<String, StoredValue> = session
        .scan_values(&branch_tip_inventory_prefix())?
        .into_iter()
        .map(|stored| (stored.address.key.clone(), stored))
        .collect();
    let configurations: BTreeMap<String, StoredValue> = session
        .scan_values(&lane_config(""))?
        .into_iter()
        .map(|stored| (stored.address.key.clone(), stored))
        .collect();
    let states: BTreeMap<String, StoredValue> = session
        .scan_values(&lane_state_value(""))?
        .into_iter()
        .map(|stored| (stored.address.key.clone(), stored))
        .collect();

    let mut names: Vec<&String> = tips.keys().collect::<Vec<_>>().into_iter().collect();
    for key in configurations.keys().chain(states.keys()) {
        if !tips.contains_key(key) && !names.contains(&key) {
            names.push(key);
        }
    }

    let mut restored = Vec::new();
    for lane in names {
        let tip = decode_tip(tips.get(lane))?;
        let configuration = decode_optional::<LaneConfiguration>(configurations.get(lane), "lane config")?;
        let state = decode_optional::<LaneState>(states.get(lane), "lane state")?;
        if !matches!(
            classify_lane_storage(lane, tip, configuration, state)?,
            ClassifiedLaneStorage::Lane { .. }
        ) {
            continue;
        }
        let snapshot = Lane::read_snapshot(session, lane)?;
        validate_restored_operation(lane, &snapshot)?;
        restored.push((lane.to_string(), snapshot));
    }
    Ok(restored)
}

/// The open-operation projection of one restored snapshot set (pi
/// `createAgentHarness` open list).
pub fn open_operations(restored: &[(String, LaneSnapshotState)]) -> Vec<OpenOperation> {
    restored
        .iter()
        .filter_map(|(lane, snapshot)| {
            let operation: &Operation = snapshot.operation.as_ref()?;
            Some(OpenOperation {
                lane: lane.clone(),
                operation_id: operation.meta.operation_id.clone(),
                kind: intent_kind(&operation.meta.intent),
                started_at: operation.meta.started_at,
                aborting: matches!(
                    operation.state.scope().control,
                    crate::harness::session::types::Control::CancelRequested { .. }
                ),
            })
        })
        .collect()
}

/// Decode a `string | null` branch tip. `None` (outer) = value absent;
/// `Some(None)` = present but null (root).
fn decode_tip(stored: Option<&StoredValue>) -> SessionResult<Option<Option<String>>> {
    match stored {
        None => Ok(None),
        Some(stored) => {
            if stored.value.is_null() {
                Ok(Some(None))
            } else {
                stored
                    .value
                    .as_str()
                    .map(|tip| Some(Some(String::from(tip))))
                    .ok_or_else(|| SessionError::Storage("branch tip decode failed".into()))
            }
        }
    }
}

fn decode_optional<T: serde::de::DeserializeOwned>(
    stored: Option<&StoredValue>,
    what: &str,
) -> SessionResult<Option<T>> {
    match stored {
        None => Ok(None),
        Some(stored) => serde_json::from_value(stored.value.clone())
            .map(Some)
            .map_err(|e| SessionError::Storage(format!("{what} decode failed: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::session::memory::MemoryStorage;
    use crate::harness::session::session::Session;
    use crate::harness::session::types::{
        Control, OperationMeta, OperationScope, RunSettings,
    };
    use crate::harness::session::commit::Write;
    use crate::harness::session::values::{
        branch_tip, lane_config, lane_state as lane_state_addr, operation_meta as operation_meta_addr,
        operation_state as operation_state_addr, set_value,
    };
    use crate::harness::session::SessionMetadata;
    use std::sync::Arc;

    fn session() -> Session {
        Session::new(
            SessionMetadata {
                id: "s".into(),
                created_at: 0,
                storage_version: 1,
                cwd: None,
                parent_session_id: None,
            },
            Arc::new(MemoryStorage::new()),
        )
    }

    fn run_meta(operation_id: &str, lane: &str) -> OperationMeta {
        OperationMeta {
            operation_id: operation_id.into(),
            lane: lane.into(),
            source_tip_id: None,
            started_at: 1,
            intent: OperationIntent::Run { prompt_entry_ids: vec![] },
        }
    }

    fn test_scope() -> OperationScope {
        OperationScope {
            control: Control::Running,
            settings: RunSettings::default(),
            latest_assistant_entry_id: None,
        }
    }

    #[test]
    fn classify_matches_upstream_taxonomy() {
        use ClassifiedLaneStorage::*;
        assert!(matches!(
            classify_lane_storage("main", None, None, None).unwrap(),
            Absent
        ));
        assert!(matches!(
            classify_lane_storage("main", Some(Some("e1".into())), None, None).unwrap(),
            Branch { .. }
        ));
        assert!(classify_lane_storage("main", None, None, Some(LaneState::default())).is_err());
        assert!(classify_lane_storage("main", Some(None), None, Some(LaneState::default())).is_err());
        assert!(matches!(
            classify_lane_storage("main", Some(None), None, None).unwrap(),
            Branch { tip: None }
        ));
    }

    #[test]
    fn state_matches_intent_kinds() {
        let starting = OperationState::Starting { scope: test_scope() };
        assert!(state_matches_intent(
            &OperationIntent::Run { prompt_entry_ids: vec![] },
            &starting
        ));

        let navigation = OperationState::NavigationReadyToCommit {
            scope: test_scope(),
            target_id: Some("e1".into()),
            label: None,
        };
        assert!(!state_matches_intent(
            &OperationIntent::Run { prompt_entry_ids: vec![] },
            &navigation
        ));
        assert!(state_matches_intent(
            &OperationIntent::Navigation {
                target_id: Some("e1".into()),
                summarize: false,
                label: None,
                custom_instructions: None,
            },
            &navigation
        ));
        assert!(!state_matches_intent(
            &OperationIntent::Navigation {
                target_id: Some("e2".into()),
                summarize: false,
                label: None,
                custom_instructions: None,
            },
            &navigation
        ));
    }

    #[tokio::test]
    async fn restore_finds_open_operation_and_validates_intent() {
        let session = session();
        session
            .mutate(|mutator| {
                let configuration = crate::harness::session::types::LaneConfiguration {
                    provider: "test".into(),
                    model_id: "m".into(),
                    thinking_level: crate::harness::types::ThinkingLevel::Minimal,
                    active_tool_names: vec![],
                };
                let durable = LaneState {
                    current_operation_id: Some("op1".into()),
                    last_operation_id: None,
                    inbox: vec![],
                };
                let meta = run_meta("op1", "main");
                let state = OperationState::Starting { scope: test_scope() };
                mutator.commit(vec![
                    Write::Value(set_value(&branch_tip("main"), serde_json::json!("e0"))),
                    Write::Value(set_value(&lane_config("main"), serde_json::to_value(&configuration).unwrap())),
                    Write::Value(set_value(&lane_state_addr("main"), serde_json::to_value(&durable).unwrap())),
                    Write::Value(set_value(&operation_meta_addr("op1"), serde_json::to_value(&meta).unwrap())),
                    Write::Value(set_value(&operation_state_addr("op1"), serde_json::to_value(&state).unwrap())),
                ])?;
                Ok(())
            })
            .await
            .unwrap();

        let restored = restore_session(&session).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].0, "main");
        let open = open_operations(&restored);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].operation_id, "op1");
        assert_eq!(open[0].kind, "run");
        assert!(!open[0].aborting);

        // Cross-kind corruption must fault at restore time, not in dispatch.
        let bad_meta = OperationMeta {
            intent: OperationIntent::Compaction { custom_instructions: None },
            ..run_meta("op1", "main")
        };
        session
            .mutate(|mutator| {
                mutator.commit(vec![Write::Value(set_value(
                    &operation_meta_addr("op1"),
                    serde_json::to_value(&bad_meta).unwrap(),
                ))])?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(restore_session(&session).is_err());
    }

    #[tokio::test]
    async fn restore_skips_branch_only_and_absent_names() {
        let session = session();
        session
            .mutate(|mutator| {
                mutator.commit(vec![Write::Value(set_value(&branch_tip("side"), serde_json::json!("e1")))])?;
                Ok(())
            })
            .await
            .unwrap();
        let restored = restore_session(&session).unwrap();
        assert!(restored.is_empty());
    }
}
