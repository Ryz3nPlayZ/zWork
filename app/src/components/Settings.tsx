/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  RefreshCw,
  ExternalLink,
  CircleCheck,
  CircleDashed,
  Plus,
  Trash2,
  X,
  Sun,
  Moon,
  Monitor,
  Cpu,
  Plug,
  Sliders,
  Brain,
  User,
  LogOut,
  ShieldAlert,
  AlertTriangle,
  ChevronDown,
  Palette,
  Download,
  Search,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { IS_TAURI } from "../lib/platform";
import { isWebAuthClient, startWebGoogleSignIn } from "../lib/cloud";
import { dragRegionAttrs, onDragMouseDown } from "../lib/drag";
import {
  setTranslucencyPref,
  useTranslucencyPref,
  nativeVibrancySupported,
  translucencySupported,
} from "../lib/translucency";
import {
  loadSchemePref,
  setSchemePref,
  loadThemePref,
  setThemePref,
  resolvedSchemeModes,
} from "../lib/theme";
import { COLOR_SCHEMES, DEFAULT_SCHEME_ID } from "../lib/themes";
import { fallbackAppVersion, resolveAppVersion } from "../lib/appVersion";
import {
  loadTemplates,
  saveTemplates,
  newTemplateId,
  normalizeTrigger,
  type PromptTemplate,
} from "../lib/templates";
import { IconButton } from "./IconButton";
import { api, IS_WEB, type CatalogModel, type CatalogProvider, type Integration, type RuntimeStatus } from "../lib/api";
import { KeybindRecorder } from "./KeybindRecorder";

type Section = "account" | "appearance" | "general" | "memory" | "models" | "integrations";

const SECTION_META: Record<Section, { title: string; description: string; icon: React.ReactNode }> = {
  account: {
    title: "Account",
    description: "Sign in with Google to sync your data.",
    icon: <User className="h-4 w-4" />,
  },
  appearance: {
    title: "Appearance",
    description: "Theme, color scheme, and sidebar glass.",
    icon: <Palette className="h-4 w-4" />,
  },
  general: {
    title: "General",
    description: "Defaults, permissions, and preferences.",
    icon: <Sliders className="h-4 w-4" />,
  },
  memory: {
    title: "Memory",
    description: "Persistent notes zWork remembers.",
    icon: <Brain className="h-4 w-4" />,
  },
  models: {
    title: "Models",
    description: "Register and manage AI models.",
    icon: <Cpu className="h-4 w-4" />,
  },
  integrations: {
    title: "Integrations",
    description: "Detect and reuse local tooling.",
    icon: <Plug className="h-4 w-4" />,
  },
};

export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const integrations = useApp((s) => s.integrations);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const refreshIntegrations = useApp((s) => s.refreshIntegrations);
  const refreshMe = useApp((s) => s.refreshMe);
  const saveSettings = useApp((s) => s.saveSettings);
  const setView = useApp((s) => s.setView);

  const hasModels = (providers?.models ?? []).length > 0;
  const consumeSettingsSection = useApp((s) => s.consumeSettingsSection);
  const [section, setSection] = useState<Section>("general");

  const refreshSettingsPage = useCallback(async () => {
    // The health poll only matters on desktop (local sidecar readiness). On
    // the web there's no sidecar, and /api/health polls just create console
    // noise.
    if (!IS_WEB) {
      await api.waitForBackend(20).catch(() => {});
    }
    await Promise.all([
      refreshProviders(),
      refreshSettings(),
      refreshIntegrations(),
      refreshMe(),
    ]);
  }, [refreshProviders, refreshSettings, refreshIntegrations, refreshMe]);

  useEffect(() => {
    void refreshSettingsPage();
  }, [refreshSettingsPage]);

  useEffect(() => {
    if (!hasModels) setSection("models");
  }, [hasModels]);

  useEffect(() => {
    const pending = consumeSettingsSection();
    if (pending) setSection(pending as Section);
  }, [consumeSettingsSection]);

  const upsertCustomModel = useApp((s) => s.upsertCustomModel);
  const deleteCustomModel = useApp((s) => s.deleteCustomModel);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-paper">
      {/* Header — also a window drag region so the pane is movable
          from its own content, not a separate "chin" bar. */}
      <div
        {...dragRegionAttrs()}
        onMouseDown={onDragMouseDown}
        className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-5"
      >
        <div className="flex min-w-0 items-center gap-3" data-no-drag>
          <IconButton
            icon={<ArrowLeft />}
            label="Back to chat"
            size="sm"
            showTooltip={false}
            onClick={() => setView("chat")}
          />
          <h1 className="text-[14px] font-semibold text-ink">Settings</h1>
        </div>
      </div>

      {/* Body — nav is sticky, only content scrolls */}
      <div className="min-h-0 flex-1 flex flex-col lg:flex-row overflow-hidden">
        <div className="mx-auto flex w-full max-w-[1080px] gap-0 lg:gap-8 px-0 lg:px-8 py-0 lg:py-6 flex-1 min-h-0">
          {/* Section tabs — horizontal sticky on mobile, vertical sticky on desktop */}
          <nav className="flex shrink-0 flex-row gap-0 lg:flex-col lg:w-[200px] border-b border-line lg:border-b-0 lg:pt-2 overflow-x-auto lg:overflow-visible lg:sticky lg:top-0 bg-paper">
            {(Object.keys(SECTION_META) as Section[]).map((key) => {
              const meta = SECTION_META[key];
              const isActive = section === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSection(key)}
                  className={cn(
                    "press flex items-center gap-2.5 whitespace-nowrap px-4 py-3 text-[13px] font-medium transition-colors lg:rounded-lg lg:px-3 lg:py-2",
                    isActive
                      ? "text-ink border-b-2 border-ink lg:border-b-0 lg:bg-line/70"
                      : "text-ink-muted border-b-2 border-transparent hover:text-ink lg:border-b-0 lg:hover:bg-line/60",
                  )}
                >
                  <span className={cn("flex h-5 w-5 items-center justify-center", isActive ? "text-ink" : "text-ink-faint")}>
                    {meta.icon}
                  </span>
                  <span>{meta.title}</span>
                </button>
              );
            })}
          </nav>

          {/* Content area — only this scrolls */}
          <div className="min-w-0 flex-1 w-full px-5 lg:px-0 py-5 space-y-5 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
            {section === "account" && <AccountPanel />}
            {section === "models" && (
              <ModelsPanel
                providers={providers}
                settings={settings}
                onUpsert={upsertCustomModel}
                onDelete={deleteCustomModel}
                onSaveSettings={saveSettings}
              />
            )}
            {section === "integrations" && (
              <IntegrationsPanel integrations={integrations} onRefresh={refreshSettingsPage} />
            )}
            {section === "appearance" && <AppearancePanel />}
            {section === "general" && (
              <GeneralPanel settings={settings} onSave={saveSettings} />
            )}
            {section === "memory" && <MemoryPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Models (with inline credentials) ----------------

const EMPTY_MODEL = {
  name: "",
  shape: "auto",
  credential: "anthropic",
  model_id: "",
  base_url_override: "",
};

// Pinned to the top of the provider picker; everything else follows A–Z.
const POPULAR_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "deepseek",
  "xai",
  "mistral",
  "groq",
  "zai",
  "ollama",
];

// Gateways (OpenRouter & co.) list hundreds of `vendor/model` ids A–Z; surface
// the frontier labs first so the obvious picks aren't buried.
const FEATURED_VENDORS = ["anthropic", "openai", "google", "x-ai", "deepseek", "moonshotai", "z-ai", "qwen", "mistralai"];

