//! `extract_document`: the text of office files and PDFs, extracted in
//! process — no Python, no LibreOffice, nothing the user has to install.
//!
//! PDF via `pdf-extract`; Excel / OpenDocument spreadsheets via `calamine`
//! (rendered as markdown tables); Word, PowerPoint and OpenDocument text or
//! slides by reading their XML straight out of the zip. Legacy `.doc` /
//! `.rtf` go through `textutil` on macOS and the readers below elsewhere.

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

/// macOS: renders pages with PDFKit and reads them with the Vision framework — both
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

/// Windows: renders pages with Windows.Data.Pdf and reads them with
/// Windows.Media.Ocr, both built into Windows 10+, through PowerShell's WinRT
/// bridge. Arguments come in through env vars (`-Command` has no argv).
const OCR_SCRIPT_WINDOWS: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
  $opT = $ext | ? { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | select -First 1
  $actT = $ext | ? { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | select -First 1
  function Await($op, [Type]$t) { $task = $opT.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }
  function AwaitAction($op) { $actT.Invoke($null, @($op)).Wait() }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($engine -eq $null) { throw 'no OCR language is installed (Settings > Time & language > Language)' }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($env:ZWORK_OCR_PDF))) ([Windows.Storage.StorageFile])
  $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $to = [Math]::Min([int]$doc.PageCount, [int]$env:ZWORK_OCR_TO)
  $pages = New-Object Collections.Generic.List[string]
  for ($i = [int]$env:ZWORK_OCR_FROM - 1; $i -lt $to; $i++) {
    $page = $doc.GetPage($i)
    $k = [Math]::Min(2, 2000 / [Math]::Max($page.Size.Width, $page.Size.Height))
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]($page.Size.Width * $k)
    $opts.DestinationHeight = [uint32]($page.Size.Height * $k)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $pages.Add((($res.Lines | % { $_.Text }) -join "`n"))
  }
  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($pages)))
} catch { [Console]::Error.WriteLine('Error: ' + $_.Exception.Message); exit 1 }
"#;

fn ocr_pdf(path: &Path, from: usize, to: usize) -> Result<Vec<String>, String> {
    let deadline = std::time::Instant::now() + OCR_TIMEOUT;
    let out = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("/usr/bin/osascript");
        c.args(["-l", "JavaScript", "-e", OCR_SCRIPT]).arg(path).args([from.to_string(), to.to_string()]);
        run_until(c, deadline)?
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", OCR_SCRIPT_WINDOWS])
            .env("ZWORK_OCR_PDF", path)
            .env("ZWORK_OCR_FROM", from.to_string())
            .env("ZWORK_OCR_TO", to.to_string());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0800_0000); // CREATE_NO_WINDOW
        run_until(c, deadline)?
    } else {
        return ocr_tesseract(path, from, to, deadline);
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim()).map_err(|_| {
        let err = String::from_utf8_lossy(&out.stderr);
        err.lines().rfind(|l| l.contains("Error")).unwrap_or("no output").trim().to_string()
    })
}

