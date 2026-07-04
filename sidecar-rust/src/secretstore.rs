use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use serde::{Deserialize, Serialize};
use crate::paths::home_dir;

/// The OS keychain service name under which zWork stores provider credentials.
const KEYRING_SERVICE: &str = "zwork";

/// Process-lifetime cache of resolved keychain values.
///
/// Without this, every `settings::load()` (which happens on most API
/// endpoints, every chat turn, and every 60s scheduler tick) re-queries the
/// OS keychain for all 11 known credentials. On macOS each `get_password`
/// against an existing keychain item can surface the
/// "<binary> wants to use your confidential information stored in 'zwork'"
/// authorization prompt — so a cold launch (which fires 3 concurrent
/// `settings::load()` calls during frontend bootstrap) produced ~33 prompts,
/// and every subsequent chat/scheduler tick added ~11 more.
///
/// We cache by credential name after the first resolution so the keychain is
/// touched at most once per credential per process start. The cache is kept
/// in sync by `keyring_set` / `keyring_delete`, so writes/deletes remain
/// coherent for the rest of the process lifetime.
static KEYRING_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, String>> {
    KEYRING_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Deserialize, Default)]
struct SecretData {
    #[serde(default)]
    api_keys: HashMap<String, String>,
}

fn secret_file_path() -> PathBuf {
    home_dir().join("secrets.json")
}

fn read_secrets_file() -> HashMap<String, String> {
    let path = secret_file_path();
    if !path.exists() {
        return HashMap::new();
    }
    match fs::read_to_string(&path) {
        Ok(content) => {
            let data: SecretData = serde_json::from_str(&content).unwrap_or_default();
            data.api_keys
        }
        Err(_) => HashMap::new(),
    }
}

fn write_secrets_file(keys: &HashMap<String, String>) {
    let path = secret_file_path();
    let data = SecretData { api_keys: keys.clone() };
    if let Ok(content) = serde_json::to_string_pretty(&data) {
        let _ = fs::write(&path, content);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
    }
}

/// Read one secret from the OS keyring. Returns `None` if the keyring is
/// unavailable (headless Linux without a Secret Service, sandboxed env, etc.)
/// or the entry doesn't exist. Results are cached for the process lifetime
/// to avoid repeated keychain authorization prompts on macOS — see
/// `KEYRING_CACHE`.
fn keyring_get(credential: &str) -> Option<String> {
    if let Some(v) = cache().lock().ok().and_then(|c| c.get(credential).cloned()) {
        // Empty string is our cache's sentinel for "resolved, but absent from
        // the keychain" — it prevents re-querying a missing entry on every call.
        if v.is_empty() {
            return None;
        }
        return Some(v);
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, credential).ok()?;
    let resolved = entry.get_password().ok();
    if let Some(ref v) = resolved {
        cache().lock().ok().map(|mut c| c.insert(credential.to_string(), v.clone()));
    } else {
        // Cache the miss as an empty string so we don't keep prompting for a
        // credential that isn't stored in the keychain.
        cache().lock().ok().map(|mut c| c.insert(credential.to_string(), String::new()));
    }
    resolved
}

/// Write one secret to the OS keyring. Best-effort: silently no-ops if the
/// keyring backend is unavailable. Updates the process cache so subsequent
/// reads don't re-query the keychain.
fn keyring_set(credential: &str, value: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, credential) {
        if entry.set_password(value).is_ok() {
            cache().lock().ok().map(|mut c| c.insert(credential.to_string(), value.to_string()));
        }
    }
}

/// Delete one secret from the OS keyring. Best-effort. Updates the process
/// cache so subsequent reads reflect the deletion.
fn keyring_delete(credential: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, credential) {
        let _ = entry.delete_credential();
    }
    cache().lock().ok().map(|mut c| c.insert(credential.to_string(), String::new()));
}

#[allow(dead_code)]
pub fn get_api_key(credential: &str) -> String {
    if credential.is_empty() {
        return String::new();
    }
    // Prefer the keyring; fall back to the file store.
    if let Some(v) = keyring_get(credential) {
        return v;
    }
    read_secrets_file().get(credential).cloned().unwrap_or_default()
}

/// Persist a credential. Writes to BOTH the keyring (primary) and the file
/// store (fallback) so a missing keyring backend never loses the secret —
/// matching the Python backend's `auto` sync behavior.
pub fn set_api_key(credential: &str, value: &str) {
    if credential.is_empty() {
        return;
    }
    if value.is_empty() {
        delete_api_key(credential);
        return;
    }
    keyring_set(credential, value);
    let mut current = read_secrets_file();
    current.insert(credential.to_string(), value.to_string());
    write_secrets_file(&current);
}

pub fn delete_api_key(credential: &str) {
    keyring_delete(credential);
    let mut current = read_secrets_file();
    current.remove(credential);
    write_secrets_file(&current);
}

pub fn load_api_keys(credentials: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let file_secrets = read_secrets_file();
    for credential in credentials.keys() {
        // 1. Try the OS keyring first.
        if let Some(v) = keyring_get(credential) {
            if !v.is_empty() {
                out.insert(credential.clone(), v);
                continue;
            }
        }
        // 2. Fall back to the file store.
        if let Some(v) = file_secrets.get(credential) {
            if !v.is_empty() {
                out.insert(credential.clone(), v.clone());
                // Migrate into the keyring if it's available.
                keyring_set(credential, v);
                continue;
            }
        }
        // 3. Legacy fallback: plaintext value in the settings map itself.
        if let Some(legacy) = credentials.get(credential) {
            if !legacy.is_empty() {
                out.insert(credential.clone(), legacy.clone());
                set_api_key(credential, legacy);
            }
        }
    }
    out
}

