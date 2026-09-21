//! Port of pi `core/tools/bash.ts` + `utils/shell.ts` (Unix only).
//!
//! The command runs in its own process group via `bash -c`; on abort or
//! timeout the whole group is killed with SIGKILL. stdout and stderr are
//! merged into an [`OutputAccumulator`], and `on_update` is throttled to
//! one snapshot per 100ms.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::harness::agent_types::{AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolFuture};
use crate::harness::types::{AbortSignal, UserContent};

use super::output_accumulator::{OutputAccumulator, OutputAccumulatorOptions, OutputSnapshot};
use super::truncate::{format_size, TruncatedBy, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES};

pub const BASH_SNIPPET: &str = "Execute bash commands (ls, grep, find, etc.)";
pub const BASH_UPDATE_THROTTLE_MS: u64 = 100;

pub struct BashTool {
    cwd: PathBuf,
    /// Prepended to every command (pi `commandPrefix`), e.g. shell setup.
    command_prefix: Option<String>,
    /// Extra environment for the child.
    env: Vec<(String, String)>,
    description: String,
}

impl BashTool {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            command_prefix: None,
            env: Vec::new(),
            description: format!(
                "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last {} lines or {}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
                DEFAULT_MAX_LINES,
                DEFAULT_MAX_BYTES / 1024
            ),
        }
    }

    pub fn with_command_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.command_prefix = Some(prefix.into());
        self
    }

    pub fn with_env(mut self, env: Vec<(String, String)>) -> Self {
        self.env = env;
        self
    }
}

#[derive(serde::Deserialize)]
struct BashArgs {
    command: String,
    #[serde(default)]
    timeout: Option<f64>,
}

fn kill_process_group(pid: u32) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    let pgid = Pid::from_raw(pid as i32);
    if killpg(pgid, Signal::SIGKILL).is_err() {
        let _ = nix::sys::signal::kill(pgid, Signal::SIGKILL);
    }
}

enum ExecOutcome {
    Exited(Option<i32>),
    Aborted,
    TimedOut(u64),
}

struct Updater {
    on_update: AgentToolUpdateCallback,
    last_update_at: Option<Instant>,
    dirty: bool,
}

impl Updater {
    fn emit(&mut self, output: &mut OutputAccumulator) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        self.last_update_at = Some(Instant::now());
        let snapshot = output.snapshot(true);
        (self.on_update)(AgentToolResult {
            content: vec![UserContent::text(snapshot.content.clone())],
            details: json!({
                "truncation": if snapshot.truncation.truncated { json!(snapshot.truncation) } else { Value::Null },
                "fullOutputPath": snapshot.full_output_path,
            }),
            usage: None,
            terminate: None,
        });
    }

    /// Returns `true` when a snapshot should be emitted now, `false` when the
    /// caller should wait for the throttle window.
    fn mark_dirty(&mut self) -> bool {
        self.dirty = true;
        match self.last_update_at {
            Some(t) => t.elapsed() >= Duration::from_millis(BASH_UPDATE_THROTTLE_MS),
            None => true,
        }
    }
}

fn format_output(snapshot: &OutputSnapshot, last_line_bytes: usize, empty_text: &str) -> (String, Value) {
    let truncation = &snapshot.truncation;
    let mut text = if snapshot.content.is_empty() { empty_text.to_string() } else { snapshot.content.clone() };
    let mut details = Value::Null;
    if truncation.truncated {
        details = json!({ "truncation": truncation, "fullOutputPath": snapshot.full_output_path });
        let start_line = truncation.total_lines - truncation.output_lines + 1;
        let end_line = truncation.total_lines;
        let full = snapshot.full_output_path.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
        if truncation.last_line_partial {
            text.push_str(&format!(
                "\n\n[Showing last {} of line {end_line} (line is {}). Full output: {full}]",
                format_size(truncation.output_bytes),
                format_size(last_line_bytes)
            ));
        } else if truncation.truncated_by == Some(TruncatedBy::Lines) {
            text.push_str(&format!(
                "\n\n[Showing lines {start_line}-{end_line} of {}. Full output: {full}]",
                truncation.total_lines
            ));
        } else {
            text.push_str(&format!(
                "\n\n[Showing lines {start_line}-{end_line} of {} ({} limit). Full output: {full}]",
                truncation.total_lines,
                format_size(DEFAULT_MAX_BYTES)
            ));
        }
    }
    (text, details)
}