/// Linux has no OCR built in; poppler's `pdftoppm` and `tesseract` are one
/// package install away on every distro.
fn ocr_tesseract(path: &Path, from: usize, to: usize, deadline: std::time::Instant) -> Result<Vec<String>, String> {
    let missing = |e: String| if e.contains("No such file") { "install poppler-utils and tesseract-ocr to read scans".to_string() } else { e };
    let dir = std::env::temp_dir().join(format!("zwork-ocr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut c = std::process::Command::new("pdftoppm");
        c.args(["-r", "200", "-gray", "-png", "-f", &from.to_string(), "-l", &to.to_string()]).arg(path).arg(dir.join("p"));
        let out = run_until(c, deadline).map_err(missing)?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        // pdftoppm zero-pads page numbers, so names sort in page order.
        let mut images: Vec<_> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok().map(|e| e.path())).collect();
        images.sort();
        images
            .iter()
            .map(|img| {
                let mut c = std::process::Command::new("tesseract");
                c.arg(img).arg("stdout");
                run_until(c, deadline).map_err(missing).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            })
            .collect()
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// Run to completion or kill at `deadline`. Output is drained on threads so a
/// child writing more than a pipe buffer can't stall waiting on us.
fn run_until(mut cmd: std::process::Command, deadline: std::time::Instant) -> Result<std::process::Output, String> {
    fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    }
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let (stdout, stderr) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out — try a smaller page range".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    Ok(std::process::Output { status, stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() })
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
        "doc" if !cfg!(target_os = "macos") => word97(&std::fs::read(path).map_err(|e| e.to_string())?),
        "rtf" if !cfg!(target_os = "macos") => Ok(rtf_text(&std::fs::read(path).map_err(|e| e.to_string())?)),
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

/// Text of a Word 97-2003 `.doc`: the main story's pieces, per [MS-DOC] —
/// the FIB says which table stream holds the piece table (CLX), each piece is
/// either cp1252 or UTF-16 in the WordDocument stream.
fn word97(bytes: &[u8]) -> Result<String, String> {
    let bad = |what: &str| format!("Could not read the .doc file ({what}). Save it as .docx and try again.");
    let word = ole_stream(bytes, "WordDocument").ok_or_else(|| bad("not a Word 97-2003 document"))?;
    let u16_at = |b: &[u8], o: usize| b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]]));
    let u32_at = |b: &[u8], o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]));
    let flags = u16_at(&word, 0x0A).ok_or_else(|| bad("truncated"))?;
    if flags & 0x0100 != 0 {
        return Err("This .doc is password-protected.".into());
    }
    // FibBase (32) · csw · fibRgW · cslw · fibRgLw · cbRgFcLcb · fibRgFcLcb
    let csw = u16_at(&word, 32).ok_or_else(|| bad("truncated"))? as usize;
    let rg_lw = 34 + csw * 2 + 2;
    let cslw = u16_at(&word, rg_lw - 2).ok_or_else(|| bad("truncated"))? as usize;
    let ccp_text = u32_at(&word, rg_lw + 12).ok_or_else(|| bad("truncated"))? as usize;
    let rg_fc = rg_lw + cslw * 4 + 2;
    let (fc_clx, lcb_clx) = (u32_at(&word, rg_fc + 33 * 8), u32_at(&word, rg_fc + 33 * 8 + 4));
    let (fc_clx, lcb_clx) = (fc_clx.ok_or_else(|| bad("truncated"))? as usize, lcb_clx.ok_or_else(|| bad("truncated"))? as usize);
    let table = ole_stream(bytes, if flags & 0x0200 != 0 { "1Table" } else { "0Table" }).ok_or_else(|| bad("no table stream"))?;
    let clx = table.get(fc_clx..fc_clx + lcb_clx).ok_or_else(|| bad("bad piece table"))?;
    // Skip Prc entries (0x01, i16 size, grpprl) to the Pcdt (0x02, u32 size, PlcPcd).
    let mut i = 0;
    while clx.get(i) == Some(&0x01) {
        i += 3 + u16_at(clx, i + 1).ok_or_else(|| bad("bad piece table"))? as usize;
    }
    if clx.get(i) != Some(&0x02) {
        return Err(bad("bad piece table"));
    }
    let plc = clx.get(i + 5..i + 5 + u32_at(clx, i + 1).unwrap_or(0) as usize).ok_or_else(|| bad("bad piece table"))?;
    let n = plc.len().saturating_sub(4) / 12;
    let mut text = String::new();
    for k in 0..n {
        let (start, end) = (u32_at(plc, k * 4).unwrap_or(0) as usize, u32_at(plc, k * 4 + 4).unwrap_or(0) as usize);
        let (start, end) = (start.min(ccp_text), end.min(ccp_text));
        if end <= start {
            continue;
        }
        let fc = u32_at(plc, (n + 1) * 4 + k * 8 + 2).unwrap_or(0);
        if fc & 0x4000_0000 != 0 {
            let off = (fc & 0x3FFF_FFFF) as usize / 2;
            let raw = word.get(off..off + (end - start)).ok_or_else(|| bad("truncated text"))?;
            text += &encoding_rs::WINDOWS_1252.decode_without_bom_handling(raw).0;
        } else {
            let off = fc as usize;
            let raw = word.get(off..off + (end - start) * 2).ok_or_else(|| bad("truncated text"))?;
            text += &String::from_utf16_lossy(&raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>());
        }
    }
    // Field codes (0x13 code 0x14 result 0x15) keep only the result; marks become layout.
    let (mut out, mut in_code) = (String::new(), 0usize);
    for c in text.chars() {
        match c {
            '\u{13}' => in_code += 1,
            '\u{14}' => in_code = in_code.saturating_sub(1),
            '\u{15}' => {}
            _ if in_code > 0 => {}
            '\r' | '\u{0b}' | '\u{0c}' => out.push('\n'),
            '\u{07}' => out.push('\t'),
            c if (c as u32) < 0x20 && c != '\t' => {}
            c => out.push(c),
        }
    }
    Ok(out)
}

