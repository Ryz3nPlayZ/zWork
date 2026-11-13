/* Hallmark · genre: modern-minimal · design-system: design.md · designed-as-app */

/**
 * Settings → Appearance. Every look control Freebuff Desktop has, in the same
 * order: Theme, Interface size, Wallpaper, Panels, Dithering, Import and export.
 * The state lives in lib/wallpaper.ts (look) and lib/themes/custom.ts (colors).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Upload, X } from "lucide-react";
import { cn } from "../lib/cn";
import { applyZoom, loadZoom } from "../lib/zoom";
import { setSchemePref, resolvedSchemeModes, setThemePref } from "../lib/theme";
import { COLOR_SCHEMES, DEFAULT_SCHEME_ID } from "../lib/themes";
import {
  CUSTOM_SCHEME_ID,
  hexToRgb,
  readableText,
  rgbToHex,
  type ThemeColors,
} from "../lib/themes/custom";
import {
  MAX_SAVED,
  THEME_PRESETS,
  WALLPAPER_PRESETS,
  applyMode,
  applyPreset,
  applyTheme as applySavedTheme,
  encodeWallpaper,
  exportTheme,
  gradientCss,
  importTheme,
  notifyLookChanged,
  removeSaved,
  saveCurrentTheme,
  saveLook,
  setThemeColors,
  useLook,
  type DitherPattern,
  type FadeDir,
  type LookPatch,
} from "../lib/wallpaper";
import {
  nativeVibrancySupported,
  setTranslucencyPref,
  translucencySupported,
  useTranslucencyPref,
} from "../lib/translucency";
import { Button, Segmented, Switch } from "./page/Page";

// ---------------- primitives ----------------

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
      {hint && <p className="mt-0.5 text-[12px] text-ink-muted">{hint}</p>}
      <div className="mt-2.5 divide-y divide-line-soft rounded-xl border border-line bg-paper-raised px-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, children, stack }: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={cn("py-3", stack ? "space-y-2.5" : "flex items-center justify-between gap-4")}>
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-4 text-ink-muted">{hint}</div>}
      </div>
      <div className={cn(stack ? "" : "flex shrink-0 items-center gap-2")}>{children}</div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "%",
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className={cn("flex items-center gap-3", disabled && "opacity-50")}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="ring-focus w-40 accent-[rgb(var(--accent))] disabled:cursor-not-allowed"
      />
      <span className="w-11 text-right text-[12px] tabular-nums text-ink-muted">
        {value}
        {unit}
      </span>
    </div>
  );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="press ring-focus-within flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-line bg-paper pl-1.5 pr-2.5 hover:border-line-strong">
      <span className="h-5 w-5 rounded-md border border-line" style={{ backgroundColor: value }} />
      <span className="text-[12px] text-ink">{label}</span>
      <span className="text-[11px] uppercase tabular-nums text-ink-faint">{value.slice(1)}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="sr-only" aria-label={label} />
    </label>
  );
}

function Select<T extends string>({
  value,
  onChange,
  label,
  children,
}: {
  value: T;
  onChange: (v: T) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
        className="press ring-focus h-8 min-w-[150px] cursor-pointer appearance-none rounded-lg border border-line bg-paper pl-3 pr-8 text-[12.5px] text-ink hover:border-line-strong focus:border-line-strong focus:outline-none"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
    </div>
  );
}

/** "R G B" from a CSS variable on :root, as #rrggbb. */
function cssColor(name: string): string {
  const parts = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? rgbToHex(parts as [number, number, number]) : "#808080";
}

// ---------------- theme tiles ----------------

