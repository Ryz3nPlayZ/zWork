use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::paths::home_dir;

/// The OS keychain service name under which zWork stores provider credentials.
const KEYRING_SERVICE: &str = "zwork";

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
/// or the entry doesn't exist.
fn keyring_get(credential: &str) -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, credential).ok()?;
    entry.get_password().ok()
}

/// Write one secret to the OS keyring. Best-effort: silently no-ops if the
/// keyring backend is unavailable.
fn keyring_set(credential: &str, value: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, credential) {
        let _ = entry.set_password(value);
    }
}

/// Delete one secret from the OS keyring. Best-effort.
fn keyring_delete(credential: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, credential) {
        let _ = entry.delete_credential();
    }
}

/// Read one credential. **File store first** — it never triggers OS keychain
/// prompts. The keychain is only consulted as a fallback for a credential
/// missing from the file (e.g. a value written by an older build that used
/// keychain-first).
#[allow(dead_code)]
pub fn get_api_key(credential: &str) -> String {
    if credential.is_empty() {
        return String::new();
    }
    if let Some(v) = read_secrets_file().get(credential).cloned() {
        if !v.is_empty() {
            return v;
        }
    }
    // Fallback: try the keychain. If found, migrate into the file so we never
    // touch the keychain for this credential again.
    if let Some(v) = keyring_get(credential) {
        if !v.is_empty() {
            let mut current = read_secrets_file();
            current.insert(credential.to_string(), v.clone());
            write_secrets_file(&current);
            return v;
        }
    }
    String::new()
}

/// Persist a credential. Writes to the file store FIRST (the primary,
/// prompt-free source), then best-effort mirrors into the keychain so that
/// users who prefer keychain-based tooling still see the value there.
pub fn set_api_key(credential: &str, value: &str) {
    if credential.is_empty() {
        return;
    }
    if value.is_empty() {
        delete_api_key(credential);
        return;
    }
    let mut current = read_secrets_file();
    current.insert(credential.to_string(), value.to_string());
    write_secrets_file(&current);
    // Best-effort sync to the keychain. Failures here are fine — the file is
    // authoritative for reads, so a missing keychain entry just means the
    // keychain copy is stale/absent, not that the secret is lost.
    keyring_set(credential, value);
}

pub fn delete_api_key(credential: &str) {
    let mut current = read_secrets_file();
    current.remove(credential);
    write_secrets_file(&current);
    keyring_delete(credential);
}

/// Load all known credentials. **File-first**: reads `secrets.json` once and
/// resolves everything from it. The keychain is only touched as a fallback
/// for individual credentials missing from the file, and any value found
/// there is immediately migrated into the file so the next call won't prompt.
///
/// This mirrors the old Python backend's `"file"` default mode, which was
/// deliberately chosen (commit 16cc9a4) to avoid the repeated macOS keychain
/// authorization prompts that a keychain-first read order produces.
pub fn load_api_keys(credentials: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut file_secrets = read_secrets_file();
    let mut file_dirty = false;

    for credential in credentials.keys() {
        // 1. File store first — never prompts.
        if let Some(v) = file_secrets.get(credential) {
            if !v.is_empty() {
                out.insert(credential.clone(), v.clone());
                continue;
            }
        }
        // 2. Keychain fallback. Only reached for credentials absent from the
        //    file. If found, migrate into the file so future reads stay
        //    prompt-free.
        if let Some(v) = keyring_get(credential) {
            if !v.is_empty() {
                out.insert(credential.clone(), v.clone());
                file_secrets.insert(credential.clone(), v);
                file_dirty = true;
                continue;
            }
        }
        // 3. Legacy fallback: plaintext value in the settings map itself.
        if let Some(legacy) = credentials.get(credential) {
            if !legacy.is_empty() {
                out.insert(credential.clone(), legacy.clone());
                file_secrets.insert(credential.clone(), legacy.clone());
                file_dirty = true;
                // Also seed the keychain so other keychain-aware tooling works.
                keyring_set(credential, legacy);
            }
        }
    }

    if file_dirty {
        write_secrets_file(&file_secrets);
    }

    out
}
