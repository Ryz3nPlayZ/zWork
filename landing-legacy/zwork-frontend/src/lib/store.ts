import { create } from "zustand";
import {
  api,
  streamChat,
  type ApiChatSummary,
  type ProvidersResponse,
  type SettingsPublic,
  type Integration,
  type CustomModel,
  type MeResponse,
  type Project,
} from "./api";
import { fetchCloudSession, getCloudToken, logoutCloudSession, startDesktopGoogleSignIn } from "./cloud";
import { setTelemetryEnabled, trackError, trackArtifactCreated } from "./telemetry";

const LEGACY_MANAGED_BASE_URLS = new Set(["https://ollama.com/v1"]);
const LEGACY_MANAGED_MODEL_IDS = new Set([
  "ollama-minimax-m2-7-cloud",
  "zwork-managed-proxy",
  "minimax-m2.7:cloud",
]);
const ROUTER_MODEL_ID = "zwork-router";
const ROUTER_MODEL_NAME = "zWork Router";
const ROUTER_BASE_URL = "https://api.tryzwork.app/api";
const ROUTER_TARGET_MODEL_ID = "deepseek-v4-flash";
const ONBOARDING_DONE_KEY = "zwork:onboarding-completed";

function hasCompletedOnboardingLocally(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ONBOARDING_DONE_KEY) === "true";
}

function rememberOnboardingDone(done: boolean) {
  if (typeof window === "undefined") return;
  if (done) {
    window.localStorage.setItem(ONBOARDING_DONE_KEY, "true");
  }
}

export type Role = "user" | "assistant";

export interface MessageAttachment {
  name: string;
  mime: string;
  kind: string;
  size?: number;
  previewUrl?: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  providerLabel?: string;
  resolvedModel?: string;
  upstreamProvider?: string;
  /** Tool calls / steps performed during this assistant turn. */
  activities?: Activity[];
  /** Files the user attached when sending this message. */
  attachments?: MessageAttachment[];
}

export interface Activity {
  id: string;
  label: string;
  icon?: string;
  done: boolean;
}

export interface SubagentTask {
  id: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
  deltaAccumulator?: string; // Accumulated delta text
  activityCount?: number; // Number of activities seen
}

export interface Chat {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
  /** High-level streaming status for the assistant turn in-flight. */
  status?: string; // e.g., "Thinking", "Drafting", "Planning"
  working?: boolean;
  error?: string;
  activities: Activity[];
  /** True when the backend signaled the provider isn't set up; UI shows a retry action. */
  needsSetup?: boolean;
  /** Last user message in this chat, used for the retry button. */
  lastUserMessage?: string;
  /** Chat-scoped artifact panel state. */
  artifactPanelOpen?: boolean;
  activeArtifactId?: string | null;
}

export type View = "chat" | "settings" | "projects" | "analytics" | "plan";

export type SettingsSection =
  | "account"
  | "plan"
  | "general"
  | "memory"
  | "personalization"
  | "models"
  | "integrations";

export type ChatBucket = "Today" | "This week" | "Earlier";

// ---- Artifacts ----

export type ArtifactKind = "code" | "diff" | "doc" | "sheet" | "graph" | "preview";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  language?: string;
  content: string;
  /** For diff artifacts: the original content. */
  original?: string;
  /** For sheet artifacts: parsed row/col data. */
  rows?: string[][];
  /** For graph/preview artifacts: an image URL or HTML src. */
  src?: string;
  createdAt: number;
  sourceMessageId?: string;
}

function parseArtifactAttributes(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
  for (const match of src.matchAll(re)) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? match[2] ?? "";
    out[key] = String(value).trim();
  }
  return out;
}

function extractArtifacts(text: string, sourceMessageId?: string): { cleaned: string; artifacts: Artifact[] } {
  const re = /\[\[ARTIFACT\s+([^\]]+)\]\]([\s\S]*?)\[\[\/ARTIFACT\]\]/g;
  const artifacts: Artifact[] = [];
  let cleaned = text;
  for (const match of text.matchAll(re)) {
    const attrs = parseArtifactAttributes(match[1] || "");
    const kind = (attrs.kind || "doc") as ArtifactKind;
    const title = attrs.title || {
      doc: "Document",
      sheet: "Sheet",
      graph: "Graph",
      code: "Code",
      diff: "Diff",
      preview: "Preview",
    }[kind] || "Artifact";
    const body = (match[2] || "").trim();
    const artifact: Artifact = {
      id: uid(),
      kind,
      title,
      content: body,
      createdAt: Date.now(),
      sourceMessageId,
    };
    if (kind === "sheet") {
      artifact.rows = body
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => line.split("\t"));
    }
    if (kind === "graph" && body.startsWith("data:image/")) {
      artifact.src = body;
    }
    artifacts.push(artifact);
    cleaned = cleaned.replace(match[0], "").trim();
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  cleaned = stripArtifactJunk(cleaned);
  return { cleaned, artifacts };
}

