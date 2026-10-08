import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../package.json";

const FALLBACK_VERSION = packageJson.version;

export async function resolveAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return FALLBACK_VERSION;
  }
}

export function fallbackAppVersion(): string {
  return FALLBACK_VERSION;
}
