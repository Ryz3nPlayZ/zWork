//! Per-chat agent-turn handles, so Stop can abort an in-flight turn.
//!
//! Aborting drops the turn future; tools own their own cleanup on drop
//! (bash kills its process group, MCP calls send `notifications/cancelled`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::task::JoinHandle;
use crate::sync_util::Unpoison;

fn active_runs() -> &'static Mutex<HashMap<String, JoinHandle<()>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, JoinHandle<()>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register the agent-turn task so it can be aborted when the user stops a
/// chat. The caller removes it with `unregister_run` when the turn finishes.
pub fn register_run(chat_id: &str, handle: JoinHandle<()>) {
    active_runs().lock_unpoisoned().insert(chat_id.to_string(), handle);
}

pub fn unregister_run(chat_id: &str) {
    active_runs().lock_unpoisoned().remove(chat_id);
}

/// Abort the chat's running turn. Returns whether one was running.
pub fn cancel_run(chat_id: &str) -> bool {
    match active_runs().lock_unpoisoned().remove(chat_id) {
        Some(handle) => {
            handle.abort();
            true
        }
        None => false,
    }
}
