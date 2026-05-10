// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tauri_plugin_process::init as process_init;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::Builder as UpdaterBuilder;

enum BackendChild {
    Packaged(CommandChild),
    Dev(Child),
}

impl BackendChild {
    fn pid(&self) -> u32 {
        match self {
            BackendChild::Packaged(child) => child.pid(),
            BackendChild::Dev(child) => child.id(),
        }
    }

    fn shutdown(self) {
        match self {
            BackendChild::Packaged(child) => {
                let _ = child.kill();
            }
            BackendChild::Dev(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Managed handle to the Python or packaged backend process.
struct Backend(Mutex<Option<BackendChild>>);

fn zwork_data_dir() -> PathBuf {
    if let Ok(v) = std::env::var("ZWORK_HOME") {
        return PathBuf::from(v);
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("zWork")
}

fn zwork_sidecar_home() -> PathBuf {
    zwork_data_dir().join("state")
}

fn append_log(msg: &str) {
    use std::io::Write;

    let mut base = zwork_data_dir();
    let _ = std::fs::create_dir_all(&base);
    base.push("backend.log");

    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(base)
    {
        let _ = writeln!(f, "[{}] {}", timestamp(), msg);
    }
}

fn backend_http_healthy() -> bool {
    let addr = "127.0.0.1:8787";
    let timeout = Duration::from_millis(600);
    let mut stream =
        match TcpStream::connect_timeout(&addr.parse().expect("valid backend addr"), timeout) {
            Ok(stream) => stream,
            Err(_) => return false,
        };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let _ = stream.shutdown(Shutdown::Write);

    let mut buf = [0_u8; 128];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    std::str::from_utf8(&buf[..n])
        .map(|head| head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200"))
        .unwrap_or(false)
}

fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

#[cfg(target_os = "linux")]
fn configure_linux_webview_env() {
    // Force software rendering paths to prevent WebKitWebProcess SIGABRT (Signal 6).
    // The WebProcess crashes when GPU drivers misbehave during WebGL or compositing.
    //
    // WEBKIT_DISABLE_COMPOSITING_MODE: disables the compositing thread so WebKit
    // uses a simpler single-threaded rendering path.
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

    // WEBKIT_DISABLE_DMABUF_RENDERER: disables zero-copy DMA-BUF texture sharing
    // between processes (WebKitGTK >= 2.42). Buggy kernel/DRM drivers can abort
    // the WebProcess when dmabuf allocations fail.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    // Force Mesa's software rasterizer (llvmpipe) for all OpenGL/WebGL calls
    // inside the WebProcess. This is the safest option — it avoids GPU driver
    // bugs entirely at the cost of rendering performance for 3D content.
    std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");

    // Force GTK to use the Cairo software renderer instead of OpenGL/Vulkan
    // for widget drawing. Without this, GTK may still try to create a GL
    // context, which can fail on headless or misconfigured GPU setups.
    std::env::set_var("GSK_RENDERER", "cairo");

    // On Wayland, use XWayland (GDK_BACKEND=x11) rather than native Wayland.
    // The bundled WebKitGTK's EGL initialisation crashes on native Wayland
    // compositors when the Mesa/EGL versions don't match (CI bundles ubuntu
    // libraries; user machines run Arch/Fedora/etc. with newer Mesa). XWayland
    // uses GLX which doesn't hit the same EGL code path.
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webview_env() {}

fn find_dev_repo_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ZWORK_ROOT") {
        let p = PathBuf::from(p);
        if p.join("sidecar").is_dir() && p.join(".venv").is_dir() {
            return Some(p);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = cur {
            if dir.join("sidecar").is_dir() && dir.join(".venv").is_dir() {
                return Some(dir);
            }
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let mut cur: Option<PathBuf> = Some(cwd);
        while let Some(dir) = cur {
            if dir.join("sidecar").is_dir() && dir.join(".venv").is_dir() {
                return Some(dir);
            }
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }

    if let Some(home) = dirs::home_dir() {
        let p = home.join("zwork");
        if p.join("sidecar").is_dir() && p.join(".venv").is_dir() {
            return Some(p);
        }
    }

    None
}

fn python_executable(root: &PathBuf) -> PathBuf {
    if let Ok(value) = std::env::var("ZWORK_PYTHON") {
        return PathBuf::from(value);
    }

    let python = root.join(".venv").join("bin").join("python3");
    if python.exists() {
        return python;
    }

    let python = root.join(".venv").join("bin").join("python");
    if python.exists() {
        return python;
    }

    let python = root.join(".venv").join("Scripts").join("python.exe");
    if python.exists() {
        return python;
    }

    PathBuf::from("python3")
}

fn start_packaged_backend(app: &tauri::AppHandle) -> Option<BackendChild> {
    let mut sidecar = match app.shell().sidecar("zwork-backend") {
        Ok(cmd) => cmd,
        Err(err) => {
            append_log(&format!("sidecar lookup failed: {err}"));
            return None;
        }
    };

    sidecar = sidecar
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("ZWORK_HOME", zwork_sidecar_home().display().to_string());

    match sidecar.spawn() {
        Ok((mut rx, child)) => {
            append_log("Spawning packaged backend");
            let pid = child.pid();
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            append_log(&format!(
                                "[backend stdout] {}",
                                String::from_utf8_lossy(&line)
                            ));
                        }
                        CommandEvent::Stderr(line) => {
                            append_log(&format!(
                                "[backend stderr] {}",
                                String::from_utf8_lossy(&line)
                            ));
                        }
                        _ => {}
                    }
                }
                append_log(&format!("Packaged backend output stream closed pid={pid}"));
                if let Some(backend) = app_handle.try_state::<Backend>() {
                    if let Ok(mut guard) = backend.0.lock() {
                        if guard.as_ref().map(|child| child.pid()) == Some(pid) {
                            *guard = None;
                        }
                    }
                }
            });
            Some(BackendChild::Packaged(child))
        }
        Err(err) => {
            append_log(&format!("Packaged sidecar spawn failed: {err}"));
            None
        }
    }
}

fn start_dev_backend() -> Option<BackendChild> {
    let root = find_dev_repo_root()?;
    let python_exe = python_executable(&root);
    let sidecar_home = zwork_sidecar_home();

    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open({
            let mut path = zwork_data_dir();
            let _ = std::fs::create_dir_all(&path);
            path.push("backend.log");
            path
        })
        .ok();

    let mut cmd = Command::new(&python_exe);
    cmd.current_dir(&root)
        .arg("-m")
        .arg("sidecar.server")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("ZWORK_HOME", sidecar_home.as_os_str());

    if let Some(f) = log {
        if let Ok(f2) = f.try_clone() {
            cmd.stdout(Stdio::from(f));
            cmd.stderr(Stdio::from(f2));
        }
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }

    append_log(&format!(
        "Spawning dev backend: python={} root={} zwork_home={}",
        python_exe.display(),
        root.display(),
        sidecar_home.display(),
    ));

    match cmd.spawn() {
        Ok(mut child) => {
            append_log(&format!("Dev backend spawned pid={}", child.id()));
            match child.try_wait() {
                Ok(Some(status)) => {
                    append_log(&format!("Dev backend exited immediately: {status}"));
                    None
                }
                Ok(None) => Some(BackendChild::Dev(child)),
                Err(err) => {
                    append_log(&format!("Dev backend liveness check failed: {err}"));
                    Some(BackendChild::Dev(child))
                }
            }
        }
        Err(err) => {
            append_log(&format!("Dev backend spawn failed: {err}"));
            None
        }
    }
}

fn spawn_backend(app: &tauri::AppHandle) -> Option<BackendChild> {
    if let Some(child) = start_packaged_backend(app) {
        return Some(child);
    }
    start_dev_backend()
}

fn ensure_backend_running(app: &tauri::AppHandle, backend: &Backend) -> Result<bool, String> {
    if backend_http_healthy() {
        return Ok(true);
    }

    let mut guard = backend
        .0
        .lock()
        .map_err(|_| "backend state lock poisoned".to_string())?;
    if let Some(child) = guard.take() {
        append_log(&format!(
            "Backend health check failed; stopping stale pid={}",
            child.pid()
        ));
        child.shutdown();
    }
    *guard = spawn_backend(app);
    Ok(guard.is_some())
}

fn start_backend_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));
        if let Some(backend) = app.try_state::<Backend>() {
            if !backend_http_healthy() {
                append_log("Backend watchdog detected unhealthy backend");
                let _ = ensure_backend_running(&app, &backend);
            }
        }
    });
}

