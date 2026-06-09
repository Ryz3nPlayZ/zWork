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

fn read_secrets() -> HashMap<String, String> {
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

fn write_secrets(keys: HashMap<String, String>) {
    let path = secret_file_path();
    let data = SecretData { api_keys: keys };
    if let Ok(content) = serde_json::to_string_pretty(&data) {
        let _ = fs::write(&path, content);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
    }
}

pub fn get_api_key(credential: &str) -> String {
    if credential.is_empty() {
        return String::new();
    }
    read_secrets().get(credential).cloned().unwrap_or_default()
}

pub fn set_api_key(credential: &str, value: &str) {
    if credential.is_empty() {
        return;
    }
    let mut current = read_secrets();
    if value.is_empty() {
        current.remove(credential);
    } else {
        current.insert(credential.to_string(), value.to_string());
    }
    write_secrets(current);
}

pub fn delete_api_key(credential: &str) {
    set_api_key(credential, "");
}

pub fn load_api_keys(credentials: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let secrets = read_secrets();
    for credential in credentials.keys() {
        if let Some(val) = secrets.get(credential) {
            if !val.is_empty() {
                out.insert(credential.clone(), val.clone());
                continue;
            }
        }
        // Legacy fallback: if key is in the credential map directly
        if let Some(legacy) = credentials.get(credential) {
            if !legacy.is_empty() {
                out.insert(credential.clone(), legacy.clone());
                // Migrate to secret store
                set_api_key(credential, legacy);
            }
        }
    }
    out
}