function Tile({
  label,
  selected,
  onClick,
  surface,
  text,
  accent,
  backdrop,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  surface: string;
  text: string;
  accent: string;
  backdrop?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="press ring-focus group flex w-[92px] flex-col items-center gap-1.5 rounded-lg"
    >
      <span
        className={cn(
          "relative flex h-[58px] w-full items-end overflow-hidden rounded-lg border p-1.5 transition-shadow",
          selected ? "border-transparent shadow-[0_0_0_2px_rgb(var(--accent))]" : "border-line group-hover:border-line-strong",
        )}
        style={{ background: backdrop ?? surface }}
      >
        <span className="flex h-[34px] w-full flex-col justify-center gap-1 rounded-md px-1.5" style={{ background: surface }}>
          <span className="h-[3px] w-3/4 rounded-full" style={{ background: text, opacity: 0.85 }} />
          <span className="flex items-center gap-1">
            <span className="h-[3px] w-1/2 rounded-full" style={{ background: text, opacity: 0.4 }} />
            <span className="ml-auto h-2 w-2 rounded-full" style={{ background: accent }} />
          </span>
        </span>
        {selected && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-paper">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
        )}
      </span>
      <span className={cn("text-[11.5px]", selected ? "font-medium text-ink" : "text-ink-muted")}>{label}</span>
    </button>
  );
}

const PARCHMENT = {
  light: { surface: "#f2f0e8", text: "#302e28", accent: "#c9825b" },
  dark: { surface: "#1f1e1b", text: "#e8e4da", accent: "#d39470" },
};

// ---------------- panel ----------------

