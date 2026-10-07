//! Port of pi `harness/session/fork-policy.ts`.
//!
//! Decides what a fork copies: which entries make up the destination
//! branch ancestry, and how each reserved-namespace value projects into
//! destination state. Operation/pending/result state and the usage ledger
//! never survive a fork.

use super::commit::CommittedWrite;
use super::types::{LaneState, SessionError};

pub enum ForkCurrentStatePlan {
    Tree,
    Branch { branch: String, destination_tip: Option<String> },
}

/// Walk the source branch ancestry from its tip, selecting every entry on
/// the path down to (and, unless `before`, including) the requested entry.
/// Returns the destination branch name and its new tip.
pub fn select_branch_fork(
    branch: &str,
    entry_id: Option<&str>,
    before: bool,
    tip: Option<String>,
    select_entry: &mut dyn FnMut(&str),
    get_parent: &mut dyn FnMut(&str) -> Option<Option<String>>,
) -> Result<(String, Option<String>), String> {
    // An empty source branch forks to an empty destination branch.
    let Some(mut current) = tip else {
        return Ok((branch.to_string(), None));
    };
    let requested = entry_id.unwrap_or_else(|| current.as_str()).to_string();
    let mut found = false;
    let mut destination_tip: Option<String> = None;
    loop {
        let entry = current.clone();
        let parent =
            get_parent(&entry).ok_or_else(|| format!("Corrupt source branch: missing parent {entry}"))?;
        if entry == requested {
            found = true;
            destination_tip = if before { parent.clone() } else { Some(entry.clone()) };
            if !before {
                select_entry(&entry);
            }
        } else if found {
            select_entry(&entry);
        }
        match parent {
            None => break,
            Some(p) => current = p,
        }
    }
    if !found {
        return Err(format!("Fork entry {entry_id:?} is not on source branch {branch:?}"));
    }
    Ok((branch.to_string(), destination_tip))
}

/// Project one current scalar row or surviving list element into
/// destination state. `None` = drop it.
pub fn project_fork_current_state_write(
    write: CommittedWrite,
    plan: &ForkCurrentStatePlan,
    is_entry_copied: &dyn Fn(&str) -> bool,
) -> Result<Option<CommittedWrite>, SessionError> {
    let (namespace, key) = match &write {
        CommittedWrite::ValueSet { namespace, key, .. } | CommittedWrite::ListAppend { namespace, key, .. } => {
            (namespace.as_str(), key.as_str())
        }
        // Deletes are not current state; callers replay only live values.
        _ => return Ok(None),
    };

    match namespace {
        "pi.session.name" => Ok(Some(write)),
        "pi.entry.label" => Ok(is_entry_copied(key).then_some(write)),
        "pi.branch.tip" => match plan {
            ForkCurrentStatePlan::Tree => Ok(Some(write)),
            ForkCurrentStatePlan::Branch { branch, destination_tip } => {
                if key != branch {
                    return Ok(None);
                }
                let new_tip = destination_tip
                    .clone()
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null);
                match write {
                    CommittedWrite::ValueSet { seq, namespace, key, .. } => Ok(Some(CommittedWrite::ValueSet {
                        seq,
                        namespace,
                        key,
                        value: new_tip,
                    })),
                    other => Ok(Some(other)),
                }
            }
        },
        "pi.lane.config" => match plan {
            ForkCurrentStatePlan::Tree => Ok(Some(write)),
            ForkCurrentStatePlan::Branch { branch, .. } if key == branch => Ok(Some(write)),
            ForkCurrentStatePlan::Branch { .. } => Ok(None),
        },
        // Fresh idle lane state — operations never survive a fork.
        "pi.lane.state" => match plan {
            ForkCurrentStatePlan::Tree => Ok(Some(clear_lane_state(write))),
            ForkCurrentStatePlan::Branch { branch, .. } if key == branch => Ok(Some(clear_lane_state(write))),
            ForkCurrentStatePlan::Branch { .. } => Ok(None),
        },
        "pi.result" => Ok(None),
        ns if ns.starts_with("pi.op.") || ns.starts_with("pi.pending.") => Ok(None),
        ns if ns == "pi" || ns.starts_with("pi.") => {
            Err(SessionError::Storage(format!("Unknown reserved fork namespace: {ns}")))
        }
        _ => match plan {
            ForkCurrentStatePlan::Tree => Ok(Some(write)),
            ForkCurrentStatePlan::Branch { .. } => Ok(None),
        },
    }
}

fn clear_lane_state(write: CommittedWrite) -> CommittedWrite {
    match write {
        CommittedWrite::ValueSet { seq, namespace, key, .. } => {
            let fresh = LaneState::default();
            CommittedWrite::ValueSet {
                seq,
                namespace,
                key,
                value: serde_json::to_value(&fresh).unwrap_or(serde_json::Value::Null),
            }
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain() -> std::collections::HashMap<String, Option<String>> {
        let mut m = std::collections::HashMap::new();
        m.insert("a".into(), None);
        m.insert("b".into(), Some("a".into()));
        m.insert("c".into(), Some("b".into()));
        m
    }

    #[test]
    fn selects_ancestry_at_entry() {
        let chain = chain();
        let mut selected = Vec::new();
        let (_, tip) = select_branch_fork(
            "main",
            Some("b"),
            false,
            Some("c".into()),
            &mut |id| selected.push(id.to_string()),
            &mut |id| chain.get(id).cloned(),
        )
        .unwrap();
        assert_eq!(tip.as_deref(), Some("b"));
        // Selection fires during the tip→root walk, so order is b, a.
        assert_eq!(selected, vec!["b", "a"]);
    }

    #[test]
    fn position_before_stops_at_parent() {
        let chain = chain();
        let mut selected = Vec::new();
        let (_, tip) = select_branch_fork(
            "main",
            Some("b"),
            true,
            Some("c".into()),
            &mut |id| selected.push(id.to_string()),
            &mut |id| chain.get(id).cloned(),
        )
        .unwrap();
        assert_eq!(tip.as_deref(), Some("a"));
        assert_eq!(selected, vec!["a"]);
    }

    #[test]
    fn rejects_entry_off_branch() {
        let chain = chain();
        let err = select_branch_fork(
            "main",
            Some("zzz"),
            false,
            Some("c".into()),
            &mut |_| {},
            &mut |id| chain.get(id).cloned(),
        )
        .unwrap_err();
        assert!(err.contains("not on source branch"));
    }
}
