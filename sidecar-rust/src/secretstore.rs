use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::paths::home_dir;

#[derive(Serialize, Deserialize, Default)]
struct SecretData {
    #[serde(default)]
    api_keys: HashMap<String, String>,
}

fn secret_file_path() -> PathBuf {
    home_dir().join("secrets.json")
}

// ──────────────────────────────────────────────────────────────────────────
// Keychain backend (macOS only)
//
// Secrets are stored as generic-password items in the user's keychain under
// the service "zWork". This is the same model 1Password / Sequel Ace / most
// native Mac apps use, and it means the keys are encrypted at rest, gated
// behind the user's login, and survive app reinstalls. On every other
// platform (Linux/Windows) — and as a fallback when the keychain is locked
// or unavailable — we use the original plaintext `secrets.json` (mode 0600).
//
// Migration is transparent: `get_api_key` checks the keychain first, then
// falls back to the file. When a key is found in the file but not the
// keychain, `set_api_key` writes it to the keychain and prunes it from the
// file, so legacy installs upgrade on first contact without any UI change.
// ──────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords::{get_generic_password, set_generic_password, delete_generic_password};

    const SERVICE: &str = "zWork";

    /// Read a secret from the macOS keychain. Returns `None` if not found or
    /// if the keychain is locked/unavailable (caller falls back to the file).
    pub fn get(account: &str) -> Option<String> {
        match get_generic_password(SERVICE, account) {
            Ok(bytes) => String::from_utf8(bytes).ok().filter(|s| !s.is_empty()),
            // errItemNotFound is the normal "absent" case; other errors
            // (auth cancelled, keychain locked) mean we should fall back.
            Err(_) => None,
        }
    }

    /// Write a secret to the keychain. Returns false if the write failed so
    /// the caller can fall back to the file store rather than dropping the
    /// secret on the floor.
    pub fn set(account: &str, value: &str) -> bool {
        set_generic_password(SERVICE, account, value.as_bytes()).is_ok()
    }

    /// Delete a secret from the keychain. Best-effort; absence is not an error.
    pub fn delete(account: &str) {
        let _ = delete_generic_password(SERVICE, account);
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    // Non-macOS: no keychain backend. All access falls through to the file
    // store, so these always report "absent" on read and "unsupported" on write.
    pub fn get(_account: &str) -> Option<String> { None }
    pub fn set(_account: &str, _value: &str) -> bool { false }
    pub fn delete(_account: &str) {}
}

// ──────────────────────────────────────────────────────────────────────────
// File backend (fallback + cross-platform)
// ──────────────────────────────────────────────────────────────────────────

fn read_file_secrets() -> HashMap<String, String> {
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

fn write_file_secrets(keys: &HashMap<String, String>) {
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

// ──────────────────────────────────────────────────────────────────────────
// Public API (keychain-first, file-fallback, transparent migration)
// ──────────────────────────────────────────────────────────────────────────

#[allow(dead_code)]
pub fn get_api_key(credential: &str) -> String {
    if credential.is_empty() {
        return String::new();
    }
    // 1. Keychain (macOS). On other platforms this is always None and we
    //    skip straight to the file.
    if let Some(val) = keychain::get(credential) {
        return val;
    }
    // 2. File fallback.
    let secrets = read_file_secrets();
    if let Some(val) = secrets.get(credential) {
        if !val.is_empty() {
            // Transparent migration: promote the legacy file entry into the
            // keychain so we never read it from plaintext again. Best-effort —
            // if the keychain write fails we leave the file copy in place.
            if keychain::set(credential, val) {
                // Prune from the file so it only lives in the keychain now.
                let mut pruned = secrets.clone();
                pruned.remove(credential);
                write_file_secrets(&pruned);
            }
            return val.clone();
        }
    }
    String::new()
}

pub fn set_api_key(credential: &str, value: &str) {
    if credential.is_empty() {
        return;
    }
    if value.is_empty() {
        // Deletion: remove from both stores so a cleared key is fully gone.
        keychain::delete(credential);
        let mut current = read_file_secrets();
        if current.remove(credential).is_some() {
            write_file_secrets(&current);
        }
        return;
    }
    // Write to the keychain when available; otherwise (or on failure) keep
    // the plaintext file copy so the secret is never lost.
    if !keychain::set(credential, value) {
        let mut current = read_file_secrets();
        current.insert(credential.to_string(), value.to_string());
        write_file_secrets(&current);
    } else {
        // Keychain write succeeded — make sure no stale plaintext copy remains.
        let mut current = read_file_secrets();
        if current.remove(credential).is_some() {
            write_file_secrets(&current);
        }
    }
}

#[allow(dead_code)]
pub fn delete_api_key(credential: &str) {
    set_api_key(credential, "");
}

pub fn load_api_keys(credentials: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let file_secrets = read_file_secrets();
    for credential in credentials.keys() {
        // Keychain first, then file, then legacy in-place credential map.
        if let Some(val) = keychain::get(credential) {
            if !val.is_empty() {
                out.insert(credential.clone(), val);
                continue;
            }
        }
        if let Some(val) = file_secrets.get(credential) {
            if !val.is_empty() {
                out.insert(credential.clone(), val.clone());
                // Migrate file → keychain opportunistically.
                if keychain::set(credential, val) {
                    let mut pruned = file_secrets.clone();
                    pruned.remove(credential);
                    write_file_secrets(&pruned);
                }
                continue;
            }
        }
        // Legacy fallback: key present directly in the credential map.
        if let Some(legacy) = credentials.get(credential) {
            if !legacy.is_empty() {
                out.insert(credential.clone(), legacy.clone());
                // Migrate to the secret store (keychain → file).
                set_api_key(credential, legacy);
            }
        }
    }
    out
}
