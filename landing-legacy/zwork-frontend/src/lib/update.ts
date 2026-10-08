import { invoke } from "@tauri-apps/api/core";
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
  | { phase: "opening" }
  | { phase: "relaunching" }
  | { phase: "error"; message: string };

const releasePage = "https://github.com/Ryz3nPlayZ/zWork/releases/latest";
const releasesApi = "https://api.github.com/repos/Ryz3nPlayZ/zWork/releases/latest";
const lastInstalledUpdateKey = "zwork:last-installed-update";

function normalizeVersion(value: string): string {
  return value.replace(/^v/i, "").trim();
}

interface SemverVersion {
  core: number[];
  prerelease: Array<number | string> | null;
}

function parseVersion(value: string): SemverVersion {
  const normalized = normalizeVersion(value);
  const [coreRaw, prereleaseRaw] = normalized.split("-", 2);
  const core = coreRaw.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const prerelease = prereleaseRaw
    ? prereleaseRaw.split(".").map((part) => {
        if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
        return part;
      })
    : null;
  return { core, prerelease };
}

function compareIdentifier(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a.localeCompare(b);
}

function compareVersions(a: SemverVersion, b: SemverVersion): number {
  const n = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < n; i += 1) {
    const av = a.core[i] ?? 0;
    const bv = b.core[i] ?? 0;
    if (av !== bv) return av - bv;
  }

  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;

  const m = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < m; i += 1) {
    const av = a.prerelease[i];
    const bv = b.prerelease[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const diff = compareIdentifier(av, bv);
    if (diff !== 0) return diff;
  }

  return 0;
}

async function checkTauriUpdater(currentVersionParts: SemverVersion): Promise<UpdateCardState | null> {
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

interface GithubReleasePayload {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

async function checkGitHubReleases(
  currentVersion: string,
  currentVersionParts: SemverVersion,
): Promise<UpdateCardState | null> {
  try {
    const response = await fetch(releasesApi, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const release = (await response.json()) as GithubReleasePayload;
    if (!release.tag_name || release.draft) return null;

    const latestVersion = normalizeVersion(release.tag_name);
    if (!latestVersion) return null;
    if (compareVersions(parseVersion(latestVersion), currentVersionParts) <= 0) return null;

    return {
      currentVersion: normalizeVersion(currentVersion),
      latestVersion,
      releaseUrl: release.html_url || releasePage,
      notes: release.body || undefined,
      source: "github",
    };
  } catch {
    return null;
  }
}

export async function detectUpdate(currentVersion: string): Promise<UpdateCardState | null> {
  const currentVersionParts = parseVersion(currentVersion);
  const fromUpdater = await checkTauriUpdater(currentVersionParts);
  if (fromUpdater) return fromUpdater;
  return await checkGitHubReleases(currentVersion, currentVersionParts);
}

export async function installUpdate(
  card: UpdateCardState,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<{ ok: true; willRelaunch: boolean } | { ok: false; message: string }> {
  if (card.source === "github") {
    try {
      onProgress?.({ phase: "opening" });
      await openReleaseUrl(card.releaseUrl);
      onProgress?.({ phase: "idle" });
      return { ok: true, willRelaunch: false };
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : "Could not open the release page.";
      onProgress?.({ phase: "error", message });
      return { ok: false, message };
    }
  }

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

export async function openReleaseUrl(url: string): Promise<void> {
  await invoke("open_external", { url });
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
