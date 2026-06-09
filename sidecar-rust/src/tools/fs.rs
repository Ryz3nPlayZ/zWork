use serde_json::Value;
use std::fs;
use std::path::Path;

pub async fn execute_read_file(params: &Value) -> Result<String, String> {
    let path_str = params.get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'path'".to_string())?;
    
    let path = Path::new(path_str);
    fs::read_to_string(path).map_err(|e| format!("Failed to read file '{}': {}", path_str, e))
}

pub async fn execute_write_file(params: &Value) -> Result<String, String> {
    let path_str = params.get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'path'".to_string())?;
    let content = params.get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'content'".to_string())?;
    
    let path = Path::new(path_str);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, content)
        .map(|_| format!("Wrote {} characters successfully to {}", content.len(), path_str))
        .map_err(|e| format!("Failed to write file '{}': {}", path_str, e))
}

pub async fn execute_list_dir(params: &Value) -> Result<String, String> {
    let path_str = params.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let path = Path::new(path_str);
    
    let entries = fs::read_dir(path)
        .map_err(|e| format!("Failed to read directory '{}': {}", path_str, e))?;
        
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env" && name != ".gitignore" {
            continue; // Ignore hidden directories/files except standard dotfiles
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if is_dir {
            dirs.push(format!("  {}/", name));
        } else {
            files.push(format!("  {} ({} bytes)", name, size));
        }
    }
    
    dirs.sort();
    files.sort();
    
    let mut result = Vec::new();
    result.push(format!("Contents of directory '{}':", path_str));
    if !dirs.is_empty() {
        result.push("Directories:".to_string());
        result.extend(dirs);
    }
    if !files.is_empty() {
        result.push("Files:".to_string());
        result.extend(files);
    }
    if result.len() == 1 {
        result.push("  (empty directory)".to_string());
    }
    
    Ok(result.join("\n"))
}
