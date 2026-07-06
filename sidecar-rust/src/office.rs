//! `desktop_office` tool — semantic Word (.docx) and Excel (.xlsx) editing
//! without a GUI. Shells out to Python (`python-docx` / `openpyxl`) since there
//! is no pure-Rust equivalent and the export handlers already rely on the same
//! libs. Mirrors the Python `dctl_office` action set.

use serde_json::{json, Value};
use std::time::Duration;

/// Run an inline Python script and return (stdout, stderr, ok).
async fn run_python(script: &str) -> (String, String, bool) {
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("python3").arg("-c").arg(script).output(),
    )
    .await;
    match out {
        Ok(Ok(o)) => (
            String::from_utf8_lossy(&o.stdout).to_string(),
            String::from_utf8_lossy(&o.stderr).to_string(),
            o.status.success(),
        ),
        Ok(Err(e)) => (String::new(), e.to_string(), false),
        Err(_) => (String::new(), "Timed out (30s)".to_string(), false),
    }
}

/// Escape a string for safe embedding in a Python single-quoted literal.
fn pylit(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// Dispatch an office action. Returns a human-readable result string.
pub async fn execute(params: &Value) -> Result<String, String> {
    let kind = params.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("Missing 'path' parameter".to_string());
    }

    match kind {
        "word" => word_action(action, params, path).await,
        "excel" => excel_action(action, params, path).await,
        "libreoffice" => {
            // LibreOffice: treat word/xlsx files the same way (python-docx /
            // openpyxl read the OOXML regardless of which suite authored them).
            if path.ends_with(".xlsx") {
                excel_action(action, params, path).await
            } else {
                word_action(action, params, path).await
            }
        }
        _ => Err(format!("Unknown office type '{}': use 'word', 'excel', or 'libreoffice'", kind)),
    }
}

async fn word_action(action: &str, params: &Value, path: &str) -> Result<String, String> {
    let p = pylit(path);
    match action {
        "read" | "inspect" | "paragraphs" => {
            let script = format!(
                "from docx import Document\n\
                 d = Document({p})\n\
                 for i, para in enumerate(d.paragraphs):\n\
                 \x20   print(f'[{{i}}] {{para.style.name}}: {{para.text}}')\n",
                p = p
            );
            let (out, err, ok) = run_python(&script).await;
            if ok { Ok(out) } else { Err(err) }
        }
        "append" => {
            let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let script = format!(
                "from docx import Document\n\
                 d = Document({p})\n\
                 d.add_paragraph({t})\n\
                 d.save({p})\n\
                 print('Appended paragraph')\n",
                p = p, t = pylit(text)
            );
            let (out, err, ok) = run_python(&script).await;
            if ok { Ok(out.trim().to_string()) } else { Err(err) }
        }
        "set-paragraph" => {
            let idx = params.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let script = format!(
                "from docx import Document\n\
                 d = Document({p})\n\
                 if {idx} < len(d.paragraphs):\n\
                 \x20   d.paragraphs[{idx}].text = {t}\n\
                 \x20   d.save({p})\n\
                 \x20   print('Updated paragraph {idx}')\n\
                 else:\n\
                 \x20   print('ERROR: index out of range')\n",
                p = p, idx = idx, t = pylit(text)
            );
            let (out, err, ok) = run_python(&script).await;
            if ok {
                if out.contains("ERROR") { Err(out.trim().to_string()) } else { Ok(out.trim().to_string()) }
            } else {
                Err(err)
            }
        }
        "replace" => {
            let find = params.get("find").and_then(|v| v.as_str()).unwrap_or("");
            let repl = params.get("replace").and_then(|v| v.as_str()).unwrap_or("");
            let script = format!(
                "from docx import Document\n\
                 d = Document({p})\n\
                 count = 0\n\
                 for para in d.paragraphs:\n\
                 \x20   if {find} in para.text:\n\
                 \x20       count += para.text.count({find})\n\
                 \x20       para.text = para.text.replace({find}, {repl})\n\
                 d.save({p})\n\
                 print(f'Replaced {{count}} occurrence(s)')\n",
                p = p, find = pylit(find), repl = pylit(repl)
            );
            let (out, err, ok) = run_python(&script).await;
            if ok { Ok(out.trim().to_string()) } else { Err(err) }
        }
        _ => Err(format!("Unknown word action '{}'", action)),
    }
}

