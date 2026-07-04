use serde_json::{json, Value};
use tokio::sync::mpsc;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use crate::watchdog::{register_process, unregister_process};

/// Default per-command timeout. Matches the Python backend's
/// `command_timeout_seconds`. 0 means unbounded (long-running servers etc.).
const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 180;

pub async fn execute_run_command(
    params: &Value,
    chat_id: &str,
    tx: &mpsc::Sender<Value>,
) -> Result<String, String> {
    let command = params.get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'command'".to_string())?;

    let cwd = params.get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or(".");

    let background = params.get("background")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let timeout_secs = params.get("timeout")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECS);

    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd.current_dir(cwd);

    #[cfg(unix)]
    {
        // Start in a new process group so we can kill the entire tree on cancel
        cmd.process_group(0);
    }

    if background {
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("Failed to spawn background process: {}", e))?;
        let pid = child.id().unwrap_or(0);

        // Background processes aren't unregistered until explicit stop
        register_process(chat_id, pid);

        Ok(format!("Started background process (pid={})", pid))
    } else {
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn command: {}", e))?;
        let pid = child.id().unwrap_or(0);

        register_process(chat_id, pid);

        let stdout = child.stdout.take().ok_or("Failed to open stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to open stderr")?;

        let tx_out = tx.clone();
        let stdout_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx_out.send(json!({
                    "type": "status",
                    "text": line
                })).await;
            }
        });

        let tx_err = tx.clone();
        let stderr_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx_err.send(json!({
                    "type": "status",
                    "text": format!("[stderr] {}", line)
                })).await;
            }
        });

        // Wait for process completion, bounded by the timeout. A hung command
        // would otherwise block the agent forever (and, before the watchdog
        // fix, couldn't even be stopped). On timeout we kill the whole tree.
        let wait = async {
            child.wait().await.map_err(|e| format!("Failed to wait for command: {}", e))
        };
        let status = if timeout_secs == 0 {
            wait.await
        } else {
            match tokio::time::timeout(Duration::from_secs(timeout_secs), wait).await {
                Ok(res) => res,
                Err(_) => {
                    // Timed out — terminate the process group so children die too.
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    crate::watchdog::terminate_process_tree(pid);
                    return Err(format!(
                        "Command timed out after {}s and was terminated.",
                        timeout_secs
                    ));
                }
            }
        };

        let _ = stdout_handle.await;
        let _ = stderr_handle.await;

        unregister_process(chat_id, pid);

        match status {
            Ok(s) if s.success() => Ok("Process exited successfully (status: 0)".to_string()),
            Ok(s) => Err(format!("Process exited with status code: {}", s.code().unwrap_or(-1))),
            Err(e) => Err(e),
        }
    }
}
