//! `extract_document`: the text of office files and PDFs, extracted in
//! process — no Python, no LibreOffice, nothing the user has to install.
//!
//! PDF via `pdf-extract`; Excel / OpenDocument spreadsheets via `calamine`
//! (rendered as markdown tables); Word, PowerPoint and OpenDocument text or
//! slides by reading their XML straight out of the zip. Legacy `.doc` /
//! `.rtf` go through macOS `textutil`.

use std::io::{Cursor, Read};
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::Value;

use crate::harness::tools::path_utils::expand_path;
use crate::harness::tools::truncate::truncate_or_spill;

const SCANNED_HINT: &str = " It is probably a scan or handwriting; if the model can see images, look at it with the desktop tools \
    (open the file, then desktop_capture).";

/// Pages OCR'd when the caller gives no range (about 5-10s each).
const OCR_DEFAULT_PAGES: usize = 20;
const OCR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(150);

/// Renders pages with PDFKit and reads them with the Vision framework — both
/// ship with macOS, driven through JavaScript for Automation.
const OCR_SCRIPT: &str = r#"
ObjC.import('PDFKit'); ObjC.import('Vision'); ObjC.import('AppKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (doc.isNil()) throw new Error("cannot open the PDF");
  const from = parseInt(argv[1]), to = Math.min(Number(doc.pageCount), parseInt(argv[2]));
  const pages = [];
  for (let i = from - 1; i < to; i++) {
    const page = doc.pageAtIndex(i);
    const b = page.boundsForBox(0);
    const k = Math.min(2, 2000 / Math.max(b.size.width, b.size.height));
    const img = page.thumbnailOfSizeForBox($.NSMakeSize(b.size.width * k, b.size.height * k), 0);
    const handler = $.VNImageRequestHandler.alloc.initWithDataOptions(img.TIFFRepresentation, $({}));
    const req = $.VNRecognizeTextRequest.alloc.init;
    req.recognitionLevel = 0;
    req.usesLanguageCorrection = true;
    handler.performRequestsError($([req]), null);
    const lines = [];
    const res = req.results;
    for (let j = 0; j < res.count; j++) {
      const o = res.objectAtIndex(j), bb = o.boundingBox;
      lines.push({ y: bb.origin.y + bb.size.height, x: bb.origin.x, t: o.topCandidates(1).objectAtIndex(0).string.js });
    }
    lines.sort((a, b) => (Math.abs(a.y - b.y) < 0.01 ? a.x - b.x : b.y - a.y));
    pages.push(lines.map(l => l.t).join("\n"));
  }
  return JSON.stringify(pages);
}
"#;

fn ocr_pdf(path: &Path, from: usize, to: usize) -> Result<Vec<String>, String> {
    if !cfg!(target_os = "macos") {
        return Err("OCR is only available on macOS".into());
    }
    let mut child = std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", OCR_SCRIPT])
        .arg(path)
        .args([from.to_string(), to.to_string()])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + OCR_TIMEOUT;
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out — try a smaller page range".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim()).map_err(|_| {
        let err = String::from_utf8_lossy(&out.stderr);
        err.lines().rfind(|l| l.contains("Error")).unwrap_or("no output").trim().to_string()
    })
}

/// Rows rendered per sheet before the rest are summarised.
const MAX_SHEET_ROWS: usize = 2000;