async fn excel_action(action: &str, params: &Value, path: &str) -> Result<String, String> {
    let p = pylit(path);
    match action {
        "sheets" | "inspect" | "read" => {
            let script = format!(
                "from openpyxl import load_workbook\n\
                 wb = load_workbook({p}, data_only=True)\n\
                 for ws in wb.worksheets:\n\
                 \x20   print(f'Sheet: {{ws.title}} ({{ws.max_row}}x{{ws.max_column}})')\n",
                p = p
            );
            let (out, err, ok) = run_python(&script).await;
            if ok { Ok(out) } else { Err(err) }
        }
        "write-cell" => {
            let sheet = params.get("sheet").and_then(|v| v.as_str()).unwrap_or("");
            let cell = params.get("cell").and_then(|v| v.as_str()).unwrap_or("");
            let value = params.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let script = format!(
                "from openpyxl import load_workbook\n\
                 wb = load_workbook({p})\n\
                 ws = wb[{s}] if {s} else wb.active\n\
                 ws[{c}] = {v}\n\
                 wb.save({p})\n\
                 print('Wrote cell {c}')\n",
                p = p, s = pylit(sheet), c = pylit(cell), v = pylit(value)
            );
            let (out, err, ok) = run_python(&script).await;
            if ok { Ok(out.trim().to_string()) } else { Err(err) }
        }
        "write-range" | "fill-table" => {
            // `value` holds a JSON array-of-arrays; write it starting at `cell`.
            let sheet = params.get("sheet").and_then(|v| v.as_str()).unwrap_or("");
            let cell = params.get("cell").and_then(|v| v.as_str()).unwrap_or("A1");
            let value = params.get("value").cloned().unwrap_or(json!([]));
            let script = format!(
                "import json\n\
                 from openpyxl import load_workbook\n\
                 from openpyxl.utils import range_boundaries\n\
                 wb = load_workbook({p})\n\
                 ws = wb[{s}] if {s} else wb.active\n\
                 data = json.loads({v})\n\
                 min_col, min_row, _, _ = range_boundaries({c} + ':' + {c})\n\
                 for ri, row in enumerate(data):\n\
                 \x20   for ci, val in enumerate(row):\n\
                 \x20       ws.cell(row=min_row+ri, column=min_col+ci, value=val)\n\
                 wb.save({p})\n\
                 print(f'Wrote {{len(data)}} row(s) starting at {c}')\n",
                p = p, s = pylit(sheet), c = pylit(cell), v = pylit(&value.to_string())
            );
            let (out, err, ok) = run_python(&script).await;
            if ok { Ok(out.trim().to_string()) } else { Err(err) }
        }
        "locate-cell" => {
            let sheet = params.get("sheet").and_then(|v| v.as_str()).unwrap_or("");
            let find = params.get("find").and_then(|v| v.as_str()).unwrap_or("");
            let script = format!(
                "from openpyxl import load_workbook\n\
                 wb = load_workbook({p}, data_only=True)\n\
                 ws = wb[{s}] if {s} else wb.active\n\
                 found = []\n\
                 for row in ws.iter_rows():\n\
                 \x20   for c in row:\n\
                 \x20       if c.value is not None and {find} in str(c.value):\n\
                 \x20           found.append(c.coordinate)\n\
                 print(', '.join(found) if found else 'not found')\n",
                p = p, s = pylit(sheet), find = pylit(find)
            );
            let (out, err, ok) = run_python(&script).await;
            if ok { Ok(out.trim().to_string()) } else { Err(err) }
        }
        "fill-cell" => {
            // Find a row by `find` (row label), then write `replace` into `cell` column.
            let sheet = params.get("sheet").and_then(|v| v.as_str()).unwrap_or("");
            let find = params.get("find").and_then(|v| v.as_str()).unwrap_or("");
            let cell = params.get("cell").and_then(|v| v.as_str()).unwrap_or("");
            let value = params.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let script = format!(
                "from openpyxl import load_workbook\n\
                 from openpyxl.utils import column_index_from_string\n\
                 wb = load_workbook({p})\n\
                 ws = wb[{s}] if {s} else wb.active\n\
                 target_col = column_index_from_string({cell})\n\
                 written = False\n\
                 for row in ws.iter_rows():\n\
                 \x20   first = row[0].value\n\
                 \x20   if first is not None and {find} in str(first):\n\
                 \x20       ws.cell(row=row[0].row, column=target_col, value={v})\n\
                 \x20       written = True\n\
                 \x20       break\n\
                 wb.save({p})\n\
                 print('Wrote cell' if written else 'row not found')\n",
                p = p, s = pylit(sheet), cell = pylit(cell), find = pylit(find), v = pylit(value)
            );
            let (out, err, ok) = run_python(&script).await;
            if ok { Ok(out.trim().to_string()) } else { Err(err) }
        }
        _ => Err(format!("Unknown excel action '{}'", action)),
    }
}
