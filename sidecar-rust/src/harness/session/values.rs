//! Port of pi `harness/session/values.ts` — typed value/list addresses.
//!
//! A session stores three kinds of durable data (entries, a usage ledger,
//! and scalar/list values). Values live in namespaced addresses; the `pi.*`
//! namespaces are reserved for the harness runtime and carry defined
//! semantics (see the constructors below). Application namespaces must not
//! start with `pi.`.
//!
//! pi's `Value<T>` phantom typing becomes untyped [`Addr`] here; typed
//! access happens at the read boundary (`Session::get_value::<T>`).

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// A value or list address. The region (scalar vs list) is chosen by the
/// accessor, mirroring pi's separate `scalarValues` / `listValues` stores.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Addr {
    pub namespace: String,
    pub key: String,
}

fn validate_address(namespace: &str, key: &str) -> Result<(), String> {
    if namespace.is_empty() {
        return Err("Value namespace must not be empty".into());
    }
    if namespace.contains('\u{0}') {
        return Err("Value namespace must not contain \\u0000".into());
    }
    if key.contains('\u{0}') {
        return Err("Value key must not contain \\u0000".into());
    }
    Ok(())
}

pub fn value(namespace: &str, key: &str) -> Result<Addr, String> {
    validate_address(namespace, key)?;
    Ok(Addr { namespace: namespace.into(), key: key.into() })
}

pub fn list(namespace: &str, key: &str) -> Result<Addr, String> {
    validate_address(namespace, key)?;
    Ok(Addr { namespace: namespace.into(), key: key.into() })
}

/// A scalar cell as stored: last-set value plus the seq that set it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredValue {
    pub address: Addr,
    pub value: Json,
    pub seq: u64,
}

/// One element of a stored list, with the seq that appended it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListElement {
    pub seq: u64,
    pub value: Json,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ListReadOptions {
    /// Only elements with seq strictly greater (asc) / smaller (desc).
    pub cursor: Option<u64>,
    pub desc: bool,
    pub limit: Option<usize>,
}

pub const DEFAULT_LIST_LIMIT: usize = 1_000;
pub const MAX_LIST_LIMIT: usize = 10_000;

pub fn resolve_list_read_options(options: ListReadOptions) -> (Option<u64>, bool, usize) {
    let limit = options.limit.unwrap_or(DEFAULT_LIST_LIMIT).min(MAX_LIST_LIMIT).max(1);
    (options.cursor, options.desc, limit)
}

// ---------------------------------------------------------------------------
// Write constructors (pi value()/list() write helpers)
// ---------------------------------------------------------------------------

use super::commit::{ListWrite, ValueWrite};

pub fn set_value(address: &Addr, next: Json) -> ValueWrite {
    ValueWrite::Set { namespace: address.namespace.clone(), key: address.key.clone(), value: next }
}

pub fn delete_value(address: &Addr) -> ValueWrite {
    ValueWrite::Delete { namespace: address.namespace.clone(), key: address.key.clone() }
}

pub fn append_list(address: &Addr, element: Json) -> ListWrite {
    ListWrite::Append { namespace: address.namespace.clone(), key: address.key.clone(), value: element }
}

pub fn delete_list(address: &Addr) -> ListWrite {
    ListWrite::Delete { namespace: address.namespace.clone(), key: address.key.clone() }
}

// ---------------------------------------------------------------------------
// Reserved pi.* addresses (values.ts constructors)
// ---------------------------------------------------------------------------

pub fn branch_tip(branch: &str) -> Addr {
    value("pi.branch.tip", branch).expect("branch name validated upstream")
}

pub fn branch_tip_inventory_prefix() -> Addr {
    value("pi.branch.tip", "").expect("static")
}

pub fn lane_config(lane: &str) -> Addr {
    value("pi.lane.config", lane).expect("lane name validated upstream")
}

pub fn lane_state(lane: &str) -> Addr {
    value("pi.lane.state", lane).expect("lane name validated upstream")
}

pub fn operation_result(operation_id: &str) -> Addr {
    value("pi.result", operation_id).expect("static")
}

pub fn operation_meta(operation_id: &str) -> Addr {
    value("pi.op.meta", operation_id).expect("static")
}

pub fn operation_state(operation_id: &str) -> Addr {
    value("pi.op.state", operation_id).expect("static")
}

pub fn operation_tool_args(operation_id: &str, step_id: &str, source_index: usize) -> Addr {
    value("pi.op.tool_args", &format!("{operation_id}:{step_id}:{source_index}")).expect("static")
}

pub fn operation_tool_memo(operation_id: &str, invocation_id: &str, name: &str) -> Addr {
    value("pi.op.tool_memo", &format!("{operation_id}:{invocation_id}:{name}")).expect("static")
}

pub fn operation_preparation(operation_id: &str, task_id: &str) -> Addr {
    value("pi.op.preparation", &format!("{operation_id}:{task_id}")).expect("static")
}

pub fn operation_tool_args_prefix(operation_id: &str, step_id: Option<&str>) -> Addr {
    let key = match step_id {
        None => format!("{operation_id}:"),
        Some(step) => format!("{operation_id}:{step}:"),
    };
    value("pi.op.tool_args", &key).expect("static")
}

pub fn operation_tool_memo_prefix(operation_id: &str, invocation_id: Option<&str>) -> Addr {
    let key = match invocation_id {
        None => format!("{operation_id}:"),
        Some(inv) => format!("{operation_id}:{inv}:"),
    };
    value("pi.op.tool_memo", &key).expect("static")
}

pub fn operation_preparation_prefix(operation_id: &str) -> Addr {
    value("pi.op.preparation", &format!("{operation_id}:")).expect("static")
}

pub fn pending_entry(entry_id: &str) -> Addr {
    value("pi.pending.entry", entry_id).expect("static")
}

pub fn pending_tool_output(operation_id: &str, invocation_id: &str) -> Addr {
    value("pi.pending.tool_output", &format!("{operation_id}:{invocation_id}")).expect("static")
}

pub fn pending_assistant_frames(operation_id: &str, response_entry_id: &str) -> Addr {
    value("pi.pending.assistant_frame", &format!("{operation_id}:{response_entry_id}")).expect("static")
}

pub fn pending_tool_output_prefix(operation_id: &str) -> Addr {
    value("pi.pending.tool_output", &format!("{operation_id}:")).expect("static")
}

pub fn session_name() -> Addr {
    value("pi.session.name", "").expect("static")
}

pub fn entry_label(entry_id: &str) -> Addr {
    value("pi.entry.label", entry_id).expect("static")
}
