import { useEffect, useMemo, useState } from "react";
import appPackage from "../../package.json";
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
  FileText,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { IconButton } from "./IconButton";
import type { Integration } from "../lib/api";

type Section = "general" | "memory" | "personalization" | "models" | "integrations";

const SECTION_META: Record<Section, { title: string; description: string; icon: React.ReactNode }> = {
  general: {
    title: "General",
    description: "Theme, defaults, preferences.",
    icon: <Sliders className="h-4 w-4" />,
  },
  memory: {
    title: "Memory",
    description: "Persistent notes zWork remembers.",
    icon: <Brain className="h-4 w-4" />,
  },
  personalization: {
    title: "Personalization",
    description: "Your zwork.md preferences file.",
    icon: <FileText className="h-4 w-4" />,
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

const CREDENTIAL_PLACEHOLDERS: Record<string, { keyPlaceholder: string; baseUrlPlaceholder: string }> = {
  anthropic: {
    keyPlaceholder: "sk-ant-…",
    baseUrlPlaceholder: "https://api.anthropic.com",
  },
  openai: {
    keyPlaceholder: "sk-…",
    baseUrlPlaceholder: "https://api.openai.com/v1",
  },
  claude_code: {
    keyPlaceholder: "(reuses local credentials — no key needed)",
    baseUrlPlaceholder: "",
  },
};

export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const integrations = useApp((s) => s.integrations);
  const bootstrap = useApp((s) => s.bootstrap);
  const saveSettings = useApp((s) => s.saveSettings);
  const setView = useApp((s) => s.setView);

  const hasModels = (providers?.models ?? []).length > 0;
  const [section, setSection] = useState<Section>("general");

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!hasModels) setSection("models");
  }, [hasModels]);

  const upsertCustomModel = useApp((s) => s.upsertCustomModel);
  const deleteCustomModel = useApp((s) => s.deleteCustomModel);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-paper">
      {/* Header */}
      <div className="titlebar-drag flex h-12 shrink-0 items-center justify-between border-b border-line px-5">
        <div className="flex min-w-0 items-center gap-3" data-no-drag>
          <IconButton
            icon={<ArrowLeft />}
            label="Back to chat"
            size="sm"
            onClick={() => setView("chat")}
          />
          <h1 className="text-[14px] font-semibold text-ink">Settings</h1>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1080px] gap-0 lg:gap-8 px-0 lg:px-8 py-0 lg:py-6">
          {/* Section tabs — horizontal on mobile, vertical on desktop */}
          <nav className="flex shrink-0 flex-row gap-0 lg:flex-col lg:w-[200px] border-b border-line lg:border-b-0 lg:pt-2 overflow-x-auto">
            {(Object.keys(SECTION_META) as Section[]).map((key) => {
              const meta = SECTION_META[key];
              const isActive = section === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSection(key)}
                  className={cn(
                    "press flex items-center gap-2.5 whitespace-nowrap px-4 py-3 text-[13px] font-medium transition-colors lg:rounded-xl lg:px-3 lg:py-2.5",
                    isActive
                      ? "text-ink border-b-2 border-ink lg:border-b-0 lg:bg-paper-sunken"
                      : "text-ink-muted border-b-2 border-transparent hover:text-ink lg:border-b-0 lg:hover:bg-line/40",
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

          {/* Content area */}
          <div className="min-w-0 flex-1 px-5 lg:px-0 py-5 space-y-5">
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
              <IntegrationsPanel integrations={integrations} onRefresh={bootstrap} />
            )}
            {section === "general" && (
              <GeneralPanel settings={settings} onSave={saveSettings} />
            )}
            {section === "memory" && <MemoryPanel />}
            {section === "personalization" && <PersonalizationPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Models (with inline credentials) ----------------

const EMPTY_MODEL = {
  name: "",
  shape: "anthropic" as "anthropic" | "openai",
  credential: "anthropic",
  model_id: "",
  base_url_override: "",
};

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
  const [baseUrl, setBaseUrl] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | undefined>();

  const credMeta = CREDENTIAL_PLACEHOLDERS[form.credential] || CREDENTIAL_PLACEHOLDERS.openai;
  const credStatus = providers?.credentials?.[form.credential];
  const maskedKey = settings?.api_keys?.[form.credential] || "";
  const savedBaseUrl = settings?.provider_config?.[form.credential]?.base_url ?? "";
  const isKeyless = form.credential === "claude_code";

  // Prefill credential fields when the selected credential changes.
  useEffect(() => {
    setBaseUrl(savedBaseUrl);
    setApiKey("");
  }, [form.credential, savedBaseUrl]);

  const startEdit = (id: string) => {
    const m = customModels.find((cm) => cm.id === id);
    if (!m) return;
    setForm({
      name: m.name,
      shape: (m.shape as "anthropic" | "openai") || "anthropic",
      credential: m.credential,
      model_id: m.model_id,
      base_url_override: m.base_url_override,
    });
    setEditId(id);
    setShowForm(true);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.model_id.trim()) return;
    setBusy(true);
    try {
      // Save credentials alongside the model upsert.
      const patch: {
        api_keys?: Record<string, string>;
        provider_config?: Record<string, Record<string, string>>;
      } = {};
      if (!isKeyless && apiKey.trim()) {
        patch.api_keys = { [form.credential]: apiKey.trim() };
      }
      if (!isKeyless && baseUrl.trim() && baseUrl.trim() !== savedBaseUrl) {
        patch.provider_config = { [form.credential]: { base_url: baseUrl.trim() } };
      }
      if (patch.api_keys || patch.provider_config) {
        await onSaveSettings(patch);
      }
      await onUpsert({ ...form, id: editId });
      setShowForm(false);
      setEditId(undefined);
      setForm(EMPTY_MODEL);
      setApiKey("");
      setBaseUrl("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Models</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-muted">
            Add models to chat with. Each points to a credential and model ID.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setShowForm(true); setEditId(undefined); setForm(EMPTY_MODEL); }}
          className="press ring-focus inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-paper-sunken"
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
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">Auto-detected</span>
              </div>
              <p className="mt-0.5 text-[12px] text-ink-muted">{m.subtitle}</p>
            </div>
            <CircleCheck className="mt-0.5 h-4 w-4 text-emerald-600" />
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
                    <CircleCheck className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <CircleDashed className="h-3.5 w-3.5 text-ink-faint" />
                  )}
                </div>
                <p className="mt-0.5 text-[12px] text-ink-muted">
                  {live?.subtitle || `${m.shape} · ${m.credential} · ${m.model_id}`}
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
                <IconButton
                  icon={<Trash2 />}
                  label="Delete"
                  size="sm"
                  onClick={async () => { await onDelete(m.id); }}
                />
              </div>
            </div>
          </div>
        );
      })}

      {customModels.length === 0 && models.filter((m) => !m.synthesized).length === 0 && !showForm && (
        <div className="rounded-xl border border-dashed border-line bg-paper p-6 text-center">
          <p className="text-[13px] font-medium text-ink">No models configured</p>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            Add a model above, or set up credentials so auto-detected models appear.
          </p>
        </div>
      )}

      {/* Add / Edit form */}
      {showForm && (
        <section className="rounded-xl border border-line-strong bg-paper-raised p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[13.5px] font-semibold text-ink">
              {editId ? "Edit model" : "Add model"}
            </h3>
            <IconButton icon={<X />} label="Cancel" size="sm" onClick={() => setShowForm(false)} />
          </div>
          <div className="flex flex-col gap-3">
            <Field label="Display name">
              <input
                className="block w-full rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                placeholder="My local proxy"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <Field label="Credential source">
              <select
                value={form.credential}
                onChange={(e) => {
                  const cred = e.target.value;
                  const shape = cred === "anthropic" || cred === "claude_code" ? "anthropic" : "openai";
                  setForm((f) => ({ ...f, credential: cred, shape }));
                }}
                className="block w-full rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] text-ink focus:border-line-strong focus:outline-none"
                >
                  <option value="anthropic">Anthropic (BYOK)</option>
                  <option value="openai">OpenAI-compatible (BYOK)</option>
                  <option value="claude_code">Local config (reuse credentials)</option>
                </select>
            </Field>

            {/* Credential status + inline key + base URL */}
            {isKeyless ? (
              <div className="rounded-lg border border-line bg-paper px-3 py-2 text-[12px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  {credStatus?.configured ? (
                    <CircleCheck className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <CircleDashed className="h-3.5 w-3.5 text-ink-faint" />
                  )}
                  {credStatus?.configured
                    ? "Reusing local credentials from ~/.claude/"
                    : "Local credentials not detected — install them first"}
                </span>
              </div>
            ) : (
              <>
                <Field
                  label="API key"
                  description={
                    maskedKey
                      ? `Currently stored: ${maskedKey}. Leave blank to keep it.`
                      : "Your API key is stored locally only — never sent anywhere except the base URL."
                  }
                >
                  <div className="flex items-center rounded-lg border border-line bg-paper focus-within:border-line-strong">
                    <input
                      type={revealKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={credMeta.keyPlaceholder}
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

                <Field label="Base URL (optional)" description="Override the provider's default endpoint (e.g. a proxy).">
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={credMeta.baseUrlPlaceholder}
                    className="block w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                  />
                </Field>
              </>
            )}

            <Field label="Model ID" description="The exact model string sent to the API, e.g. claude-3-5-sonnet-20241022 or gpt-4o.">
              <input
                className="block w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                placeholder="claude-sonnet-4-5-20250929"
                value={form.model_id}
                onChange={(e) => setForm((f) => ({ ...f, model_id: e.target.value }))}
              />
            </Field>
            <Field label="Base URL override (optional)" description="Override the credential's base URL. Useful for multi-provider gateways.">
              <input
                className="block w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                placeholder="https://openrouter.ai/api/v1"
                value={form.base_url_override}
                onChange={(e) => setForm((f) => ({ ...f, base_url_override: e.target.value }))}
              />
            </Field>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                disabled={busy || !form.name.trim() || !form.model_id.trim()}
                onClick={submit}
                className="press inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-paper hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed"
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
                      ? "bg-emerald-500"
                      : i.detected
                        ? "bg-amber-400"
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

// ---------------- General ----------------

function GeneralPanel({
  settings,
  onSave,
}: {
  settings: ReturnType<typeof useApp.getState>["settings"];
  onSave: (patch: { default_model?: string; use_claude_code_config?: boolean; telemetry_enabled?: boolean }) => Promise<void>;
}) {
  const appVersion = appPackage.version;
  const providers = useApp((s) => s.providers);
  const models = providers?.models ?? [];
  const [defaultModel, setDefaultModel] = useState(settings?.default_model ?? "");
  const [useClaude, setUseClaude] = useState(!!settings?.use_claude_code_config);
  const [telemetryEnabled, setTelemetryEnabled] = useState(!!settings?.telemetry_enabled);
  const [themePref, setThemePref] = useState<"system" | "light" | "dark">(() => {
    const v = localStorage.getItem("zwork.theme");
    if (v === "light" || v === "dark") return v;
    return "system";
  });

  useEffect(() => {
    setDefaultModel(settings?.default_model ?? "");
    setUseClaude(!!settings?.use_claude_code_config);
    setTelemetryEnabled(!!settings?.telemetry_enabled);
  }, [settings]);

  const applyTheme = (v: "system" | "light" | "dark") => {
    setThemePref(v);
    import("../lib/theme").then((m) => m.setThemePref(v));
  };

  const themeOptions: { value: "system" | "light" | "dark"; icon: React.ReactNode; label: string }[] = [
    { value: "system", icon: <Monitor className="h-4 w-4" />, label: "System" },
    { value: "light", icon: <Sun className="h-4 w-4" />, label: "Light" },
    { value: "dark", icon: <Moon className="h-4 w-4" />, label: "Dark" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">General</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">Preferences for zWork.</p>
      </div>

      {/* Theme picker */}
      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <Field label="Appearance" description="Follows your system by default.">
          <div className="flex gap-2 mt-1">
            {themeOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => applyTheme(opt.value)}
                className={cn(
                  "press flex flex-col items-center gap-1.5 rounded-xl border px-4 py-3 transition-colors min-w-[64px]",
                  themePref === opt.value
                    ? "border-line-strong bg-paper-sunken text-ink shadow-[0_0_0_1px_rgb(var(--line-strong))]"
                    : "border-line bg-paper text-ink-muted hover:border-line-strong hover:bg-paper-sunken hover:text-ink",
                )}
              >
                {opt.icon}
                <span className="text-[11px] font-medium">{opt.label}</span>
              </button>
            ))}
          </div>
        </Field>
      </section>

      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <Field label="Version" description="The currently installed desktop build.">
          <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] text-ink">
            <span className="font-medium">zWork</span>
            <span className="font-mono text-ink-muted">{appVersion}</span>
          </div>
        </Field>
      </section>

      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={telemetryEnabled}
            onChange={async (e) => {
              const next = e.target.checked;
              setTelemetryEnabled(next);
              await onSave({ telemetry_enabled: next });
            }}
            className="mt-[3px] h-4 w-4 accent-ink"
          />
          <div className="space-y-1">
            <div className="text-[13px] font-medium text-ink">Anonymous usage analytics</div>
            <div className="text-[12px] leading-5 text-ink-muted">
              Helps track installs, active usage time, onboarding completion, chat volume, error rates, and update success.
              It never collects prompt text, message content, file contents, API keys, screenshots, or paths.
            </div>
          </div>
        </label>
      </section>

      {/* Default model */}
      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <Field label="Default model" description="Used when starting a new chat.">
          <select
            value={defaultModel}
            onChange={async (e) => {
              setDefaultModel(e.target.value);
              await onSave({ default_model: e.target.value });
            }}
            className="block w-full rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] text-ink focus:border-line-strong focus:outline-none"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.subtitle ? ` · ${m.subtitle}` : ""}
              </option>
            ))}
          </select>
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
    </div>
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

// ---------------- Personalization ----------------

function PersonalizationPanel() {
  const userMdContent = useApp((s) => s.userMdContent);
  const refreshUserMd = useApp((s) => s.refreshUserMd);
  const saveUserMd = useApp((s) => s.saveUserMd);
  const [draft, setDraft] = useState(userMdContent);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { void refreshUserMd(); }, [refreshUserMd]);
  useEffect(() => { setDraft(userMdContent); setDirty(false); }, [userMdContent]);

  const save = async () => {
    setSaving(true);
    try { await saveUserMd(draft); setDirty(false); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Personalization</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">
          Your <code className="font-mono text-[11.5px]">zwork.md</code> file. Generated from onboarding, editable anytime.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-paper-raised p-4">
        <textarea
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
          rows={16}
          className="block w-full resize-y rounded-lg border border-line bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-5 text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          placeholder="# zWork personalization"
        />
        <div className="mt-3 flex items-center justify-between">
          <p className="text-[11.5px] text-ink-faint">
            {dirty ? "Unsaved changes" : draft ? "Saved" : "No personalization file yet"}
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
