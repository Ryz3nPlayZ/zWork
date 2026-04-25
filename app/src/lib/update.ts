import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export interface UpdateCardState {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  notes?: string;
  source: "updater" | "github";
}

export type UpdateProgress =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "downloading"; downloadedBytes: number; totalBytes: number | null }
  | { phase: "installing" }
  | { phase: "relaunching" }
  | { phase: "error"; message: string };

const releaseRepo = "https://api.github.com/repos/Ryz3nPlayZ/zWork/releases/latest";
const releasePage = "https://github.com/Ryz3nPlayZ/zWork/releases/latest";
const lastInstalledUpdateKey = "zwork:last-installed-update";

function normalizeVersion(value: string): string {
  return value.replace(/^v/i, "").trim();
}

function parseVersion(value: string): number[] {
  return normalizeVersion(value)
    .split(".")
    .map((part) => Number.parseInt(part.replace(/[^\d].*$/, ""), 10) || 0);
}

function compareVersions(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

async function checkTauriUpdater(currentVersionParts: number[]): Promise<UpdateCardState | null> {
  try {
    const update = await check({ timeout: 15000 });
    if (!update) return null;

    const latestVersion = normalizeVersion(update.version);
    if (!latestVersion) return null;
    if (compareVersions(parseVersion(latestVersion), currentVersionParts) <= 0) return null;

    return {
      currentVersion: normalizeVersion(update.currentVersion),
      latestVersion,
      releaseUrl: releasePage,
      notes: update.body,
      source: "updater",
    };
  } catch {
    return null;
  }
}

async function checkGithubRelease(currentVersion: string, currentVersionParts: number[]): Promise<UpdateCardState | null> {
  try {
    const response = await fetch(releaseRepo, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { tag_name?: string; html_url?: string; body?: string };
    const latestVersion = normalizeVersion(data.tag_name || "");
    if (!latestVersion) return null;
    if (compareVersions(parseVersion(latestVersion), currentVersionParts) <= 0) return null;

    return {
      currentVersion: normalizeVersion(currentVersion),
      latestVersion,
      releaseUrl: data.html_url || releasePage,
      notes: data.body || undefined,
      source: "github",
    };
  } catch {
    return null;
  }
}

export async function detectUpdate(currentVersion: string): Promise<UpdateCardState | null> {
  const currentVersionParts = parseVersion(currentVersion);
  return (await checkTauriUpdater(currentVersionParts)) || (await checkGithubRelease(currentVersion, currentVersionParts));
}

export async function installUpdate(
  card: UpdateCardState,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<{ ok: true; willRelaunch: true } | { ok: false; message: string }> {
  try {
    onProgress?.({ phase: "checking" });
    const update = await check({ timeout: 15000 });
    if (!update) {
      return { ok: false, message: "No native update package is available for this build." };
    }

    let totalBytes: number | null = null;
    let downloadedBytes = 0;
    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? null;
        downloadedBytes = 0;
        onProgress?.({ phase: "downloading", downloadedBytes, totalBytes });
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        onProgress?.({ phase: "downloading", downloadedBytes, totalBytes });
      } else if (event.event === "Finished") {
        onProgress?.({ phase: "installing" });
      }
    });
    try {
      window.localStorage.setItem(
        lastInstalledUpdateKey,
        JSON.stringify({
          version: card.latestVersion,
          releaseUrl: card.releaseUrl,
          notes: card.notes || "",
          installedAt: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }
    onProgress?.({ phase: "relaunching" });
    await relaunch();
    return { ok: true, willRelaunch: true };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Update failed.";
    onProgress?.({ phase: "error", message });
    return { ok: false, message };
  }
}

export function consumeInstalledUpdateNotice(currentVersion: string): {
  version: string;
  releaseUrl: string;
  notes?: string;
} | null {
  try {
    const raw = window.localStorage.getItem(lastInstalledUpdateKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: string; releaseUrl?: string; notes?: string };
    const version = normalizeVersion(parsed.version || "");
    if (!version || version !== normalizeVersion(currentVersion)) return null;
    window.localStorage.removeItem(lastInstalledUpdateKey);
    return {
      version,
      releaseUrl: parsed.releaseUrl || releasePage,
      notes: parsed.notes || undefined,
    };
  } catch {
    return null;
  }
}
