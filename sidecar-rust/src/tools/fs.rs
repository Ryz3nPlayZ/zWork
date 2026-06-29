use serde_json::Value;
use std::fs;
use std::path::Path;

pub async fn execute_read_file(params: &Value) -> Result<String, String> {
    let path_str = params.get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'path'".to_string())?;
    
    let path = Path::new(path_str);
    let mut content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read file '{}': {}", path_str, e))?;
    
    if content.len() > 200_000 {
        content.truncate(200_000);
        content.push_str("\n…[truncated]");
    }
    Ok(content)
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

pub async fn execute_replace_file_content(params: &Value) -> Result<String, String> {
    let path_str = params.get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'path'".to_string())?;
    let target = params.get("target_content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'target_content'".to_string())?;
    let replacement = params.get("replacement_content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'replacement_content'".to_string())?;

    let path = Path::new(path_str);
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read file '{}': {}", path_str, e))?;

    // Check occurrences
    let occurrences: Vec<_> = content.match_indices(target).collect();
    if occurrences.is_empty() {
        return Err(format!("Target content not found in file '{}'", path_str));
    }

    let start_line = params.get("start_line").and_then(|v| v.as_u64()).map(|v| v as usize);
    let end_line = params.get("end_line").and_then(|v| v.as_u64()).map(|v| v as usize);

    // If start_line and end_line are provided, search within them
    let new_content = if let (Some(s_line), Some(e_line)) = (start_line, end_line) {
        if s_line == 0 || e_line < s_line {
            return Err("Invalid line range".to_string());
        }
        let lines: Vec<&str> = content.lines().collect();
        if e_line > lines.len() {
            return Err(format!("End line {} exceeds file line count {}", e_line, lines.len()));
        }
        
        // Find char range for [s_line, e_line]
        let mut char_start = 0;
        for i in 0..(s_line - 1) {
            char_start += lines[i].len() + 1; // +1 for newline character
        }
        let mut char_end = char_start;
        for i in (s_line - 1)..e_line {
            if i < lines.len() {
                char_end += lines[i].len() + 1;
            }
        }

        // Substring to search in
        let search_area = &content[char_start..char_end.min(content.len())];
        if !search_area.contains(target) {
            return Err(format!("Target content not found in lines {}-{}", s_line, e_line));
        }

        let occurrences_in_range: Vec<_> = search_area.match_indices(target).collect();
        if occurrences_in_range.len() > 1 {
            return Err(format!("Target content matches multiple times in lines {}-{}", s_line, e_line));
        }

        // Perform the replacement
        let replaced_area = search_area.replace(target, replacement);
        let mut result = content[..char_start].to_string();
        result.push_str(&replaced_area);
        result.push_str(&content[char_end.min(content.len())..]);
        result
    } else {
        if occurrences.len() > 1 {
            return Err(format!(
                "Target content matches {} times. Please specify start_line and end_line to disambiguate.",
                occurrences.len()
            ));
        }
        content.replace(target, replacement)
    };

    fs::write(path, &new_content)
        .map(|_| format!("Successfully replaced target content in {}", path_str))
        .map_err(|e| format!("Failed to write updated content to '{}': {}", path_str, e))
}

pub async fn execute_grep_search(params: &Value) -> Result<String, String> {
    let query = params.get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'query'".to_string())?;
    let path_str = params.get("path")
        .and_then(|v| v.as_str())
        .unwrap_or(".");
    let is_regex = params.get("is_regex")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let case_insensitive = params.get("case_insensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let path = Path::new(path_str);
    if !path.exists() {
        return Err(format!("Path '{}' does not exist", path_str));
    }

    // Compile regex
    let re = if is_regex {
        let pattern = if case_insensitive {
            format!("(?i){}", query)
        } else {
            query.to_string()
        };
        regex::Regex::new(&pattern).map_err(|e| format!("Invalid regex: {}", e))?
    } else {
        let escaped = regex::escape(query);
        let pattern = if case_insensitive {
            format!("(?i){}", escaped)
        } else {
            escaped
        };
        regex::Regex::new(&pattern).unwrap()
    };

    let mut results = Vec::new();
    let mut files_checked = 0;
    
    fn visit_dirs(
        dir: &Path,
        re: &regex::Regex,
        results: &mut Vec<String>,
        files_checked: &mut usize,
    ) -> std::io::Result<()> {
        if dir.is_dir() {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if name.starts_with('.') && name != ".env" && name != ".gitignore" {
                    continue; // Skip hidden dirs (except standard dotfiles)
                }
                if name == "target" || name == "node_modules" || name == ".git" || name == ".cargo_cache" || name == ".venv" || name == "dist" || name == "build" {
                    continue; // Skip common heavy dirs
                }
                if path.is_dir() {
                    visit_dirs(&path, re, results, files_checked)?;
                } else {
                    *files_checked += 1;
                    if let Ok(content) = fs::read_to_string(&path) {
                        for (idx, line) in content.lines().enumerate() {
                            if re.is_match(line) {
                                let relative = path.to_string_lossy().to_string();
                                results.push(format!("{}:{}:{}", relative, idx + 1, line.trim_end()));
                                if results.len() >= 100 {
                                    return Ok(()); // Limit results to 100
                                }
                            }
                        }
                    }
                }
                if results.len() >= 100 {
                    return Ok(());
                }
            }
        } else {
            *files_checked += 1;
            if let Ok(content) = fs::read_to_string(dir) {
                for (idx, line) in content.lines().enumerate() {
                    if re.is_match(line) {
                        let relative = dir.to_string_lossy().to_string();
                        results.push(format!("{}:{}:{}", relative, idx + 1, line.trim_end()));
                    }
                }
            }
        }
        Ok(())
    }

    let _ = visit_dirs(path, &re, &mut results, &mut files_checked);
    
    if results.is_empty() {
        Ok(format!("No matches found for query '{}' across {} files.", query, files_checked))
    } else {
        Ok(results.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[tokio::test]
    async fn test_replace_file_content_success() {
        let temp_dir = std::env::temp_dir().join(format!("test_replace_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("hello.txt");
        fs::write(&file_path, "line 1\nline 2\nline 3\n").unwrap();

        let params = json!({
            "path": file_path.to_str().unwrap(),
            "target_content": "line 2",
            "replacement_content": "line 2 modified"
        });

        let res = execute_replace_file_content(&params).await;
        assert!(res.is_ok());
        let content = fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "line 1\nline 2 modified\nline 3\n");

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[tokio::test]
    async fn test_replace_file_content_with_lines() {
        let temp_dir = std::env::temp_dir().join(format!("test_replace_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("hello.txt");
        fs::write(&file_path, "line 1\ntarget\nline 3\ntarget\n").unwrap();

        // Target content matches multiple, but start_line and end_line narrow it down to the first instance
        let params = json!({
            "path": file_path.to_str().unwrap(),
            "target_content": "target",
            "replacement_content": "replaced",
            "start_line": 1,
            "end_line": 3
        });

        let res = execute_replace_file_content(&params).await;
        assert!(res.is_ok());
        let content = fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "line 1\nreplaced\nline 3\ntarget\n");

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[tokio::test]
    async fn test_grep_search() {
        let temp_dir = std::env::temp_dir().join(format!("test_grep_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("hello.txt");
        fs::write(&file_path, "some search string\nother line\n").unwrap();

        let params = json!({
            "path": temp_dir.to_str().unwrap(),
            "query": "search string"
        });

        let res = execute_grep_search(&params).await;
        assert!(res.is_ok());
        let output = res.unwrap();
        assert!(output.contains("some search string"));

        fs::remove_dir_all(&temp_dir).unwrap();
    }
}

