//! Native macOS window capture for "Share Window".
//!
//! Uses CoreGraphics + CoreFoundation + ImageIO FFI directly so zWork captures
//! with its OWN Screen Recording TCC grant, **in-process**. The previous design
//! shelled out to the system `screencapture` CLI, but that is a *separate* TCC
//! binary — granting zWork.app did not grant `/usr/sbin/screencapture`, so
//! captures came back empty on modern macOS. Capturing in-process via
//! `CGWindowListCreateImage` + `CGImageDestination` runs entirely under zWork's
//! own grant and returns the PNG bytes directly (no temp file, no child
//! process).
//!
//! Permission flow:
//!  - `screen_capture_granted()` wraps `CGPreflightScreenCaptureAccess` — the
//!    non-prompting check the UI uses to route to System Settings.
//!  - `request_screen_capture()` wraps `CGRequestScreenCaptureAccess` — the
//!    PROMPTING call that triggers the native "allow Screen Recording" dialog
//!    on first use. macOS only honors the prompt on first launch, so the UI
//!    pairs it with a deep-link to System Settings for subsequent grants.

#![cfg(target_os = "macos")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;
use std::thread;
use std::time::Duration;

// ---- CoreFoundation / CoreGraphics opaque types (all `*const c_void`) ----
type CVoid = std::ffi::c_void;
type CFAllocatorRef = *const CVoid;
type CFStringRef = *const CVoid;
type CFArrayRef = *const CVoid;
type CFDictionaryRef = *const CVoid;
type CFNumberRef = *const CVoid;
type CFMutableDataRef = *const CVoid;
type CFTypeID = usize;
type CFIndex = isize;
type CFStringEncoding = u32;
type CFNumberType = u32;

// CoreGraphics types for image capture.
type CGDirectDisplayID = u32;
type CGWindowID = u32;
type CGWindowListOption = u32;
type CGImageRef = *const CVoid;
type CGImageDestinationRef = *const CVoid;

// kCGWindowListOptionOnScreenOnly = (1 << 0). See CGWindow.h.
const WINDOW_LIST_ON_SCREEN_ONLY: CGWindowListOption = 1;
const NULL_WINDOW_ID: CGWindowID = 0;

// kCFStringEncodingUTF8 = 0x08000100.
const ENCODING_UTF8: CFStringEncoding = 0x08000100;

// CFNumberType enum values — kCFNumberSInt64Type = 4. CFNumberGetValue converts
// between numeric representations, so reading every window-dict number as
// SInt64 handles both SInt32 (PID, layer) and the rare SInt64 window id.
const NUMBER_SINT_64_TYPE: CFNumberType = 4;

#[derive(Serialize)]
pub struct WindowInfo {
    pub window_id: i64,
    pub pid: i64,
    pub app_name: String,
    #[allow(dead_code)]
    pub title: String,
}

// CoreGraphics + CoreFoundation symbols. These frameworks are linked
// transitively via Tauri's macOS deps, so no explicit `#[link]` is needed.
extern "C" {
    fn CGWindowListCopyWindowInfo(
        option: CGWindowListOption,
        relative_to_window: CGWindowID,
    ) -> CFArrayRef;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;

    // CGWindowListCreateImage(displayID, listOption, windowID, imageOption).
    // Capture a single window: displayID = kCGNullDirectDisplay (0),
    // listOption = kCGWindowListOptionIncludingWindow (1<<3),
    // imageOption = kCGWindowImageDefault (0) → full window at native res.
    fn CGWindowListCreateImage(
        display: CGDirectDisplayID,
        list_option: CGWindowListOption,
        window_id: CGWindowID,
        image_option: u32,
    ) -> CGImageRef;

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

    fn CFDataCreateMutable(alloc: CFAllocatorRef, capacity: CFIndex) -> CFMutableDataRef;
    fn CFDataGetBytePtr(data: CFMutableDataRef) -> *const u8;
    fn CFDataGetLength(data: CFMutableDataRef) -> CFIndex;
}

// ImageIO symbols. ImageIO is NOT linked transitively, so we link it
// explicitly as a framework.
#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    // Create an image destination that writes into a CFMutableData. `type_id`
    // is the UTI string (e.g. "public.png") — despite the param name in older
    // docs, it's the UTI constant, not a typeID number.
    fn CGImageDestinationCreateWithData(
        data: CFMutableDataRef,
        type_id: CFStringRef,
        count: CFIndex,
        options: CFDictionaryRef,
    ) -> CGImageDestinationRef;
    // Add a CGImage to the destination. (Returns void in the SDK we target.)
    fn CGImageDestinationAddImage(
        dest: CGImageDestinationRef,
        image: CGImageRef,
        properties: CFDictionaryRef,
    );
    // Finalize → flush the encoded bytes into the backing CFData. Returns false
    // on encoding failure.
    fn CGImageDestinationFinalize(dest: CGImageDestinationRef) -> bool;
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