function inferArtifactKind(text: string): ArtifactKind | null {
  const t = text.toLowerCase();
  // Only trigger sheet for explicit creation requests or data export
  if (/(create|make|write|generate|build|export)\s+(a\s+)?(spreadsheet|table|sheet|csv|tsv)/.test(t)) return "sheet";
  if (/export\s+(to\s+)?(csv|tsv|spreadsheet)/.test(t)) return "sheet";
  // Graphs are inherently artifact-worthy
  if (/(create|make|generate|build|plot|show)\s+(a\s+)?(chart|graph|visualization)/.test(t)) return "graph";
  if (/(chart|graph|plot|visualization|visualise|visualize)\s+(of|for|showing)/.test(t)) return "graph";
  // Code artifacts for explicit runnable code requests
  if (/(create|write|generate)\s+(a\s+)?(runnable\s+)?(script|code\s+snippet|example)/.test(t)) return "code";
  // Docs only for explicit document creation with intent indicators
  if (/(create|write|draft|make|generate)\s+(a\s+)?(document|doc|brief|report)(\s+for|\s+about|\s+titled|\s+called)?/.test(t)) return "doc";
  return null;
}

function sanitizeArtifactContent(text: string): string {
  return stripArtifactJunk(text)
    .replace(/^Created artifact:.*$/gim, "")
    .replace(/^Created a .* artifact in the sidebar\.$/gim, "")
    .replace(/`?\.sidecar\/[^`\s]+`?/g, "")
    .replace(/Created\s+\w+\s+artifact:?\s*/gim, "")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}

function stripArtifactJunk(text: string): string {
  let out = (text || "").trim();
  out = out.replace(/^\s*```(?:text|plain|plaintext|markdown)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();
  out = out.replace(/^```(?:text|plain|plaintext|markdown)?\s*/i, "").replace(/\n```\s*$/i, "").trim();
  out = out
    .split("\n")
    .filter((line) => !/^\s*(text|open|undefined)\s*$/i.test(line))
    .join("\n")
    .trim();
  out = out.replace(/^here(?:'|’)s the artifact:?\s*$/i, "Here's the artifact:");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function needsManagedRouterMigration(settings: SettingsPublic): boolean {
  const defaultModel = settings.default_model || "";
  const customModels = settings.custom_models || [];
  const routerModel = customModels.find((model) => model.id === ROUTER_MODEL_ID);
  const hasLegacyCustomModel = customModels.some((model) => LEGACY_MANAGED_MODEL_IDS.has(model.id) || LEGACY_MANAGED_MODEL_IDS.has(model.model_id));
  const routerNeedsUpgrade = !!routerModel && (
    routerModel.credential !== "zwork_router" ||
    routerModel.shape !== "anthropic" ||
    routerModel.model_id !== ROUTER_TARGET_MODEL_ID ||
    routerModel.base_url_override !== ROUTER_BASE_URL
  );
  return (
    LEGACY_MANAGED_BASE_URLS.has(settings.provider_config?.openai?.base_url || "") ||
    LEGACY_MANAGED_BASE_URLS.has(settings.provider_config?.zwork_router?.base_url || "") ||
    LEGACY_MANAGED_MODEL_IDS.has(defaultModel) ||
    hasLegacyCustomModel ||
    routerNeedsUpgrade
  );
}

async function migrateManagedRouterSettings(settings: SettingsPublic): Promise<SettingsPublic> {
  const cloudToken = getCloudToken().trim();
  await api.putSettings({
    ...(cloudToken ? { api_keys: { zwork_router: cloudToken } } : {}),
    provider_config: {
      zwork_router: { base_url: ROUTER_BASE_URL },
    },
    default_model: ROUTER_MODEL_ID,
  });

  for (const model of settings.custom_models || []) {
    if (LEGACY_MANAGED_MODEL_IDS.has(model.id) || LEGACY_MANAGED_MODEL_IDS.has(model.model_id)) {
      await api.deleteCustomModel(model.id);
    }
  }

  await api.upsertCustomModel({
    id: ROUTER_MODEL_ID,
    name: ROUTER_MODEL_NAME,
    shape: "anthropic",
    credential: "zwork_router",
    model_id: ROUTER_TARGET_MODEL_ID,
    base_url_override: ROUTER_BASE_URL,
  });

  return await api.getSettings();
}

async function syncManagedRouterToken() {
  const cloudToken = getCloudToken().trim();
  if (!cloudToken) return;
  await api.putSettings({
    api_keys: { zwork_router: cloudToken },
    provider_config: {
      zwork_router: { base_url: ROUTER_BASE_URL },
    },
  });
}

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  tier?: "free" | "pro" | "max";
  coupon_code?: string | null;
}

interface AppState {
  // UI
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (v: boolean) => void;
  view: View;
  setView: (v: View) => void;
  /** Pending settings section to focus when SettingsPage mounts. */
  settingsSection: SettingsSection | null;
  openSettings: (section?: SettingsSection) => void;
  consumeSettingsSection: () => SettingsSection | null;

  // Auth
  user: User | null;
  isLoadingAuth: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => void;

  // Backend state
  providers: ProvidersResponse | null;
  integrations: Integration[];
  settings: SettingsPublic | null;
  chatSummaries: ApiChatSummary[];
  me: MeResponse | null;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;

  // Onboarding UI state
  onboardingDone: boolean | null;
  setOnboardingDone: (v: boolean) => void;

  // Composer state
  model: string;
  setModel: (m: string) => void;
  webSearch: boolean;
  toggleWeb: () => void;
  focusChatInput: number;
  triggerFocusChatInput: () => void;

  // Per-chat runtime cache
  chats: Record<string, Chat>;
  /**
   * The chat the user is currently viewing. null = landing (new chat).
   * A brand-new chat is NOT created in the history until the user sends
   * the first message.
   */
  activeChatId: string | null;

  // Abort for an in-flight stream
  _abort: AbortController | null;

  // Artifacts
  artifacts: Artifact[];
  openArtifact: (a: Artifact) => void;
  closeArtifactPanel: () => void;
  clearArtifacts: () => void;
  updateArtifact: (id: string, patch: Partial<Artifact>) => void;

  // Projects
  projects: Project[];
  activeProjectId: string | null;
  setActiveProject: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
  createProject: (name: string, description?: string) => Promise<void>;
  updateProject: (id: string, data: { name?: string; description?: string }) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  // Memory / user-md content (cached for settings editor)
  memoryContent: string;
  userMdContent: string;
  refreshMemory: () => Promise<void>;
  saveMemory: (content: string) => Promise<void>;
  refreshUserMd: () => Promise<void>;
  saveUserMd: (content: string) => Promise<void>;
  artifactMode: boolean;
  setArtifactMode: (v: boolean) => void;

  // Chat harness options
  planMode: boolean;
  setPlanMode: (v: boolean) => void;
  autoApproveDestructive: boolean;
  setAutoApproveDestructive: (v: boolean) => void;

  // Subagent state
  subagents: SubagentTask[];
  updateSubagent: (task: SubagentTask) => void;
  clearSubagents: () => void;

  // Actions
  bootstrap: () => Promise<void>;
  refreshChats: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshIntegrations: () => Promise<void>;
  refreshMe: () => Promise<void>;

  openLanding: () => void;
  openChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  renameChat: (id: string, title: string) => Promise<void>;

  send: (
    text: string,
    options?: {
      artifactMode?: boolean;
      planMode?: boolean;
      autoApproveDestructive?: boolean;
      attachments?: Array<{
        client_id?: string | null;
        name: string;
        path: string;
        mime: string;
        kind: string;
        size?: number;
        previewUrl?: string;
      }>;
    },
  ) => Promise<void>;
  retry: () => Promise<void>;
  stop: () => void;

  saveSettings: (patch: Partial<SettingsPublic> & { api_keys?: Record<string, string> }) => Promise<void>;
  upsertCustomModel: (m: Omit<CustomModel, "id"> & { id?: string }) => Promise<void>;
  deleteCustomModel: (id: string) => Promise<void>;
}

const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function pickAvailableModel(providers: ProvidersResponse | null, current = "") {
  if (!providers) return current;
  const configuredModels = providers.models.filter((m) => m.configured);
  if (current && configuredModels.some((m) => m.id === current)) {
    return current;
  }
  if (providers.default_model && configuredModels.some((m) => m.id === providers.default_model)) {
    return providers.default_model;
  }
  return (
    configuredModels[0]?.id ||
    providers.models[0]?.id ||
    ""
  );
}

export const useApp = create<AppState>((set, get) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  view: "chat",
  setView: (v) => set({ view: v }),
  settingsSection: null,
  openSettings: (section) =>
    set({ view: "settings", settingsSection: section ?? null }),
  consumeSettingsSection: () => {
    const pending = get().settingsSection;
    if (pending) set({ settingsSection: null });
    return pending;
  },

  user: null,
  isLoadingAuth: false,
  signInWithGoogle: async () => {
    set({ isLoadingAuth: true });
    try {
      const cloudUser = await startDesktopGoogleSignIn();
      await syncManagedRouterToken().catch(() => {});
      set({
        user: {
          id: cloudUser.user_id,
          email: cloudUser.email,
          name: cloudUser.name,
          tier: cloudUser.tier,
          coupon_code: cloudUser.coupon_code ?? null,
        },
        isLoadingAuth: false,
      });
    } catch (error) {
      set({ isLoadingAuth: false });
      throw error;
    }
  },
  signOut: () => {
    void logoutCloudSession().finally(() => {
      set({ user: null });
    });
  },

  providers: null,
  integrations: [],
  settings: null,
  chatSummaries: [],
  me: null,
  searchOpen: false,
  setSearchOpen: (v) => set({ searchOpen: v }),

  onboardingDone: hasCompletedOnboardingLocally() ? true : null,
  setOnboardingDone: (v) => {
    rememberOnboardingDone(v);
    set({ onboardingDone: v });
  },

  model: "",
  setModel: (m) => set({ model: m }),
  webSearch: false,
  toggleWeb: () => set((s) => ({ webSearch: !s.webSearch })),
  focusChatInput: 0,
  triggerFocusChatInput: () => set((s) => ({ focusChatInput: s.focusChatInput + 1 })),

  chats: {},
  activeChatId: null,
  _abort: null,

  artifacts: [],
  openArtifact: (a) => {
    set((s) => {
      const chatId = s.activeChatId;
      if (!chatId) return s;
      const exists = s.artifacts.find((x) => x.id === a.id);
      const artifacts = exists ? s.artifacts : [...s.artifacts, a];
      const chat = s.chats[chatId];
      if (!chat) return { artifacts };
      return {
        artifacts,
        chats: {
          ...s.chats,
          [chatId]: {
            ...chat,
            artifactPanelOpen: true,
            activeArtifactId: a.id,
          },
        },
      };
    });
  },
  closeArtifactPanel: () =>
    set((s) => {
      const chatId = s.activeChatId;
      if (!chatId) return s;
      const chat = s.chats[chatId];
      if (!chat) return s;
      return {
        chats: {
          ...s.chats,
          [chatId]: {
            ...chat,
            artifactPanelOpen: false,
            activeArtifactId: null,
          },
        },
      };
    }),
  clearArtifacts: () =>
    set((s) => ({
      artifacts: [],
      chats: Object.fromEntries(
        Object.entries(s.chats).map(([id, chat]) => [
          id,
          { ...chat, artifactPanelOpen: false, activeArtifactId: null },
        ]),
      ),
    })),

  projects: [],
  activeProjectId: null,
  setActiveProject: (id) => set({ activeProjectId: id }),
  memoryContent: "",
  userMdContent: "",
  artifactMode: false,
  setArtifactMode: (v) => set({ artifactMode: v }),

  // Chat harness options
  planMode: false,
  setPlanMode: (v) => set({ planMode: v }),
  autoApproveDestructive: false,
  setAutoApproveDestructive: (v) => set({ autoApproveDestructive: v }),

  // Subagent state
  subagents: [],
  updateSubagent: (task: SubagentTask) =>
    set((s) => {
      const idx = s.subagents.findIndex((sa) => sa.id === task.id);
      if (idx < 0) return s;
      const updated = [...s.subagents];
      updated[idx] = task;
      return { subagents: updated };
    }),
  clearSubagents: () => set({ subagents: [] }),

  refreshProjects: async () => {
    try {
      const { projects } = await api.listProjects();
      set({ projects });
    } catch (e) { console.warn("refreshProjects failed:", e) }
  },

  createProject: async (name, description) => {
    await api.createProject(name, description);
    await get().refreshProjects();
  },

  updateProject: async (id, data) => {
    await api.updateProject(id, data);
    await get().refreshProjects();
  },

  deleteProject: async (id) => {
    await api.deleteProject(id);
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  },

  refreshMemory: async () => {
    try {
      const { content } = await api.getMemory();
      set({ memoryContent: content });
    } catch (e) { console.warn("refreshMemory failed:", e) }
  },

  saveMemory: async (content) => {
    await api.putMemory(content);
    set({ memoryContent: content });
  },

  refreshUserMd: async () => {
    try {
      const { content } = await api.getUserMd();
      set({ userMdContent: content });
    } catch (e) { console.warn("refreshUserMd failed:", e) }
  },

  saveUserMd: async (content) => {
    await api.putUserMd(content);
    set({ userMdContent: content });
  },

  bootstrap: async () => {
    await api.waitForBackend(20).catch(() => {});

    try {
      const cloudUser = await fetchCloudSession();
      if (cloudUser) {
        await syncManagedRouterToken().catch(() => {});
        set({
          user: {
            id: cloudUser.user_id,
            email: cloudUser.email,
            name: cloudUser.name,
            tier: cloudUser.tier,
            coupon_code: cloudUser.coupon_code ?? null,
          },
        });
      }
    } catch (e) { console.warn("bootstrap cloud sync failed:", e) }

    await Promise.all([
      get().refreshProviders(),
      get().refreshSettings(),
      get().refreshIntegrations(),
      get().refreshChats(),
      get().refreshMe(),
      get().refreshProjects(),
      api
        .onboardStatus()
        .then((st) => {
          const completed = !!st.completed || hasCompletedOnboardingLocally();
          rememberOnboardingDone(completed);
          set({ onboardingDone: completed });
        })
        .catch(() => {
          if (hasCompletedOnboardingLocally()) {
            set({ onboardingDone: true });
          }
        }),
    ]);
    const fallback = pickAvailableModel(get().providers, get().model);
    if (fallback !== get().model) set({ model: fallback });
  },

  refreshChats: async () => {
    try {
      const { chats } = await api.listChats();
      set({ chatSummaries: chats });
    } catch (e) { console.warn("refreshChats failed:", e) }
  },

  refreshProviders: async () => {
    try {
      const p = await api.providers();
      set((s) => ({ providers: p, model: pickAvailableModel(p, s.model) }));
    } catch (e) { console.warn("refreshProviders failed:", e) }
  },

  refreshSettings: async () => {
    try {
      let s = await api.getSettings();
      if (needsManagedRouterMigration(s)) {
        s = await migrateManagedRouterSettings(s);
      }
      set({ settings: s });
      setTelemetryEnabled(!!s.telemetry_enabled);
    } catch (e) { console.warn("refreshSettings failed:", e) }
  },

  refreshIntegrations: async () => {
    try {
      const { integrations } = await api.integrations();
      set({ integrations });
    } catch (e) { console.warn("refreshIntegrations failed:", e) }
  },

  refreshMe: async () => {
    try {
      const me = await api.me();
      set({ me });
    } catch (e) { console.warn("refreshMe failed:", e) }
  },

  openLanding: () => set({ activeChatId: null, view: "chat" }),

  openChat: async (id) => {
    set({ activeChatId: id, view: "chat" });
    // Fetch full chat lazily
    if (!get().chats[id]) {
      try {
        const full = await api.getChat(id);
        const messages: Message[] = full.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            id: m.id,
            role: m.role as Role,
            content: m.content,
            createdAt: m.created_at,
            activities: m.activities || [],
          }));
        const latestActivities = [...messages].reverse().find((m) => m.role === "assistant" && (m.activities || []).length > 0)?.activities || [];
        // Extract artifacts from loaded messages so they appear in the
        // artifact panel after app restart — otherwise raw [[ARTIFACT...]]
        // tags leak into the displayed text.
        const loadedArtifacts: Artifact[] = [];
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          if (m.role === "assistant" && m.content.includes("[[ARTIFACT")) {
            const { cleaned, artifacts } = extractArtifacts(m.content, m.id);
            if (artifacts.length > 0) {
              messages[i] = { ...m, content: cleaned || (artifacts.length === 1 ? "Here's the artifact:" : "Here are the artifacts:") };
              loadedArtifacts.push(...artifacts);
            }
          }
        }
        set((s) => ({
          artifacts: [...s.artifacts, ...loadedArtifacts],
          chats: {
            ...s.chats,
            [id]: {
              id,
              title: full.title,
              updatedAt: full.updated_at,
              messages,
              activities: latestActivities,
              artifactPanelOpen: false,
              activeArtifactId: null,
            },
          },
        }));
      } catch (e) {
        set((s) => ({
          chats: {
            ...s.chats,
            [id]: {
              id,
              title: "Unavailable",
              updatedAt: Date.now(),
              messages: [],
              error: String(e),
              activities: [],
              artifactPanelOpen: false,
              activeArtifactId: null,
            },
          },
        }));
      }
    }
  },

  deleteChat: async (id) => {
    try {
      await api.deleteChat(id);
    } catch (e) { console.warn("deleteChat failed:", e) }
    set((s) => {
      const { [id]: _, ...rest } = s.chats;
      void _;
      return {
        chats: rest,
        activeChatId: s.activeChatId === id ? null : s.activeChatId,
      };
    });
    await get().refreshChats();
  },

  renameChat: async (id, title) => {
    try {
      await api.renameChat(id, title);
    } catch (e) { console.warn("renameChat failed:", e) }
    set((s) => {
      const c = s.chats[id];
      if (!c) return s;
      return { chats: { ...s.chats, [id]: { ...c, title } } };
    });
    await get().refreshChats();
  },

  stop: () => {
    get()._abort?.abort();
    set({ _abort: null });
  },

  retry: async () => {
    // Re-send the last user message for the current chat. Drops the trailing
    // assistant "setup needed" message so the UI doesn't duplicate.
    const id = get().activeChatId;
    if (!id) return;
    const c = get().chats[id];
    if (!c) return;
    const last = c.lastUserMessage;
    if (!last) return;

    // Remove the last assistant message (the setup error) and the prior user
    // message — `send` will re-append both cleanly.
    set((s) => {
      const chat = s.chats[id];
      if (!chat) return s;
      const msgs = [...chat.messages];
      // drop trailing assistant
      while (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs.pop();
      // drop matching trailing user
      if (msgs.length && msgs[msgs.length - 1].role === "user"
        && msgs[msgs.length - 1].content === last) {
        msgs.pop();
      }
      return {
        chats: {
          ...s.chats,
          [id]: { ...chat, messages: msgs, needsSetup: false, error: undefined },
        },
      };
    });

    // Refresh providers so a newly added key is picked up, then send.
    await get().refreshProviders();
    const p = get().providers;
    const fallback = pickAvailableModel(p, get().model);
    if (fallback !== get().model) set({ model: fallback });
    await get().send(last);
  },

  send: async (text, options) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Clear any previous subagent state
    set({ subagents: [] });

    const currentId = get().activeChatId;
    const model = pickAvailableModel(get().providers, get().model);
    const inferredArtifactKind = inferArtifactKind(trimmed);
    const artifactMode = (options?.artifactMode ?? get().artifactMode) || !!inferredArtifactKind;
    const planMode = options?.planMode ?? get().planMode;
    const autoApproveDestructive = options?.autoApproveDestructive ?? get().autoApproveDestructive;
    const attachments = options?.attachments ?? [];
    const activeProjectId = get().activeProjectId;

    // Optimistically place the user message into a local chat.
    // If there's no active chat yet, create a provisional client-side one; the
    // server will assign the real id via the "chat" SSE event and we reconcile.
    let localId = currentId ?? `tmp_${uid()}`;
    const userMsgText = trimmed;
    const userMsg: Message = {
      id: uid(),
      role: "user",
      content: userMsgText,
      createdAt: Date.now(),
      attachments: attachments.length
        ? attachments.map((a) => ({
            name: a.name,
            mime: a.mime,
            kind: a.kind,
            size: a.size,
            previewUrl: a.previewUrl,
          }))
        : undefined,
    };

    set((s) => {
      const existing = s.chats[localId];
      const chat: Chat = existing
        ? {
          ...existing,
          messages: [...existing.messages, userMsg],
          working: true,
          status: "Thinking",
          error: undefined,
          needsSetup: false,
          lastUserMessage: userMsgText,
          activities: [],
          updatedAt: Date.now(),
        }
        : {
          id: localId,
          title:
            userMsgText.slice(0, 56) + (userMsgText.length > 56 ? "…" : ""),
          updatedAt: Date.now(),
          messages: [userMsg],
          working: true,
          status: "Thinking",
          lastUserMessage: userMsgText,
          activities: [],
          artifactPanelOpen: false,
          activeArtifactId: null,
        };
      return {
        chats: { ...s.chats, [localId]: chat },
        activeChatId: localId,
      };
    });

    // Prepare assistant message placeholder for streaming
    const asstId = uid();
    set((s) => {
      const c = s.chats[localId]!;
      return {
        chats: {
          ...s.chats,
          [localId]: {
            ...c,
            messages: [
              ...c.messages,
              {
                id: asstId,
                role: "assistant",
                content: "",
                createdAt: Date.now(),
              },
            ],
          },
        },
      };
    });

    const controller = new AbortController();
    set({ _abort: controller });

    try {
      await streamChat(
        {
          chat_id: currentId && !currentId.startsWith("tmp_") ? currentId : undefined,
          message: trimmed,
          model,
          artifact_mode: artifactMode,
          project_id: activeProjectId ?? undefined,
          plan_mode: planMode,
          auto_approve_destructive: autoApproveDestructive,
          attachments,
        },
        (evt) => {
          if (evt.type === "chat") {
            // Server assigned an id — reconcile if we were provisional.
            const prevId = localId;
            if (prevId !== evt.id) {
              set((s) => {
                const c = s.chats[prevId];
                if (!c) return s;
                const { [prevId]: _, ...rest } = s.chats;
                void _;
                const updated: Chat = { ...c, id: evt.id, title: evt.title };
                return {
                  chats: { ...rest, [evt.id]: updated },
                  activeChatId: evt.id,
                };
              });
              localId = evt.id;
            }
          } else if (evt.type === "status") {
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, status: evt.text, working: true },
                },
              };
            });
          } else if (evt.type === "delta") {
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const msgs = c.messages.map((m) =>
                m.id === asstId ? { ...m, content: m.content + evt.text } : m,
              );
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, messages: msgs },
                },
              };
            });
          } else if (evt.type === "meta") {
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const msgs = c.messages.map((m) =>
                m.id === asstId
                  ? {
                      ...m,
                      providerLabel: evt.provider,
                      resolvedModel: evt.resolved_model,
                      upstreamProvider: evt.upstream_provider,
                    }
                  : m,
              );
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, messages: msgs },
                },
              };
            });
          } else if (evt.type === "needs_setup") {
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, needsSetup: true },
                },
              };
            });
          } else if (evt.type === "error") {
            trackError("api_error", evt.text);
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, error: evt.text, working: false, status: undefined },
                },
              };
            });
          } else if (evt.type === "activity") {
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const existing = c.activities.find((a) => a.id === evt.id);
              let activities = c.activities;
              if (existing) {
                activities = activities.map((a) =>
                  a.id === evt.id
                    ? { ...a, label: evt.label, icon: evt.icon, done: evt.done ?? false }
                    : a,
                );
              } else {
                activities = [...activities, { id: evt.id, label: evt.label, icon: evt.icon, done: evt.done ?? false }];
              }
              // Sync activities to the assistant message for persistence
              const msgs = c.messages.map((m) =>
                m.id === asstId ? { ...m, activities } : m,
              );
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, activities, messages: msgs },
                },
              };
            });
          } else if (evt.type === "permission") {
            // Permission gate event - could be used to show a warning in UI
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const permissionActivity: Activity = {
                id: `perm_${evt.tool}_${Date.now()}`,
                label: `${evt.blocked ? "Blocked" : "Allowed"} ${evt.tool} (${evt.risk})`,
                icon: evt.risk === "destructive" ? "shield-alert" : evt.risk === "sensitive" ? "shield" : "check",
                done: true,
              };
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, activities: [...c.activities, permissionActivity] },
                },
              };
            });
          } else if (evt.type === "compaction") {
            // Compaction event - summarization happening
            if (evt.status === "summarizing") {
              set((s) => {
                const c = s.chats[localId];
                if (!c) return s;
                return {
                  chats: {
                    ...s.chats,
                    [localId]: { ...c, status: "Compacting conversation..." },
                  },
                };
              });
            }
          } else if (evt.type === "subagent_started") {
            // A new subagent has been spawned
            set((s) => {
              const existing = s.subagents.find((sa) => sa.id === evt.task_id);
              if (existing) return s;
              const newSubagent: SubagentTask = {
                id: evt.task_id,
                description: evt.description,
                status: "running",
                deltaAccumulator: "",
                activityCount: 0,
              };
              return {
                subagents: [...s.subagents, newSubagent],
                chats: {
                  ...s.chats,
                  [localId]: {
                    ...s.chats[localId]!,
                    status: `Working on ${s.subagents.length + 1} task${s.subagents.length > 0 ? "s" : ""}...`,
                  },
                },
              };
            });
          } else if (evt.type === "subagent_progress") {
            // Subagent status update
            set((s) => {
              const idx = s.subagents.findIndex((sa) => sa.id === evt.task_id);
              if (idx < 0) return s;
              const updated = [...s.subagents];
              updated[idx] = { ...updated[idx], status: evt.status };
              return { subagents: updated };
            });
          } else if (evt.type === "subagent_delta") {
            // Subagent is producing text output
            set((s) => {
              const idx = s.subagents.findIndex((sa) => sa.id === evt.task_id);
              if (idx < 0) return s;
              const updated = [...s.subagents];
              const existing = updated[idx];
              updated[idx] = {
                ...existing,
                deltaAccumulator: (existing.deltaAccumulator || "") + evt.text,
              };
              return { subagents: updated };
            });
          } else if (evt.type === "subagent_activity") {
            // Subagent activity (tool execution, etc.)
            set((s) => {
              const idx = s.subagents.findIndex((sa) => sa.id === evt.task_id);
              if (idx < 0) return s;
              const updated = [...s.subagents];
              const existing = updated[idx];
              updated[idx] = {
                ...existing,
                activityCount: (existing.activityCount || 0) + 1,
              };
              return { subagents: updated };
            });
          } else if (evt.type === "subagent_done") {
            // Subagent completed
            set((s) => {
              const idx = s.subagents.findIndex((sa) => sa.id === evt.task_id);
              if (idx < 0) return s;
              const updated = [...s.subagents];
              updated[idx] = {
                ...updated[idx],
                status: evt.error ? "failed" : "completed",
                result: evt.result,
                error: evt.error,
              };
              // Update status based on remaining subagents
              const remaining = updated.filter((sa) => sa.status === "running").length;
              return {
                subagents: updated,
                chats: {
                  ...s.chats,
                  [localId]: {
                    ...s.chats[localId]!,
                    status: remaining > 0 ? `Working on ${remaining} task${remaining > 1 ? "s" : ""}...` : undefined,
                  },
                },
              };
            });
          } else if (evt.type === "heartbeat") {
            return;
          } else if (evt.type === "done" || evt.type === "end") {
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              // Final sync of activities to the assistant message
              const msgs = c.messages.map((m) =>
                m.id === asstId ? { ...m, activities: [...c.activities] } : m,
              );
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, working: false, status: undefined, messages: msgs },
                },
              };
            });
          }
        },
        controller.signal,
      );

      const assistantContent = get().chats[localId]?.messages.find((m) => m.id === asstId)?.content || "";
      set((s) => {
        const c = s.chats[localId];
        if (!c || !c.working) return s;
        return {
          chats: {
            ...s.chats,
            [localId]: { ...c, working: false, status: undefined },
          },
        };
      });
      const { cleaned, artifacts } = extractArtifacts(assistantContent, asstId);
      if (artifacts.length > 0) {
        for (const artifact of artifacts) {
          get().openArtifact(artifact);
          trackArtifactCreated(artifact.kind, artifact.content?.length);
        }
        set((s) => {
          const c = s.chats[localId];
          if (!c) return s;
          const msgs = c.messages.map((m) =>
            m.id === asstId
              ? {
                  ...m,
                  content: cleaned || (artifacts.length === 1 ? "Here's the artifact:" : "Here are the artifacts:"),
                }
              : m,
          );
          return {
            chats: {
              ...s.chats,
              [localId]: { ...c, messages: msgs },
            },
          };
        });
      } else if (artifactMode) {
        const assistantContent = get().chats[localId]?.messages.find((m) => m.id === asstId)?.content || "";
        if (inferredArtifactKind && assistantContent.trim()) {
          const title = userMsgText
            .replace(/^(create|write|draft|make|generate|build)\s+(a|an|the)?\s*/i, "")
            .replace(/\b(document|doc|table|sheet|spreadsheet|chart|graph|report|brief|note|summary)\b/i, "")
            .trim()
            .slice(0, 40) || {
              doc: "Document",
              sheet: "Sheet",
              graph: "Graph",
              code: "Code",
              diff: "Diff",
              preview: "Preview",
            }[inferredArtifactKind];
          const artifact: Artifact = {
            id: uid(),
            kind: inferredArtifactKind,
            title: title || "Artifact",
            content: sanitizeArtifactContent(assistantContent),
            createdAt: Date.now(),
            sourceMessageId: asstId,
          };
          if (artifact.kind === "sheet") {
            artifact.rows = assistantContent
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .map((line) => line.split("\t"));
          }
          if (artifact.kind === "graph" && assistantContent.startsWith("data:image/")) {
            artifact.src = assistantContent.trim();
          }
          get().openArtifact(artifact);
          trackArtifactCreated(artifact.kind, artifact.content?.length);
          set((s) => {
            const c = s.chats[localId];
            if (!c) return s;
            const msgs = c.messages.map((m) =>
              m.id === asstId
                ? {
                    ...m,
                    content: cleaned || "Here's the artifact:",
                  }
                : m,
            );
            return {
              chats: {
                ...s.chats,
                [localId]: { ...c, messages: msgs },
              },
            };
          });
        }
      }
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      if (!isAbort) {
        trackError("chat_error", String(e));
        set((s) => {
          const c = s.chats[localId];
          if (!c) return s;
          return {
            chats: {
              ...s.chats,
              [localId]: { ...c, working: false, status: undefined, error: String(e) },
            },
          };
        });
      }
    } finally {
      set({ _abort: null });
      // Refresh history so the new chat shows up in the sidebar.
      get().refreshChats();
    }
  },

  saveSettings: async (patch) => {
    const s = await api.putSettings(patch);
    set({ settings: s });
    setTelemetryEnabled(!!s.telemetry_enabled);
    await get().refreshProviders();
  },

  upsertCustomModel: async (m) => {
    await api.upsertCustomModel(m);
    await Promise.all([get().refreshProviders(), get().refreshSettings()]);
  },

  deleteCustomModel: async (id) => {
    await api.deleteCustomModel(id);
    await Promise.all([get().refreshProviders(), get().refreshSettings()]);
  },

  updateArtifact: (id, patch) => {
    set((s) => ({
      artifacts: s.artifacts.map((artifact) =>
        artifact.id === id ? { ...artifact, ...patch } : artifact,
      ),
    }));
  },
}));

export function bucketFor(ts: number): ChatBucket {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return "Today";
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (ts > weekAgo) return "This week";
  return "Earlier";
}
