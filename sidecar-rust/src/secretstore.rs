//! API-key secret store — file-only, by design.
//!
//! Keys live in exactly one place: `secrets.json` (mode 0600) inside the
//! state directory (`ZWORK_HOME`, set by the app to its Application Support
//! dir; `~/.zwork` for bare CLI runs).
//!
//! macOS Keychain is deliberately NOT used and must not be re-added until the
//! app carries a stable Developer ID signature. zWork ships unsigned
//! (ad-hoc), so its code identity changes with every rebuild; keychain ACL
//! grants ("Always Allow") are partitioned by signing identity and never
//! persist for such binaries, so every read re-prompts for the login
//! password. Keychain support has now been added and removed repeatedly
//! (beta.2 → beta.5, v0.5.2) and every incarnation produced password-prompt
//! storms on launch and on every settings reload. There is no keychain code
//! in this crate at all — prompts are impossible by construction. See
//! docs/SECURITY.md before touching this.

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

fn read_file_secrets() -> HashMap<String, String> {
    let path = secret_file_path();
    let Ok(content) = fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let data: SecretData = serde_json::from_str(&content).unwrap_or_default();
    data.api_keys
}

fn write_file_secrets(keys: &HashMap<String, String>) -> bool {
    let path = secret_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = SecretData { api_keys: keys.clone() };
    let Ok(content) = serde_json::to_string_pretty(&data) else {
        return false;
    };
    if fs::write(&path, content).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    true
}

/// Read a key. The file is the only store; absent means empty.
#[allow(dead_code)]
pub fn get_api_key(credential: &str) -> String {
    if credential.is_empty() {
        return String::new();
    }
    read_file_secrets().get(credential).cloned().unwrap_or_default()
}

/// Write a key, or delete it when `value` is empty.
pub fn set_api_key(credential: &str, value: &str) {
    if credential.is_empty() {
        return;
    }
    let mut current = read_file_secrets();
    if value.is_empty() {
        current.remove(credential);
    } else {
        current.insert(credential.to_string(), value.to_string());
    }
    write_file_secrets(&current);
}

#[allow(dead_code)]
pub fn delete_api_key(credential: &str) {
    set_api_key(credential, "");
}

/// Resolve the known credentials at settings-load time: file first, then the
/// legacy in-place `api_keys` map from settings.json. A key found only in the
/// legacy map is written into the file immediately so the plaintext-in-
/// settings copy can eventually go away.
pub fn load_api_keys(credentials: &HashMap<String, String>) -> HashMap<String, String> {
    let mut file_secrets = read_file_secrets();
    let mut out = HashMap::new();
    let mut changed = false;
    for credential in credentials.keys() {
        if let Some(val) = file_secrets.get(credential) {
            if !val.is_empty() {
                out.insert(credential.clone(), val.clone());
                continue;
            }
        }
        if let Some(legacy) = credentials.get(credential) {
            if !legacy.is_empty() {
                out.insert(credential.clone(), legacy.clone());
                file_secrets.insert(credential.clone(), legacy.clone());
                changed = true;
            }
        }
    }
    if changed {
        write_file_secrets(&file_secrets);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ZWORK_HOME is process-global, so all file-store assertions run inside
    // one test to stay race-free under the parallel test harness.
    #[test]
    fn file_store_round_trip_and_legacy_migration() {
        let tmp = std::env::temp_dir().join(format!(
            "zwork-secretstore-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("ZWORK_HOME", &tmp);

        // Round trip: set → get → clear.
        set_api_key("anthropic", "sk-test-123");
        assert_eq!(get_api_key("anthropic"), "sk-test-123");
        set_api_key("anthropic", "");
        assert_eq!(get_api_key("anthropic"), "");

        // Empty-value delete leaves other keys intact.
        set_api_key("openai", "sk-keep");
        set_api_key("groq", "gsk-temp");
        set_api_key("groq", "");
        assert_eq!(get_api_key("openai"), "sk-keep");
        assert_eq!(get_api_key("groq"), "");

        // load_api_keys: file hit wins, legacy-only key migrates into the
        // file and survives a fresh load.
        set_api_key("zai", "zai-from-file");
        let mut credentials = HashMap::new();
        credentials.insert("zai".to_string(), "zai-from-legacy".to_string());
        credentials.insert("deepseek".to_string(), "ds-from-legacy".to_string());
        credentials.insert("ollama".to_string(), String::new());
        let loaded = load_api_keys(&credentials);
        assert_eq!(loaded.get("zai").unwrap(), "zai-from-file");
        assert_eq!(loaded.get("deepseek").unwrap(), "ds-from-legacy");
        assert!(!loaded.contains_key("ollama"));
        // Legacy key is now durable in the file even with an empty legacy map.
        let mut empty_legacy = HashMap::new();
        empty_legacy.insert("deepseek".to_string(), String::new());
        let reloaded = load_api_keys(&empty_legacy);
        assert_eq!(reloaded.get("deepseek").unwrap(), "ds-from-legacy");

        // File exists with 0600 permissions.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(secret_file_path())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        let _ = fs::remove_dir_all(&tmp);
        // Restore the ambient environment for any test that runs after this
        // one and touches paths::home_dir().
        std::env::remove_var("ZWORK_HOME");
    }
}
