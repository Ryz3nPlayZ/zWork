/** The Dock icon choice. "system" leaves the bundle icon, which follows the Mac's appearance. */
import { useState } from "react";
import { hasTrafficLights } from "./platform";

export type AppIconPref = "system" | "light" | "dark";
const KEY = "zwork.appIcon";

export function loadAppIconPref(): AppIconPref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "system";
}

export function applyAppIcon(variant: AppIconPref): void {
  if (!hasTrafficLights()) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("set_app_icon", { variant }))
    .catch((err) => console.warn("[appIcon] set_app_icon failed:", err));
}

export function useAppIconPref(): [AppIconPref, (v: AppIconPref) => void] {
  const [pref, setPref] = useState(loadAppIconPref);
  const set = (v: AppIconPref) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {}
    setPref(v);
    applyAppIcon(v);
  };
  return [pref, set];
}