pub async fn execute_extract_document(params: &Value) -> Result<String, String> {
    let raw = params.get("path").and_then(Value::as_str).ok_or("Missing parameter 'path'")?;
    let pages = params.get("pages").and_then(Value::as_str).map(parse_range).transpose()?;
    let path = expand_path(raw);
    if !path.is_file() {
        return Err(format!("File does not exist: {}", path.display()));
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();

    let owned = path.clone();
    let ext2 = ext.clone();
    // Parsers are synchronous and pdf-extract can panic on malformed files;
    // a panicking blocking task surfaces here as a JoinError.
    let text = tokio::task::spawn_blocking(move || extract(&owned, &ext2, pages))
        .await
        .map_err(|_| format!("{name} could not be parsed (the file may be damaged or unusual)"))??;
    if text.trim().is_empty() {
        return Ok(format!("{name}: no text found.{}", if ext == "pdf" { SCANNED_HINT } else { "" }));
    }
    let out_ext = if matches!(ext.as_str(), "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" | "docx" | "pptx" | "odt" | "odp" | "html" | "htm") { "md" } else { "txt" };
    Ok(truncate_or_spill(&name, &text, out_ext))
}

fn extract(path: &Path, ext: &str, pages: Option<(usize, usize)>) -> Result<String, String> {
    match ext {
        "pdf" => pdf(path, pages),
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => spreadsheet(path),
        "docx" | "docm" => docx(&mut open_zip(path)?),
        "pptx" | "pptm" => pptx(&mut open_zip(path)?, pages),
        "odt" => odf(&mut open_zip(path)?, false, pages),
        "odp" => odf(&mut open_zip(path)?, true, pages),
        "html" | "htm" => {
            let html = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            Ok(crate::harness::tools::web_fetch::html_to_markdown(&html))
        }
        "doc" | "rtf" | "rtfd" | "wordml" | "webarchive" => textutil(path),
        _ => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            if bytes.iter().take(8000).any(|&b| b == 0) {
                return Err(format!("Unsupported document format '.{ext}' (binary file)"));
            }
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

/// "3" or "2-5" (1-based, inclusive).
fn parse_range(s: &str) -> Result<(usize, usize), String> {
    let bad = || format!("Invalid page range '{s}' (use e.g. '3' or '2-5')");
    let (a, b) = s.split_once('-').unwrap_or((s, s));
    let a: usize = a.trim().parse().map_err(|_| bad())?;
    let b: usize = if b.trim().is_empty() { usize::MAX } else { b.trim().parse().map_err(|_| bad())? };
    if a == 0 || b < a {
        return Err(bad());
    }
    Ok((a, b))
}

/// Label each unit ("Page", "Slide") and keep only the requested range.
fn number_units(units: Vec<String>, label: &str, range: Option<(usize, usize)>) -> Result<String, String> {
    let total = units.len();
    let (from, to) = range.unwrap_or((1, total.max(1)));
    if from > total {
        return Err(format!("{label} {from} is past the end (the document has {total})"));
    }
    let mut out = format!("({total} {}s)\n", label.to_lowercase());
    for (i, text) in units.into_iter().enumerate().skip(from - 1).take(to.saturating_sub(from) + 1) {
        out += &format!("\n## {label} {}\n\n{}\n", i + 1, text.trim());
    }
    Ok(out)
}

fn pdf(path: &Path, range: Option<(usize, usize)>) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes).map_err(|e| {
        let e = e.to_string();
        if e.to_lowercase().contains("encrypt") || e.to_lowercase().contains("password") {
            "This PDF is password-protected.".to_string()
        } else {
            format!("Could not read PDF: {e}")
        }
    })?;
    let pages: Vec<String> = pages.into_iter().map(|p| collapse(&p)).collect();
    let chars: usize = pages.iter().map(|p| p.chars().filter(|c| !c.is_whitespace()).count()).sum();
    if chars >= 40 * pages.len().max(1) {
        return number_units(pages, "Page", range);
    }
    // Little or no text layer: a scan or a photo of paper. OCR it.
    let total = pages.len();
    let (from, to) = range.unwrap_or((1, OCR_DEFAULT_PAGES));
    match ocr_pdf(path, from, to.min(total)) {
        Ok(ocr) if ocr.iter().any(|p| !p.trim().is_empty()) => {
            let mut units = vec![String::new(); total];
            for (i, text) in ocr.into_iter().enumerate() {
                units[from - 1 + i] = text;
            }
            let shown = to.min(total);
            let mut out = number_units(units, "Page", Some((from, shown)))?;
            out.insert_str(0, "[Scanned PDF — text below was read with OCR and may contain mistakes.]\n");
            if shown < total && range.is_none() {
                out += &format!("\n[OCR covered pages {from}-{shown} of {total}. Pass pages: \"{}-{}\" for more.]", shown + 1, (shown + OCR_DEFAULT_PAGES).min(total));
            }
            Ok(out)
        }
        Ok(_) => Ok(format!("{}\n[No readable text found, even with OCR.{SCANNED_HINT}]", number_units(pages, "Page", range)?)),
        Err(e) => Ok(format!("{}\n[Very little selectable text, and OCR failed ({e}).{SCANNED_HINT}]", number_units(pages, "Page", range)?)),
    }
}

fn spreadsheet(path: &Path) -> Result<String, String> {
    use calamine::{open_workbook_auto, Data, Reader as _};
    let mut wb = open_workbook_auto(path).map_err(|e| format!("Could not open spreadsheet: {e}"))?;
    let mut out = String::new();
    for name in wb.sheet_names() {
        let Ok(range) = wb.worksheet_range(&name) else { continue };
        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|r| {
                r.iter()
                    .map(|c| match c {
                        Data::Empty => String::new(),
                        Data::Float(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", *f as i64),
                        Data::DateTime(d) => {
                            let (y, mo, da, h, mi, s, _) = d.to_ymd_hms_milli();
                            match (d.is_duration(), (h, mi, s) == (0, 0, 0)) {
                                (true, _) => format!("{:.2}h", d.as_f64() * 24.0),
                                (false, true) => format!("{y:04}-{mo:02}-{da:02}"),
                                (false, false) => format!("{y:04}-{mo:02}-{da:02} {h:02}:{mi:02}"),
                            }
                        }
                        other => other.to_string(),
                    })
                    .map(|v| v.replace('|', "\\|").replace('\n', " "))
                    .collect()
            })
            .filter(|r: &Vec<String>| r.iter().any(|c| !c.is_empty()))
            .collect();
        out += &format!("\n## Sheet: {name}\n\n");
        if rows.is_empty() {
            out += "(empty)\n";
            continue;
        }
        let width = rows.iter().map(|r| r.iter().rposition(|c| !c.is_empty()).map_or(0, |i| i + 1)).max().unwrap_or(0);
        for (i, row) in rows.iter().take(MAX_SHEET_ROWS).enumerate() {
            let cells: Vec<&str> = (0..width).map(|j| row.get(j).map_or("", String::as_str)).collect();
            out += &format!("| {} |\n", cells.join(" | "));
            if i == 0 {
                out += &format!("|{}\n", " --- |".repeat(width));
            }
        }
        if rows.len() > MAX_SHEET_ROWS {
            out += &format!("\n({} more rows not shown)\n", rows.len() - MAX_SHEET_ROWS);
        }
    }
    Ok(out.trim_start().to_string())
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<Cursor<Vec<u8>>>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Not a valid Office document (could not open it as a zip)".to_string())
}

fn zip_text(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Option<String> {
    let mut s = String::new();
    zip.by_name(name).ok()?.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Word: paragraphs (headings as `#`, list items as `-`) and tables as
/// markdown rows, in document order.
fn docx(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>) -> Result<String, String> {
    let xml = zip_text(zip, "word/document.xml").ok_or("Not a Word document (word/document.xml missing)")?;
    let mut r = Reader::from_str(&xml);
    let mut out = String::new();
    let mut para = String::new();
    let mut prefix = String::new();
    let mut in_text = false;
    let mut cell = String::new();
    let mut row: Vec<String> = Vec::new();
    let mut table_depth = 0usize;
    let mut header_done = false;
    loop {
        let ev = r.read_event().map_err(|e| format!("Malformed document XML: {e}"))?;
        match &ev {
            Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                b"p" if table_depth == 0 => {
                    para.clear();
                    prefix.clear();
                }
                b"pStyle" => {
                    let style = attr(e, b"val").unwrap_or_default().to_lowercase();
                    if let Some(n) = style.strip_prefix("heading").and_then(|n| n.parse::<usize>().ok()) {
                        prefix = format!("{} ", "#".repeat(n.clamp(1, 6)));
                    } else if style == "title" {
                        prefix = "# ".into();
                    }
                }
                b"numPr" if prefix.is_empty() => prefix = "- ".into(),
                b"t" => in_text = matches!(ev, Event::Start(_)),
                b"tab" => target(table_depth, &mut para, &mut cell).push('\t'),
                b"br" | b"cr" => target(table_depth, &mut para, &mut cell).push('\n'),
                b"tbl" => {
                    table_depth += 1;
                    if table_depth == 1 {
                        header_done = false;
                    }
                }
                _ => {}
            },
            Event::Text(t) if in_text => {
                let s = t.decode().map(|c| c.into_owned()).unwrap_or_default();
                let s = quick_xml::escape::unescape(&s).map(|c| c.into_owned()).unwrap_or(s);
                target(table_depth, &mut para, &mut cell).push_str(&s);
            }
            Event::GeneralRef(g) if in_text => {
                let s = format!("&{};", String::from_utf8_lossy(g));
                let s = quick_xml::escape::unescape(&s).map(|c| c.into_owned()).unwrap_or(s);
                target(table_depth, &mut para, &mut cell).push_str(&s);
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" if table_depth == 0 => {
                    let text = para.trim();
                    if !text.is_empty() {
                        out += &format!("{prefix}{text}\n\n");
                    }
                }
                b"p" => cell.push(' '),
                b"tc" if table_depth == 1 => row.push(std::mem::take(&mut cell).split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "\\|")),
                b"tr" if table_depth == 1 => {
                    out += &format!("| {} |\n", row.join(" | "));
                    if !header_done {
                        out += &format!("|{}\n", " --- |".repeat(row.len()));
                        header_done = true;
                    }
                    row.clear();
                }
                b"tbl" => {
                    table_depth = table_depth.saturating_sub(1);
                    if table_depth == 0 {
                        out.push('\n');
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out.trim().to_string())
}

fn target<'a>(table_depth: usize, para: &'a mut String, cell: &'a mut String) -> &'a mut String {
    if table_depth > 0 {
        cell
    } else {
        para
    }
}

/// PowerPoint: each slide's text boxes in order, then its speaker notes.
fn pptx(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, range: Option<(usize, usize)>) -> Result<String, String> {
    let numbered = |prefix: &str, zip: &zip::ZipArchive<Cursor<Vec<u8>>>| -> Vec<(usize, String)> {
        let mut v: Vec<(usize, String)> = zip
            .file_names()
            .filter_map(|n| {
                let num = n.strip_prefix(prefix)?.strip_suffix(".xml")?.parse().ok()?;
                Some((num, n.to_string()))
            })
            .collect();
        v.sort();
        v
    };
    let slides = numbered("ppt/slides/slide", zip);
    if slides.is_empty() {
        return Err("Not a PowerPoint file (no slides found)".into());
    }
    // notesSlideN → slideK, from the notes' relationship file.
    let mut notes: std::collections::HashMap<usize, String> = Default::default();
    for (n, name) in numbered("ppt/notesSlides/notesSlide", zip) {
        let rels = zip_text(zip, &format!("ppt/notesSlides/_rels/notesSlide{n}.xml.rels")).unwrap_or_default();
        let slide = rels
            .split("../slides/slide")
            .nth(1)
            .and_then(|rest| rest.split(".xml").next())
            .and_then(|k| k.parse::<usize>().ok());
        if let (Some(k), Some(xml)) = (slide, zip_text(zip, &name)) {
            // Notes pages repeat the slide number as a placeholder; keep prose.
            let text = drawing_paragraphs(&xml).into_iter().filter(|p| p.parse::<usize>().is_err()).collect::<Vec<_>>().join("\n");
            if !text.trim().is_empty() {
                notes.insert(k, text);
            }
        }
    }
    let mut units = Vec::new();
    for (num, name) in &slides {
        let mut text = drawing_paragraphs(&zip_text(zip, name).unwrap_or_default()).join("\n");
        if let Some(n) = notes.get(num) {
            text += &format!("\n\nSpeaker notes: {n}");
        }
        units.push(text);
    }
    number_units(units, "Slide", range)
}

/// Text of every `<a:p>` in a DrawingML part.
fn drawing_paragraphs(xml: &str) -> Vec<String> {
    let mut r = Reader::from_str(xml);
    let (mut out, mut para, mut in_text) = (Vec::new(), String::new(), false);
    while let Ok(ev) = r.read_event() {
        match ev {
            Event::Start(e) if e.local_name().as_ref() == b"t" => in_text = true,
            Event::End(e) if e.local_name().as_ref() == b"t" => in_text = false,
            Event::Empty(e) if e.local_name().as_ref() == b"br" => para.push('\n'),
            Event::Text(t) if in_text => para.push_str(&t.decode().map(|c| c.into_owned()).unwrap_or_default()),
            Event::GeneralRef(g) if in_text => {
                let s = format!("&{};", String::from_utf8_lossy(&g));
                para.push_str(&quick_xml::escape::unescape(&s).map(|c| c.into_owned()).unwrap_or(s));
            }
            Event::End(e) if e.local_name().as_ref() == b"p" => {
                let p = std::mem::take(&mut para);
                if !p.trim().is_empty() {
                    out.push(p.trim().to_string());
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    out
}

/// OpenDocument text (`text:p` / `text:h`) or slides (`draw:page`).
fn odf(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, slides: bool, range: Option<(usize, usize)>) -> Result<String, String> {
    let xml = zip_text(zip, "content.xml").ok_or("Not an OpenDocument file (content.xml missing)")?;
    let mut r = Reader::from_str(&xml);
    let (mut units, mut cur, mut para, mut depth) = (Vec::new(), String::new(), String::new(), 0usize);
    let mut heading = 0usize;
    while let Ok(ev) = r.read_event() {
        match &ev {
            Event::Start(e) => match e.local_name().as_ref() {
                b"p" | b"h" => {
                    depth += 1;
                    if e.local_name().as_ref() == b"h" {
                        heading = attr(e, b"outline-level").and_then(|l| l.parse().ok()).unwrap_or(1);
                    }
                }
                _ => {}
            },
            Event::Empty(e) => match e.local_name().as_ref() {
                b"tab" if depth > 0 => para.push('\t'),
                b"line-break" if depth > 0 => para.push('\n'),
                b"s" if depth > 0 => para.push(' '),
                _ => {}
            },
            Event::Text(t) if depth > 0 => para.push_str(&t.decode().map(|c| c.into_owned()).unwrap_or_default()),
            Event::GeneralRef(g) if depth > 0 => {
                let s = format!("&{};", String::from_utf8_lossy(g));
                para.push_str(&quick_xml::escape::unescape(&s).map(|c| c.into_owned()).unwrap_or(s));
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"p" | b"h" => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        let p = std::mem::take(&mut para);
                        if !p.trim().is_empty() {
                            let prefix = if heading > 0 { format!("{} ", "#".repeat(heading.min(6))) } else { String::new() };
                            cur += &format!("{prefix}{}\n\n", p.trim());
                        }
                        heading = 0;
                    }
                }
                b"page" if slides => units.push(std::mem::take(&mut cur)),
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    if slides {
        number_units(units, "Slide", range)
    } else {
        Ok(cur.trim().to_string())
    }
}

fn attr(e: &quick_xml::events::BytesStart, local: &[u8]) -> Option<String> {
    e.attributes().flatten().find(|a| a.key.local_name().as_ref() == local).map(|a| String::from_utf8_lossy(&a.value).into_owned())
}

/// Legacy Word / RTF via the converter every Mac ships with.
fn textutil(path: &Path) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Err("Legacy .doc/.rtf files can only be read on macOS. Save the file as .docx and try again.".into());
    }
    let out = std::process::Command::new("/usr/bin/textutil")
        .args(["-convert", "txt", "-stdout"])
        .arg(path)
        .output()
        .map_err(|e| format!("Could not run textutil: {e}"))?;
    if !out.status.success() {
        return Err(format!("Could not read the file: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// pdf-extract keeps the PDF's layout whitespace; squeeze runs of blank lines.
fn collapse(s: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in s.lines().map(str::trim_end) {
        blank = if line.trim().is_empty() { blank + 1 } else { 0 };
        if blank <= 1 {
            out += line;
            out.push('\n');
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(files: &[(&str, &str)]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("zwork-doc-{}.zip", uuid::Uuid::new_v4()));
        let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, body) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
        path
    }

    #[test]
    fn word_paragraphs_headings_lists_tables() {
        let doc = r#"<w:document xmlns:w="w"><w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p>
            <w:p><w:r><w:t xml:space="preserve">Budget &amp; </w:t></w:r><w:r><w:t>scope</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>First</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>Desk</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:body></w:document>"#;
        let path = zip_with(&[("word/document.xml", doc)]);
        let text = docx(&mut open_zip(&path).unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(text, "# Plan\n\nBudget & scope\n\n- First\n\n| Item | Cost |\n| --- | --- |\n| Desk | 120 |");
    }

    #[test]
    fn slides_in_order_with_notes() {
        let slide = |t: &str| format!(r#"<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"#);
        let (s1, s2, s10) = (slide("Intro"), slide("Middle"), slide("End"));
        let notes = r#"<p:notes xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Say hi</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>"#;
        let rels = r#"<Relationships><Relationship Target="../slides/slide1.xml"/></Relationships>"#;
        let path = zip_with(&[
            ("ppt/slides/slide10.xml", &s10),
            ("ppt/slides/slide1.xml", &s1),
            ("ppt/slides/slide2.xml", &s2),
            ("ppt/notesSlides/notesSlide1.xml", notes),
            ("ppt/notesSlides/_rels/notesSlide1.xml.rels", rels),
        ]);
        let text = pptx(&mut open_zip(&path).unwrap(), None).unwrap();
        assert!(text.starts_with("(3 slides)\n\n## Slide 1\n\nIntro\n\nSpeaker notes: Say hi\n\n## Slide 2\n\nMiddle"), "{text}");
        assert!(text.contains("## Slide 3\n\nEnd"));
        let only2 = pptx(&mut open_zip(&path).unwrap(), Some((2, 2))).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(only2, "(3 slides)\n\n## Slide 2\n\nMiddle\n");
    }

    #[test]
    fn page_ranges() {
        assert_eq!(parse_range("3").unwrap(), (3, 3));
        assert_eq!(parse_range("2-5").unwrap(), (2, 5));
        assert_eq!(parse_range("4-").unwrap(), (4, usize::MAX));
        assert!(parse_range("0").is_err() && parse_range("5-2").is_err() && parse_range("x").is_err());
    }

    /// Round-trips real files produced by macOS (`textutil`) when available.
    #[tokio::test]
    async fn real_files_through_the_tool() {
        let dir = std::env::temp_dir().join(format!("zwork-doc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let html = dir.join("memo.html");
        std::fs::write(&html, "<h1>Memo</h1><p>Quarterly numbers are <b>up</b>.</p>").unwrap();
        let out = execute_extract_document(&serde_json::json!({ "path": html })).await.unwrap();
        assert!(out.contains("# Memo") && out.contains("**up**"), "{out}");
        if cfg!(target_os = "macos") {
            let docx_path = dir.join("memo.docx");
            let ok = std::process::Command::new("/usr/bin/textutil")
                .args(["-convert", "docx", "-output"])
                .arg(&docx_path)
                .arg(&html)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                let out = execute_extract_document(&serde_json::json!({ "path": docx_path })).await.unwrap();
                assert!(out.contains("Memo") && out.contains("Quarterly numbers are up."), "{out}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}


