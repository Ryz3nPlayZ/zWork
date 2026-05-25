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
  FileText,
  User,
  LogOut,
  ShieldAlert,
} from "lucide-react";
import { cn } from "../lib/cn";
import { useApp } from "../lib/store";
import { isMacOS } from "../lib/platform";
import { fallbackAppVersion, resolveAppVersion } from "../lib/appVersion";
import {
  loadTemplates,
  saveTemplates,
  newTemplateId,
  normalizeTrigger,
  type PromptTemplate,
} from "../lib/templates";
import { IconButton } from "./IconButton";
import { api, type Integration } from "../lib/api";

type Section = "account" | "general" | "memory" | "personalization" | "models" | "integrations";

const SECTION_META: Record<Section, { title: string; description: string; icon: React.ReactNode }> = {
  account: {
    title: "Account",
    description: "Sign in with Google to sync your data.",
    icon: <User className="h-4 w-4" />,
  },
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

// Known native credentials whose default base URL the user might paste into
// the per-model "Base URL override" field. When that happens, steer them at
// the dedicated credential slot so we don't end up with one model's URL
// shoved into a different credential.
const NATIVE_PRESET_HINTS: Array<{ id: string; label: string; matcher: RegExp }> = [
  { id: "deepseek", label: "DeepSeek", matcher: /\bapi\.deepseek\.com\b/i },
  { id: "zai", label: "z.ai", matcher: /\bapi\.z\.ai\b/i },
];

function detectPresetCredentialHint(
  url: string,
  currentCredential: string,
): { id: string; label: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  for (const preset of NATIVE_PRESET_HINTS) {
    if (preset.matcher.test(trimmed) && currentCredential !== preset.id) {
      return { id: preset.id, label: preset.label };
    }
  }
  return null;
}

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
  deepseek: {
    keyPlaceholder: "sk-…",
    baseUrlPlaceholder: "https://api.deepseek.com/v1",
  },
  zai: {
    keyPlaceholder: "(z.ai API key)",
    baseUrlPlaceholder: "https://api.z.ai/api/paas/v4",
  },
};

