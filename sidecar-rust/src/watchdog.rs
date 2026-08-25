use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tokio::task::JoinHandle;
use crate::sync_util::Unpoison;

fn active_processes() -> &'static Mutex<HashMap<String, HashSet<u32>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, HashSet<u32>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-chat agent-turn handles. Storing the JoinHandle lets `cancel_run`
/// `.abort()` the in-flight turn — without this, hitting Stop only killed
/// child subprocesses while the LLM loop kept running to completion.
fn active_runs() -> &'static Mutex<HashMap<String, JoinHandle<()>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, JoinHandle<()>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_process(chat_id: &str, pid: u32) {
    let mut map = active_processes().lock_unpoisoned();
    map.entry(chat_id.to_string()).or_default().insert(pid);
}

pub fn unregister_process(chat_id: &str, pid: u32) {
    let mut map = active_processes().lock_unpoisoned();
    if let Some(set) = map.get_mut(chat_id) {
        set.remove(&pid);
    }
}

/// Register the agent-turn task so it can be aborted when the user stops a
/// chat. The handle is removed automatically when the turn finishes (the
/// caller drops it via `unregister_run`).
pub fn register_run(chat_id: &str, handle: JoinHandle<()>) {
    let mut map = active_runs().lock_unpoisoned();
    map.insert(chat_id.to_string(), handle);
}

pub fn unregister_run(chat_id: &str) {
    let mut map = active_runs().lock_unpoisoned();
    map.remove(chat_id);
}

pub fn cancel_run(chat_id: &str) -> bool {
    let mut cancelled_any = false;

    // 1. Abort the agent turn itself so it stops spawning further tool/LLM calls.
    {
        let mut map = active_runs().lock_unpoisoned();
        if let Some(handle) = map.remove(chat_id) {
            handle.abort();
            cancelled_any = true;
        }
    }

    // 2. Terminate any registered subprocess trees spawned by the turn.
    let pids = {
        let mut map = active_processes().lock_unpoisoned();
        map.remove(chat_id).unwrap_or_default()
    };

    for pid in pids {
        terminate_process_tree(pid);
        cancelled_any = true;
    }

    cancelled_any
}

pub fn terminate_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        // Construct the negative Pid to target the process group
        let pgid = Pid::from_raw(-(pid as i32));
        let _ = kill(pgid, Signal::SIGTERM);
        // Fallback directly to the PID itself if PGID kill failed
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    #[cfg(windows)]
    {
        // Windows: taskkill /T /F /PID
        let _ = std::process::Command::new("taskkill")
            .args(&["/T", "/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .and_then(|mut c| c.wait());
    }
}