/// One stream of an OLE compound file ([MS-CFB]), found by name. Follows the
/// sector chains without validating the rest of the FAT, which some writers
/// (TextEdit among them) get subtly wrong.
fn ole_stream(file: &[u8], name: &str) -> Option<Vec<u8>> {
    if file.get(..8)? != [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] {
        return None;
    }
    let le = |b: &[u8], o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]));
    let shift = |o: usize| file.get(o..o + 2).map(|x| 1usize << u16::from_le_bytes([x[0], x[1]]).min(16));
    let (size, mini_size) = (shift(30)?, shift(32)?);
    let sector = |s: u32| file.get(size * (s as usize + 1)..).map(|r| &r[..size.min(r.len())]);
    // DIFAT: 109 FAT sector numbers in the header, the rest in a sector chain.
    let mut fat_sectors: Vec<u32> = (0..109).filter_map(|k| le(file, 76 + k * 4)).filter(|&s| s < 0xFFFF_FFFA).collect();
    let mut next = le(file, 68)?;
    for _ in 0..le(file, 72)?.min(10_000) {
        let Some(s) = sector(next) else { break };
        fat_sectors.extend((0..size / 4 - 1).filter_map(|k| le(s, k * 4)).filter(|&v| v < 0xFFFF_FFFA));
        next = le(s, size - 4)?;
    }
    let fat: Vec<u32> = fat_sectors.iter().filter_map(|&s| sector(s)).flat_map(|s| s.chunks_exact(4).map(|c| le(c, 0).unwrap_or(0))).collect();
    let chain = |start: u32, table: &[u32]| {
        let mut v = Vec::new();
        let mut s = start;
        while (s as usize) < table.len() && v.len() <= table.len() {
            v.push(s);
            s = table[s as usize];
        }
        v
    };
    let read = |start: u32| chain(start, &fat).into_iter().filter_map(sector).flatten().copied().collect::<Vec<u8>>();
    let dir = read(le(file, 48)?);
    let root = dir.get(..128)?;
    for entry in dir.chunks_exact(128) {
        let name_len = (u16::from_le_bytes([entry[64], entry[65]]) as usize).min(64).saturating_sub(2);
        let entry_name = String::from_utf16_lossy(&entry[..name_len].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>());
        if entry[66] != 2 || !entry_name.eq_ignore_ascii_case(name) {
            continue;
        }
        let (start, len) = (le(entry, 116)?, le(entry, 120)? as usize);
        let mut data = if len < le(file, 56)? as usize {
            let mini_stream = read(le(root, 116)?);
            let minifat: Vec<u32> = read(le(file, 60)?).chunks_exact(4).map(|c| le(c, 0).unwrap_or(0)).collect();
            chain(start, &minifat).into_iter().filter_map(|s| mini_stream.get(s as usize * mini_size..(s as usize + 1) * mini_size)).flatten().copied().collect()
        } else {
            read(start)
        };
        data.truncate(len);
        return Some(data);
    }
    None
}

