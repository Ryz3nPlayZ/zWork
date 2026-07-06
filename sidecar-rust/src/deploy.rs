//! `deploy_web_app` tool — serve a local web app and return its URL.
//!
//! Inspects the project directory: if it has a `package.json` with a `dev` or
//! `start` script, runs that (npm); otherwise falls back to a static
//! `http.server` over `index.html`. Mirrors the Python `_deploy_web_app`.

use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, Instant};

/// Find the first free port among the preferred list, else pick any OS-assigned
/// port (0). Returns the bound port.
fn pick_free_port(preferred: &[u16]) -> u16 {
    for &port in preferred {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    // Fallback: let the OS assign one.
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(0)
}

/// Poll localhost:port until it accepts a connection or the timeout expires.
async fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

/// Start a detached background server. Uses `sh -c` so the model's command
/// (including env vars like `PORT=5173 npm run dev`) parses correctly.
fn run_background(command: &str, cwd: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg(command).current_dir(cwd);
        unsafe {
            cmd.pre_exec(|| {
                // Detach into a new session so we don't tie the process group
                // to the backend (it must survive the agent turn ending).
                libc_setsid();
                Ok(())
            });
        }
        // Redirect stdio so the child doesn't inherit the backend's pipes.
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let _ = cmd.spawn();
    }
    #[cfg(not(unix))]
    {
        // Windows: spawn detached via CREATE_NO_WINDOW.
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg(command).current_dir(cwd);
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        let _ = cmd.spawn();
    }
}

#[cfg(unix)]
unsafe fn libc_setsid() {
    // Detach from the controlling terminal/process group so the server keeps
    // running after the agent turn ends. `nix` is already a dependency.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = nix::unistd::setsid();
    }
}

/// Expand a leading `~/` to the user's home directory. Returns the input
/// unchanged if there's nothing to expand or the home dir can't be resolved.
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

/// Deploy a web app from a project directory. Returns a JSON object with
/// `ok` and `message` (the URL on success, an explanation on failure).
pub async fn deploy(project_path: &str, _framework: &str) -> Value {
    // Expand a leading ~/ to the home directory without an extra dependency.
    let expanded = expand_tilde(project_path);
    let p = Path::new(&expanded);
    if !p.exists() {
        return json!({ "ok": false, "message": format!("Project path does not exist: {}", project_path) });
    }
    if !p.is_dir() {
        return json!({ "ok": false, "message": format!("Project path is not a directory: {}", project_path) });
    }

    let pkg = p.join("package.json");
    if pkg.exists() {
        if let Ok(text) = std::fs::read_to_string(&pkg) {
            if let Ok(data) = serde_json::from_str::<Value>(&text) {
                let scripts = data.get("scripts").and_then(|s| s.as_object());
                let has = |key: &str| scripts.map(|s| s.contains_key(key)).unwrap_or(false);
                if has("dev") {
                    let port = pick_free_port(&[5173, 3000, 8080]);
                    run_background(&format!("PORT={} npm run dev", port), p);
                    if wait_for_port(port, Duration::from_secs(8)).await {
                        return json!({
                            "ok": true,
                            "message": format!("Started `npm run dev` in {}. Open http://localhost:{}", p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(), port),
                            "url": format!("http://localhost:{}", port),
                        });
                    }
                    return json!({ "ok": false, "message": format!("`npm run dev` started but port {} never opened. The dev server may have crashed — check its output.", port) });
                }
                if has("start") {
                    let port = pick_free_port(&[3000, 8080]);
                    run_background(&format!("PORT={} npm start", port), p);
                    if wait_for_port(port, Duration::from_secs(8)).await {
                        return json!({
                            "ok": true,
                            "message": format!("Started `npm start` in {}. Open http://localhost:{}.", p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(), port),
                            "url": format!("http://localhost:{}", port),
                        });
                    }
                    return json!({ "ok": false, "message": format!("`npm start` started but port {} never opened. The server may have crashed — check its output.", port) });
                }
            }
        }
    }

    let index = p.join("index.html");
    if index.exists() {
        let port = pick_free_port(&[8000, 8080, 5173]);
        run_background(&format!("python3 -m http.server {}", port), p);
        if wait_for_port(port, Duration::from_secs(5)).await {
            return json!({
                "ok": true,
                "message": format!("Serving {} at http://localhost:{}", p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(), port),
                "url": format!("http://localhost:{}", port),
            });
        }
        return json!({ "ok": false, "message": format!("http.server started but port {} never opened. The process may have crashed immediately.", port) });
    }

    json!({ "ok": false, "message": format!("No index.html or package.json in {}. Nothing obvious to serve.", project_path) })
}
