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

/// Cap on the combined stdout+stderr returned to the model. The cap is
/// tail-biased: build errors and test failures live at the END of the output,
/// so when we truncate we keep the tail and say so.
const MAX_OUTPUT_BYTES: usize = 12 * 1024;

/// Keep the last `max` bytes of `s` (snapped to a char boundary), prefixing a
/// truncation note when anything was dropped.
fn tail_cap(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!(
        "[output truncated: showing last ~{} KB of {} bytes]\n{}",
        max / 1024,
        s.len(),
        &s[start..]
    )
}

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

    // Pick the platform shell: `sh -c` on unix, `cmd /C` on Windows. The
    // command string the model writes is shell syntax for the host shell, so
    // routing Windows through `cmd` (not a nonexistent `sh`) keeps run_command
    // working as the cross-platform fallback after desktop_* is gated off.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    };
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
            let mut captured = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx_out.send(json!({
                    "type": "status",
                    "text": line
                })).await;
                captured.push_str(&line);
                captured.push('\n');
            }
            captured
        });

        let tx_err = tx.clone();
        let stderr_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            let mut captured = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx_err.send(json!({
                    "type": "status",
                    "text": format!("[stderr] {}", line)
                })).await;
                captured.push_str("[stderr] ");
                captured.push_str(&line);
                captured.push('\n');
            }
            captured
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

        let stdout_text = stdout_handle.await.unwrap_or_default();
        let stderr_text = stderr_handle.await.unwrap_or_default();

        unregister_process(chat_id, pid);

        // Combine stdout + stderr (stderr lines tagged) so the model can read
        // build errors, test failures, and `ls` results — previously only the
        // UI saw them. Tail-biased cap: errors live at the end.
        let mut combined = stdout_text;
        if !stderr_text.is_empty() {
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(&stderr_text);
        }
        let output = tail_cap(combined.trim_end(), MAX_OUTPUT_BYTES);

        match status {
            Ok(s) if s.success() => Ok(if output.is_empty() {
                "Process exited successfully (status: 0, no output)".to_string()
            } else {
                format!("Process exited successfully (status: 0)\n\nOutput:\n{}", output)
            }),
            Ok(s) => {
                let code = s.code().unwrap_or(-1);
                Err(if output.is_empty() {
                    format!("Process exited with status code: {}", code)
                } else {
                    format!("Process exited with status code: {}\n\nOutput:\n{}", code, output)
                })
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tail_cap_keeps_short_output_verbatim() {
        assert_eq!(tail_cap("hello", 100), "hello");
    }

    #[test]
    fn test_tail_cap_keeps_tail_and_says_so() {
        let big = "a".repeat(MAX_OUTPUT_BYTES + 500);
        let capped = tail_cap(&big, MAX_OUTPUT_BYTES);
        assert!(capped.starts_with("[output truncated: showing last ~12 KB"));
        assert!(capped.len() <= MAX_OUTPUT_BYTES + 128);
    }

    #[test]
    fn test_tail_cap_respects_char_boundaries() {
        // 4-byte emoji straddling the cut point must not panic or split.
        let big = format!("{}{}", "x".repeat(MAX_OUTPUT_BYTES), "🦀".repeat(100));
        let capped = tail_cap(&big, MAX_OUTPUT_BYTES);
        assert!(capped.contains("🦀"));
    }

    #[tokio::test]
    async fn test_stdout_is_returned_to_the_model() {
        let (tx, _rx) = mpsc::channel(64);
        let params = json!({ "command": "echo hello-from-stdout", "timeout": 30 });
        let res = execute_run_command(&params, "test-chat", &tx).await;
        let msg = res.expect("echo should succeed");
        assert!(msg.contains("status: 0"), "got: {msg}");
        assert!(msg.contains("hello-from-stdout"), "got: {msg}");
    }

    #[tokio::test]
    async fn test_stderr_is_returned_to_the_model() {
        let (tx, _rx) = mpsc::channel(64);
        let params = json!({ "command": "echo out-line; echo err-line >&2", "timeout": 30 });
        let res = execute_run_command(&params, "test-chat", &tx).await;
        let msg = res.expect("command should succeed");
        assert!(msg.contains("out-line"), "got: {msg}");
        assert!(msg.contains("[stderr] err-line"), "got: {msg}");
    }

    #[tokio::test]
    async fn test_failing_command_returns_output_in_error() {
        let (tx, _rx) = mpsc::channel(64);
        let params = json!({ "command": "echo boom-stack-trace >&2; exit 3", "timeout": 30 });
        let res = execute_run_command(&params, "test-chat", &tx).await;
        let err = res.expect_err("exit 3 should be an error");
        assert!(err.contains("status code: 3"), "got: {err}");
        assert!(err.contains("boom-stack-trace"), "got: {err}");
    }

    #[tokio::test]
    async fn test_no_output_says_so() {
        let (tx, _rx) = mpsc::channel(64);
        let params = json!({ "command": "true", "timeout": 30 });
        let res = execute_run_command(&params, "test-chat", &tx).await;
        assert_eq!(res.unwrap(), "Process exited successfully (status: 0, no output)");
    }

    #[tokio::test]
    async fn test_huge_output_is_tail_biased() {
        let (tx, _rx) = mpsc::channel(64);
        // ~34 KB of numbered lines; the tail must survive, the head must not.
        let params = json!({
            "command": "i=0; while [ $i -lt 2000 ]; do echo \"line-$i-xxxxxxxx\"; i=$((i+1)); done",
            "timeout": 30
        });
        let res = execute_run_command(&params, "test-chat", &tx).await;
        let msg = res.expect("loop should succeed");
        assert!(msg.contains("[output truncated"), "got head: {}", &msg[..200.min(msg.len())]);
        assert!(msg.contains("line-1999"), "tail missing");
        assert!(!msg.contains("line-0-x"), "head should have been dropped");
        assert!(msg.len() <= MAX_OUTPUT_BYTES + 256, "got {} bytes", msg.len());
    }

    #[tokio::test]
    async fn test_ui_streaming_still_happens() {
        let (tx, mut rx) = mpsc::channel(64);
        let params = json!({ "command": "echo streamed-line", "timeout": 30 });
        let res = execute_run_command(&params, "test-chat", &tx).await;
        assert!(res.is_ok());
        drop(tx);
        let mut saw = false;
        while let Some(evt) = rx.recv().await {
            if evt.get("text").and_then(|v| v.as_str()) == Some("streamed-line") {
                saw = true;
            }
        }
        assert!(saw, "status stream should still carry the line");
    }
}
