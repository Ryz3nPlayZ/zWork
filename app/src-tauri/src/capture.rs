//! Native macOS window capture for "Share Window".
//!
//! Uses CoreGraphics + CoreFoundation FFI directly so zWork captures with its
//! OWN Screen Recording TCC grant, removing the hard dependency on the external
//! cua-driver daemon for this feature. The window list enumerates on-screen
//! layer-0 windows; the screenshot itself shells out to the system
//! `screencapture` CLI (child processes inherit zWork's Screen Recording
//! grant), which avoids a large ImageIO FFI surface.
//!
//! See the beta.14 plan (item E1) for the design rationale.

#![cfg(target_os = "macos")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::process::Command;
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

// ---- CoreFoundation / CoreGraphics opaque types ----
type CVoid = std::ffi::c_void;
type CFAllocatorRef = *const CVoid;
type CFStringRef = *const CVoid;
type CFArrayRef = *const CVoid;
type CFDictionaryRef = *const CVoid;
type CFNumberRef = *const CVoid;
type CFTypeID = usize;
type CFIndex = isize;
type CFStringEncoding = u32;
type CFNumberType = u32;

type CGWindowID = u32;
type CGWindowListOption = u32;

// kCGWindowListOptionOnScreenOnly = (1 << 0). See CGWindow.h.
const WINDOW_LIST_ON_SCREEN_ONLY: CGWindowListOption = 1;
const NULL_WINDOW_ID: CGWindowID = 0;

// kCFStringEncodingUTF8 = 0x08000100.
const ENCODING_UTF8: CFStringEncoding = 0x08000100;

// CFNumberType enum values — kCFNumberSInt64Type = 4. CFNumberGetValue converts
// between numeric representations, so reading every window-dict number as
// SInt64 handles both SInt32 (PID, layer) and the rare SInt64 window id.
const NUMBER_SINT_64_TYPE: CFNumberType = 4;

extern "C" {
    fn CGWindowListCopyWindowInfo(
        option: CGWindowListOption,
        relative_to_window: CGWindowID,
    ) -> CFArrayRef;
    fn CGPreflightScreenCaptureAccess() -> bool;

    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: CFIndex) -> *const CVoid;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: CFStringRef) -> *const CVoid;
    fn CFRelease(cf: *const CVoid);

    fn CFStringCreateWithCString(
        alloc: CFAllocatorRef,
        cstr: *const c_char,
        num_chars: CFIndex,
        encoding: CFStringEncoding,
    ) -> CFStringRef;

    fn CFNumberGetValue(
        number: CFNumberRef,
        the_type: CFNumberType,
        value_ptr: *mut CVoid,
    ) -> bool;

    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut c_char,
        buffer_size: CFIndex,
        encoding: CFStringEncoding,
    ) -> bool;

    fn CFGetTypeID(cf: *const CVoid) -> CFTypeID;
    fn CFNumberGetTypeID() -> CFTypeID;
    fn CFStringGetTypeID() -> CFTypeID;
}

#[derive(Serialize)]
pub struct WindowInfo {
    pub window_id: i64,
    pub pid: i64,
    pub app_name: String,
    #[allow(dead_code)]
    pub title: String,
}

/// Create a CFString from a Rust string. Caller must `CFRelease` the result.
/// Returns null on failure.
unsafe fn cf_string(s: &str) -> CFStringRef {
    let cs = match CString::new(s) {
        Ok(c) => c,
        Err(_) => return ptr::null(),
    };
    CFStringCreateWithCString(ptr::null(), cs.as_ptr(), -1, ENCODING_UTF8)
}

