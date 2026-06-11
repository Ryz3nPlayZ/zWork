use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tokio::sync::oneshot;

fn active_processes() -> &'static Mutex<HashMap<String, HashSet<u32>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, HashSet<u32>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_cancellers() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    static INSTANCE: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_process(chat_id: &str, pid: u32) {
    let mut map = active_processes().lock().unwrap();
    map.entry(chat_id.to_string()).or_default().insert(pid);
}

pub fn unregister_process(chat_id: &str, pid: u32) {
    let mut map = active_processes().lock().unwrap();
    if let Some(set) = map.get_mut(chat_id) {
        set.remove(&pid);
    }
}

pub fn register_canceller(chat_id: &str, tx: oneshot::Sender<()>) {
    let mut map = active_cancellers().lock().unwrap();
    map.insert(chat_id.to_string(), tx);
}

pub fn unregister_canceller(chat_id: &str) {
    let mut map = active_cancellers().lock().unwrap();
    map.remove(chat_id);
}

pub fn cancel_run(chat_id: &str) -> bool {
    let mut cancelled_any = false;
    
    // 1. Trigger the oneshot canceller for the token loop
    {
        let mut map = active_cancellers().lock().unwrap();
        if let Some(tx) = map.remove(chat_id) {
            let _ = tx.send(());
            cancelled_any = true;
        }
    }
    
    // 2. Terminate any registered subprocess trees
    let pids = {
        let mut map = active_processes().lock().unwrap();
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