/// Plain text of an RTF document: `\par`/`\tab`/table marks become layout,
/// `\'hh` and `\uN` are decoded, and destinations (font and colour tables,
/// styles, pictures, `{\*...}`) are skipped.
/// shortcut: `\'hh` is read as cp1252 whatever `\ansicpg` says; honour it if non-Western RTFs show up.
fn rtf_text(rtf: &[u8]) -> String {
    const SKIP: &[&[u8]] = &[b"fonttbl", b"colortbl", b"stylesheet", b"info", b"pict", b"object", b"header", b"headerl", b"headerr", b"headerf", b"footer", b"footerl", b"footerr", b"footerf", b"listtable", b"listoverridetable", b"rsidtbl", b"themedata", b"colorschememapping", b"datastore", b"latentstyles", b"xmlnstbl", b"filetbl", b"revtbl", b"generator"];
    let (mut out, mut bytes) = (String::new(), Vec::new());
    let flush = |out: &mut String, bytes: &mut Vec<u8>| {
        out.push_str(&encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes).0);
        bytes.clear();
    };
    let (mut depth, mut skip_at, mut uc, mut pending) = (0usize, None::<usize>, vec![1usize], 0usize);
    let mut i = 0;
    while i < rtf.len() {
        match rtf[i] {
            b'{' => {
                depth += 1;
                uc.push(*uc.last().unwrap_or(&1));
                i += 1;
            }
            b'}' => {
                if skip_at == Some(depth) {
                    skip_at = None;
                }
                depth = depth.saturating_sub(1);
                uc.pop();
                pending = 0;
                i += 1;
            }
            b'\\' if rtf.get(i + 1).is_some_and(u8::is_ascii_alphabetic) => {
                let start = i + 1;
                i = start;
                while rtf.get(i).is_some_and(u8::is_ascii_alphabetic) {
                    i += 1;
                }
                let word = &rtf[start..i];
                let num_start = i;
                if rtf.get(i) == Some(&b'-') {
                    i += 1;
                }
                while rtf.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                let num: Option<i32> = std::str::from_utf8(&rtf[num_start..i]).ok().and_then(|n| n.parse().ok());
                if rtf.get(i) == Some(&b' ') {
                    i += 1;
                }
                if skip_at.is_some() {
                    continue;
                }
                match word {
                    b"par" | b"line" | b"row" | b"sect" | b"page" => {
                        flush(&mut out, &mut bytes);
                        out.push('\n');
                    }
                    b"tab" | b"cell" => {
                        flush(&mut out, &mut bytes);
                        out.push('\t');
                    }
                    b"uc" => {
                        if let Some(last) = uc.last_mut() {
                            *last = num.unwrap_or(1).max(0) as usize;
                        }
                    }
                    b"u" => {
                        flush(&mut out, &mut bytes);
                        let n = num.unwrap_or(0);
                        out.extend(char::from_u32(if n < 0 { (n + 65536) as u32 } else { n as u32 }));
                        pending = *uc.last().unwrap_or(&1);
                    }
                    w if SKIP.contains(&w) => skip_at = Some(depth),
                    _ => {}
                }
            }
            b'\\' => {
                let c = rtf.get(i + 1).copied().unwrap_or(b' ');
                i += 2;
                if c == b'*' {
                    skip_at = skip_at.or(Some(depth));
                }
                if skip_at.is_some() {
                    i += if c == b'\'' { 2 } else { 0 };
                    continue;
                }
                match c {
                    b'\'' => {
                        let hex = rtf.get(i..i + 2).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
                        i += 2;
                        if pending > 0 {
                            pending -= 1;
                        } else {
                            bytes.extend(hex);
                        }
                    }
                    b'\\' | b'{' | b'}' => bytes.push(c),
                    b'~' => bytes.push(b' '),
                    b'\n' | b'\r' => {
                        flush(&mut out, &mut bytes);
                        out.push('\n');
                    }
                    _ => {}
                }
            }
            b'\r' | b'\n' => i += 1,
            b => {
                i += 1;
                if skip_at.is_some() {
                    continue;
                }
                if pending > 0 {
                    pending -= 1;
                } else {
                    bytes.push(b);
                }
            }
        }
    }
    flush(&mut out, &mut bytes);
    out
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

    #[test]
    fn rtf_text_escapes_tables_and_skipped_groups() {
        let rtf = br"{\rtf1\ansi{\fonttbl\f0 Times;}{\colortbl;\red0;}{\*\generator Word;}\pard R\'e9sum\'e9 \'96 Q3\par
North\cell \uc1\u8364?4,200\cell\row \u26085\'3f ok \{x\}\par}";
        assert_eq!(rtf_text(rtf), "R\u{e9}sum\u{e9} \u{2013} Q3\nNorth\t\u{20ac}4,200\t\n\u{65e5} ok {x}\n");
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
            // The readers Windows and Linux use, against what Word-compatible apps write.
            let html = dir.join("intl.html");
            std::fs::write(&html, "<meta charset=utf-8><h1>Résumé – Q3</h1><table><tr><td>North</td><td>€4,200</td></tr></table><p>日本語 ok</p>").unwrap();
            for fmt in ["doc", "rtf"] {
                let file = dir.join(format!("intl.{fmt}"));
                let made = std::process::Command::new("/usr/bin/textutil").args(["-convert", fmt, "-output"]).arg(&file).arg(&html).status();
                assert!(made.is_ok_and(|s| s.success()), "textutil -convert {fmt}");
                let bytes = std::fs::read(&file).unwrap();
                let text = if fmt == "doc" { word97(&bytes).unwrap() } else { rtf_text(&bytes) };
                assert!(text.contains("Résumé – Q3") && text.contains("North\t€4,200") && text.contains("日本語 ok"), "{fmt}: {text:?}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The OCR path on whichever platform runs it (CI installs tesseract on Linux).
    #[tokio::test]
    async fn scanned_pdf_is_ocrd() {
        let path = std::env::temp_dir().join(format!("zwork-scan-{}.pdf", uuid::Uuid::new_v4()));
        std::fs::write(&path, include_bytes!("testdata/scanned.pdf")).unwrap();
        let out = execute_extract_document(&serde_json::json!({ "path": path })).await.unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(out.contains("read with OCR") && out.contains("Invoice 4821") && out.contains("315.40"), "{out}");
    }
}
