// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
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
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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
        Ok(child) => {
            append_log(&format!("Dev backend spawned pid={}", child.id()));
            Some(BackendChild::Dev(child))
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

fn main() {
    configure_linux_webview_env();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(process_init())
        .plugin(UpdaterBuilder::new().build())
        .manage(Backend(Mutex::new(None)))
        .build(tauri::generate_context!())
        .expect("error while building zWork");

    let app_handle = app.handle().clone();
    if let Some(backend) = app_handle.try_state::<Backend>() {
        if let Ok(mut guard) = backend.0.lock() {
            *guard = spawn_backend(&app_handle);
        }
    }

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
