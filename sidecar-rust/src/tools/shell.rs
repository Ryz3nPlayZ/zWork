use serde_json::{json, Value};
use tokio::sync::mpsc;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use crate::watchdog::{register_process, unregister_process};


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
        
        // Wait for process completion
        let status = child.wait().await.map_err(|e| format!("Failed to wait for command: {}", e))?;
        
        let _ = stdout_handle.await;
        let _ = stderr_handle.await;
        
        unregister_process(chat_id, pid);
        
        if status.success() {
            Ok(format!("Process exited successfully (status: 0)"))
        } else {
            Err(format!("Process exited with status code: {}", status.code().unwrap_or(-1)))
        }
    }
}