/// Read a CFStringRef-valued dict entry into a Rust `String`. Returns
/// `None` if the value is null or not a CFString. Window titles are absent
/// without Screen Recording permission; this degrades gracefully.
unsafe fn dict_string(dict: CFDictionaryRef, key: &str) -> Option<String> {
    let cf_key = cf_string(key);
    if cf_key.is_null() {
        return None;
    }
    let value = CFDictionaryGetValue(dict, cf_key);
    CFRelease(cf_key);
    if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
        return None;
    }
    let mut buf = vec![0u8; 2048];
    if CFStringGetCString(
        value as CFStringRef,
        buf.as_mut_ptr() as *mut c_char,
        buf.len() as CFIndex,
        ENCODING_UTF8,
    ) {
        let cstr = CStr::from_ptr(buf.as_ptr() as *const c_char);
        Some(cstr.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Read a CFNumber-valued dict entry into an `i64`. Returns `None` if the
/// value is null or not a CFNumber.
unsafe fn dict_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
    let cf_key = cf_string(key);
    if cf_key.is_null() {
        return None;
    }
    let value = CFDictionaryGetValue(dict, cf_key);
    CFRelease(cf_key);
    if value.is_null() || CFGetTypeID(value) != CFNumberGetTypeID() {
        return None;
    }
    let mut n: i64 = 0;
    if CFNumberGetValue(
        value as CFNumberRef,
        NUMBER_SINT_64_TYPE,
        &mut n as *mut i64 as *mut CVoid,
    ) {
        Some(n)
    } else {
        None
    }
}

/// Enumerate on-screen, layer-0 desktop windows for the Share Window picker.
/// Excludes zWork's own windows (so the user doesn't screenshot the overlay or
/// main window) and the Dock/menu bar (layer != 0). Window titles are absent
/// until Screen Recording is granted; app names are always present.
pub fn list_windows() -> Vec<WindowInfo> {
    unsafe {
        let array = CGWindowListCopyWindowInfo(WINDOW_LIST_ON_SCREEN_ONLY, NULL_WINDOW_ID);
        if array.is_null() {
            return Vec::new();
        }
        let count = CFArrayGetCount(array);
        let mut out = Vec::with_capacity(count.min(128) as usize);
        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(array, i) as CFDictionaryRef;
            if dict.is_null() {
                continue;
            }
            // Layer 0 = normal desktop window. Negative layers are the menu bar;
            // positive are the Dock / overlays.
            let layer = dict_i64(dict, "kCGWindowLayer").unwrap_or(-1);
            if layer != 0 {
                continue;
            }
            let app_name = dict_string(dict, "kCGWindowOwnerName")
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_default();
            if app_name.is_empty() {
                continue;
            }
            // Exclude zWork's own windows (case-insensitive).
            if app_name.eq_ignore_ascii_case("zwork") {
                continue;
            }
            let window_id = dict_i64(dict, "kCGWindowNumber").unwrap_or(0);
            let pid = dict_i64(dict, "kCGWindowOwnerPID").unwrap_or(0);
            let title = dict_string(dict, "kCGWindowName").unwrap_or_default();
            out.push(WindowInfo {
                window_id,
                pid,
                app_name,
                title,
            });
        }
        CFRelease(array);
        out
    }
}

/// Capture a screenshot of `window_id` as a base64 PNG data_url.
///
/// Shells out to the system `screencapture` CLI (`-l<id>` selects a window,
/// `-o` drops the shadow, `-x` silences the shutter sound). Child processes
/// inherit zWork's Screen Recording TCC grant, so this works once zWork itself
/// is granted. The PNG is written to a temp file, read, base64-encoded, then
/// deleted — matching the frontend's existing `{ data_url, mime }` contract.
pub fn capture_window(window_id: i64) -> Result<Value, String> {
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err(
            "Screen Recording permission is required. Grant it to zWork in System Settings."
                .to_string(),
        );
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = format!(
        "{}/zwork-share-{}-{}.png",
        std::env::temp_dir().to_string_lossy(),
        std::process::id(),
        nanos
    );
    let output = Command::new("screencapture")
        .arg(format!("-l{window_id}"))
        .arg("-o")
        .arg("-x")
        .arg(&tmp)
        .output()
        .map_err(|e| format!("failed to run screencapture: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "screencapture exited {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    let bytes = std::fs::read(&tmp).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("failed to read capture: {e}")
    })?;
    let _ = std::fs::remove_file(&tmp);
    if bytes.len() < 64 {
        return Err("screenshot was empty — Screen Recording may not be granted to zWork."
            .to_string());
    }
    let b64 = STANDARD.encode(&bytes);
    Ok(json!({
        "data_url": format!("data:image/png;base64,{b64}"),
        "mime": "image/png"
    }))
}

/// Whether zWork itself has Screen Recording permission (non-prompting). Use
/// before listing/capturing so the UI can route the user to System Settings.
pub fn screen_capture_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}