export function SettingsPage() {
  const macOS = isMacOS();
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
    await api.waitForBackend(20).catch(() => {});
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
      {/* Header */}
      <div className={cn(macOS && "titlebar-drag", "flex h-12 shrink-0 items-center justify-between border-b border-line px-5")}>
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

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
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

          {/* Content area */}
          <div className="min-w-0 flex-1 w-full px-5 lg:px-0 py-5 space-y-5">
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
  const [revealKey, setRevealKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editId, setEditId] = useState<string | undefined>();

  const credMeta = CREDENTIAL_PLACEHOLDERS[form.credential] || CREDENTIAL_PLACEHOLDERS.openai;
  const credStatus = providers?.credentials?.[form.credential];
  const maskedKey = settings?.api_keys?.[form.credential] || "";
  const isKeyless = form.credential === "claude_code";
  const presetHint = detectPresetCredentialHint(form.base_url_override, form.credential);
  const deprecatedCredentialLabel =
    form.credential === "groq"
      ? "Groq"
      : form.credential === "cerebras"
        ? "Cerebras"
        : form.credential === "zwork_router"
          ? "zWork Router"
        : null;

  // Clear the API-key field when the user switches credentials.
  useEffect(() => {
    setApiKey("");
  }, [form.credential]);

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
    setError("");
    try {
      const patch: { api_keys?: Record<string, string> } = {};
      if (!isKeyless && apiKey.trim()) {
        patch.api_keys = { [form.credential]: apiKey.trim() };
      }
      if (patch.api_keys) {
        await onSaveSettings(patch);
      }
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
                  const shape = cred === "anthropic" || cred === "claude_code" || cred === "zwork_router" ? "anthropic" : "openai";
                  setForm((f) => ({ ...f, credential: cred, shape }));
                }}
                className="w-full bg-paper border border-line text-[13px] px-3.5 py-2 rounded-xl focus:outline-none focus:ring-1 focus:ring-ink focus:border-line-strong text-ink shadow-xs appearance-none pr-10 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M7%209l3%203%203-3%22%20stroke%3D%22%23888888%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-[length:18px_18px] bg-[right_10px_center] bg-no-repeat cursor-pointer transition-all duration-150"
                >
                  {deprecatedCredentialLabel && (
                    <option value={form.credential} className="bg-paper text-ink">
                      {form.credential === "zwork_router" ? `${deprecatedCredentialLabel} (Managed)` : `${deprecatedCredentialLabel} (Deprecated)`}
                    </option>
                  )}
                  <option value="anthropic" className="bg-paper text-ink">Anthropic (BYOK)</option>
                  <option value="openai" className="bg-paper text-ink">OpenAI-compatible (BYOK)</option>
                  <option value="deepseek" className="bg-paper text-ink">DeepSeek (BYOK)</option>
                  <option value="zai" className="bg-paper text-ink">z.ai (BYOK)</option>
                  <option value="claude_code" className="bg-paper text-ink">Local config (reuse credentials)</option>
                </select>
            </Field>
            {deprecatedCredentialLabel && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800">
                {form.credential === "zwork_router"
                  ? `${deprecatedCredentialLabel} is managed by zWork and pinned to DeepSeek V4 Flash.`
                  : `${deprecatedCredentialLabel} is deprecated and hidden for new setups. Migrate this model to a stronger provider.`}
              </p>
            )}

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
            <Field label="Base URL override (optional)" description="Per-model URL override. Use this for OpenAI-compatible gateways. Doesn't change the credential's saved base URL.">
              <input
                className="block w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                placeholder="https://openrouter.ai/api/v1"
                value={form.base_url_override}
                onChange={(e) => setForm((f) => ({ ...f, base_url_override: e.target.value }))}
              />
              {presetHint && (
                <p className="mt-1 text-[12px] leading-5 text-amber-700">
                  This URL looks like {presetHint.label}.{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-amber-900"
                    onClick={() =>
                      setForm((f) => ({ ...f, credential: presetHint.id, base_url_override: "" }))
                    }
                  >
                    Use the {presetHint.label} credential instead
                  </button>{" "}
                  — it has its own API key slot and default endpoint.
                </p>
              )}
            </Field>
            {error && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">{error}</p>
            )}
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
  const [appVersion, setAppVersion] = useState(fallbackAppVersion());
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

  useEffect(() => {
    let cancelled = false;
    void resolveAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

      {/* Privacy & Telemetry Dashboard */}
      <section className="rounded-xl border border-line bg-paper-raised p-5 space-y-4 shadow-sm select-none">
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
                    ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
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
                "press relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none mt-1",
                telemetryEnabled ? "bg-accent" : "bg-paper-sunken border-line"
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
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
                <span className="bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide uppercase">
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
              <div className="text-[12.5px] font-medium text-ink">Clear Offline Application Cache</div>
              <p className="text-[11.5px] text-ink-muted">Wipes all cached chats, summaries, and temporary preferences stored in this browser session.</p>
            </div>
            <button
              onClick={() => {
                try {
                  localStorage.removeItem("zwork:cached-chats");
                  localStorage.removeItem("zwork:cached-summaries");
                  alert("Application cache cleared successfully!");
                } catch {
                  alert("Failed to clear cache.");
                }
              }}
              className="press px-3 py-1.5 text-[11px] font-medium border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 text-red-500 rounded-lg transition-all cursor-pointer"
            >
              Clear Cache
            </button>
          </div>
        </div>
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
            className="w-full bg-paper border border-line text-[13px] px-3.5 py-2 rounded-xl focus:outline-none focus:ring-1 focus:ring-ink focus:border-line-strong text-ink shadow-xs appearance-none pr-10 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M7%209l3%203%203-3%22%20stroke%3D%22%23888888%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-[length:18px_18px] bg-[right_10px_center] bg-no-repeat cursor-pointer transition-all duration-150"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id} className="bg-paper text-ink">
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

interface PersonalizationData {
  persona: string;
  vibe: string;
  verbosity: string;
  customInstructions: string;
}

function parsePersonalization(md: string): PersonalizationData {
  const data = {
    persona: "Default Assistant",
    vibe: "Professional & focused",
    verbosity: "Balanced",
    customInstructions: ""
  };

  if (!md) return data;

  const personaMatch = md.match(/-\s+\*\*Persona\*\*:\s*([^\n]+)/i);
  if (personaMatch) data.persona = personaMatch[1].trim();

  const vibeMatch = md.match(/-\s+\*\*Vibe\*\*:\s*([^\n]+)/i);
  if (vibeMatch) data.vibe = vibeMatch[1].trim();

  const verbosityMatch = md.match(/-\s+\*\*Verbosity\*\*:\s*([^\n]+)/i);
  if (verbosityMatch) data.verbosity = verbosityMatch[1].trim();

  // Find where Custom Instructions start
  const customIdx = md.indexOf("## Custom Instructions");
  if (customIdx !== -1) {
    data.customInstructions = md.substring(customIdx + "## Custom Instructions".length).trim();
  } else {
    // If not found, check How to talk to me
    const talkIdx = md.indexOf("## How to talk to me");
    if (talkIdx !== -1) {
      data.customInstructions = md.substring(talkIdx + "## How to talk to me".length).trim();
    } else {
      if (!personaMatch && !vibeMatch && !verbosityMatch) {
        data.customInstructions = md;
      }
    }
  }

  return data;
}

function buildPersonalization(data: PersonalizationData): string {
  return `# zWork personalization

## Preferences

- **Persona**: ${data.persona}
- **Vibe**: ${data.vibe}
- **Verbosity**: ${data.verbosity}

## Custom Instructions

${data.customInstructions}`;
}

function PersonalizationPanel() {
  const userMdContent = useApp((s) => s.userMdContent);
  const refreshUserMd = useApp((s) => s.refreshUserMd);
  const saveUserMd = useApp((s) => s.saveUserMd);

  const [rawMode, setRawMode] = useState(false);
  const [formData, setFormData] = useState<PersonalizationData>(() => parsePersonalization(userMdContent));
  const [rawDraft, setRawDraft] = useState(userMdContent);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { void refreshUserMd(); }, [refreshUserMd]);

  useEffect(() => {
    setFormData(parsePersonalization(userMdContent));
    setRawDraft(userMdContent);
    setDirty(false);
  }, [userMdContent]);

  const handleFormChange = (key: keyof PersonalizationData, value: string) => {
    setFormData(prev => {
      const next = { ...prev, [key]: value };
      setRawDraft(buildPersonalization(next));
      setDirty(true);
      return next;
    });
  };

  const handleRawChange = (value: string) => {
    setRawDraft(value);
    setDirty(true);
    setFormData(parsePersonalization(value));
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveUserMd(rawDraft);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">AI Persona & Personalization</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">
          Customize how your zWork AI behaves, speaks, and aligns with your goals.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-paper-raised p-4 flex flex-col gap-4">
        {/* Toggle Mode */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <span className="text-[12.5px] font-semibold text-ink">Personalization Settings</span>
          <button
            type="button"
            onClick={() => setRawMode(!rawMode)}
            className="text-[11.5px] text-accent hover:underline font-medium"
          >
            {rawMode ? "Back to Custom Vibe Settings" : "Edit Raw zwork.md Profile"}
          </button>
        </div>

        {rawMode ? (
          <textarea
            value={rawDraft}
            onChange={(e) => handleRawChange(e.target.value)}
            rows={16}
            className="block w-full resize-y rounded-lg border border-line bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-5 text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            placeholder="# zWork personalization"
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Vibe */}
              <div>
                <label className="block text-[12px] font-bold text-ink mb-1.5">Vibe / Tone</label>
                <select
                  value={formData.vibe}
                  onChange={(e) => handleFormChange("vibe", e.target.value)}
                  className="w-full bg-paper border border-line text-[13px] px-3.5 py-2 rounded-xl focus:outline-none focus:ring-1 focus:ring-ink focus:border-line-strong text-ink shadow-xs appearance-none pr-10 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M7%209l3%203%203-3%22%20stroke%3D%22%23888888%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-[length:18px_18px] bg-[right_10px_center] bg-no-repeat cursor-pointer transition-all duration-150"
                >
                  <option value="Professional & focused" className="bg-paper text-ink">Professional & focused</option>
                  <option value="Casual & friendly" className="bg-paper text-ink">Casual & friendly</option>
                  <option value="Technical & direct" className="bg-paper text-ink">Technical & direct</option>
                  <option value="Creative & storytelling" className="bg-paper text-ink">Creative & storytelling</option>
                </select>
              </div>

              {/* Verbosity */}
              <div>
                <label className="block text-[12px] font-bold text-ink mb-1.5">Verbosity</label>
                <select
                  value={formData.verbosity}
                  onChange={(e) => handleFormChange("verbosity", e.target.value)}
                  className="w-full bg-paper border border-line text-[13px] px-3.5 py-2 rounded-xl focus:outline-none focus:ring-1 focus:ring-ink focus:border-line-strong text-ink shadow-xs appearance-none pr-10 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M7%209l3%203%203-3%22%20stroke%3D%22%23888888%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-[length:18px_18px] bg-[right_10px_center] bg-no-repeat cursor-pointer transition-all duration-150"
                >
                  <option value="Concise" className="bg-paper text-ink">Concise (Short and direct)</option>
                  <option value="Balanced" className="bg-paper text-ink">Balanced (Medium length)</option>
                  <option value="Thorough" className="bg-paper text-ink">Thorough (Detailed & explanatory)</option>
                </select>
              </div>
            </div>

            {/* Custom Instructions */}
            <div>
              <label className="block text-[12px] font-bold text-ink mb-1.5">Custom Persona Instructions</label>
              <textarea
                value={formData.customInstructions}
                onChange={(e) => handleFormChange("customInstructions", e.target.value)}
                rows={5}
                className="block w-full resize-y rounded-lg border border-line bg-paper px-3 py-2 text-[12.5px] leading-5 text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                placeholder="e.g. Always keep in mind I am building a B2B SaaS startup. Use clean, visual metaphors..."
              />
            </div>
          </div>
        )}

        <div className="mt-1 flex items-center justify-between border-t border-line pt-3">
          <p className="text-[11.5px] text-ink-faint font-medium">
            {dirty ? "Unsaved changes" : "Persona settings saved"}
          </p>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="press ring-focus inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-[12px] font-bold text-paper hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </section>

      <TemplatesSection />
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
