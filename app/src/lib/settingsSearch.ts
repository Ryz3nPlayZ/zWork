/**
 * Settings search: matches page names and the settings on each page,
 * including the everyday words people use for them ("zoom" finds Interface
 * size, "dark mode" finds Theme). Scoring adapted from Freebuff
 * (common/src/util/settings-search.ts, Apache-2.0).
 *
 * A topic's label must be the setting's visible label: the Settings page
 * scrolls to the element showing that text.
 */

export type SettingsPage = "general" | "account" | "appearance" | "memory" | "models" | "integrations";

type Topic = { label: string; keywords: string; desktop?: boolean };

export const SETTINGS_TOPICS: Record<SettingsPage, Topic[]> = {
  general: [
    { label: "Default model", keywords: "ai model new chats pick switch" },
    { label: "Using your apps", keywords: "permissions computer control accessibility mac allow", desktop: true },
    { label: "Control apps", keywords: "accessibility permission click type mouse keyboard", desktop: true },
    { label: "See the screen", keywords: "screen recording screenshot permission", desktop: true },
    { label: "Chrome extension", keywords: "browser chrome web extension connect", desktop: true },
    { label: "Skip the check before risky actions", keywords: "approve approval confirm delete destructive ask", desktop: true },
    { label: "Privacy", keywords: "analytics telemetry tracking data collected" },
    { label: "Share anonymous usage stats", keywords: "analytics telemetry tracking opt out" },
    { label: "Keyboard Shortcuts", keywords: "hotkey keybinding shortcut overlay chatbox summon", desktop: true },
    { label: "Version", keywords: "update about release number" },
  ],
  account: [{ label: "Account", keywords: "sign in sign out login google sync profile email" }],
  appearance: [
    { label: "Theme", keywords: "dark mode light mode system auto preset colors palette look" },
    { label: "Colors", keywords: "accent surface text custom color picker brand" },
    { label: "More palettes", keywords: "color scheme catppuccin dracula nord gruvbox solarized tokyo github monokai" },
    { label: "Saved themes", keywords: "save preset my theme custom keep" },
    { label: "Interface size", keywords: "font text size zoom scale bigger smaller icons readable" },
    { label: "Wallpaper", keywords: "background image picture photo gradient custom upload" },
    { label: "Wallpaper opacity", keywords: "background fade strength dim" },
    { label: "Wallpaper blur", keywords: "background soften frosted" },
    { label: "Fade", keywords: "gradient fade direction position edge wallpaper" },
    { label: "Panel opacity", keywords: "transparency see through glass chat panel sidebar readable" },
    { label: "Panel blur", keywords: "glass frosted blur transparency" },
    { label: "Surface style", keywords: "3d flat depth highlight shadow cards" },
    { label: "Sidebar translucency", keywords: "glass vibrancy desktop blur sidebar", desktop: true },
    { label: "Dithering", keywords: "pixel retro bayer pattern size color levels invert image" },
    { label: "Import and export", keywords: "theme file save share copy paste backup" },
  ],
  memory: [{ label: "Prompt templates", keywords: "templates snippets slash commands saved prompts remember" }],
  models: [{ label: "Models", keywords: "add model provider api key openai anthropic google openrouter ollama protocol" }],
  integrations: [{ label: "AI apps", keywords: "claude code codex installed apps reuse rescan integrations" }],
};

export function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A single missing, extra, or mistyped letter; short words must match literally.
function nearWord(query: string, word: string): boolean {
  if (query.length < 4 || Math.abs(query.length - word.length) > 1) return false;
  let edits = 0;
  for (let i = 0, j = 0; i < query.length || j < word.length; ) {
    if (query[i] === word[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (query.length >= word.length) i++;
    if (word.length >= query.length) j++;
  }
  return true;
}

function score(query: string, label: string, keywords = ""): number {
  const name = normalize(label);
  if (name === query) return 100;
  if (name.startsWith(query)) return 90;
  if (name.includes(query)) return 80;
  const words = normalize(`${label} ${keywords}`).split(" ");
  let fuzzy = false;
  for (const token of query.split(" ")) {
    if (words.some((w) => w.startsWith(token))) continue;
    if (!words.some((w) => nearWord(token, w))) return 0;
    fuzzy = true;
  }
  return fuzzy ? 10 : 50;
}

export interface SearchHit<P extends string> {
  page: P;
  /** The matched setting's label, when it beat the page name. */
  detail?: string;
}

/** Best match per page, best pages first. An empty query lists every page. */
export function searchSettings<P extends SettingsPage>(
  query: string,
  pages: { id: P; label: string }[],
  desktop: boolean,
): SearchHit<P>[] {
  const q = normalize(query);
  if (!q) return query.trim() ? [] : pages.map((p) => ({ page: p.id }));
  return pages
    .map((p) => {
      let best = score(q, p.label);
      let detail: string | undefined;
      for (const t of SETTINGS_TOPICS[p.id]) {
        if (t.desktop && !desktop) continue;
        const v = score(q, t.label, `${p.label} ${t.keywords}`);
        if (v > best && t.label !== p.label) {
          best = v;
          detail = t.label;
        }
      }
      return { page: p.id, detail, score: best };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ page, detail }) => ({ page, detail }));
}
