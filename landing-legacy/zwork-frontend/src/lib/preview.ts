export type PreviewMode = "auth" | "app" | null;

function readPreviewParam(): string {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get("preview") || "";
  } catch {
    return "";
  }
}

export function getPreviewMode(): PreviewMode {
  const envPreview = (import.meta.env.VITE_ZWORK_PREVIEW as string | undefined)?.trim() || "";
  const raw = envPreview || readPreviewParam();
  if (raw === "auth" || raw === "app") return raw;
  return null;
}
