//! zWork's managed runtime: a Python with the document and data libraries,
//! plus Node, installed on first launch into `~/.zwork/runtime`.
//!
//! The people zWork is for have never installed a developer tool. Without
//! this, `python3` on a stock Mac is a stub that asks to install Xcode tools,
//! Word/Excel/PowerPoint generation has no libraries, and every `npx` / `uvx`
//! MCP server fails to start. Nothing global is touched: the pieces live in
//! one folder, downloads are checksum-verified, and [`path_dirs`] puts them on
//! `PATH` — the Python venv ahead of the system (so `python3` is one that has
//! the libraries), Node and uv behind it (so a developer's own toolchain wins).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::sync_util::Unpoison;

const PYTHON_VERSION: &str = "3.12";
/// What skills and the agent's own scripts reach for to make and read files.
const PYTHON_PACKAGES: &[&str] = &[
    "python-docx",
    "openpyxl",
    "python-pptx",
    "fpdf2",
    "pypdf",
    "pdfplumber",
    "reportlab",
    "pandas",
    "matplotlib",
    "xlsxwriter",
    "markdown",
    "beautifulsoup4",
    "requests",
    "pillow",
];
const NODE_CHANNEL: &str = "latest-v22.x";
/// Bumped when the package set changes so existing installs top up.
const LAYOUT_VERSION: u32 = 1;

pub fn dir() -> PathBuf {
    crate::paths::home_dir().join("runtime")
}
fn uv_dir() -> PathBuf {
    dir().join("uv")
}
fn venv_dir() -> PathBuf {
    dir().join("venv")
}
fn node_dir() -> PathBuf {
    dir().join("node")
}
fn marker() -> PathBuf {
    dir().join("ready.json")
}
fn bin(d: PathBuf) -> PathBuf {
    if cfg!(windows) {
        d.join("Scripts")
    } else {
        d.join("bin")
    }
}

/// `(ahead of the user's PATH, behind it)`. Listed whether or not installed
/// yet: PATH is fixed at startup and the shell skips missing directories.
pub fn path_dirs() -> (Vec<PathBuf>, Vec<PathBuf>) {
    (vec![bin(venv_dir())], vec![bin(node_dir()), uv_dir()])
}

/// Environment for every child process, so `uv` / `uvx` (MCP servers, the
/// agent's scripts) use managed Pythons and never probe the macOS stub.
pub fn process_env() -> Vec<(&'static str, PathBuf)> {
    vec![("UV_PYTHON_INSTALL_DIR", dir().join("python")), ("UV_CACHE_DIR", dir().join("cache"))]
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    Missing,
    Installing { step: String },
    Ready { python: String, node: String },
    Failed { error: String },
    Unsupported,
}

static PROGRESS: Mutex<Option<Status>> = Mutex::new(None);

fn set(status: Status) {
    *PROGRESS.lock_unpoisoned() = Some(status);
}

pub fn status() -> Status {
    if let Some(s) = PROGRESS.lock_unpoisoned().clone() {
        if !matches!(s, Status::Ready { .. }) {
            return s;
        }
    }
    if target().is_none() {
        return Status::Unsupported;
    }
    match read_marker() {
        Some(m) if m.layout == LAYOUT_VERSION && venv_python().exists() => Status::Ready { python: m.python, node: m.node },
        _ => Status::Missing,
    }
}

pub fn venv_python() -> PathBuf {
    bin(venv_dir()).join(if cfg!(windows) { "python.exe" } else { "python3" })
}

#[derive(Serialize, serde::Deserialize)]
struct Marker {
    layout: u32,
    python: String,
    node: String,
}

fn read_marker() -> Option<Marker> {
    serde_json::from_str(&std::fs::read_to_string(marker()).ok()?).ok()
}

/// Install (or top up) in the background unless already ready or running.
pub fn ensure_in_background() {
    if std::env::var_os("ZWORK_NO_RUNTIME").is_some() {
        return;
    }
    match status() {
        Status::Ready { .. } | Status::Installing { .. } | Status::Unsupported => return,
        _ => {}
    }
    set(Status::Installing { step: "Starting".into() });
    tokio::spawn(async {
        match install().await {
            Ok(()) => {
                *PROGRESS.lock_unpoisoned() = None;
                tracing::info!("managed runtime ready at {}", dir().display());
                crate::connectors::mcp::retry_failed().await;
            }
            Err(e) => {
                tracing::warn!("managed runtime install failed: {e}");
                set(Status::Failed { error: e });
            }
        }
    });
}

/// `(uv target triple, node platform)` for this machine.
fn target() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(("aarch64-apple-darwin", "darwin-arm64")),
        ("macos", "x86_64") => Some(("x86_64-apple-darwin", "darwin-x64")),
        ("linux", "aarch64") => Some(("aarch64-unknown-linux-gnu", "linux-arm64")),
        ("linux", "x86_64") => Some(("x86_64-unknown-linux-gnu", "linux-x64")),
        _ => None,
    }
}

