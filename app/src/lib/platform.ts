export const IS_TAURI = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const ua = navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X/i.test(ua);
}

let softwareRenderingCache: boolean | null = null;

/** Detect whether the browser is using a software (CPU) WebGL renderer.
 *  This is true on Linux when Tauri forces software rendering via
 *  WEBKIT_DISABLE_COMPOSITING_MODE + LIBGL_ALWAYS_SOFTWARE.
 */
export function isSoftwareRendering(): boolean {
  if (softwareRenderingCache !== null) return softwareRenderingCache;

  if (typeof document === "undefined") {
    softwareRenderingCache = false;
    return false;
  }

  const canvas = document.createElement("canvas");
  const gl =
    canvas.getContext("webgl") ||
    canvas.getContext("experimental-webgl");

  if (!gl) {
    softwareRenderingCache = true;
    return true;
  }

  const debugInfo = (gl as WebGLRenderingContext).getExtension(
    "WEBGL_debug_renderer_info",
  );
  if (!debugInfo) {
    softwareRenderingCache = false;
    return false;
  }

  const renderer = (gl as WebGLRenderingContext).getParameter(
    debugInfo.UNMASKED_RENDERER_WEBGL,
  ) as string;

  softwareRenderingCache = /software|llvmpipe|swiftshader|softpipe/i.test(
    renderer,
  );
  return softwareRenderingCache;
}

/** True when the current platform is likely to struggle with GPU-heavy effects.
 *  Matches Linux + software rendering, which is the Tauri/WebKitGTK combo
 *  that forces CPU compositing in unpatched AppImages.
 */
export function needsLightweightRendering(): boolean {
  return isSoftwareRendering();
}