export function AppearanceSettings() {
  const { look, image, saved, scheme, mode, colors } = useLook();
  const translucency = useTranslucencyPref();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(() => Math.round(loadZoom() * 100));
  const [themeName, setThemeName] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const hasWallpaper = look.wallpaper !== "none";
  const isCustom = scheme === CUSTOM_SCHEME_ID;
  const modes = resolvedSchemeModes();

  // What the color pickers start from: the custom colors, or what's on screen now.
  const [shown, setShown] = useState<ThemeColors>(colors);
  useEffect(() => {
    setShown(isCustom ? colors : { accent: cssColor("--accent"), surface: cssColor("--paper"), text: cssColor("--ink") });
  }, [isCustom, colors, scheme, mode]);

  const guard = (fn: () => void) => {
    setError(null);
    setNote(null);
    try {
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "zWork couldn't save that. Try a smaller picture.");
    }
  };
  const patch = (p: LookPatch) => guard(() => saveLook(p));

  const setColor = (k: keyof ThemeColors, v: string) => {
    const next = { ...shown, [k]: v };
    setShown(next);
    setThemeColors(next);
  };
  const adjusted =
    isCustom && rgbToHex(readableText(hexToRgb(colors.surface), hexToRgb(colors.text))) !== colors.text.toLowerCase();

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const url = await encodeWallpaper(file);
      guard(() => saveLook({ wallpaper: "image" }, url));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyTheme = async () => {
    guard(() => {});
    try {
      await navigator.clipboard.writeText(exportTheme(themeName || "My theme"));
      setNote("Theme copied. Paste it into zWork on another computer, or send it to someone.");
    } catch {
      setError("zWork couldn't reach the clipboard.");
    }
  };
  const pasteTheme = async () => {
    guard(() => {});
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError("zWork couldn't read the clipboard. Use Import file instead.");
      return;
    }
    guard(() => setNote(`Applied “${importTheme(text).name}”.`));
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 4_500_000) return setError("That file is too large to be a zWork theme.");
    const text = await file.text();
    guard(() => setNote(`Applied “${importTheme(text).name}”.`));
  };

  const ditherOn = hasWallpaper && look.dither.on;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Appearance</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">Theme, size, wallpaper, and how see-through the panels are.</p>
      </div>

      {(error || note) && (
        <p role="status" className={cn("-mb-2 text-[12px]", error ? "text-error" : "text-ink-muted")}>
          {error ?? note}
        </p>
      )}

      {/* ---- Theme ---- */}
      <Group title="Theme" hint="Pick a starting point, then change any of it below.">
        <div className="flex flex-wrap gap-x-2 gap-y-3 py-3.5">
          {(["system", "light", "dark"] as const).map((m) => {
            const p = m === "dark" ? PARCHMENT.dark : PARCHMENT.light;
            return (
              <Tile
                key={m}
                label={m === "system" ? "System" : m === "light" ? "Light" : "Dark"}
                selected={scheme === DEFAULT_SCHEME_ID && mode === m}
                onClick={() => guard(() => applyMode(m))}
                {...p}
                backdrop={m === "system" ? `linear-gradient(110deg, ${PARCHMENT.light.surface} 50%, ${PARCHMENT.dark.surface} 50%)` : undefined}
              />
            );
          })}
          {THEME_PRESETS.map((p) => {
            const g = WALLPAPER_PRESETS.find((w) => w.id === p.look.wallpaper);
            return (
              <Tile
                key={p.id}
                label={p.label}
                selected={look.preset === p.id}
                onClick={() => guard(() => applyPreset(p))}
                {...p.colors}
                backdrop={g ? gradientCss(g) : undefined}
              />
            );
          })}
        </div>

        <Row
          label="Colors"
          hint={
            adjusted
              ? "The text color was adjusted so it stays readable on this surface."
              : "Three colors set the whole app. Changing one makes this your own theme."
          }
          stack
        >
          <div className="flex flex-wrap gap-2">
            <ColorInput label="Accent" value={shown.accent} onChange={(v) => setColor("accent", v)} />
            <ColorInput label="Surface" value={shown.surface} onChange={(v) => setColor("surface", v)} />
            <ColorInput label="Text" value={shown.text} onChange={(v) => setColor("text", v)} />
          </div>
        </Row>

        <Row label="More palettes" hint="Ready-made color schemes from popular editors and apps.">
          <Select
            label="More palettes"
            value={scheme}
            onChange={(id) =>
              guard(() => {
                setSchemePref(id);
                saveLook({ preset: null });
                notifyLookChanged();
              })
            }
          >
            {isCustom && <option value={CUSTOM_SCHEME_ID}>Your colors</option>}
            {Object.entries(
              COLOR_SCHEMES.reduce<Record<string, typeof COLOR_SCHEMES>>((acc, s) => {
                (acc[s.group ?? "Other"] ??= []).push(s);
                return acc;
              }, {}),
            ).map(([group, list]) => (
              <optgroup key={group} label={group}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id === DEFAULT_SCHEME_ID ? "zWork (default)" : s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          {!isCustom && scheme !== DEFAULT_SCHEME_ID && modes.length > 1 && (
            <Segmented
              label="Light or dark"
              value={mode}
              onChange={(m) => guard(() => { setThemePref(m); notifyLookChanged(); })}
              options={[
                { value: "system", label: "Auto" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          )}
        </Row>

        <Row label="Saved themes" hint={`Keep up to ${MAX_SAVED} of your own, with their wallpaper.`} stack>
          {saved.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {saved.map((t, i) => (
                <span key={i} className="inline-flex h-8 items-center rounded-lg border border-line bg-paper">
                  <button
                    type="button"
                    onClick={() => guard(() => { applySavedTheme(t); setNote(`Applied “${t.name}”.`); })}
                    className="press ring-focus flex h-full items-center gap-2 rounded-l-lg pl-2 pr-2.5 text-[12.5px] text-ink hover:bg-paper-sunken"
                  >
                    <span
                      className="h-4 w-4 rounded-full border border-line"
                      style={{ background: t.colors ? `linear-gradient(135deg, ${t.colors.surface} 50%, ${t.colors.accent} 50%)` : PARCHMENT.light.accent }}
                    />
                    {t.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${t.name}`}
                    onClick={() => guard(() => removeSaved(i))}
                    className="press ring-focus flex h-full w-7 items-center justify-center rounded-r-lg border-l border-line text-ink-faint hover:bg-paper-sunken hover:text-ink"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {saved.length < MAX_SAVED ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                guard(() => {
                  saveCurrentTheme(themeName);
                  setThemeName("");
                });
              }}
            >
              <input
                value={themeName}
                onChange={(e) => setThemeName(e.target.value)}
                placeholder="Name this theme"
                maxLength={40}
                aria-label="Theme name"
                className="h-8 w-48 rounded-lg border border-line bg-paper px-3 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
              />
              <Button type="submit">Save current look</Button>
            </form>
          ) : (
            <p className="text-[11.5px] text-ink-muted">Remove a saved theme to save another.</p>
          )}
        </Row>
      </Group>

      {/* ---- Interface size ---- */}
      <Group title="Interface size" hint="Makes text, icons, and controls bigger or smaller everywhere.">
        <Row label="Interface size" hint="Shortcut: Cmd + and Cmd −.">
          <Slider
            label="Interface size"
            value={zoom}
            min={70}
            max={160}
            step={10}
            onChange={(v) => {
              setZoom(v);
              void applyZoom(v / 100);
            }}
          />
          <Button
            disabled={zoom === 100}
            onClick={() => {
              setZoom(100);
              void applyZoom(1);
            }}
          >
            Reset
          </Button>
        </Row>
      </Group>

      {/* ---- Wallpaper ---- */}
      <Group title="Wallpaper" hint="A gradient or your own picture behind the sidebar and chat.">
        <div className="py-3.5">
          <div className="flex flex-wrap gap-2">
            <Swatch label="None" selected={!hasWallpaper} onClick={() => patch({ wallpaper: "none" })}>
              <span className="text-[11px] text-ink-muted">None</span>
            </Swatch>
            {WALLPAPER_PRESETS.map((g) => (
              <Swatch
                key={g.id}
                label={g.label}
                selected={look.wallpaper === g.id}
                onClick={() => patch({ wallpaper: g.id })}
                style={{ backgroundImage: gradientCss(g) }}
              />
            ))}
            {image && (
              <Swatch
                label="Your picture"
                selected={look.wallpaper === "image"}
                onClick={() => patch({ wallpaper: "image" })}
                style={{ backgroundImage: `url("${image}")` }}
              />
            )}
            <label
              className={cn(
                "press ring-focus-within flex h-12 w-16 shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-line bg-paper text-[11px] text-ink-muted hover:border-line-strong hover:text-ink",
                busy && "pointer-events-none opacity-60",
              )}
            >
              <Upload className="h-3.5 w-3.5" />
              {busy ? "…" : image ? "Replace" : "Upload"}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  void upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
        {hasWallpaper && (
          <>
            <Row label="Wallpaper opacity" hint="Lower lets the surface color through.">
              <Slider label="Wallpaper opacity" value={look.opacity} min={10} max={100} onChange={(v) => patch({ opacity: v })} />
            </Row>
            <Row label="Wallpaper blur">
              <Slider label="Wallpaper blur" value={look.blur} min={0} max={24} unit="px" onChange={(v) => patch({ blur: v })} />
            </Row>
            <Row label="Fade" hint="Blend the wallpaper into the surface color toward one edge.">
              <Switch label="Fade" checked={look.fade.on} onChange={() => patch({ fade: { on: !look.fade.on } })} />
            </Row>
            {look.fade.on && (
              <>
                <Row label="Fade toward">
                  <Segmented<FadeDir>
                    label="Fade toward"
                    value={look.fade.dir}
                    onChange={(dir) => patch({ fade: { dir } })}
                    options={[
                      { value: "top", label: "Top" },
                      { value: "bottom", label: "Bottom" },
                      { value: "left", label: "Left" },
                      { value: "right", label: "Right" },
                    ]}
                  />
                </Row>
                <Row label="Fade starts at">
                  <Slider label="Fade starts at" value={look.fade.at} min={0} max={100} onChange={(v) => patch({ fade: { at: v } })} />
                </Row>
              </>
            )}
          </>
        )}
      </Group>

      {/* ---- Panels ---- */}
      <Group title="Panels" hint="How the sidebar and chat panel sit over the wallpaper.">
        <Row label="Panel opacity" hint={hasWallpaper ? "Lower shows more wallpaper; higher is easier to read." : "Pick a wallpaper to see through the panels."}>
          <Slider label="Panel opacity" value={look.pane} min={50} max={100} disabled={!hasWallpaper} onChange={(v) => patch({ pane: v })} />
        </Row>
        <Row label="Panel blur" hint="Frosted glass. Turn it down to keep the wallpaper sharp.">
          <Slider label="Panel blur" value={look.paneBlur} min={0} max={40} unit="px" disabled={!hasWallpaper} onChange={(v) => patch({ paneBlur: v })} />
        </Row>
        <Row label="Surface style" hint="3D adds a lit edge and soft depth to panels and cards.">
          <Segmented<"flat" | "3d">
            label="Surface style"
            value={look.surface}
            onChange={(surface) => patch({ surface })}
            options={[
              { value: "flat", label: "Flat" },
              { value: "3d", label: "3D" },
            ]}
          />
        </Row>
        {translucencySupported() && (
          <Row
            label="Sidebar translucency"
            hint={
              nativeVibrancySupported()
                ? "Frosted sidebar that shows your desktop. Off while a wallpaper is on."
                : "A lighter, glassy sidebar. Best on macOS."
            }
          >
            <Switch
              label="Sidebar translucency"
              checked={translucency === "on"}
              onChange={() => setTranslucencyPref(translucency === "on" ? "off" : "on")}
            />
          </Row>
        )}
      </Group>

      {/* ---- Dithering ---- */}
      <Group title="Dithering" hint="Turns the wallpaper into a pattern of pixels, like an old print or screen.">
        <Row label="Dithering" hint={hasWallpaper ? undefined : "Pick a wallpaper first."}>
          <Switch label="Dithering" disabled={!hasWallpaper} checked={ditherOn} onChange={() => patch({ dither: { on: !look.dither.on } })} />
        </Row>
        {ditherOn && (
          <>
            <Row label="Pattern" hint="Larger patterns give smoother shading.">
              <Segmented<string>
                label="Pattern"
                value={String(look.dither.pattern)}
                onChange={(v) => patch({ dither: { pattern: Number(v) as DitherPattern } })}
                options={[
                  { value: "2", label: "2×2" },
                  { value: "4", label: "4×4" },
                  { value: "8", label: "8×8" },
                ]}
              />
            </Row>
            <Row label="Pixel size">
              <Slider label="Pixel size" value={look.dither.size} min={1} max={8} unit="px" onChange={(v) => patch({ dither: { size: v } })} />
            </Row>
            <Row label="Color levels" hint="Fewer levels look bolder.">
              <Slider label="Color levels" value={look.dither.steps} min={2} max={8} unit="" onChange={(v) => patch({ dither: { steps: v } })} />
            </Row>
            <Row label="Invert">
              <Switch label="Invert" checked={look.dither.invert} onChange={() => patch({ dither: { invert: !look.dither.invert } })} />
            </Row>
            <Row label="Keep the wallpaper's colors" hint="Off paints the pattern in the three colors below.">
              <Switch
                label="Keep the wallpaper's colors"
                checked={look.dither.original}
                onChange={() => patch({ dither: { original: !look.dither.original } })}
              />
            </Row>
            {!look.dither.original && (
              <Row label="Pattern colors" stack>
                <div className="flex flex-wrap gap-2">
                  <ColorInput label="Shadows" value={look.dither.back} onChange={(v) => patch({ dither: { back: v } })} />
                  <ColorInput label="Midtones" value={look.dither.front} onChange={(v) => patch({ dither: { front: v } })} />
                  <ColorInput label="Highlights" value={look.dither.highlight} onChange={(v) => patch({ dither: { highlight: v } })} />
                </div>
              </Row>
            )}
          </>
        )}
      </Group>

      {/* ---- Import and export ---- */}
      <Group title="Import and export" hint="Move your look to another computer or share it with someone.">
        <Row label="Import and export" hint="A theme holds the colors, wallpaper, and every setting above. Not your interface size." stack>
          <div className="flex flex-wrap gap-2">
          <Button icon={<Copy />} onClick={() => void copyTheme()}>
            Copy theme
          </Button>
          <Button onClick={() => void pasteTheme()}>Paste theme</Button>
          <Button icon={<Upload />} onClick={() => importRef.current?.click()}>
            Import file
          </Button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json,.txt"
            className="sr-only"
            onChange={(e) => {
              void importFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          </div>
        </Row>
      </Group>
    </div>
  );
}

function Swatch({
  label,
  selected,
  onClick,
  style,
  children,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  style?: React.CSSProperties;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={selected}
      onClick={onClick}
      style={style}
      className={cn(
        "press ring-focus flex h-12 w-16 shrink-0 items-center justify-center rounded-lg border bg-paper bg-cover bg-center transition-shadow",
        selected ? "border-transparent shadow-[0_0_0_2px_rgb(var(--accent))]" : "border-line hover:border-line-strong",
      )}
    >
      {children}
    </button>
  );
}