/// A short sleep so macOS's TCC permission cache can update after a grant or
/// prompt before the caller re-preflights. CoreGraphics sometimes defers the
/// re-evaluation until the run loop yields.
fn yield_run_loop_once() {
    thread::sleep(Duration::from_millis(50));
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

/// Capture a screenshot of `window_id` as a base64 PNG data_url, IN-PROCESS.
///
/// Uses `CGWindowListCreateImage` (single-window, full content, default image
/// options) so the capture runs entirely under zWork's own Screen Recording
/// grant — no child process, no separate TCC binary. The CGImage is encoded to
/// PNG bytes via ImageIO's `CGImageDestination`, then base64-encoded to match
/// the frontend's existing `{ data_url, mime }` contract.
pub fn capture_window(window_id: i64) -> Result<Value, String> {
    // Preflight — give a clear error before touching CoreGraphics. Pump the run
    // loop once first in case a grant just landed and the cache is stale.
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        yield_run_loop_once();
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(
                "Screen Recording permission is required. Grant it to zWork in System Settings."
                    .to_string(),
            );
        }
    }

    const NULL_DISPLAY: CGDirectDisplayID = 0;
    // kCGWindowListOptionIncludingWindow = (1 << 3). Capture just this window.
    const LIST_OPTION_SINGLE_WINDOW: u32 = 1 << 3;
    // kCGWindowImageDefault = 0. Full window at native resolution.
    const IMAGE_OPTION_DEFAULT: u32 = 0;

    let image = unsafe {
        CGWindowListCreateImage(
            NULL_DISPLAY,
            LIST_OPTION_SINGLE_WINDOW,
            window_id as CGWindowID,
            IMAGE_OPTION_DEFAULT,
        )
    };
    if image.is_null() {
        return Err(format!(
            "No window found with id {window_id} (it may have closed)."
        ));
    }

    // Encode the CGImage to PNG bytes via ImageIO (in-process, no temp file).
    let png_bytes = encode_image_to_png(image);
    unsafe { CFRelease(image) };

    let bytes = png_bytes.map_err(|e| format!("failed to encode screenshot: {e}"))?;
    if bytes.len() < 64 {
        return Err(
            "screenshot was empty — Screen Recording may not be granted to zWork.".to_string(),
        );
    }
    let b64 = STANDARD.encode(&bytes);
    Ok(json!({
        "data_url": format!("data:image/png;base64,{b64}"),
        "mime": "image/png"
    }))
}

/// Encode a CGImageRef to PNG bytes via an in-memory ImageIO destination.
///
/// Creates a `CFMutableData`, an image destination over it with the
/// `public.png` UTI, adds the image, finalizes, then copies the bytes out.
/// All intermediate CF objects are released.
fn encode_image_to_png(image: CGImageRef) -> Result<Vec<u8>, String> {
    unsafe {
        let data = CFDataCreateMutable(ptr::null(), 0);
        if data.is_null() {
            return Err("CFDataCreateMutable returned null".to_string());
        }

        // "public.png" is the PNG UTI. Despite the `type_id` param name in
        // legacy docs, CGImageDestinationCreateWithData takes the UTI string.
        let png_type = cf_string("public.png");
        if png_type.is_null() {
            CFRelease(data);
            return Err("could not create PNG UTI string".to_string());
        }

        let dest = CGImageDestinationCreateWithData(data, png_type, 1, ptr::null());
        CFRelease(png_type);
        if dest.is_null() {
            CFRelease(data);
            return Err("CGImageDestinationCreateWithData returned null".to_string());
        }

        CGImageDestinationAddImage(dest, image, ptr::null());
        let ok = CGImageDestinationFinalize(dest);
        CFRelease(dest);

        if !ok {
            CFRelease(data);
            return Err("CGImageDestinationFinalize failed".to_string());
        }

        let ptr_bytes = CFDataGetBytePtr(data);
        let len = CFDataGetLength(data) as usize;
        let bytes = std::slice::from_raw_parts(ptr_bytes, len).to_vec();
        CFRelease(data);
        Ok(bytes)
    }
}

/// Whether zWork itself has Screen Recording permission (non-prompting). Use
/// before listing/capturing so the UI can route the user to System Settings.
pub fn screen_capture_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Trigger the native macOS "allow Screen Recording" prompt (prompting). macOS
/// only honors this on the app's first launch; subsequent calls return the
/// cached state. The UI pairs this with a deep-link to System Settings for
/// re-grants. Returns the (post-prompt) permission state.
pub fn request_screen_capture() -> bool {
    // The prompting call. Pump the run loop once so the TCC cache updates
    // before the caller immediately re-preflights.
    let _ = unsafe { CGRequestScreenCaptureAccess() };
    yield_run_loop_once();
    // CGRequestScreenCaptureAccess's return value is unreliable across macOS
    // versions; re-preflight to report a consistent state.
    unsafe { CGPreflightScreenCaptureAccess() }
}