fn is_http_url(url: &str) -> bool {
    if let Some((scheme, rest)) = url.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        (scheme == "http" || scheme == "https") && !rest.is_empty() && !rest.starts_with('/')
    } else {
        false
    }
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_http_url(&url) {
        return Err("only http(s) URLs may be opened externally".into());
    }
    app.shell().open(url, None).map_err(|err| err.to_string())
}

#[tauri::command]
fn ensure_backend(app: tauri::AppHandle, backend: tauri::State<Backend>) -> Result<bool, String> {
    ensure_backend_running(&app, &backend)
}

#[tauri::command]
fn restart_backend(app: tauri::AppHandle, backend: tauri::State<Backend>) -> Result<bool, String> {
    let mut guard = backend
        .0
        .lock()
        .map_err(|_| "backend state lock poisoned".to_string())?;
    if let Some(child) = guard.take() {
        child.shutdown();
    }
    *guard = spawn_backend(&app);
    Ok(guard.is_some())
}

#[tauri::command]
async fn begin_desktop_auth(app: tauri::AppHandle, start_url: String) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("failed to bind local auth callback: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("failed to resolve auth callback port: {err}"))?
        .port();

    if !is_http_url(&start_url) {
        return Err("auth start_url must be an http(s) URL".into());
    }
    let separator = if start_url.contains('?') { '&' } else { '?' };
    let launch_url = format!("{start_url}{separator}port={port}");
    app.shell()
        .open(launch_url, None)
        .map_err(|err| format!("failed to open browser: {err}"))?;

    let accept = tokio::time::timeout(Duration::from_secs(240), listener.accept())
        .await
        .map_err(|_| "sign-in timed out".to_string())?
        .map_err(|err| format!("failed to accept auth callback: {err}"))?;
    let (socket, _) = accept;

    let mut request = vec![0u8; 8192];
    let size = tokio::time::timeout(Duration::from_secs(15), socket.readable())
        .await
        .map_err(|_| "auth callback stalled".to_string())
        .and_then(|_| {
            socket
                .try_read(&mut request)
                .map_err(|err| format!("failed to read auth callback: {err}"))
        })?;

    let raw = String::from_utf8_lossy(&request[..size]);
    let path = raw
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    let query = path.split('?').nth(1).unwrap_or("");
    let mut code: Option<String> = None;
    let mut error_message: Option<String> = None;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("").replace('+', " ");
        let decoded = percent_decode(&value);
        match key {
            "code" if !decoded.is_empty() => code = Some(decoded),
            "error" if !decoded.is_empty() => error_message = Some(decoded),
            _ => {}
        }
    }

    let ok = code.is_some() && error_message.is_none();
    let html = if ok {
        "<!doctype html><html><body style=\"font-family:Georgia,serif;background:#f6efe5;color:#151313;display:grid;place-items:center;min-height:100vh;margin:0\"><div style=\"padding:24px 28px;border:1px solid rgba(21,19,19,.1);border-radius:20px;background:rgba(255,255,255,.86)\"><h1 style=\"margin:0 0 10px;font-size:28px\">Signed in</h1><p style=\"margin:0;color:#6a615b\">You can close this tab and return to zWork.</p></div></body></html>"
    } else {
        "<!doctype html><html><body style=\"font-family:Georgia,serif;background:#f6efe5;color:#151313;display:grid;place-items:center;min-height:100vh;margin:0\"><div style=\"padding:24px 28px;border:1px solid rgba(21,19,19,.1);border-radius:20px;background:rgba(255,255,255,.86)\"><h1 style=\"margin:0 0 10px;font-size:28px\">Sign-in failed</h1><p style=\"margin:0;color:#6a615b\">Return to zWork and try again.</p></div></body></html>"
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = tokio::time::timeout(Duration::from_secs(5), socket.writable()).await;
    let _ = socket.try_write(response.as_bytes());

    if let Some(message) = error_message {
        return Err(message);
    }

    code.ok_or_else(|| "missing auth code".to_string())
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // Read the two hex bytes directly. The previous version sliced
            // `&input[i+1..i+3]`, which panics when the bytes after `%` fall
            // inside a multi-byte UTF-8 character (e.g. "%é").
            if let (Some(hi), Some(lo)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod is_http_url_tests {
    use super::is_http_url;

    #[test]
    fn accepts_https_with_host() {
        assert!(is_http_url("https://example.com"));
        assert!(is_http_url("https://example.com/path?query=1"));
    }

    #[test]
    fn accepts_http_with_host() {
        assert!(is_http_url("http://example.com"));
        assert!(is_http_url("http://localhost:8080/foo"));
    }

    #[test]
    fn case_insensitive_scheme() {
        assert!(is_http_url("HTTPS://example.com"));
        assert!(is_http_url("Http://example.com"));
    }

    #[test]
    fn rejects_other_schemes() {
        // The whole point of the guard.
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("ftp://example.com"));
        assert!(!is_http_url("smb://attacker/share"));
        assert!(!is_http_url("vscode://settings"));
        assert!(!is_http_url("data:text/html,<script>alert(1)</script>"));
    }

    #[test]
    fn rejects_no_scheme() {
        assert!(!is_http_url(""));
        assert!(!is_http_url("example.com"));
        assert!(!is_http_url("/etc/passwd"));
    }

    #[test]
    fn rejects_empty_or_path_only_host() {
        // "http://" alone, or "http:///path" with no host, would be passed
        // straight to xdg-open and behave unpredictably.
        assert!(!is_http_url("http://"));
        assert!(!is_http_url("https://"));
        assert!(!is_http_url("http:///etc/passwd"));
    }
}

#[cfg(test)]
mod percent_decode_tests {
    use super::percent_decode;

    #[test]
    fn decodes_normal_escapes() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("a%2Bb%3Dc"), "a+b=c");
    }

    #[test]
    fn passes_through_plain_ascii() {
        assert_eq!(percent_decode("foo=bar&baz=1"), "foo=bar&baz=1");
    }

    #[test]
    fn passes_through_invalid_escape() {
        // %XX with non-hex digits should be left alone, not panic.
        assert_eq!(percent_decode("%XY"), "%XY");
    }

    #[test]
    fn passes_through_truncated_escape() {
        assert_eq!(percent_decode("a%"), "a%");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn does_not_panic_on_non_ascii_after_percent() {
        // Previously this panicked at "byte index is not a char boundary"
        // because &str[i+1..i+3] cuts into the middle of "é" (2 bytes in UTF-8).
        let _ = percent_decode("%é");

        // Realistic case: a query value mixing UTF-8 with valid escapes.
        // The legitimate ones still decode.
        assert_eq!(percent_decode("name=ré%C3%A9"), "name=ré\u{00e9}");
    }

    #[test]
    fn case_insensitive_hex() {
        assert_eq!(percent_decode("%2a"), "*");
        assert_eq!(percent_decode("%2A"), "*");
    }
}

fn main() {
    configure_linux_webview_env();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(process_init())
        .plugin(UpdaterBuilder::new().build())
        .invoke_handler(tauri::generate_handler![
            open_external,
            ensure_backend,
            restart_backend,
            begin_desktop_auth
        ])
        .manage(Backend(Mutex::new(None)))
        .build(tauri::generate_context!())
        .expect("error while building zWork");

    let app_handle = app.handle().clone();
    if let Some(backend) = app_handle.try_state::<Backend>() {
        if let Ok(mut guard) = backend.0.lock() {
            *guard = spawn_backend(&app_handle);
        }
    }
    start_backend_watchdog(app_handle.clone());

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(backend) = app_handle.try_state::<Backend>() {
                if let Ok(mut guard) = backend.0.lock() {
                    if let Some(child) = guard.take() {
                        child.shutdown();
                        eprintln!("[zwork] backend stopped");
                    }
                }
            }
        }
    });
}