fn append_status(text: &str, status: &str) -> String {
    if text.is_empty() {
        status.to_string()
    } else {
        format!("{text}\n\n{status}")
    }
}

impl AgentTool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to execute" },
                "timeout": { "type": "number", "description": "Timeout in seconds (optional, no default timeout)" }
            },
            "required": ["command"]
        })
    }
    fn prompt_snippet(&self) -> Option<&str> {
        Some(BASH_SNIPPET)
    }
    fn execute<'a>(&'a self, _id: &'a str, params: Value, signal: Option<&'a AbortSignal>, on_update: AgentToolUpdateCallback) -> ToolFuture<'a> {
        Box::pin(async move {
            let args: BashArgs = serde_json::from_value(params).map_err(|e| format!("Invalid bash arguments: {e}"))?;
            let command = match &self.command_prefix {
                Some(p) => format!("{p}\n{}", args.command),
                None => args.command.clone(),
            };
            let timeout_secs = args.timeout.filter(|t| *t > 0.0).map(|t| t.ceil() as u64);

            let output = Arc::new(Mutex::new(OutputAccumulator::new(OutputAccumulatorOptions {
                temp_file_prefix: Some("zwork-bash".into()),
                ..Default::default()
            })));
            let updater = Arc::new(Mutex::new(Updater { on_update: on_update.clone(), last_update_at: None, dirty: false }));
            on_update(AgentToolResult { content: vec![], details: Value::Null, usage: None, terminate: None });

            let mut cmd = Command::new("bash");
            cmd.arg("-c").arg(&command).current_dir(&self.cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
            cmd.process_group(0);
            cmd.kill_on_drop(true);
            for (k, v) in &self.env {
                cmd.env(k, v);
            }
            let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn bash: {e}"))?;
            let pid = child.id().unwrap_or(0);
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            // Pump both pipes into the accumulator; schedule throttled updates.
            let (delay_tx, mut delay_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
            fn pump<R: AsyncReadExt + Unpin + Send + 'static>(
                reader: Option<R>,
                output: Arc<Mutex<OutputAccumulator>>,
                updater: Arc<Mutex<Updater>>,
                delay_tx: tokio::sync::mpsc::UnboundedSender<()>,
            ) -> tokio::task::JoinHandle<()> {
                tokio::spawn(async move {
                    let Some(mut reader) = reader else { return };
                    let mut buf = [0u8; 8192];
                    loop {
                        match reader.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let mut out = output.lock().unwrap_or_else(|e| e.into_inner());
                                out.append(&buf[..n]);
                                let mut up = updater.lock().unwrap_or_else(|e| e.into_inner());
                                if up.mark_dirty() {
                                    up.emit(&mut out);
                                } else {
                                    let _ = delay_tx.send(());
                                }
                            }
                        }
                    }
                })
            }
            let h1 = pump(stdout, output.clone(), updater.clone(), delay_tx.clone());
            let h2 = pump(stderr, output.clone(), updater.clone(), delay_tx.clone());
            drop(delay_tx);

            // Throttle timer task: whenever a deferred update is requested,
            // wait out the window then emit.
            let timer = {
                let output = output.clone();
                let updater = updater.clone();
                tokio::spawn(async move {
                    while delay_rx.recv().await.is_some() {
                        let wait = {
                            let up = updater.lock().unwrap_or_else(|e| e.into_inner());
                            up.last_update_at
                                .map(|t| Duration::from_millis(BASH_UPDATE_THROTTLE_MS).saturating_sub(t.elapsed()))
                                .unwrap_or(Duration::ZERO)
                        };
                        tokio::time::sleep(wait).await;
                        // Drain any requests that piled up during the wait.
                        while delay_rx.try_recv().is_ok() {}
                        let mut out = output.lock().unwrap_or_else(|e| e.into_inner());
                        let mut up = updater.lock().unwrap_or_else(|e| e.into_inner());
                        up.emit(&mut out);
                    }
                })
            };

            let outcome = {
                let wait = child.wait();
                tokio::pin!(wait);
                let abort = async {
                    match signal {
                        Some(s) => s.cancelled().await,
                        None => std::future::pending::<()>().await,
                    }
                };
                let timeout = async {
                    match timeout_secs {
                        Some(t) => tokio::time::sleep(Duration::from_secs(t)).await,
                        None => std::future::pending::<()>().await,
                    }
                };
                tokio::select! {
                    r = &mut wait => ExecOutcome::Exited(r.ok().and_then(|s| s.code())),
                    _ = abort => { kill_process_group(pid); let _ = wait.await; ExecOutcome::Aborted }
                    _ = timeout => { kill_process_group(pid); let _ = wait.await; ExecOutcome::TimedOut(timeout_secs.unwrap_or(0)) }
                }
            };

            let _ = h1.await;
            let _ = h2.await;
            timer.abort();
            let (snapshot, last_line_bytes) = {
                let mut out = output.lock().unwrap_or_else(|e| e.into_inner());
                out.finish();
                let mut up = updater.lock().unwrap_or_else(|e| e.into_inner());
                up.emit(&mut out);
                let snap = out.snapshot(true);
                out.close_temp_file();
                (snap, out.last_line_bytes())
            };

            match outcome {
                ExecOutcome::Aborted => {
                    let (text, _) = format_output(&snapshot, last_line_bytes, "");
                    Err(append_status(&text, "Command aborted"))
                }
                ExecOutcome::TimedOut(secs) => {
                    let (text, _) = format_output(&snapshot, last_line_bytes, "");
                    Err(append_status(&text, &format!("Command timed out after {secs} seconds")))
                }
                ExecOutcome::Exited(code) => {
                    let (text, details) = format_output(&snapshot, last_line_bytes, "(no output)");
                    match code {
                        None => Err(append_status(&text, "Command terminated without an exit code")),
                        Some(0) => Ok(AgentToolResult::text(text).with_details(details)),
                        Some(c) => Err(append_status(&text, &format!("Command exited with code {c}"))),
                    }
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noop() -> AgentToolUpdateCallback {
        Arc::new(|_| {})
    }

    #[tokio::test]
    async fn runs_and_reports_exit_codes() {
        let tool = BashTool::new(std::env::temp_dir());
        let r = tool.execute("1", json!({"command": "echo hi; echo err 1>&2"}), None, noop()).await.unwrap();
        let text = r.text_content();
        assert!(text.contains("hi") && text.contains("err"), "{text}");
        let r = tool.execute("2", json!({"command": "true"}), None, noop()).await.unwrap();
        assert_eq!(r.text_content(), "(no output)");
        let err = tool.execute("3", json!({"command": "echo boom; exit 3"}), None, noop()).await.unwrap_err();
        // Untruncated output keeps its trailing newline (pi parity).
        assert_eq!(err, "boom\n\n\nCommand exited with code 3");
    }

    #[tokio::test]
    async fn timeout_and_abort_kill_the_group() {
        let tool = BashTool::new(std::env::temp_dir());
        let start = Instant::now();
        let err = tool.execute("1", json!({"command": "sleep 5", "timeout": 1}), None, noop()).await.unwrap_err();
        assert_eq!(err, "Command timed out after 1 seconds");
        assert!(start.elapsed() < Duration::from_secs(4));

        let signal = AbortSignal::new();
        let s2 = signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            s2.abort();
        });
        let err = tool.execute("2", json!({"command": "echo partial; sleep 5"}), Some(&signal), noop()).await.unwrap_err();
        assert_eq!(err, "partial\n\n\nCommand aborted");
    }

    #[tokio::test]
    async fn streams_updates() {
        let tool = BashTool::new(std::env::temp_dir());
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let s = seen.clone();
        let cb: AgentToolUpdateCallback = Arc::new(move |r| s.lock().unwrap().push(r.text_content()));
        tool.execute("1", json!({"command": "echo a; sleep 0.3; echo b"}), None, cb).await.unwrap();
        let seen = seen.lock().unwrap();
        assert!(seen.iter().any(|t| t == "a\n" || t == "a"), "{seen:?}");
        assert!(seen.last().unwrap().contains("b"));
    }
}
