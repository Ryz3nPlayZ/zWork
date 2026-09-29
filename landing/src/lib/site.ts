export const DOWNLOAD_URL = "https://github.com/Ryz3nPlayZ/zWork/releases/latest";
export const REPO_URL = "https://github.com/Ryz3nPlayZ/zWork";
export const PRIVACY_URL = `${REPO_URL}/blob/main/legal/PRIVACY.md`;
export const TERMS_URL = `${REPO_URL}/blob/main/legal/TERMS.md`;

export type Platform = "Mac" | "Windows" | "Linux";

/** Direct installer links. Asset names are fixed by .github/workflows/release.yml. */
const ASSET: Record<Platform, string> = {
  Mac: "zWork-macos-universal.dmg",
  Windows: "zWork-windows-x86_64-setup.exe",
  Linux: "zWork-linux-x86_64.AppImage",
};

/** The installer for this platform, or the release page when we can't tell. */
export function downloadUrl(platform: Platform | null): string {
  return platform ? `${DOWNLOAD_URL}/download/${ASSET[platform]}` : DOWNLOAD_URL;
}

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
