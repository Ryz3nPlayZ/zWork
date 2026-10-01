import { useEffect, useState } from "react";

export const REPO = "Ryz3nPlayZ/zWork";
export const REPO_URL = `https://github.com/${REPO}`;
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;
export const DOCS_URL = `${REPO_URL}/blob/main/docs/WIKI.md`;
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;
export const PRIVACY_URL = `${REPO_URL}/blob/main/legal/PRIVACY.md`;
export const TERMS_URL = `${REPO_URL}/blob/main/legal/TERMS.md`;
/** The real app, built for the web, no sign-in. See docs/INVENTORY.md. */
export const DEMO_URL = "https://app.tryzwork.app";

export type Platform = "Mac" | "Windows" | "Linux";
export const PLATFORMS: Platform[] = ["Mac", "Windows", "Linux"];

/** Direct installer links. Asset names are fixed by .github/workflows/release.yml. */
const ASSET: Record<Platform, string> = {
  Mac: "zWork-macos-universal.dmg",
  Windows: "zWork-windows-x86_64-setup.exe",
  Linux: "zWork-linux-x86_64.AppImage",
};

export const ASSET_LABEL: Record<Platform, string> = {
  Mac: ".dmg, Apple silicon and Intel",
  Windows: ".exe installer, x64",
  Linux: ".AppImage, x86_64",
};

/** One-line installs, the same ones the README gives. */
export const INSTALL: Record<Platform, { shell: string; command: string }> = {
  Mac: { shell: "Terminal", command: "brew install Ryz3nPlayZ/tap/zwork" },
  Windows: {
    shell: "PowerShell",
    command: `irm https://raw.githubusercontent.com/${REPO}/main/scripts/install-windows.ps1 | iex`,
  },
  Linux: {
    shell: "Terminal",
    command: `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash`,
  },
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

export type RepoStats = { stars: number | null; version: string | null };

const STATS_KEY = "zwork:repo-stats";
const STATS_TTL = 60 * 60 * 1000;

function readCache(): RepoStats | null {
  try {
    const raw = sessionStorage.getItem(STATS_KEY);
    if (!raw) return null;
    const { at, stats } = JSON.parse(raw) as { at: number; stats: RepoStats };
    return Date.now() - at < STATS_TTL ? stats : null;
  } catch {
    return null;
  }
}

/** Stars and the latest release tag from the public GitHub API. Unauthenticated
 *  calls are limited to 60 an hour per visitor, so the answer is cached for the
 *  session and every caller copes with nulls. */
export function useRepoStats(): RepoStats {
  const [stats, setStats] = useState<RepoStats>(() => readCache() ?? { stars: null, version: null });
  useEffect(() => {
    if (readCache()) return;
    const ctrl = new AbortController();
    const get = (path: string) =>
      fetch(`https://api.github.com/repos/${REPO}${path}`, { signal: ctrl.signal }).then((r) => (r.ok ? r.json() : null));
    Promise.all([get(""), get("/releases/latest")])
      .then(([repo, release]) => {
        const next: RepoStats = {
          stars: typeof repo?.stargazers_count === "number" ? repo.stargazers_count : null,
          version: typeof release?.tag_name === "string" ? release.tag_name.replace(/^v/, "") : null,
        };
        setStats(next);
        try {
          sessionStorage.setItem(STATS_KEY, JSON.stringify({ at: Date.now(), stats: next }));
        } catch {
          /* storage blocked: fetch again next visit */
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  return stats;
}