function vendorRank(id: string): number {
  const slash = id.indexOf("/");
  if (slash < 0) return 0;
  const i = FEATURED_VENDORS.indexOf(id.slice(0, slash));
  return i < 0 ? FEATURED_VENDORS.length : i;
}

// Pseudo-providers that live outside the models.dev catalog.
const LOCAL_CONFIG = "claude_code";
const CUSTOM_ENDPOINT = "custom";

const PROTOCOLS: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Automatic (from catalog)" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "openai", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "google", label: "Google Gemini" },
];

const inputClass =
  "block w-full rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none";

function formatTokens(n: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}k`;
}

function formatPrice(cost: CatalogModel["cost"]): string {
  if (!cost.input && !cost.output) return "free";
  return `$${+cost.input.toFixed(2)} / $${+cost.output.toFixed(2)}`;
}

function ProviderPicker({
  providers,
  value,
  onChange,
}: {
  providers: CatalogProvider[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    const rank = (p: CatalogProvider) => {
      const i = POPULAR_PROVIDERS.indexOf(p.id);
      return p.configured ? -100 + Math.max(i, 0) : i >= 0 ? i : 100;
    };
    const q = query.trim().toLowerCase();
    return providers
      .filter((p) => p.supported)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [providers, query]);

  const current = providers.find((p) => p.id === value);
  const label =
    value === LOCAL_CONFIG
      ? "Local config (reuse credentials)"
      : value === CUSTOM_ENDPOINT
        ? "Custom OpenAI-compatible endpoint"
        : value === "zwork_router"
          ? "zWork Router (managed)"
          : current?.name || value;

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const row = (id: string, name: string, meta: string, configured: boolean) => (
    <li key={id}>
      <button
        type="button"
        onClick={() => pick(id)}
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
          id === value ? "bg-accent/10 text-accent" : "text-ink hover:bg-paper-sunken",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {configured ? (
            <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <CircleDashed className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          )}
          <span className="truncate">{name}</span>
        </span>
        <span className="shrink-0 text-[11px] text-ink-faint">{meta}</span>
      </button>
    </li>
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ring-focus flex w-full items-center justify-between rounded-xl border border-line bg-paper px-3.5 py-2 text-left text-[13px] text-ink transition-colors hover:border-line-strong"
      >
        <span className="flex items-center gap-2">
          {current?.configured ? (
            <CircleCheck className="h-3.5 w-3.5 text-success" />
          ) : (
            <CircleDashed className="h-3.5 w-3.5 text-ink-faint" />
          )}
          {label}
        </span>
        <ChevronDown className={cn("h-4 w-4 text-ink-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1.5 rounded-xl border border-line bg-paper p-1.5 shadow-sm">
          <div className="flex items-center gap-2 border-b border-line px-2 pb-1.5">
            <Search className="h-3.5 w-3.5 text-ink-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${options.length} providers…`}
              className="w-full bg-transparent py-1 text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>
          <ul className="mt-1 max-h-64 overflow-y-auto">
            {options.map((p) => row(p.id, p.name, p.keyless ? "local" : `${p.model_count} models`, p.configured))}
            {!query && row(LOCAL_CONFIG, "Local config (reuse credentials)", "no key", false)}
            {!query && row(CUSTOM_ENDPOINT, "Custom OpenAI-compatible endpoint", "any URL", false)}
            {query && options.length === 0 && (
              <li className="px-2.5 py-2 text-[12px] text-ink-muted">
                No match.{" "}
                <button type="button" className="underline underline-offset-2" onClick={() => pick(CUSTOM_ENDPOINT)}>
                  Use a custom endpoint
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function ModelsPanel({
  providers,
  settings,
  onUpsert,
  onDelete,
  onSaveSettings,
}: {
  providers: ReturnType<typeof useApp.getState>["providers"];
  settings: ReturnType<typeof useApp.getState>["settings"];
  onUpsert: (m: typeof EMPTY_MODEL & { id?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSaveSettings: (patch: {
    api_keys?: Record<string, string>;
    provider_config?: Record<string, Record<string, string>>;
  }) => Promise<void>;
}) {
  const models = providers?.models ?? [];
  const customModels = settings?.custom_models ?? [];
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_MODEL);
  const [apiKey, setApiKey] = useState("");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [revealKey, setRevealKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editId, setEditId] = useState<string | undefined>();

  // models.dev catalog: provider list once, model list per selected provider.
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  // Ollama local-model discovery + pull — the catalog can't know what's installed.
  const [ollamaModels, setOllamaModels] = useState<{ id: string; name: string }[] | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaError, setOllamaError] = useState("");
  const [ollamaPullName, setOllamaPullName] = useState("");
  const [ollamaPulling, setOllamaPulling] = useState(false);
  const [ollamaPullProgress, setOllamaPullProgress] = useState("");

  const provider = catalog.find((p) => p.id === form.credential);
  const credStatus = providers?.credentials?.[form.credential];
  const maskedKey = settings?.api_keys?.[form.credential] || "";
  const isLocalConfig = form.credential === LOCAL_CONFIG;
  const isCustom = form.credential === CUSTOM_ENDPOINT || (!provider && !isLocalConfig && form.credential !== "zwork_router");
  const isOllama = form.credential === "ollama";
  const savedVars = settings?.provider_config?.[form.credential] ?? {};

  useEffect(() => {
    if (!showForm || catalog.length) return;
    api.providerCatalog().then((r) => setCatalog(r.providers)).catch(() => setCatalog([]));
  }, [showForm, catalog.length]);

  useEffect(() => {
    setApiKey("");
    setVars({});
    setCatalogModels([]);
    if (!showForm || isLocalConfig || form.credential === CUSTOM_ENDPOINT) return;
    let cancelled = false;
    api
      .providerCatalogModels(form.credential)
      .then((r) => !cancelled && setCatalogModels(r.models))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.credential, showForm]);

  useEffect(() => {
    if (!isOllama) {
      setOllamaModels(null);
      setOllamaError("");
      setOllamaPullProgress("");
    } else if (showForm && ollamaModels === null && !ollamaLoading) {
      void loadOllamaModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.credential, showForm]);

  const loadOllamaModels = async () => {
    setOllamaLoading(true);
    setOllamaError("");
    try {
      const res = await api.ollamaModels(form.base_url_override, apiKey);
      setOllamaError(res.error || "");
      setOllamaModels(res.error ? [] : res.models || []);
    } catch {
      setOllamaError("Couldn't reach Ollama. Is it running on localhost:11434?");
      setOllamaModels([]);
    } finally {
      setOllamaLoading(false);
    }
  };

  const pullOllamaModel = async () => {
    const name = ollamaPullName.trim();
    if (!name || ollamaPulling) return;
    setOllamaPulling(true);
    setOllamaPullProgress("Starting pull…");
    try {
      await api.ollamaPull(name, form.base_url_override, apiKey, (rec) => {
        if (rec.status === "success") {
          setOllamaPullProgress("Done");
        } else if (rec.total && rec.completed != null) {
          const pct = rec.total > 0 ? Math.round((rec.completed / rec.total) * 100) : 0;
          setOllamaPullProgress(`${rec.status} — ${pct}%`);
        } else {
          setOllamaPullProgress(rec.status);
        }
      });
      await loadOllamaModels();
      setOllamaPullName("");
      setOllamaPullProgress("");
    } catch (e) {
      setOllamaPullProgress(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOllamaPulling(false);
    }
  };

  // Catalog models filtered by what's typed in the Model ID box.
  const modelMatches = useMemo(() => {
    const q = form.model_id.trim().toLowerCase();
    return catalogModels
      .filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      .sort((a, b) => vendorRank(a.id) - vendorRank(b.id))
      .slice(0, 60);
  }, [catalogModels, form.model_id]);
  const exactModel = catalogModels.find((m) => m.id === form.model_id);

  const pickModel = (id: string, name: string) =>
    setForm((f) => {
      const autoNamed = !f.name.trim() || catalogModels.some((m) => m.name === f.name) || f.name === f.model_id;
      return { ...f, model_id: id, name: autoNamed ? name : f.name };
    });

  const startEdit = (id: string) => {
    const m = customModels.find((cm) => cm.id === id);
    if (!m) return;
    setForm({
      name: m.name,
      shape: m.shape || "auto",
      credential: m.credential,
      model_id: m.model_id,
      base_url_override: m.base_url_override,
    });
    setShowAdvanced(Boolean(m.base_url_override) || (m.shape !== "" && m.shape !== "auto"));
    setEditId(id);
    setShowForm(true);
  };

  const needsBaseUrl = isCustom && !form.base_url_override.trim();
  const missingVars = (provider?.vars ?? []).filter((v) => !(vars[v] ?? savedVars[v] ?? "").trim());
  const canSubmit = form.name.trim() && form.model_id.trim() && !needsBaseUrl && missingVars.length === 0;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const patch: {
        api_keys?: Record<string, string>;
        provider_config?: Record<string, Record<string, string>>;
      } = {};
      if (!isLocalConfig && apiKey.trim()) patch.api_keys = { [form.credential]: apiKey.trim() };
      const changedVars = Object.fromEntries(Object.entries(vars).filter(([, v]) => v.trim()));
      if (Object.keys(changedVars).length) patch.provider_config = { [form.credential]: changedVars };
      if (patch.api_keys || patch.provider_config) await onSaveSettings(patch);
      await onUpsert({ ...form, id: editId });
      setShowForm(false);
      setEditId(undefined);
      setForm(EMPTY_MODEL);
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err || "Failed to save model"));
    } finally {
      setBusy(false);
    }
  };

  const openNew = () => {
    setShowForm(true);
    setShowAdvanced(false);
    setEditId(undefined);
    setForm(EMPTY_MODEL);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Models</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-muted">
            Bring any model from 150+ providers — Anthropic, OpenAI, Gemini, OpenRouter, local Ollama and more.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="press ring-focus inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken"
        >
          <Plus className="h-3.5 w-3.5" /> Add model
        </button>
      </div>

      {/* Synthesized models */}
      {models.filter((m) => m.synthesized).map((m) => (
        <div key={m.id} className="rounded-xl border border-line bg-paper-raised p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-semibold text-ink">{m.name}</span>
                <span className="rounded-full border border-success/20 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">Auto-detected</span>
              </div>
              <p className="mt-0.5 text-[12px] text-ink-muted">{m.subtitle}</p>
            </div>
            <CircleCheck className="mt-0.5 h-4 w-4 text-success" />
          </div>
        </div>
      ))}

      {/* Custom models */}
      {customModels.map((m) => {
        const live = models.find((lm) => lm.id === m.id);
        return (
          <div key={m.id} className="rounded-xl border border-line bg-paper-raised p-4">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-semibold text-ink">{m.name}</span>
                  {live?.configured ? (
                    <CircleCheck className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <CircleDashed className="h-3.5 w-3.5 text-ink-faint" />
                  )}
                </div>
                <p className="mt-0.5 truncate text-[12px] text-ink-muted">
                  {live?.subtitle || `${m.credential} · ${m.model_id}`}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => startEdit(m.id)}
                  className="press rounded px-2 py-1 text-[11.5px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
                >
                  Edit
                </button>
                <IconButton icon={<Trash2 />} label="Delete" size="sm" onClick={async () => { await onDelete(m.id); }} />
              </div>
            </div>
          </div>
        );
      })}

      {customModels.length === 0 && models.filter((m) => !m.synthesized).length === 0 && !showForm && (
        <div className="rounded-xl border border-dashed border-line bg-paper p-6 text-center">
          <p className="text-[13px] font-medium text-ink">No models configured</p>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            Add a model above, or set a provider key in your environment so it's detected automatically.
          </p>
        </div>
      )}

      {/* Add / Edit form */}
      {showForm && (
        <section className="rounded-xl border border-line-strong bg-paper-raised p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[13.5px] font-semibold text-ink">{editId ? "Edit model" : "Add model"}</h3>
            <IconButton icon={<X />} label="Cancel" size="sm" onClick={() => setShowForm(false)} />
          </div>
          <div className="flex flex-col gap-3">
            <Field label="Provider">
              <ProviderPicker
                providers={catalog}
                value={form.credential}
                onChange={(id) => {
                  setForm((f) => ({ ...f, credential: id, model_id: "", base_url_override: "" }));
                  setShowAdvanced(id === CUSTOM_ENDPOINT);
                }}
              />
              {provider?.doc && (
                <a
                  href={provider.doc}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-ink-muted hover:text-ink"
                >
                  {provider.name} docs <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </Field>

            {form.credential === "zwork_router" && (
              <p className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-[12px] leading-5 text-warning">
                zWork Router is managed by zWork and pinned to its hosted lineup.
              </p>
            )}

            {isLocalConfig ? (
              <div className="rounded-lg border border-line bg-paper px-3 py-2 text-[12px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  {credStatus?.configured ? (
                    <CircleCheck className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <CircleDashed className="h-3.5 w-3.5 text-ink-faint" />
                  )}
                  {credStatus?.configured
                    ? "Reusing local credentials from ~/.claude/"
                    : "Local credentials not detected — install them first"}
                </span>
              </div>
            ) : (
              <Field
                label={provider?.keyless ? "API key (optional)" : "API key"}
                description={
                  maskedKey
                    ? `Currently stored: ${maskedKey}. Leave blank to keep it.`
                    : credStatus?.source === "env"
                      ? "Found in your environment — leave blank to use it."
                      : provider?.env?.length
                        ? `Stored locally. You can also set ${provider.env[0]} in your environment.`
                        : "Stored locally — only ever sent to this provider."
                }
              >
                <div className="flex items-center rounded-lg border border-line bg-paper focus-within:border-line-strong">
                  <input
                    type={revealKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={provider?.keyless ? "Leave blank for a local server" : provider?.env?.[0] || "API key"}
                    className="block w-full bg-transparent px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none"
                  />
                  <IconButton
                    icon={revealKey ? <EyeOff /> : <Eye />}
                    size="sm"
                    label={revealKey ? "Hide" : "Reveal"}
                    onClick={() => setRevealKey((v) => !v)}
                    className="mr-1"
                  />
                </div>
              </Field>
            )}

            {provider?.vars.map((v) => (
              <Field key={v} label={v.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}>
                <input
                  className={cn(inputClass, "font-mono")}
                  placeholder={savedVars[v] || v}
                  value={vars[v] ?? ""}
                  onChange={(e) => setVars((cur) => ({ ...cur, [v]: e.target.value }))}
                />
              </Field>
            ))}

            <Field label="Model" description={catalogModels.length ? "Pick from the list or type any model ID." : "The exact model ID sent to the API."}>
              <input
                className={cn(inputClass, "font-mono")}
                placeholder={catalogModels[0]?.id || (isOllama ? "llama3.2" : "model-id")}
                value={form.model_id}
                onChange={(e) => setForm((f) => ({ ...f, model_id: e.target.value }))}
              />
              {!isOllama && modelMatches.length > 0 && !exactModel && (
                <ul className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border border-line bg-paper p-1">
                  {modelMatches.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => pickModel(m.id, m.name)}
                        className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-paper-sunken"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] text-ink">{m.name}</span>
                          <span className="block truncate font-mono text-[10.5px] text-ink-faint">{m.id}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] text-ink-muted">
                          {m.reasoning && <span className="rounded border border-line px-1">reasoning</span>}
                          {m.images && <span className="rounded border border-line px-1">vision</span>}
                          {m.context > 0 && <span>{formatTokens(m.context)}</span>}
                          <span className="font-mono">{formatPrice(m.cost)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {exactModel && (
                <p className="mt-1 text-[11.5px] text-ink-muted">
                  {[
                    exactModel.context && `${formatTokens(exactModel.context)} context`,
                    exactModel.reasoning && "reasoning",
                    exactModel.images && "vision",
                    `${formatPrice(exactModel.cost)} per 1M tokens`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </Field>

            {isOllama && (
              <div className="space-y-2 rounded-lg border border-line bg-paper-sunken/40 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-ink-muted">
                    {ollamaLoading
                      ? "Detecting installed models…"
                      : ollamaModels === null
                        ? "Models auto-load when Ollama is running."
                        : ollamaModels.length === 0
                          ? ollamaError || "No models found."
                          : `${ollamaModels.length} model${ollamaModels.length === 1 ? "" : "s"} installed — click to use:`}
                  </span>
                  <button
                    type="button"
                    onClick={() => void loadOllamaModels()}
                    disabled={ollamaLoading}
                    className="press inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-2 py-1 text-[11.5px] font-semibold text-ink hover:border-line-strong disabled:opacity-50"
                  >
                    <RefreshCw className={cn("h-3 w-3", ollamaLoading && "animate-spin")} />
                    {ollamaLoading ? "Loading…" : "Refresh"}
                  </button>
                </div>
                {ollamaModels && ollamaModels.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {ollamaModels.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => pickModel(m.id, m.name || m.id)}
                          className={cn(
                            "press rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                            form.model_id === m.id
                              ? "border-accent/40 bg-accent/10 text-accent"
                              : "border-line bg-paper text-ink-muted hover:border-line-strong hover:text-ink",
                          )}
                        >
                          {m.id}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center gap-1.5 pt-1">
                  <input
                    type="text"
                    value={ollamaPullName}
                    onChange={(e) => setOllamaPullName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void pullOllamaModel();
                      }
                    }}
                    placeholder="Pull a model — e.g. llama3.2"
                    disabled={ollamaPulling}
                    className="min-w-0 flex-1 rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[11.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => void pullOllamaModel()}
                    disabled={ollamaPulling || !ollamaPullName.trim()}
                    className="press inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1.5 text-[11.5px] font-semibold text-ink hover:border-line-strong disabled:opacity-50"
                  >
                    <Download className={cn("h-3 w-3", ollamaPulling && "animate-pulse")} />
                    {ollamaPulling ? "Pulling…" : "Pull"}
                  </button>
                </div>
                {ollamaPullProgress && <p className="font-mono text-[11px] text-ink-muted">{ollamaPullProgress}</p>}
                {ollamaError && (
                  <p className="text-[11px] leading-relaxed text-warning">
                    {ollamaError}{" "}
                    <span className="text-ink-faint">Make sure Ollama is installed and running (localhost:11434).</span>
                  </p>
                )}
              </div>
            )}

            <Field label="Display name">
              <input
                className={inputClass}
                placeholder={exactModel?.name || "My model"}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>

            {!isLocalConfig && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-muted hover:text-ink"
                >
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !showAdvanced && "-rotate-90")} />
                  {isCustom ? "Endpoint" : "Advanced"}
                </button>
                {showAdvanced && (
                  <div className="mt-2 flex flex-col gap-3">
                    <Field
                      label={isCustom ? "Base URL" : "Base URL override (optional)"}
                      description="Point this model at a proxy or self-hosted gateway. The provider's saved endpoint is unchanged."
                    >
                      <input
                        className={cn(inputClass, "font-mono")}
                        placeholder={provider?.base_url || "https://my-gateway.example.com/v1"}
                        value={form.base_url_override}
                        onChange={(e) => setForm((f) => ({ ...f, base_url_override: e.target.value }))}
                      />
                    </Field>
                    <Field label="Protocol" description="Automatic picks the right wire format per model.">
                      <div className="relative">
                        <select
                          value={form.shape || "auto"}
                          onChange={(e) => setForm((f) => ({ ...f, shape: e.target.value }))}
                          className="ring-focus w-full cursor-pointer appearance-none rounded-xl border border-line bg-paper px-3.5 py-2 pr-10 text-[13px] text-ink transition-colors hover:border-line-strong focus:border-line-strong focus:outline-none"
                        >
                          {PROTOCOLS.map((p) => (
                            <option key={p.value} value={p.value} className="bg-paper text-ink">
                              {p.label}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                      </div>
                    </Field>
                  </div>
                )}
              </div>
            )}

            {missingVars.length > 0 && (
              <p className="text-[12px] text-ink-muted">Fill in {missingVars.join(", ")} to use {provider?.name}.</p>
            )}
            {error && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">{error}</p>
            )}
            <div className="flex justify-end pt-1">
              <button
                type="button"
                disabled={busy || !canSubmit}
                onClick={submit}
                className="press inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-paper hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Saving…" : editId ? "Update" : "Add"}
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------- Integrations ----------------

function IntegrationsPanel({
  integrations,
  onRefresh,
}: {
  integrations: Integration[];
  onRefresh: () => Promise<void>;
}) {
  const items = useMemo(() => integrations, [integrations]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Integrations</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-muted">
            Reuse credentials from local AI tools zWork detects.
          </p>
        </div>
        <IconButton
          icon={<RefreshCw />}
          label="Rescan"
          variant="outline"
          size="md"
          onClick={() => onRefresh()}
        />
      </div>

      <div className="flex flex-col gap-3">
        {items.map((i) => (
          <div
            key={i.id}
            className="flex items-start justify-between gap-3 rounded-xl border border-line bg-paper-raised p-4"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex h-1.5 w-1.5 rounded-full",
                    i.can_reuse_credentials
                      ? "bg-success"
                      : i.detected
                        ? "bg-warning"
                        : "bg-ink/20",
                  )}
                />
                <h3 className="text-[13.5px] font-semibold text-ink">{i.name}</h3>
                {i.detected ? (
                  <span className="rounded-full border border-line bg-paper-sunken px-2 py-0.5 text-[10.5px] font-medium text-ink-muted">
                    {i.can_reuse_credentials ? "Connected" : "Detected"}
                  </span>
                ) : (
                  <span className="rounded-full border border-line bg-paper-sunken px-2 py-0.5 text-[10.5px] font-medium text-ink-faint">
                    Not installed
                  </span>
                )}
              </div>
              <p className="mt-1 text-[12px] text-ink-muted">{i.detail || "Not detected on this machine."}</p>
              {i.path && (
                <p className="mt-0.5 font-mono text-[11px] text-ink-faint">{i.path}</p>
              )}
            </div>
            {i.id === "claude_code" && i.detected && (
              <a
                href="https://docs.anthropic.com/en/docs/claude-code"
                target="_blank"
                rel="noreferrer"
                className="press inline-flex items-center gap-1 rounded-md border border-line bg-paper px-2.5 py-1 text-[11.5px] font-medium text-ink-muted hover:text-ink hover:border-line-strong"
              >
                Docs <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <div className="rounded-xl border border-dashed border-line bg-paper p-6 text-center text-[12.5px] text-ink-muted">
            No integrations detected.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Appearance ----------------

function AppearancePanel() {
  const [themePref, setThemePrefState] = useState<"system" | "light" | "dark">(() =>
    loadThemePref(),
  );
  const [schemePref, setSchemePrefState] = useState<string>(() => loadSchemePref());
  const translucencyPref = useTranslucencyPref();
  const translucencyNative = nativeVibrancySupported();
  const schemeModes = resolvedSchemeModes();
  const modeLocked = schemeModes.length === 1;

  const applyTheme = (v: "system" | "light" | "dark") => {
    setThemePrefState(v);
    setThemePref(v);
  };

  const applyScheme = (id: string) => {
    setSchemePrefState(id);
    setSchemePref(id);
    const pref = loadThemePref();
    setThemePrefState(pref);
  };

  const themeOptions: { value: "system" | "light" | "dark"; icon: React.ReactNode; label: string }[] = [
    { value: "system", icon: <Monitor className="h-4 w-4" />, label: "System" },
    { value: "light", icon: <Sun className="h-4 w-4" />, label: "Light" },
    { value: "dark", icon: <Moon className="h-4 w-4" />, label: "Dark" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Appearance</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">Theme, color scheme, and sidebar glass.</p>
      </div>

      <section className="rounded-xl border border-line bg-paper-raised p-4 space-y-4">
        <Field
          label="Theme"
          description={
            modeLocked
              ? `This color scheme is ${schemeModes[0]} only.`
              : "Follows your system by default."
          }
        >
          <div className="flex gap-2 mt-1">
            {themeOptions.map((opt) => {
              const disabled =
                modeLocked ||
                (opt.value !== "system" && !schemeModes.includes(opt.value));
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => applyTheme(opt.value)}
                  className={cn(
                    "press flex flex-col items-center gap-1.5 rounded-xl border px-4 py-3 transition-colors min-w-[64px]",
                    disabled && "opacity-40 cursor-not-allowed",
                    !disabled && themePref === opt.value
                      ? "border-line-strong bg-paper-sunken text-ink shadow-[0_0_0_1px_rgb(var(--line-strong))]"
                      : "border-line bg-paper text-ink-muted hover:border-line-strong hover:bg-paper-sunken hover:text-ink",
                  )}
                >
                  {opt.icon}
                  <span className="text-[11px] font-medium">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </Field>

        <Field
          label="Color scheme"
          description="The palette family. Parchment is the zWork default."
        >
          <div className="mt-1.5 flex items-center gap-2">
            <div className="relative">
              <select
                value={schemePref}
                onChange={(e) => applyScheme(e.target.value)}
                className="press ring-focus appearance-none rounded-lg border border-line bg-paper px-3 py-2 pr-8 text-[12.5px] text-ink hover:border-line-strong focus:border-line-strong focus:outline-none cursor-pointer min-w-[180px]"
              >
                {Object.entries(
                  COLOR_SCHEMES.reduce<Record<string, typeof COLOR_SCHEMES>>((acc, s) => {
                    const g = s.group ?? "Other";
                    (acc[g] ??= []).push(s);
                    return acc;
                  }, {}),
                ).map(([group, schemes]) => (
                  <optgroup key={group} label={group}>
                    {schemes.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                        {s.id === DEFAULT_SCHEME_ID ? " (default)" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
            </div>
            <span
              className="h-6 w-6 rounded-full border border-line"
              style={{ backgroundColor: "rgb(var(--accent))" }}
              aria-hidden
            />
          </div>
        </Field>
      </section>

      {/* No compositor blur behind the window on Tauri Windows/Linux — the
          effect can't render there, so don't offer a dead toggle. */}
      {translucencySupported() && (
        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <Field
            label="Sidebar translucency"
            description={
              translucencyNative
                ? "Frosted-glass sidebar that blurs the desktop behind the window."
                : "A lighter, glassy sidebar. Best on macOS, where it shows real desktop blur."
            }
          >
            <button
              type="button"
              role="switch"
              aria-checked={translucencyPref === "on"}
              onClick={() =>
                setTranslucencyPref(translucencyPref === "on" ? "off" : "on")
              }
              className={cn(
                "press ring-focus relative mt-2 inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors",
                translucencyPref === "on"
                  ? "border-transparent bg-accent"
                  : "border-line bg-paper-sunken",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none h-[1.125rem] w-[1.125rem] rounded-full bg-paper-raised shadow-sm transition-transform",
                  translucencyPref === "on" ? "translate-x-5" : "translate-x-0.5",
                )}
              />
            </button>
          </Field>
        </section>
      )}
    </div>
  );
}

// ---------------- General ----------------

function GeneralPanel({
  settings,
  onSave,
}: {
  settings: ReturnType<typeof useApp.getState>["settings"];
  onSave: (patch: { default_model?: string; use_claude_code_config?: boolean; telemetry_enabled?: boolean }) => Promise<void>;
}) {
  const [appVersion, setAppVersion] = useState(fallbackAppVersion());
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  const providers = useApp((s) => s.providers);

  const accessibilityPermissionGranted = useApp((s) => s.accessibilityPermissionGranted);
  const screenRecordingPermissionGranted = useApp((s) => s.screenRecordingPermissionGranted);
  const driverOk = useApp((s) => s.driverOk);
  const wrongIdentityHint = useApp((s) => s.wrongIdentityHint);
  const zworkSelfTrusted = useApp((s) => s.zworkSelfTrusted);
  const checkMacOSPermissions = useApp((s) => s.checkMacOSPermissions);
  const requestAccessibility = useApp((s) => s.requestAccessibility);
  const requestScreenRecording = useApp((s) => s.requestScreenRecording);
  const extensionConnected = useApp((s) => s.extensionConnected);
  const checkBrowserBridge = useApp((s) => s.checkBrowserBridge);
  const autoApproveDestructive = useApp((s) => s.autoApproveDestructive);
  const setAutoApproveDestructive = useApp((s) => s.setAutoApproveDestructive);

  useEffect(() => {
    if (IS_WEB) return;
    checkMacOSPermissions();
    checkBrowserBridge();
    const interval = setInterval(() => {
      checkMacOSPermissions();
      checkBrowserBridge();
    }, 2000);
    // Re-check the instant the window regains focus — e.g. the user just
    // returned from System Settings after toggling CuaDriver on.
    const onFocus = () => {
      checkMacOSPermissions();
      checkBrowserBridge();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkMacOSPermissions, checkBrowserBridge]);

  const models = providers?.models ?? [];
  const [defaultModel, setDefaultModel] = useState(settings?.default_model ?? "");
  const [useClaude, setUseClaude] = useState(!!settings?.use_claude_code_config);
  const [telemetryEnabled, setTelemetryEnabled] = useState(!!settings?.telemetry_enabled);
  useEffect(() => {
    setDefaultModel(settings?.default_model ?? "");
    setUseClaude(!!settings?.use_claude_code_config);
    setTelemetryEnabled(!!settings?.telemetry_enabled);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    void resolveAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version);
    });
    void api
      .health()
      .then((h) => {
        if (!cancelled && h?.version) setBackendVersion(h.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">General</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">Preferences for zWork.</p>
      </div>

      {/* System Permissions Section */}
      {!IS_WEB && (
        <section className="rounded-xl border border-line bg-paper-raised p-5 space-y-4 select-none">
          <div>
            <h3 className="text-[14px] font-semibold text-ink flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4 text-accent" />
              Desktop Control & System Permissions
            </h3>
            <p className="text-[12px] text-ink-muted mt-1 leading-relaxed">
              Desktop automation runs through CuaDriver.app — grant these macOS permissions to <span className="font-medium text-ink">CuaDriver</span>, not zWork. (zWork's own grant only covers its hotkey.) These are one-time OS permission requests.
            </p>
          </div>

          {/* Wrong-identity banner — the core fix. Shown when the TCC grant
              looks mis-attributed (granted to zWork, not CuaDriver). The most
              common cause of "permission granted but automation still dead". */}
          {driverOk !== false &&
            driverOk !== null &&
            (wrongIdentityHint ||
              (zworkSelfTrusted === true &&
                (accessibilityPermissionGranted === false ||
                  screenRecordingPermissionGranted === false))) && (
              <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-ink">
                    Granted to zWork, but automation needs CuaDriver
                  </div>
                  <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                    {wrongIdentityHint ??
                      "macOS shows Accessibility granted to zWork, but the automation runs through CuaDriver.app. In System Settings → Privacy & Security, toggle the permission on for CuaDriver (not zWork), then retry."}
                  </p>
                </div>
              </div>
            )}

          {/* Driver not reachable — the prerequisite to everything below.
              Permissions rows are pointless if CuaDriver.app isn't installed,
              so surface that distinctly instead of silently showing "Required". */}
          {driverOk === false && (
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5">
              <ShieldAlert className="h-4 w-4 shrink-0 text-warning mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-ink">
                  CuaDriver isn&rsquo;t reachable
                </div>
                <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                  Desktop control runs through CuaDriver.app. Install it from
                  &ldquo;trycua/cua&rdquo; on GitHub, then relaunch zWork.
                </p>
              </div>
            </div>
          )}

          <div className="border-t border-line my-3" />

          {/* Perm 1: Accessibility */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium text-ink flex items-center gap-2">
                <span>Accessibility Access</span>
                <span className={cn(
                  "px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide uppercase",
                  accessibilityPermissionGranted
                    ? "bg-success/10 text-success border border-success/20"
                    : "bg-warning/10 text-warning border border-warning/20"
                )}>
                  {accessibilityPermissionGranted ? "Granted" : "Required"}
                </span>
              </div>
              <p className="text-[11.5px] text-ink-muted">
                Read app UI trees, click, and type. Granted on the <span className="font-medium text-ink">CuaDriver</span> identity — not zWork.
              </p>
            </div>
            {!accessibilityPermissionGranted && (
              <button
                onClick={requestAccessibility}
                className="press px-3 py-1.5 text-[11px] font-medium border border-line bg-paper-raised hover:bg-paper-sunken text-ink rounded-lg transition-colors cursor-pointer shrink-0"
              >
                Grant to CuaDriver
              </button>
            )}
          </div>

          <div className="border-t border-line-soft" />

          {/* Perm 2: Screen Capture */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium text-ink flex items-center gap-2">
                <span>Screen Recording</span>
                <span className={cn(
                  "px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide uppercase",
                  screenRecordingPermissionGranted
                    ? "bg-success/10 text-success border border-success/20"
                    : "bg-ink-faint/10 text-ink-muted border border-line"
                )}>
                  {screenRecordingPermissionGranted ? "Granted" : "Optional"}
                </span>
              </div>
              <p className="text-[11.5px] text-ink-muted">
                Optional — only needed for future screenshot/vision mode. Current desktop control uses the accessibility tree and does not require this. If enabled, grant on the <span className="font-medium text-ink">CuaDriver</span> identity.
              </p>
            </div>
            <button
              onClick={requestScreenRecording}
              className="press px-3 py-1.5 text-[11px] font-medium border border-line bg-paper-raised hover:bg-paper-sunken text-ink rounded-lg transition-colors cursor-pointer shrink-0"
            >
              Open Settings
            </button>
          </div>

          <div className="border-t border-line-soft" />

          {/* Perm 3: Browser Bridge (zbctl Chrome extension) */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium text-ink flex items-center gap-2">
                <span>Browser Bridge</span>
                <span className={cn(
                  "px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide uppercase",
                  extensionConnected
                    ? "bg-success/10 text-success border border-success/20"
                    : "bg-warning/10 text-warning border border-warning/20"
                )}>
                  {extensionConnected === null ? "…" : extensionConnected ? "Connected" : "Disconnected"}
                </span>
              </div>
              <p className="text-[11.5px] text-ink-muted">
                The zbctl Chrome extension for direct browser control. Load it unpacked from the zWork app&rsquo;s extension folder; it connects to the backend on port 8787.
              </p>
            </div>
          </div>

          <div className="border-t border-line" />

          {/* Single Toggle: Auto-Approve Destructive Actions */}
          <div className="flex items-start justify-between gap-4 pt-1">
            <div className="space-y-1 flex-1">
              <div className="text-[13px] font-medium text-ink flex items-center gap-2">
                <span>Auto-Approve Destructive Actions</span>
                <span className={cn(
                  "px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide uppercase",
                  autoApproveDestructive
                    ? "bg-success/10 text-success border border-success/20"
                    : "bg-paper-sunken text-ink-faint border border-line"
                )}>
                  {autoApproveDestructive ? "Enabled" : "Disabled"}
                </span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-ink-muted">
                When enabled, the agent skips the per-action confirmation prompt for a small blocklist of destructive operations — commands like <code className="font-mono text-ink">rm&nbsp;-rf</code>, <code className="font-mono text-ink">format</code>, or <code className="font-mono text-ink">dropdb</code>, and writes to <code className="font-mono text-ink">settings.json</code> or <code className="font-mono text-ink">secrets.json</code>. Ordinary file edits, most commands, and the agent's clarifying questions are unaffected.
              </p>
            </div>
            
            <button
              onClick={() => setAutoApproveDestructive(!autoApproveDestructive)}
              className={cn(
                "press ring-focus relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors mt-1",
                autoApproveDestructive ? "bg-accent" : "bg-paper-sunken border-line"
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-paper-raised shadow ring-0 transition-transform",
                  autoApproveDestructive ? "translate-x-4" : "translate-x-0"
                )}
              />
            </button>
          </div>
        </section>
      )}

      {/* Version check */}
      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <Field label="Version" description="The installed app and running backend build. If these don't match after an update, fully quit (Cmd+Q) and relaunch zWork.">
          <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] text-ink">
            <span className="font-medium">zWork</span>
            <span className="font-mono text-ink-muted">{appVersion}</span>
            <span className="text-ink-faint">·</span>
            <span className="text-ink-muted">backend</span>
            <span className="font-mono text-ink-muted">{backendVersion ?? "…"}</span>
          </div>
        </Field>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-muted">
          <a
            href="https://tryzwork.app/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:text-ink hover:underline"
          >
            Privacy Policy
          </a>
          <a
            href="https://tryzwork.app/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:text-ink hover:underline"
          >
            Terms of Service
          </a>
        </div>
      </section>

      {/* Privacy & Telemetry Dashboard */}
      <section className="rounded-xl border border-line bg-paper-raised p-5 space-y-4 select-none">
        <div>
          <h3 className="text-[14px] font-semibold text-ink flex items-center gap-1.5">
            <ShieldAlert className="h-4 w-4 text-accent animate-[pulse_3s_infinite]" />
            Privacy & Telemetry Dashboard
          </h3>
          <p className="text-[12px] text-ink-muted mt-1 leading-relaxed">
            Manage your data preferences. We prioritize your privacy and comply with strict security standards.
          </p>
        </div>

        <div className="border-t border-line my-3" />

        <div className="space-y-4">
          {/* Toggle 1: Telemetry */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1 flex-1">
              <div className="text-[13px] font-medium text-ink flex items-center gap-2">
                <span>Usage Analytics & Telemetry</span>
                <span className={cn(
                  "px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide uppercase",
                  telemetryEnabled
                    ? "bg-success/10 text-success border border-success/20"
                    : "bg-paper-sunken text-ink-faint border border-line"
                )}>
                  {telemetryEnabled ? "Active" : "Disabled"}
                </span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-ink-muted">
                Tracks application installs, active usage hours, onboarding success rates, and feature usage. 
                We never collect prompts, model outputs, file names, API keys, or screenshots.
              </p>
            </div>
            
            {/* Toggle Button */}
            <button
              onClick={async () => {
                const next = !telemetryEnabled;
                setTelemetryEnabled(next);
                await onSave({ telemetry_enabled: next });
              }}
              className={cn(
                "press ring-focus relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors mt-1",
                telemetryEnabled ? "bg-accent" : "bg-paper-sunken border-line"
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-paper-raised shadow ring-0 transition-transform",
                  telemetryEnabled ? "translate-x-4" : "translate-x-0"
                )}
              />
            </button>
          </div>

          <div className="border-t border-line-soft" />

          {/* Policy */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1 flex-1">
              <div className="text-[13px] font-medium text-ink flex items-center gap-2">
                <span>Zero Prompt & Content Leak Policy</span>
                <span className="bg-success/10 text-success border border-success/20 px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide uppercase">
                  Locked
                </span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-ink-muted">
                Prompt inputs, model completions, file uploads, local text index data, and desktop screen controls are processed locally. They are never sent to external servers for tracking.
              </p>
            </div>
          </div>

          <div className="border-t border-line-soft" />

          {/* Wipe Local Cache Action */}
          <div className="flex items-center justify-between gap-4 pt-1">
            <div className="space-y-0.5">
              <div className="text-[12.5px] font-medium text-ink">Clear Offline Chat Cache</div>
              <p className="text-[11.5px] text-ink-muted">Removes the cached chats and summaries used to display history while offline. Reopens empty until the next sync.</p>
            </div>
            <button
              onClick={() => {
                try {
                  localStorage.removeItem("zwork:cached-chats");
                  localStorage.removeItem("zwork:cached-summaries");
                  localStorage.removeItem("zwork:cache-version");
                  alert("Offline chat cache cleared.");
                } catch {
                  alert("Failed to clear cache.");
                }
              }}
              className="press ring-focus px-3 py-1.5 text-[11px] font-medium border border-error/20 bg-error/5 hover:bg-error/10 text-error rounded-lg transition-colors cursor-pointer"
            >
              Clear Cache
            </button>
          </div>
        </div>
      </section>

      {!IS_WEB && <RuntimeSection />}

      {/* Default model */}
      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <Field label="Default model" description="Used when starting a new chat.">
          <div className="relative">
            <select
              value={defaultModel}
              onChange={async (e) => {
                setDefaultModel(e.target.value);
                await onSave({ default_model: e.target.value });
              }}
              className="ring-focus w-full appearance-none rounded-xl border border-line bg-paper px-3.5 py-2 pr-10 text-[13px] text-ink hover:border-line-strong focus:border-line-strong focus:outline-none cursor-pointer transition-colors"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id} className="bg-paper text-ink">
                  {m.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          </div>
        </Field>
      </section>

      {/* Local credential config toggle */}
      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={useClaude}
            onChange={async (e) => {
              setUseClaude(e.target.checked);
              await onSave({ use_claude_code_config: e.target.checked });
            }}
            className="mt-[3px] h-4 w-4 accent-ink"
          />
          <div>
            <div className="text-[13px] font-medium text-ink">Reuse local credentials</div>
            <div className="text-[12px] text-ink-muted">
              When enabled and no BYOK key is set, zWork reads{" "}
              <code className="font-mono text-[11.5px]">~/.claude/settings.json</code>{" "}
              and uses <code className="font-mono text-[11.5px]">ANTHROPIC_AUTH_TOKEN</code>{" "}
              and <code className="font-mono text-[11.5px]">ANTHROPIC_BASE_URL</code>.
            </div>
          </div>
        </label>
      </section>

      {/* Global Keyboard Shortcut */}
      {IS_TAURI && !IS_WEB && (
        <GlobalShortcutSection />
      )}

      {/* Prompt Templates */}
      <TemplatesSection />
    </div>
  );
}

// ---------------- Global Shortcut ----------------

const OVERLAY_SHORTCUT_KEY = "zwork:overlay-shortcut";

function GlobalShortcutSection() {
  const [shortcut, setShortcut] = useState<string>(() => {
    return localStorage.getItem(OVERLAY_SHORTCUT_KEY) || "Control+Alt+Space";
  });

  // On mount, sync the stored shortcut with the Tauri backend
  useEffect(() => {
    if (!IS_TAURI || IS_WEB) return;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // Re-register whatever we have stored so the backend is in sync
        await invoke("register_overlay_shortcut", { shortcutStr: shortcut });
      } catch (e) {
        console.warn("Failed to sync overlay shortcut:", e);
      }
    })();
  }, []);

  const handleChange = async (newShortcut: string) => {
    if (!IS_TAURI || IS_WEB) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("register_overlay_shortcut", { shortcutStr: newShortcut });
      setShortcut(newShortcut);
      if (newShortcut) {
        localStorage.setItem(OVERLAY_SHORTCUT_KEY, newShortcut);
      } else {
        localStorage.removeItem(OVERLAY_SHORTCUT_KEY);
      }
    } catch (e) {
      console.error("Failed to register overlay shortcut:", e);
      alert(`Failed to register shortcut: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-paper-raised p-5 space-y-3">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">Keyboard Shortcuts</h3>
        <p className="text-[12px] text-ink-muted mt-1 leading-relaxed">
          Configure global keyboard shortcuts that work even when zWork is not focused.
        </p>
      </div>
      <div className="border-t border-line" />
      <KeybindRecorder
        label="Toggle Chatbox Overlay"
        description="Brings up the zWork overlay on top of any app. Requires a modifier key (⌘, ⌃, ⌥, ⇧) plus another key."
        value={shortcut}
        onChange={handleChange}
      />
    </section>
  );
}

// ---------------- Memory ----------------

function MemoryPanel() {
  const memoryContent = useApp((s) => s.memoryContent);
  const refreshMemory = useApp((s) => s.refreshMemory);
  const saveMemory = useApp((s) => s.saveMemory);
  const [draft, setDraft] = useState(memoryContent);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { void refreshMemory(); }, [refreshMemory]);
  useEffect(() => { setDraft(memoryContent); setDirty(false); }, [memoryContent]);

  const save = async () => {
    setSaving(true);
    try { await saveMemory(draft); setDirty(false); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Memory</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">
          Notes zWork persists across sessions. Only saves when you tell it to "remember" something.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <textarea
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
          rows={12}
          className="block w-full resize-y rounded-lg border border-line bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-5 text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          placeholder="- No memories saved yet"
        />
        <div className="mt-3 flex items-center justify-between">
          <p className="text-[11.5px] text-ink-faint">
            {dirty ? "Unsaved changes" : "Saved"}
          </p>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="press ring-focus inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-paper hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------------- Templates ----------------

function TemplatesSection() {
  const [templates, setTemplates] = useState<PromptTemplate[]>(() => loadTemplates());
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [trigger, setTrigger] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const persist = (next: PromptTemplate[]) => {
    setTemplates(next);
    saveTemplates(next);
  };

  const resetForm = () => {
    setEditId(null);
    setTrigger("");
    setTitle("");
    setBody("");
    setShowForm(false);
  };

  const startEdit = (tpl: PromptTemplate) => {
    setEditId(tpl.id);
    setTrigger(tpl.trigger);
    setTitle(tpl.title);
    setBody(tpl.body);
    setShowForm(true);
  };

  const submit = () => {
    const cleanTrigger = normalizeTrigger(trigger);
    const cleanTitle = title.trim();
    if (!cleanTrigger || !cleanTitle || !body) return;
    const conflict = templates.find(
      (t) => t.trigger === cleanTrigger && t.id !== editId,
    );
    if (conflict) {
      alert(`A template with the trigger "/${cleanTrigger}" already exists.`);
      return;
    }
    if (editId) {
      persist(
        templates.map((t) =>
          t.id === editId
            ? { ...t, trigger: cleanTrigger, title: cleanTitle, body }
            : t,
        ),
      );
    } else {
      persist([
        ...templates,
        { id: newTemplateId(), trigger: cleanTrigger, title: cleanTitle, body },
      ]);
    }
    resetForm();
  };

  const remove = (id: string) => {
    persist(templates.filter((t) => t.id !== id));
    if (editId === id) resetForm();
  };

  return (
    <section className="rounded-xl border border-line bg-paper-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">Prompt templates</h3>
          <p className="mt-1 text-[12px] text-ink-muted">
            Saved prompts you can insert by typing{" "}
            <code className="font-mono text-[11.5px]">/trigger</code> in the
            composer.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (showForm && !editId) {
              resetForm();
            } else {
              setEditId(null);
              setTrigger("");
              setTitle("");
              setBody("");
              setShowForm(true);
            }
          }}
          className="press ring-focus inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken"
        >
          <Plus className="h-3.5 w-3.5" />
          New template
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {templates.length === 0 && !showForm && (
          <div className="rounded-lg border border-dashed border-line bg-paper p-4 text-center text-[12.5px] text-ink-muted">
            No templates yet. Create one to get started.
          </div>
        )}
        {templates.map((tpl) => (
          <div
            key={tpl.id}
            className="rounded-lg border border-line bg-paper px-3 py-2.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{tpl.title}</span>
                  <span className="rounded-full border border-line bg-paper-sunken px-1.5 py-px font-mono text-[10.5px] text-ink-muted">
                    /{tpl.trigger}
                  </span>
                </div>
                <p className="mt-1 truncate text-[11.5px] text-ink-muted">
                  {tpl.body.replace(/\s+/g, " ").trim().slice(0, 120)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => startEdit(tpl)}
                  className="press rounded px-2 py-1 text-[11.5px] text-ink-muted hover:bg-paper-sunken hover:text-ink"
                >
                  Edit
                </button>
                <IconButton
                  icon={<Trash2 />}
                  label="Delete"
                  size="sm"
                  onClick={() => remove(tpl.id)}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="mt-3 rounded-lg border border-line-strong bg-paper p-3">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-[12.5px] font-semibold text-ink">
              {editId ? "Edit template" : "New template"}
            </h4>
            <IconButton icon={<X />} label="Cancel" size="sm" onClick={resetForm} />
          </div>
          <div className="flex flex-col gap-3">
            <Field label="Trigger" description="Lowercase, dashes only. Used as /trigger in the composer.">
              <input
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
                placeholder="summarize"
                className="block w-full rounded-lg border border-line bg-paper-raised px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
              />
            </Field>
            <Field label="Title">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Summarize"
                className="block w-full rounded-lg border border-line bg-paper-raised px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
              />
            </Field>
            <Field label="Body" description="The text inserted into the composer when the template is chosen.">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                placeholder="Summarize the following clearly and concisely…"
                className="block w-full resize-y rounded-lg border border-line bg-paper-raised px-3 py-2 font-mono text-[12.5px] leading-5 text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="press rounded-lg border border-line bg-paper-raised px-3 py-1.5 text-[12.5px] text-ink hover:bg-paper-sunken"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!normalizeTrigger(trigger) || !title.trim() || !body}
                className="press ring-focus inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-paper hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                {editId ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- Account ----------------

function AccountPanel() {
  const user = useApp((s) => s.user);
  const isLoadingAuth = useApp((s) => s.isLoadingAuth);
  const signInWithGoogle = useApp((s) => s.signInWithGoogle);
  const signOut = useApp((s) => s.signOut);

  const handleSignIn = async () => {
    // Web build: the desktop invoke("begin_desktop_auth") path doesn't exist
    // in a browser — navigate to the Better Auth Google OAuth flow instead.
    if (isWebAuthClient()) {
      startWebGoogleSignIn();
      return;
    }
    try {
      await signInWithGoogle();
    } catch (error) {
      alert(`Sign in failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Account</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">
          Sign in with Google to sync your data across devices.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-paper-raised p-4">
        {user ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {user.picture && (
                <img
                  src={user.picture}
                  alt={user.name}
                  className="h-10 w-10 rounded-full"
                />
              )}
              <div>
                <p className="text-[14px] font-medium text-ink">{user.name}</p>
                <p className="text-[12px] text-ink-muted">{user.email}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="press ring-focus inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-line/40"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={isLoadingAuth}
            onClick={handleSignIn}
            className="press ring-focus inline-flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-paper px-4 py-2.5 text-[13px] font-medium text-ink hover:bg-line/40 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="currentColor"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="currentColor"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="currentColor"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            {isLoadingAuth ? "Signing in..." : "Sign in with Google"}
          </button>
        )}
      </section>
    </div>
  );
}

// ---------------- Primitives ----------------

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium text-ink">{label}</span>
      </div>
      {children}
      {description && (
        <p className="mt-1.5 text-[11.5px] text-ink-muted">{description}</p>
      )}
    </div>
  );
}

/** Python + Node that zWork installs for itself, so office files, skills and
 *  `npx` / `uvx` connectors work without the user installing developer tools. */
function RuntimeSection() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await api.runtimeStatus();
        if (cancelled) return;
        setStatus(r.status);
        if (r.status.state === "installing") timer = setTimeout(poll, 1500);
      } catch {
        /* sidecar restarting — the next open of Settings re-polls */
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!status || status.state === "unsupported") return null;

  const retry = async () => {
    const r = await api.runtimeInstall().catch(() => null);
    if (r) setStatus(r.status);
    // Pick up progress from here.
    const tick = async () => {
      const s = await api.runtimeStatus().catch(() => null);
      if (!s) return;
      setStatus(s.status);
      if (s.status.state === "installing") setTimeout(tick, 1500);
    };
    setTimeout(tick, 800);
  };

  let detail: string;
  switch (status.state) {
    case "ready":
      detail = `Python ${status.python} with document and data libraries, Node ${status.node}.`;
      break;
    case "installing":
      detail = `${status.step}…`;
      break;
    case "failed":
      detail = status.error;
      break;
    default:
      detail = "Not installed yet.";
  }

  return (
    <section className="rounded-xl border border-line bg-paper-raised p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink flex items-center gap-2">
            Built-in tools
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status.state === "ready"
                  ? "bg-emerald-500"
                  : status.state === "failed"
                    ? "bg-red-500"
                    : "bg-amber-500 animate-pulse"
              }`}
            />
          </div>
          <div className="mt-0.5 text-[12px] text-ink-muted">
            What zWork uses to create Word, Excel, PowerPoint and PDF files and to run connectors.{" "}
            <span className={status.state === "failed" ? "text-red-500" : undefined}>{detail}</span>
          </div>
        </div>
        {(status.state === "failed" || status.state === "missing") && (
          <button
            onClick={retry}
            className="ring-focus shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-paper-sunken transition-colors"
          >
            {status.state === "failed" ? "Retry" : "Install"}
          </button>
        )}
      </div>
    </section>
  );
}
