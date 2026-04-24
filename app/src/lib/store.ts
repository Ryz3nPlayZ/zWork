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

export type Role = "user" | "assistant";

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** Tool calls / steps performed during this assistant turn. */
  activities?: Activity[];
}

export interface Activity {
  id: string;
  label: string;
  icon?: string;
  done: boolean;
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

export type View = "chat" | "settings" | "projects";

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
  return { cleaned, artifacts };
}

function inferArtifactKind(text: string): ArtifactKind | null {
  const t = text.toLowerCase();
  if (/(table|sheet|spreadsheet|csv|tsv|rows|columns)/.test(t)) return "sheet";
  if (/(chart|graph|plot|visualization|visualise|visualize)/.test(t)) return "graph";
  if (/(code snippet|script|runnable example|example code)/.test(t)) return "code";
  if (/(document|doc|brief|report|note|summary|outline|write a|draft a|make a document|create a document)/.test(t)) return "doc";
  return null;
}

function sanitizeArtifactContent(text: string): string {
  return text
    .replace(/^Created artifact:.*$/gim, "")
    .replace(/^Created a .* artifact in the sidebar\.$/gim, "")
    .replace(/`?\.sidecar\/[^`\s]+`?/g, "")
    .replace(/Created\s+\w+\s+artifact:?\s*/gim, "")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}

interface AppState {
  // UI
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (v: boolean) => void;
  view: View;
  setView: (v: View) => void;

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
      attachments?: Array<{
        client_id?: string | null;
        name: string;
        path: string;
        mime: string;
        kind: string;
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

export const useApp = create<AppState>((set, get) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  view: "chat",
  setView: (v) => set({ view: v }),

  providers: null,
  integrations: [],
  settings: null,
  chatSummaries: [],
  me: null,
  searchOpen: false,
  setSearchOpen: (v) => set({ searchOpen: v }),

  onboardingDone: null,
  setOnboardingDone: (v) => set({ onboardingDone: v }),

  model: "",
  setModel: (m) => set({ model: m }),
  webSearch: false,
  toggleWeb: () => set((s) => ({ webSearch: !s.webSearch })),

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
  artifactMode: true,
  setArtifactMode: (v) => set({ artifactMode: v }),

  refreshProjects: async () => {
    try {
      const { projects } = await api.listProjects();
      set({ projects });
    } catch { /* ignore */ }
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
    } catch { /* ignore */ }
  },

  saveMemory: async (content) => {
    await api.putMemory(content);
    set({ memoryContent: content });
  },

  refreshUserMd: async () => {
    try {
      const { content } = await api.getUserMd();
      set({ userMdContent: content });
    } catch { /* ignore */ }
  },

  saveUserMd: async (content) => {
    await api.putUserMd(content);
    set({ userMdContent: content });
  },

  bootstrap: async () => {
    await Promise.all([
      get().refreshProviders(),
      get().refreshSettings(),
      get().refreshIntegrations(),
      get().refreshChats(),
      get().refreshMe(),
      get().refreshProjects(),
      api
        .onboardStatus()
        .then((st) => set({ onboardingDone: !!st.completed }))
        .catch(() => set({ onboardingDone: true })),
    ]);
    // default model: backend default if not chosen, else first configured model
    if (!get().model) {
      const p = get().providers;
      const fallback =
        p?.default_model ||
        p?.models.find((m) => m.configured)?.id ||
        p?.models[0]?.id ||
        "";
      if (fallback) set({ model: fallback });
    }
  },

  refreshChats: async () => {
    try {
      const { chats } = await api.listChats();
      set({ chatSummaries: chats });
    } catch {
      /* ignore */
    }
  },

  refreshProviders: async () => {
    try {
      const p = await api.providers();
      set({ providers: p });
    } catch {
      /* ignore */
    }
  },

  refreshSettings: async () => {
    try {
      const s = await api.getSettings();
      set({ settings: s });
    } catch {
      /* ignore */
    }
  },

  refreshIntegrations: async () => {
    try {
      const { integrations } = await api.integrations();
      set({ integrations });
    } catch {
      /* ignore */
    }
  },

  refreshMe: async () => {
    try {
      const me = await api.me();
      set({ me });
    } catch {
      /* ignore */
    }
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
          }));
        set((s) => ({
          chats: {
            ...s.chats,
            [id]: {
              id,
              title: full.title,
              updatedAt: full.updated_at,
              messages,
              activities: [],
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
    } catch {
      /* ignore */
    }
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
    } catch {
      /* ignore */
    }
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
    if (p && !get().model) {
      const fallback = p.default_model
        || p.models.find((m) => m.configured)?.id
        || p.models[0]?.id
        || "";
      if (fallback) set({ model: fallback });
    }
    await get().send(last);
  },

  send: async (text, options) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const currentId = get().activeChatId;
    const model = get().model || get().providers?.default_model || "";
    const inferredArtifactKind = inferArtifactKind(trimmed);
    const artifactMode = (options?.artifactMode ?? get().artifactMode) || !!inferredArtifactKind;
    const attachments = options?.attachments ?? [];

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
      const { cleaned, artifacts } = extractArtifacts(assistantContent, asstId);
      if (artifacts.length > 0) {
        for (const artifact of artifacts) {
          get().openArtifact(artifact);
        }
        set((s) => {
          const c = s.chats[localId];
          if (!c) return s;
          const msgs = c.messages.map((m) =>
            m.id === asstId
              ? {
                  ...m,
                  content: cleaned || `Created ${artifacts.length} artifact${artifacts.length > 1 ? "s" : ""} in the sidebar.`,
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
          set((s) => {
            const c = s.chats[localId];
            if (!c) return s;
            const msgs = c.messages.map((m) =>
              m.id === asstId
                ? {
                    ...m,
                    content: cleaned || `Created a ${artifact.kind} artifact in the sidebar.`,
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
