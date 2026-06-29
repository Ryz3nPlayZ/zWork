use serde_json::Value;
use std::fs;
use std::path::Path;
use tokio::process::Command;
use crate::paths::repo_root;

pub async fn execute_extract_document(params: &Value) -> Result<String, String> {
    let path_str = params.get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing parameter 'path'".to_string())?;
        
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(format!("File does not exist: {}", path_str));
    }
    
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
        
    match ext.as_str() {
        "txt" | "md" | "json" | "csv" | "py" | "js" | "ts" | "rs" | "html" | "css" | "sh" | "yaml" | "yml" => {
            // Read directly in Rust
            fs::read_to_string(path)
                .map_err(|e| format!("Failed to read plaintext file: {}", e))
        }
        "pdf" | "docx" | "xlsx" | "pptx" => {
            // Spawn Python sidecar script runner
            extract_via_python(path_str, &ext).await
        }
        _ => {
            // Default: try reading as plaintext
            match fs::read_to_string(path) {
                Ok(txt) => Ok(txt),
                Err(_) => Err(format!("Unsupported document format: '.{}'", ext)),
            }
        }
    }
}

async fn extract_via_python(file_path: &str, ext: &str) -> Result<String, String> {
    let rr = repo_root();
    
    // Resolve python executable in the repository venv
    let python_exe = if cfg!(windows) {
        rr.join(".venv").join("Scripts").join("python.exe")
    } else {
        rr.join(".venv").join("bin").join("python3")
    };
    
    let python_exe = if python_exe.exists() {
        python_exe
    } else {
        std::path::PathBuf::from("python3")
    };
    
    // inline Python script that uses pypdf, docx, openpyxl, pptx
    let script = format!(
        r#"
import sys
from pathlib import Path

path = Path(r"{file_path}")
ext = "{ext}"

def extract_pdf(p):
    import pypdf
    reader = pypdf.PdfReader(p)
    return "\n".join(page.extract_text() for page in reader.pages)

def extract_docx(p):
    import docx
    doc = docx.Document(p)
    return "\n".join(para.text for para in doc.paragraphs)

def extract_xlsx(p):
    import openpyxl
    wb = openpyxl.load_workbook(p, data_only=True)
    out = []
    for sheet in wb.worksheets:
        out.append(f"--- Sheet: {{sheet.title}} ---")
        for row in sheet.iter_rows(values_only=True):
            if any(row):
                out.append("\t".join(str(val) if val is not None else "" for val in row))
    return "\n".join(out)

def extract_pptx(p):
    import pptx
    prs = pptx.Presentation(p)
    out = []
    for i, slide in enumerate(prs.slides):
        out.append(f"--- Slide {{i+1}} ---")
        for shape in slide.shapes:
            if hasattr(shape, "text") and shape.text.strip():
                out.append(shape.text.strip())
    return "\n".join(out)

try:
    if ext == "pdf":
        print(extract_pdf(path))
    elif ext == "docx":
        print(extract_docx(path))
    elif ext == "xlsx":
        print(extract_xlsx(path))
    elif ext == "pptx":
        print(extract_pptx(path))
    else:
        print("Unsupported format")
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
"#,
        file_path = file_path,
        ext = ext
    );
    
    let mut cmd = Command::new(&python_exe);
    cmd.arg("-c").arg(&script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    
    let output = cmd.output()
        .await
        .map_err(|e| format!("Failed to launch document extractor (python): {}", e))?;
        
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let err_txt = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Python extraction failed: {}", err_txt))
    }
}
