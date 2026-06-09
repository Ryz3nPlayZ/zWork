use serde_json::Value;
use std::process::Stdio;
use tokio::process::Command;
use crate::paths::repo_root;

fn find_dctl_path() -> String {
    let rr = repo_root();
    
    // 1. Dev layout: sibling dctl folder
    let sibling = rr.parent().unwrap_or(&rr).join("dctl").join("dist").join("dctl");
    if sibling.exists() {
        return sibling.to_string_lossy().to_string();
    }
    
    // 2. Installed path
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin").join("dctl");
        if local_bin.exists() {
            return local_bin.to_string_lossy().to_string();
        }
    }
    
    // 3. Fallback to PATH
    "dctl".to_string()
}

pub async fn execute_dctl(params: &Value) -> Result<String, String> {
    let subcommand = params.get("subcommand")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'subcommand'".to_string())?;
        
    let args_val = params.get("args").and_then(|v| v.as_array());
    let mut args = Vec::new();
    args.push(subcommand.to_string());
    
    if let Some(arr) = args_val {
        for arg in arr {
            if let Some(s) = arg.as_str() {
                args.push(s.to_string());
            } else {
                args.push(arg.to_string());
            }
        }
    }
    
    let dctl_bin = find_dctl_path();
    let mut cmd = Command::new(&dctl_bin);
    cmd.args(&args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    
    let output = cmd.output()
        .await
        .map_err(|e| format!("Failed to run dctl (bin={}): {}", dctl_bin, e))?;
        
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    
    if output.status.success() {
        if stdout.is_empty() {
            Ok("Command completed successfully".to_string())
        } else {
            Ok(stdout)
        }
    } else {
        Err(format!("dctl failed: {}\n{}", stderr, stdout))
    }
}
