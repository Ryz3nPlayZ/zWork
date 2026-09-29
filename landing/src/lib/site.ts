export const DOWNLOAD_URL = "https://github.com/Ryz3nPlayZ/zWork/releases/latest";
export const REPO_URL = "https://github.com/Ryz3nPlayZ/zWork";
export const PRIVACY_URL = `${REPO_URL}/blob/main/legal/PRIVACY.md`;
export const TERMS_URL = `${REPO_URL}/blob/main/legal/TERMS.md`;

export type Platform = "Mac" | "Windows" | "Linux";

/** Best guess at the visitor's desktop OS, for the download label. Phones
 *  get null (zWork is a desktop app); unknowns get "Mac", the primary build. */
export function detectPlatform(): Platform | null {
  if (typeof navigator === "undefined") return "Mac";
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return null;
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "Linux";
  return "Mac";
}