async fn install() -> Result<(), String> {
    let (uv_target, node_platform) = target().ok_or("this platform is not supported yet")?;
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let http = reqwest::Client::builder()
        .user_agent(concat!("zWork/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    // 1. uv — installs Python and packages, and runs `uvx` MCP servers.
    let uv = uv_dir().join("uv");
    if !uv.exists() {
        set(Status::Installing { step: "Downloading uv".into() });
        let base = format!("https://github.com/astral-sh/uv/releases/latest/download/uv-{uv_target}.tar.gz");
        let sum = fetch_text(&http, &format!("{base}.sha256")).await?;
        let expected = sum.split_whitespace().next().ok_or("empty uv checksum")?.to_string();
        let staged = download_verified(&http, &base, &expected, "uv").await?;
        let unpacked = untar(&staged).await?;
        let src = unpacked.join(format!("uv-{uv_target}"));
        std::fs::create_dir_all(uv_dir()).map_err(|e| e.to_string())?;
        for exe in ["uv", "uvx"] {
            std::fs::rename(src.join(exe), uv_dir().join(exe)).map_err(|e| format!("installing {exe}: {e}"))?;
        }
        let _ = std::fs::remove_dir_all(unpacked);
    }

    // 2. Python + libraries, in a venv of their own.
    let uv_cmd = |args: &[&str]| {
        let mut c = tokio::process::Command::new(&uv);
        c.args(args).envs(process_env()).env("UV_PYTHON_PREFERENCE", "only-managed").kill_on_drop(true);
        c
    };
    if !venv_python().exists() {
        set(Status::Installing { step: format!("Installing Python {PYTHON_VERSION}") });
        run(uv_cmd(&["venv", "--seed", "--python", PYTHON_VERSION, &venv_dir().to_string_lossy()]), "creating the Python environment").await?;
    }
    set(Status::Installing { step: "Installing document & data libraries".into() });
    let py = venv_python();
    let mut args = vec!["pip", "install", "--python", py.to_str().unwrap_or_default()];
    args.extend(PYTHON_PACKAGES);
    run(uv_cmd(&args), "installing Python libraries").await?;
    let python = capture(tokio::process::Command::new(&py).arg("--version")).await.unwrap_or_default();

    // 3. Node — `npx` MCP servers and JavaScript skills.
    let node_bin = bin(node_dir()).join("node");
    if !node_bin.exists() {
        set(Status::Installing { step: "Downloading Node.js".into() });
        let index = format!("https://nodejs.org/dist/{NODE_CHANNEL}");
        let sums = fetch_text(&http, &format!("{index}/SHASUMS256.txt")).await?;
        let suffix = format!("-{node_platform}.tar.gz");
        let (expected, file) = sums
            .lines()
            .filter_map(|l| l.split_once("  "))
            .find(|(_, f)| f.starts_with("node-v") && f.ends_with(&suffix))
            .ok_or("Node.js download not found for this platform")?;
        let staged = download_verified(&http, &format!("{index}/{file}"), expected, "Node.js").await?;
        let unpacked = untar(&staged).await?;
        let _ = std::fs::remove_dir_all(node_dir());
        std::fs::rename(unpacked.join(file.trim_end_matches(".tar.gz")), node_dir()).map_err(|e| format!("installing Node.js: {e}"))?;
        let _ = std::fs::remove_dir_all(unpacked);
    }
    let node = capture(tokio::process::Command::new(&node_bin).arg("--version")).await.unwrap_or_default();

    let m = Marker { layout: LAYOUT_VERSION, python: python.trim().trim_start_matches("Python ").to_string(), node: node.trim().to_string() };
    std::fs::write(marker(), serde_json::to_string_pretty(&m).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(())
}

async fn fetch_text(http: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = http.get(url).timeout(Duration::from_secs(30)).send().await.map_err(|e| format!("{url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url}: HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// Stream `url` to a staging file, reporting progress, and refuse it unless
/// its SHA-256 matches.
async fn download_verified(http: &reqwest::Client, url: &str, sha256: &str, what: &str) -> Result<PathBuf, String> {
    use tokio::io::AsyncWriteExt;
    let mut resp = http.get(url).send().await.map_err(|e| format!("downloading {what}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("downloading {what}: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let path = dir().join(format!("download-{}.tar.gz", uuid::Uuid::new_v4().simple()));
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let (mut done, mut last_pct) = (0u64, u64::MAX);
    loop {
        let chunk = match tokio::time::timeout(Duration::from_secs(60), resp.chunk()).await {
            Ok(Ok(Some(c))) => c,
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(format!("downloading {what}: {e}")),
            Err(_) => return Err(format!("downloading {what}: the connection stalled")),
        };
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if total > 0 && done * 100 / total != last_pct {
            last_pct = done * 100 / total;
            set(Status::Installing { step: format!("Downloading {what} ({last_pct}%)") });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    let actual = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !actual.eq_ignore_ascii_case(sha256.trim()) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("{what} download failed its checksum; not installing it"));
    }
    Ok(path)
}

/// Unpack a verified archive next to it and delete the archive.
async fn untar(archive: &Path) -> Result<PathBuf, String> {
    let out = archive.with_extension("d");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let mut tar = tokio::process::Command::new("tar");
    tar.arg("-xzf").arg(archive).arg("-C").arg(&out);
    let result = run(tar, "unpacking").await;
    let _ = std::fs::remove_file(archive);
    result.map(|_| out)
}

async fn run(mut cmd: tokio::process::Command, what: &str) -> Result<(), String> {
    let out = tokio::time::timeout(Duration::from_secs(900), cmd.output())
        .await
        .map_err(|_| format!("{what} timed out"))?
        .map_err(|e| format!("{what}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let tail: Vec<&str> = err.lines().rev().filter(|l| !l.trim().is_empty()).take(3).collect();
    Err(format!("{what} failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" / ")))
}

async fn capture(cmd: &mut tokio::process::Command) -> Option<String> {
    let out = cmd.output().await.ok()?;
    Some(String::from_utf8_lossy(if out.stdout.is_empty() { &out.stderr } else { &out.stdout }).into_owned())
}
