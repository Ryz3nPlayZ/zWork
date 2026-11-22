import { create } from "zustand";
import {
  api,
  streamChat,
  IS_WEB,
  type ApiChatSummary,
  type ProvidersResponse,
  type SettingsPublic,
  type Integration,
  type ComposioStatus,
  type ComposioAccount,
  type ComposioApp,
  type CrewMember,
  type CrewMemberInput,
  type CustomModel,
  type MeResponse,
  type Project,
  type ScheduledTask,
  type InboxItem,
  type QueuedItem,
} from "./api";
import { fetchCloudSession, getCloudToken, logoutCloudSession, startDesktopGoogleSignIn } from "./cloud";
import { isDemoMode } from "./preview";
import { isMacOS } from "./platform";
import { invoke } from "@tauri-apps/api/core";
import { setTelemetryEnabled, trackError, recordTelemetry } from "./telemetry";
import {
  emitChatListChanged,
  registerWindowSync,
} from "./windowSync";

const LEGACY_MANAGED_BASE_URLS = new Set(["https://ollama.com/v1"]);
const LEGACY_MANAGED_MODEL_IDS = new Set([
  "ollama-minimax-m2-7-cloud",
  "zwork-managed-proxy",
  "minimax-m2.7:cloud",
  "zwork-vision",
  "zwork-ultimate",
  // Retired when the router went automatic.
  "zwork-flash",
  "zwork-pro",
  "zwork-ultra",
]);
const ROUTER_BASE_URL = "https://api.tryzwork.app/api";
/**
 * The hosted lineup: zWork picks the model for each task itself (cheap by
 * default, stronger when the task needs it); Apex is the strongest model.
 */
const HOSTED_MODELS = [
  { id: "zwork-auto", name: "zWork" },
  { id: "zwork-apex", name: "Apex" },
] as const;

async function upsertHostedModels() {
  for (const m of HOSTED_MODELS) {
    await api.upsertCustomModel({
      id: m.id,
      name: m.name,
      shape: "openai",
      credential: "zwork_router",
      model_id: m.id,
      base_url_override: ROUTER_BASE_URL,
    });
  }
}
const ONBOARDING_DONE_KEY = "zwork:onboarding-completed";
const LOGIN_START_KEY = "zwork:login-start-set";
const SECURITY_PRESET_KEY = "zwork:security-preset";
export type SecurityPreset = "ask" | "edit" | "plan" | "full";

const SECURITY_PRESET_META: Record<
  SecurityPreset,
  { autoApproveDestructive: boolean; planMode: boolean; webSearchEnabled: boolean }
> = {
  ask: { autoApproveDestructive: false, planMode: false, webSearchEnabled: false },
  edit: { autoApproveDestructive: true, planMode: false, webSearchEnabled: false },
  plan: { autoApproveDestructive: false, planMode: true, webSearchEnabled: false },
  full: { autoApproveDestructive: true, planMode: false, webSearchEnabled: true },
};

function loadSecurityPreset(): SecurityPreset {
  try {
    const v = localStorage.getItem(SECURITY_PRESET_KEY);
    if (v && v in SECURITY_PRESET_META) return v as SecurityPreset;
  } catch {}
  return "ask";
}

const INITIAL_PRESET = loadSecurityPreset();

/** Reasoning effort sent with each message; the router passes it upstream as
 *  `reasoning.effort`. Medium is the default: GLM otherwise thinks at max. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra" },
  { id: "max", label: "Max" },
];
const EFFORT_KEY = "zwork:effort";

function loadEffort(): Effort {
  try {
    const v = localStorage.getItem(EFFORT_KEY);
    if (v && EFFORTS.some((e) => e.id === v)) return v as Effort;
  } catch {}
  return "medium";
}

/** Set by Settings' "Redo onboarding": that run keeps the user's model and usage-stats choices. */
export const REDO_ONBOARDING_KEY = "zwork:redo-onboarding";

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

/**
 * Read whether zWork's OWN process holds the Accessibility grant — a separate
 * TCC identity from CuaDriver's. Used to detect the classic "granted to zWork,
 * not CuaDriver" trap: if zWork is trusted but the driver reports its grant is
 * missing, the user granted to the wrong app. Returns null off-Tauri or on
 * failure so the UI degrades gracefully (never blocks on this read).
 */
async function readZworkSelfTrusted(): Promise<boolean | null> {
  if (IS_WEB) return null;
  try {
    return await invoke<boolean>("ax_self_trusted");
  } catch {
    return null;
  }
}

export type Role = "user" | "assistant";

export interface Task {
  id: string;
  title: string;
  column: "inbox" | "todo" | "doing" | "done";
  created_at: number;
  updated_at: number;
  due_date: string | null;
  completed_at: number | null;
  description?: string;
  assignee?: string;
  priority?: "low" | "medium" | "high";
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  created_at: number;
  start_time: string | null;
  end_time: string | null;
}

export interface MessageAttachment {
  name: string;
  mime: string;
  kind: string;
  size?: number;
  previewUrl?: string;
  /** Uploaded file path and inline data, kept so an edit can re-send it. */
  path?: string;
  dataUrl?: string;
}

/** An uploaded file sent with a message. */
export interface SendAttachment {
  client_id?: string | null;
  name: string;
  path: string;
  data_url?: string;
  mime: string;
  kind: string;
  size?: number;
  previewUrl?: string;
}

/** A sent user message loaded into the composer for editing. */
export interface EditingMessage {
  chatId: string;
  messageId: string;
  text: string;
  attachments: MessageAttachment[];
}

/**
 * An ordered timeline segment of an assistant message. Replaces the old flat
 * `content: string` + side-channel `activities: Activity[]` model: the model
 * streams text, thinking, and tool calls interleaved, and we render each in
 * the order it actually occurred.
 *
 * Mirrors the structure every frontier harness (Goose, Claude Code, opencode)
 * uses for streamed turns — see `assistant_content_blocks` in the Rust agent
 * loop (`sidecar-rust/src/agent/mod.rs`).
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      /** Process narration: text the model speaks between tool calls ("Let me
       *  check that file…"). It is NOT the answer — a later tool call demotes
       *  the preceding text run to narration so the final answer (the trailing
       *  text run) stands alone. Rendered inside the process panel. */
      kind: "narration";
      text: string;
    }
  | {
      kind: "tool";
      id: string;
      tool: string;
      label: string;
      icon?: string;
      input?: unknown;
      result?: string;
      ok?: boolean;
      done: boolean;
      /** Set while a destructive-tool permission gate is awaiting the user's
       *  Allow/Deny decision. Carries the gate_id the backend is waiting on. */
      pendingGate?: { gateId: string; reason: string };
    }
  | {
      /** A user-facing recovery hint surfaced when automation failed due to a
       *  macOS permission problem (the classic "granted to zWork, not CuaDriver"
       *  trap). Rendered as a distinct amber card with an action button. */
      kind: "permission_recovery";
      id: string;
      /** Discriminator for the recovery type — currently "cuadriver_permissions". */
      recoveryKind: string;
      message: string;
    };

/**
 * Normalized token/cost usage for one assistant run. Built from either the
 * live `usage` SSE event (snake_case wire shape) or a persisted chat row
 * (camelCase harness Usage JSON).
 */
export interface MessageUsage {
  /** Prompt-side tokens, including cache reads/writes. */
  input: number;
  output: number;
  totalTokens: number;
  /** Present only when the model's pricing is known (non-zero). */
  costUsd?: number;
}

function usageFromWire(evt: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd?: number;
}): MessageUsage {
  return {
    input: evt.prompt_tokens,
    output: evt.completion_tokens,
    totalTokens: evt.total_tokens,
    costUsd: evt.cost_usd && evt.cost_usd > 0 ? evt.cost_usd : undefined,
  };
}

function usageFromRow(u: unknown): MessageUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const r = u as {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
    totalTokens?: number; cost?: { total?: number };
  };
  if (r.input == null && r.output == null && r.totalTokens == null) return undefined;
  const cost = r.cost?.total;
  return {
    input: (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0),
    output: r.output ?? 0,
    totalTokens: r.totalTokens ?? ((r.input ?? 0) + (r.output ?? 0)),
    costUsd: cost && cost > 0 ? cost : undefined,
  };
}

export interface Message {
  id: string;
  role: Role;
  /**
   * Ordered timeline segments. This is the source of truth for assistant
   * turns; user messages carry a single text part.
   */
  parts: MessagePart[];
  /**
   * Derived concatenation of all `text` parts, kept in sync so legacy
   * artifact-extraction / persistence / PATCH paths keep working. Prefer
   * `parts` for all new code and rendering.
   */
  content: string;
  createdAt: number;
  providerLabel?: string;
  resolvedModel?: string;
  upstreamProvider?: string;
  /** Token/cost usage for this assistant run (live event or reloaded row). */
  usage?: MessageUsage;
  /** @deprecated use parts[] — kept only for legacy migration / API shape. */
  activities?: Activity[];
  /** Files the user attached when sending this message. */
  attachments?: MessageAttachment[];
  feedback?: "bad" | "good";
}

/**
 * Coerce a backend message `content` value into a plain display string.
 *
 * New chats store content as a string, but chats written before the
 * content-shape fix stored Anthropic content blocks — a single `{type,text}`
 * object or an array of them. Rendering either as a React child throws
 * ("Minified React error #31: object with keys {text,type}"). This normalizes
 * every shape so those older chats still open instead of crashing the view.
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b: any) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Build an ordered `parts[]` timeline from any legacy message shape.
 *
 * - If `parts` already exists, it's returned as-is (new code path).
 * - Otherwise we fold the flat `content` string + side-channel `activities[]`
 *   into one text part followed by N tool parts. Old chats render correctly
 *   with no backend migration — tool calls lose their chronological position
 *   (they all appear after the text), but nothing crashes.
 */
export function normalizeToParts(msg: {
  parts?: MessagePart[];
  content?: unknown;
  activities?: Activity[];
}): MessagePart[] {
  if (Array.isArray(msg.parts) && msg.parts.length > 0) return msg.parts;
  const text = contentToText(msg.content);
  const parts: MessagePart[] = [];
  if (text.trim()) parts.push({ kind: "text", text });
  for (const a of msg.activities || []) {
    parts.push({
      kind: "tool",
      id: a.id,
      tool: a.tool ?? a.label,
      label: a.label,
      icon: a.icon,
      done: a.done,
      input: a.input,
      result: a.result,
      ok: a.ok,
    });
  }
  return parts;
}

/**
 * Concatenate the `text` parts of a timeline — the derived `content` value.
 */
export function partsToText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Immutable update: set `parts` on a message and re-derive `content`.
 */
export function withParts(m: Message, parts: MessagePart[]): Message {
  return { ...m, parts, content: partsToText(parts) };
}

/**
 * Append-or-merge helpers for the streaming reducer. Segments are bounded by
 * the events that interrupt them: a `delta` extends the trailing text part
 * (opening one if the last part isn't text); a `thinking_delta` extends a
 * thinking part; `tool_use`/`activity`/`tool_result` operate on tool parts.
 * This is what lets the renderer show interleaved text/thinking/tool calls in
 * the order they actually occurred — the core fix for the "one big blob" bug.
 */
export function appendTextPart(parts: MessagePart[], text: string): MessagePart[] {
  if (!text) return parts;
  const last = parts[parts.length - 1];
  if (last && last.kind === "text") {
    return [...parts.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...parts, { kind: "text", text }];
}

export function appendThinkingPart(parts: MessagePart[], text: string): MessagePart[] {
  if (!text) return parts;
  const last = parts[parts.length - 1];
  if (last && last.kind === "thinking") {
    return [...parts.slice(0, -1), { kind: "thinking", text: last.text + text }];
  }
  return [...parts, { kind: "thinking", text }];
}

/**
 * Reclassify the trailing run of text parts as process narration. Called when
 * a tool call opens: any text the model streamed before deciding to use a tool
 * is mid-process commentary ("middle thoughts"), not the final answer, so it
 * moves into the process panel and out of the response body. The answer is
 * whatever text streams after the LAST tool call of the run.
 */
export function demoteTrailingTextToNarration(parts: MessagePart[]): MessagePart[] {
  let end = parts.length;
  while (end > 0 && parts[end - 1].kind === "text") end -= 1;
  if (end === parts.length) return parts;
  return parts.map((p, i) => (i >= end && p.kind === "text" ? { kind: "narration" as const, text: p.text } : p));
}

/**
 * Replace all `text` parts with a single text part containing `newText`,
 * inserted at the position of the first text part. Used by artifact
 * extraction, which post-processes the concatenated answer text and writes
 * back the cleaned version. Non-text parts keep their relative order.
 */
export function replaceTextParts(parts: MessagePart[], newText: string): MessagePart[] {
  const firstTextIdx = parts.findIndex((p) => p.kind === "text");
  if (firstTextIdx < 0) {
    return newText.trim() ? [...parts, { kind: "text", text: newText }] : parts;
  }
  // Non-text parts before the first text part stay in place; the (single)
  // cleaned text part slots in at the first-text position; any non-text parts
  // that followed remain after it.
  const head: MessagePart[] = [];
  for (const p of parts.slice(0, firstTextIdx)) {
    if (p.kind !== "text") head.push(p);
  }
  const tail: MessagePart[] = [];
  let seenText = false;
  for (const p of parts.slice(firstTextIdx)) {
    if (p.kind === "text") { seenText = true; continue; }
    if (seenText) tail.push(p);
  }
  const result = [...head];
  if (newText.trim()) result.push({ kind: "text", text: newText });
  result.push(...tail);
  return result;
}

export interface Activity {
  id: string;
  label: string;
  icon?: string;
  done: boolean;
  /** Saved only for calls whose card needs them after a reload (generate_image). */
  tool?: string;
  input?: unknown;
  result?: string;
  ok?: boolean;
}

/**
 * Offline-cache schema version. Bump whenever the persisted Message shape
 * changes; readers compare against `localStorage["zwork:cache-version"]` and
 * drop stale caches rather than hydrating messages that would crash the view.
 * `v2` = the content→parts migration.
 */
export const CHAT_CACHE_VERSION = "v2";

/**
 * Read cached chats from localStorage, but only if the stored schema version
 * matches the current one. Returns null on mismatch (caller falls back to a
 * backend fetch).
 */
export function readCachedChats(): Record<string, Chat> | null {
  try {
    const version = localStorage.getItem("zwork:cache-version");
    if (version !== CHAT_CACHE_VERSION) return null;
    const raw = localStorage.getItem("zwork:cached-chats");
    if (!raw) return null;
    const allChats = JSON.parse(raw) as Record<string, Chat>;
    // Defensive: ensure every message has parts (normalize legacy entries).
    for (const chat of Object.values(allChats)) {
      if (!chat?.messages) continue;
      chat.messages = chat.messages.map((m) =>
        Array.isArray(m.parts) && m.parts.length > 0
          ? m
          : { ...m, parts: normalizeToParts({ content: m.content, activities: m.activities }) },
      );
    }
    return allChats;
  } catch {
    return null;
  }
}

/**
 * Derive sidebar summaries from in-memory chats. Used in web demo mode,
 * which has no backend chat persistence — the local store (kept alive across
 * refreshes via the localStorage cache) is the source of truth.
 */
function demoSummariesFromChats(chats: Record<string, Chat>): ApiChatSummary[] {
  return Object.values(chats)
    .filter((c) => c.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 40)
    .map((c) => {
      const lastTextMsg = [...c.messages].reverse().find((m) => m.content?.trim());
      return {
        id: c.id,
        title: c.title,
        created_at: c.messages[0]?.createdAt ?? c.updatedAt,
        updated_at: c.updatedAt,
        message_count: c.messages.length,
        model: "zwork-auto",
        kind: "chat",
        project_id: c.projectId ?? undefined,
        preview: lastTextMsg?.content?.slice(0, 140) ?? "",
      };
    });
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

/** A single agent-authored todo step, shown in the right-side Todo panel. */
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface AgentTodo {
  id: string;
  content: string;
  status: TodoStatus;
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
  /** Chat-scoped agent todo list + panel open state (driven by `todo_update` events). */
  todos?: AgentTodo[];
  todoPanelOpen?: boolean;
  pendingQuestion?: {
    questionId?: string;
    question: string;
    options: string[];
  } | null;
  projectId?: string | null;
  crewId?: string | null;
  /** Messages queued against the live run (steer / follow-up / next-run),
   *  rendered as chips in the composer. Authoritative copy comes from
   *  `queue` events on the stream. */
  queuedItems?: QueuedItem[];
}

export type View = "chat" | "settings" | "projects" | "analytics" | "plan" | "connectors" | "skills" | "admin" | "tasks" | "inbox" | "scheduled" | "crew";

export type SettingsSection =
  | "account"
  | "plan"
  | "general"
  | "memory"
  | "models"
  | "integrations";

export type ChatBucket = "Today" | "This week" | "Earlier";

/** Older replies wrapped documents in [[ARTIFACT …]]…[[/ARTIFACT]] tags for a
 *  sidebar that's gone; show what was inside them as ordinary text. */
function inlineArtifactTags(text: string): string {
  return text
    .replace(/\[\[(?:ARTIFACT|DOCUMENT)\s+[^\]]*\]\]([\s\S]*?)\[\[\/(?:ARTIFACT|DOCUMENT)\]\]/g, (_, body: string) => body.trim())
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prior turns of a chat as plain text, for the web app's stateless calls. */
function webHistory(chat: Chat | undefined): { role: "user" | "assistant"; content: string }[] {
  if (!chat) return [];
  return chat.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

function needsManagedRouterMigration(settings: SettingsPublic): boolean {
  const defaultModel = settings.default_model || "";
  const customModels = settings.custom_models || [];
  const hasOldRouter = customModels.some((model) => model.id === "zwork-router");
  const hasLegacyCustomModel = customModels.some((model) => LEGACY_MANAGED_MODEL_IDS.has(model.id) || LEGACY_MANAGED_MODEL_IDS.has(model.model_id));
  // Every tier exists, named and pointed at its alias over the OpenAI shape.
  const lineupStale = HOSTED_MODELS.some(({ id, name }) => {
    const m = customModels.find((c) => c.id === id);
    return !m || m.name !== name || m.model_id !== id || m.shape !== "openai" || m.credential !== "zwork_router";
  });

  return (
    LEGACY_MANAGED_BASE_URLS.has(settings.provider_config?.openai?.base_url || "") ||
    LEGACY_MANAGED_BASE_URLS.has(settings.provider_config?.zwork_router?.base_url || "") ||
    LEGACY_MANAGED_MODEL_IDS.has(defaultModel) ||
    hasLegacyCustomModel ||
    hasOldRouter ||
    lineupStale
  );
}

async function migrateManagedRouterSettings(settings: SettingsPublic): Promise<SettingsPublic> {
  const cloudToken = getCloudToken().trim();
  await api.putSettings({
    ...(cloudToken ? { api_keys: { zwork_router: cloudToken } } : {}),
    provider_config: {
      zwork_router: { base_url: ROUTER_BASE_URL },
    },
    default_model: "zwork-auto",
  });

  for (const model of settings.custom_models || []) {
    if (
      model.id === "zwork-router" ||
      LEGACY_MANAGED_MODEL_IDS.has(model.id) ||
      LEGACY_MANAGED_MODEL_IDS.has(model.model_id)
    ) {
      await api.deleteCustomModel(model.id);
    }
  }

  await upsertHostedModels();

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
  
  await upsertHostedModels();
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
  composioStatus: ComposioStatus | null;
  composioAccounts: ComposioAccount[];
  composioApps: ComposioApp[];
  settings: SettingsPublic | null;
  chatSummaries: ApiChatSummary[];
  me: MeResponse | null;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  keybindingsOpen: boolean;
  setKeybindingsOpen: (v: boolean) => void;

  // Onboarding UI state
  onboardingDone: boolean | null;
  setOnboardingDone: (v: boolean) => void;

  // Backend readiness
  backendReady: boolean;
  backendOffline: boolean;

  // Composer state
  model: string;
  setModel: (m: string) => void;
  webSearch: boolean;
  toggleWeb: () => void;
  focusChatInput: number;
  triggerFocusChatInput: () => void;
  /** An image pushed from the standalone Share Window picker (its own OS window)
   *  for the active ChatInput to consume as an attachment. ChatInput watches this
   *  and drains it via clearPendingShareImage once injected. Null when idle. */
  pendingShareImage: { dataUrl: string; mime: string; name?: string } | null;
  pushPendingShareImage: (img: { dataUrl: string; mime: string; name?: string }) => void;
  clearPendingShareImage: () => void;

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


  // Agent todo panel (chat-scoped, driven by `todo_update` events)
  closeTodoPanel: () => void;
  toggleTodoPanel: () => void;

  // Projects
  projects: Project[];
  activeProjectId: string | null;
  setActiveProject: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
  /** Creates the project and resolves to its id. */
  createProject: (name: string, description?: string, icon?: string) => Promise<string | undefined>;
  updateProject: (id: string, data: { name?: string; description?: string; starred?: boolean; icon?: string }) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  // Memory / user-md content (cached for settings editor)
  memoryContent: string;
  userMdContent: string;
  refreshMemory: () => Promise<void>;
  saveMemory: (content: string) => Promise<void>;
  refreshUserMd: () => Promise<void>;
  saveUserMd: (content: string) => Promise<void>;

  // Chat harness options
  planMode: boolean;
  setPlanMode: (v: boolean) => void;
  autoApproveDestructive: boolean;
  setAutoApproveDestructive: (v: boolean) => void;
  accessibilityPermissionGranted: boolean | null;
  screenRecordingPermissionGranted: boolean | null;
  /**
   * Whether the cua-driver daemon is reachable. The driver (CuaDriver.app,
   * identity com.trycua.driver) is what actually performs desktop control and
   * holds the TCC grants — so the two booleans above reflect ITS grants, and
   * driverOk distinguishes "permissions missing" from "driver not installed".
   */
  driverOk: boolean | null;
  /**
   * Ready-to-render message when the TCC grant looks mis-attributed — i.e. the
   * driver reports its grant missing while the permission check wasn't measured
   * against CuaDriver's identity. The classic "granted to zWork, not CuaDriver"
   * trap. null when the state is healthy or ambiguous.
   */
  wrongIdentityHint: string | null;
  /**
   * Whether zWork's OWN process holds the Accessibility grant (a separate TCC
   * identity from CuaDriver). Read via the Tauri host's `ax_self_trusted`
   * command. When true while `accessibilityPermissionGranted` is false, the UI
   * shows the wrong-identity banner — the user granted to zWork, not CuaDriver.
   */
  zworkSelfTrusted: boolean | null;
  checkMacOSPermissions: () => Promise<void>;
  requestAccessibility: () => Promise<void>;
  requestScreenRecording: () => Promise<void>;
  /** Whether the zbctl Chrome extension WebSocket is connected to the backend. */
  extensionConnected: boolean | null;
  checkBrowserBridge: () => Promise<void>;
  webSearchEnabled: boolean;
  setWebSearchEnabled: (v: boolean) => void;
  /** Security preset bundles auto-approve, plan-mode, and web-search toggles. */
  securityPreset: "ask" | "edit" | "plan" | "full";
  setSecurityPreset: (preset: "ask" | "edit" | "plan" | "full") => void;
  effort: Effort;
  setEffort: (effort: Effort) => void;

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
  refreshComposio: () => Promise<void>;
  connectComposioApp: (app: string) => Promise<void>;
  disconnectComposioApp: (app: string) => Promise<void>;
  setComposioConfig: (body: { enabled?: boolean; api_key?: string }) => Promise<void>;
  refreshMe: () => Promise<void>;

  openLanding: () => void;
  openChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  renameChat: (id: string, title: string) => Promise<void>;
  answerQuestion: (chatId: string, answer: string) => Promise<void>;
  /** Resolve a pending destructive-tool permission gate (Allow / Deny). */
  resolveGate: (chatId: string, messageId: string, gateId: string, allow: boolean) => Promise<void>;

  send: (
    text: string,
    options?: {
      planMode?: boolean;
      autoApproveDestructive?: boolean;
      attachments?: SendAttachment[];
      /** Re-attach to the chat's run that is still going (after a reload); `text` is ignored. */
      resume?: boolean;
    },
  ) => Promise<void>;
  retry: () => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  flagBadResponse: (messageId: string) => void;
  /** The sent message the composer is editing, if any. */
  editing: EditingMessage | null;
  /** Load a sent user message into the composer for editing. */
  startEditMessage: (messageId: string) => void;
  cancelEditMessage: () => void;
  /** Edit a previously sent user message: drop it and everything after it
   *  (in the chat and the model's history), then run the edited text fresh. */
  editAndResend: (
    messageId: string,
    newText: string,
    attachments?: SendAttachment[],
  ) => Promise<void>;
  /** Fork the active chat at a message — ancestry copies into a new chat, which opens. */
  forkFromMessage: (messageId: string, before?: boolean) => Promise<void>;
  /** Restore a parked rewind branch as the active tail (current tail is parked in turn). */
  restoreBranch: (branchId: string) => Promise<void>;
  /** Permanently discard a parked rewind branch. */
  deleteBranch: (branchId: string) => Promise<void>;
  stop: () => void;

  /** Send while a run is live: queues the message against the run instead of
   *  starting a new one. `kind` picks the semantics — steer joins the
   *  in-flight context at its next checkpoint; follow_up drives a next run
   *  when this one finishes; next_run queues a whole additional run. If the
   *  race is lost (run finished first), falls back to a normal send. */
  sendWhileBusy: (text: string, kind?: QueuedItem["kind"]) => Promise<void>;
  /** Cancel one queued message (composer chip ×). Consumed items are left
   *  alone — the run already took them. */
  cancelQueued: (entryId: string) => Promise<void>;
  /** Set steering / follow-up queue modes ("all" | "one-at-a-time"). */
  setQueueModes: (modes: { steering?: "all" | "one-at-a-time"; followUp?: "all" | "one-at-a-time" }) => Promise<void>;
  /** Composer draft pushed from the store (Stop returning unconsumed queued
   *  messages back to the composer). ChatInput consumes + clears it. */
  draftInject: { chatId: string; text: string; nonce: number } | null;
  /** First job picked in onboarding; the home screen puts it in the composer once. */
  starterDraft: string;
  clearDraftInject: () => void;

  saveSettings: (patch: Partial<SettingsPublic> & { api_keys?: Record<string, string> }) => Promise<void>;
  upsertCustomModel: (m: Omit<CustomModel, "id"> & { id?: string }) => Promise<void>;
  deleteCustomModel: (id: string) => Promise<void>;

  // Tasks & Calendar
  tasks: Task[];
  events: CalendarEvent[];
  fetchTasks: () => Promise<void>;
  addTask: (title: string, column: Task["column"], due_date?: string | null, description?: string, assignee?: string, priority?: string) => Promise<void>;
  updateTask: (id: string, title: string, column: Task["column"], due_date?: string | null, description?: string, assignee?: string, priority?: string) => Promise<void>;
  updateTaskColumn: (id: string, column: Task["column"]) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  fetchEvents: () => Promise<void>;
  addEvent: (title: string, date: string, start_time?: string | null, end_time?: string | null) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;

  // Crew
  crew: CrewMember[];
  crewLoading: boolean;
  crewError: string | null;
  newChatCrewId: string;
  fetchCrew: () => Promise<void>;
  createCrew: (body: CrewMemberInput) => Promise<CrewMember>;
  updateCrew: (id: string, body: CrewMemberInput) => Promise<CrewMember>;
  deleteCrew: (id: string) => Promise<void>;
  setChatCrew: (crewId: string) => Promise<void>;

  // Scheduled Tasks + Inbox
  scheduledTasks: ScheduledTask[];
  inboxItems: InboxItem[];
  inboxUnreadCount: number;
  fetchSchedules: () => Promise<void>;
  createSchedule: (body: {
    title: string;
    prompt: string;
    interval_minutes?: number;
    daily_time?: string;
    daily_weekdays?: number[];
    enabled?: boolean;
    crew_id?: string;
  }) => Promise<{ error?: string } | undefined>;
  updateSchedule: (
    id: string,
    body: Partial<{
      title: string;
      prompt: string;
      interval_minutes: number | null;
      daily_time: string | null;
      daily_weekdays: number[] | null;
      enabled: boolean;
      crew_id: string;
    }>,
  ) => Promise<void>;
  deleteSchedule: (id: string) => Promise<void>;
  runScheduleNow: (id: string) => Promise<void>;
  fetchInbox: (unreadOnly?: boolean) => Promise<void>;
  markInboxRead: (id: string) => Promise<void>;
  markAllInboxRead: () => Promise<void>;
  deleteInboxItem: (id: string) => Promise<void>;
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

const SIDEBAR_OPEN_KEY = "zwork:sidebar-open";

function loadSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  const v = window.localStorage.getItem(SIDEBAR_OPEN_KEY);
  if (v === null) return true;
  return v === "true";
}

export const useApp = create<AppState>((set, get) => ({
  sidebarOpen: loadSidebarOpen(),
  toggleSidebar: () => {
    const next = !get().sidebarOpen;
    try { window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(next)); } catch {}
    set({ sidebarOpen: next });
  },
  setSidebarOpen: (v) => {
    try { window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(v)); } catch {}
    set({ sidebarOpen: v });
  },
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
    // Backstop: the desktop flow below calls Tauri invoke(), which doesn't
    // exist in a browser. Web callers must route through the browser OAuth
    // flow (see isWebAuthClient/startWebGoogleSignIn in cloud.ts) before
    // reaching this action.
    if (IS_WEB) {
      set({ isLoadingAuth: false });
      throw new Error("Web sign-in must use the browser Google OAuth flow.");
    }
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
  composioStatus: null,
  composioAccounts: [],
  composioApps: [],
  settings: null,
  chatSummaries: [],
  me: null,
  searchOpen: false,
  setSearchOpen: (v) => set({ searchOpen: v }),
  keybindingsOpen: false,
  setKeybindingsOpen: (v) => set({ keybindingsOpen: v }),

  // Tasks
  tasks: [],
  events: [],

  // Crew
  crew: [],
  crewLoading: false,
  crewError: null,
  newChatCrewId: "",

  // Scheduled Tasks + Inbox
  scheduledTasks: [],
  inboxItems: [],
  inboxUnreadCount: 0,

  onboardingDone: hasCompletedOnboardingLocally() ? true : null,
  setOnboardingDone: (v) => {
    rememberOnboardingDone(v);
    set({ onboardingDone: v });
  },

  backendReady: false,
  backendOffline: false,

  model: "",
  setModel: (m) => set({ model: m }),
  webSearch: false,
  toggleWeb: () => set((s) => ({ webSearch: !s.webSearch })),
  focusChatInput: 0,
  triggerFocusChatInput: () => set((s) => ({ focusChatInput: s.focusChatInput + 1 })),
  pendingShareImage: null,
  pushPendingShareImage: (img) => set({ pendingShareImage: img }),
  clearPendingShareImage: () => set({ pendingShareImage: null }),

  chats: {},
  activeChatId: null,
  _abort: null,
  draftInject: null,
  editing: null,
  starterDraft: "",
  clearDraftInject: () => set({ draftInject: null }),

  closeTodoPanel: () =>
    set((s) => {
      const chatId = s.activeChatId;
      if (!chatId) return s;
      const chat = s.chats[chatId];
      if (!chat) return s;
      return {
        chats: {
          ...s.chats,
          [chatId]: { ...chat, todoPanelOpen: false },
        },
      };
    }),
  toggleTodoPanel: () =>
    set((s) => {
      const chatId = s.activeChatId;
      if (!chatId) return s;
      const chat = s.chats[chatId];
      if (!chat) return s;
      return {
        chats: {
          ...s.chats,
          [chatId]: { ...chat, todoPanelOpen: !chat.todoPanelOpen },
        },
      };
    }),
  projects: [],
  activeProjectId: null,
  setActiveProject: (id) => set({ activeProjectId: id }),
  memoryContent: "",
  userMdContent: "",

  // Chat harness options
  planMode: SECURITY_PRESET_META[INITIAL_PRESET].planMode,
  setPlanMode: (v) => set({ planMode: v }),
  autoApproveDestructive: SECURITY_PRESET_META[INITIAL_PRESET].autoApproveDestructive,
  setAutoApproveDestructive: (v) => set({ autoApproveDestructive: v }),
  accessibilityPermissionGranted: null,
  screenRecordingPermissionGranted: null,
  driverOk: null,
  wrongIdentityHint: null,
  zworkSelfTrusted: null,
  extensionConnected: null,
  webSearchEnabled: SECURITY_PRESET_META[INITIAL_PRESET].webSearchEnabled,
  setWebSearchEnabled: (v) => set({ webSearchEnabled: v }),
  effort: loadEffort(),
  setEffort: (effort) => {
    try {
      localStorage.setItem(EFFORT_KEY, effort);
    } catch {}
    set({ effort });
  },
  securityPreset: INITIAL_PRESET,
  setSecurityPreset: (preset) => {
    try {
      localStorage.setItem(SECURITY_PRESET_KEY, preset);
    } catch {}
    const meta = SECURITY_PRESET_META[preset];
    set({
      securityPreset: preset,
      autoApproveDestructive: meta.autoApproveDestructive,
      planMode: meta.planMode,
      webSearchEnabled: meta.webSearchEnabled,
    });
  },

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

  checkMacOSPermissions: async () => {
    if (IS_WEB || !isMacOS()) return;
    try {
      // Source of truth = the cua-driver daemon's identity (com.trycua.driver),
      // not zWork's own — the driver is what actually performs the AX work.
      const [st, selfTrusted] = await Promise.all([
        api.desktopStatus(),
        readZworkSelfTrusted(),
      ]);
      set({
        driverOk: st.driver_ok,
        accessibilityPermissionGranted: st.accessibility,
        screenRecordingPermissionGranted: st.screen_recording,
        wrongIdentityHint: st.wrong_identity_hint ?? null,
        zworkSelfTrusted: selfTrusted,
      });
    } catch (e) {
      // Backend itself unreachable — distinct from driver-not-installed.
      console.error("Failed to check driver permissions:", e);
      set({ driverOk: false });
    }
  },
  requestAccessibility: async () => {
    if (IS_WEB) return;
    try {
      // Two-pronged: ask the driver to raise its TCC prompt (the correct
      // attribution path) AND deep-link to the Accessibility pane, because
      // macOS does not reliably re-show a driver-attributed AX prompt after
      // the first launch — without the deep-link, the button could appear to
      // do nothing. The user lands in System Settings either way and can
      // toggle CuaDriver on manually.
      const { invoke } = await import("@tauri-apps/api/core");
      const [st, selfTrusted] = await Promise.all([
        api.desktopGrant(),
        readZworkSelfTrusted(),
        invoke("open_macos_privacy_pane", { pane: "accessibility" }).catch(() => {}),
      ]);
      set({
        driverOk: st.driver_ok,
        accessibilityPermissionGranted: st.accessibility,
        screenRecordingPermissionGranted: st.screen_recording,
        wrongIdentityHint: st.wrong_identity_hint ?? null,
        zworkSelfTrusted: selfTrusted,
      });
    } catch (e) {
      console.error("Failed to grant driver permissions:", e);
    }
  },
  requestScreenRecording: async () => {
    if (IS_WEB) return;
    // Screen Recording can't be reliably raised by the driver's grant flow
    // (it tends to surface the Accessibility prompt), and current desktop
    // capture is AX-only so it isn't even required. Deep-link the user to the
    // Screen Recording pane to toggle CuaDriver on, then re-poll.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_macos_privacy_pane", { pane: "screen_recording" });
      setTimeout(() => {
        get().checkMacOSPermissions().catch(() => {});
      }, 1500);
    } catch (e) {
      console.error("Failed to open Screen Recording settings:", e);
    }
  },

  checkBrowserBridge: async () => {
    if (IS_WEB) return;
    try {
      const st = await api.browserBridgeStatus();
      set({ extensionConnected: st.connected });
    } catch (e) {
      console.error("Failed to check browser bridge:", e);
      set({ extensionConnected: false });
    }
  },

  refreshProjects: async () => {
    try {
      const { projects } = await api.listProjects();
      set({ projects });
    } catch (e) { console.warn("refreshProjects failed:", e) }
  },

  createProject: async (name, description, icon) => {
    const res = await api.createProject(name, description, icon);
    await get().refreshProjects();
    return res.project?.id;
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

  fetchTasks: async () => {
    try {
      const { tasks } = await api.listTasks();
      set({ tasks });
    } catch (e) { console.warn("fetchTasks failed:", e); }
  },

  addTask: async (title, column, due_date, description, assignee, priority) => {
    try {
      const { task } = await api.createTask({ title, column, due_date, description, assignee, priority });
      set((s) => ({ tasks: [...s.tasks, task] }));
    } catch (e) { console.warn("addTask failed:", e); }
  },

  updateTask: async (id, title, column, due_date, description, assignee, priority) => {
    try {
      const { task } = await api.updateTask(id, { title, column, due_date, description, assignee, priority });
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? task : t)),
      }));
    } catch (e) { console.warn("updateTask failed:", e); }
  },

  updateTaskColumn: async (id, column) => {
    try {
      // Optimistic update
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, column } : t)),
      }));
      await api.updateTaskColumn(id, column);
    } catch (e) {
      console.warn("updateTaskColumn failed, reverting:", e);
      await get().fetchTasks();
    }
  },

  deleteTask: async (id) => {
    try {
      await api.deleteTask(id);
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    } catch (e) { console.warn("deleteTask failed:", e); }
  },

  fetchEvents: async () => {
    try {
      const { events } = await api.listEvents();
      set({ events });
    } catch (e) { console.warn("fetchEvents failed:", e); }
  },

  addEvent: async (title, date, start_time, end_time) => {
    try {
      const { event } = await api.createEvent({ title, date, start_time, end_time });
      set((s) => ({ events: [...s.events, event] }));
    } catch (e) { console.warn("addEvent failed:", e); }
  },

  deleteEvent: async (id) => {
    try {
      await api.deleteEvent(id);
      set((s) => ({ events: s.events.filter((e) => e.id !== id) }));
    } catch (e) { console.warn("deleteEvent failed:", e); }
  },

  fetchCrew: async () => {
    set({ crewLoading: true, crewError: null });
    try {
      const crew = await api.listCrew();
      set({ crew, crewLoading: false });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Couldn't load your crew.";
      set({ crewError: message, crewLoading: false });
    }
  },

  createCrew: async (body) => {
    const member = await api.createCrew(body);
    set((s) => ({ crew: [...s.crew, member] }));
    return member;
  },

  updateCrew: async (id, body) => {
    const member = await api.updateCrew(id, body);
    set((s) => ({ crew: s.crew.map((m) => (m.id === id ? member : m)) }));
    return member;
  },

  deleteCrew: async (id) => {
    await api.deleteCrew(id);
    set((s) => ({
      crew: s.crew.filter((m) => m.id !== id),
      newChatCrewId: s.newChatCrewId === id ? "" : s.newChatCrewId,
    }));
  },

  setChatCrew: async (crewId) => {
    const id = get().activeChatId;
    if (!id || id.startsWith("tmp_")) {
      set({ newChatCrewId: crewId });
      return;
    }
    const previous = get().chats[id]?.crewId ?? "";
    set((s) => ({
      chats: s.chats[id] ? { ...s.chats, [id]: { ...s.chats[id], crewId } } : s.chats,
      chatSummaries: s.chatSummaries.map((c) => (c.id === id ? { ...c, crew_id: crewId } : c)),
    }));
    try {
      await api.setChatCrew(id, crewId);
    } catch (e) {
      set((s) => ({
        chats: s.chats[id] ? { ...s.chats, [id]: { ...s.chats[id], crewId: previous } } : s.chats,
        chatSummaries: s.chatSummaries.map((c) => (c.id === id ? { ...c, crew_id: previous } : c)),
      }));
      throw e;
    }
  },

  // ─── Scheduled Tasks + Inbox ──────────────────────────────────────────────

  fetchSchedules: async () => {
    try {
      const { tasks } = await api.listSchedules();
      set({ scheduledTasks: tasks });
      // A schedule can't run if zWork isn't open, so the first one turns on
      // open-at-login, once. The switch on the Scheduled page turns it off for good.
      if (tasks.length > 0 && !localStorage.getItem(LOGIN_START_KEY)) {
        localStorage.setItem(LOGIN_START_KEY, "1");
        await api.setLaunchAtLogin(true);
      }
    } catch (e) { console.warn("fetchSchedules failed:", e); }
  },

  createSchedule: async (body) => {
    try {
      const res = await api.createSchedule(body);
      if (res.error) return { error: res.error };
      await get().fetchSchedules();
    } catch (e) {
      console.warn("createSchedule failed:", e);
      return { error: e instanceof Error ? e.message : "Failed to create task" };
    }
  },

  updateSchedule: async (id, body) => {
    try {
      await api.updateSchedule(id, body);
      await get().fetchSchedules();
    } catch (e) { console.warn("updateSchedule failed:", e); }
  },

  deleteSchedule: async (id) => {
    try {
      await api.deleteSchedule(id);
      set((s) => ({ scheduledTasks: s.scheduledTasks.filter((t) => t.id !== id) }));
    } catch (e) { console.warn("deleteSchedule failed:", e); }
  },

  runScheduleNow: async (id) => {
    try {
      await api.runScheduleNow(id);
    } catch (e) { console.warn("runScheduleNow failed:", e); }
  },

  fetchInbox: async (unreadOnly) => {
    try {
      const { items, unread_count } = await api.listInbox(unreadOnly);
      set({ inboxItems: items, inboxUnreadCount: unread_count });
    } catch (e) { console.warn("fetchInbox failed:", e); }
  },

  markInboxRead: async (id) => {
    try {
      await api.markInboxRead(id);
      set((s) => ({
        inboxItems: s.inboxItems.map((i) => (i.id === id ? { ...i, read: true } : i)),
        inboxUnreadCount: Math.max(0, s.inboxUnreadCount - 1),
      }));
    } catch (e) { console.warn("markInboxRead failed:", e); }
  },

  markAllInboxRead: async () => {
    try {
      await api.markAllInboxRead();
      set((s) => ({
        inboxItems: s.inboxItems.map((i) => ({ ...i, read: true })),
        inboxUnreadCount: 0,
      }));
    } catch (e) { console.warn("markAllInboxRead failed:", e); }
  },

  deleteInboxItem: async (id) => {
    try {
      await api.deleteInboxItem(id);
      set((s) => ({ inboxItems: s.inboxItems.filter((i) => i.id !== id) }));
    } catch (e) { console.warn("deleteInboxItem failed:", e); }
  },

  bootstrap: async () => {
    // Web mode: skip local sidecar entirely
    if (IS_WEB) {
      try {
        const cloudUser = await fetchCloudSession();
        if (cloudUser) {
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

      // Mark onboarding done in web (no local sidecar)
      rememberOnboardingDone(true);

      // The web app runs the auto router only; Apex needs the desktop app.
      const webProviders: ProvidersResponse = {
        credentials: {},
        default_model: "zwork-auto",
        models: [
          {
            id: "zwork-auto",
            name: "zWork",
            subtitle: "Picks the right model for each task",
            shape: "openai",
            credential: "managed",
            model_id: "zwork-auto",
            configured: true,
            synthesized: false,
          },
        ],
      };

      set({ onboardingDone: true, model: "zwork-auto", providers: webProviders, backendReady: true });

      if (isDemoMode()) {
        // Anonymous demo: hydrate previously-cached demo chats so the session
        // survives a refresh. The offline-cache subscriber doubles as the
        // demo's persistence layer (demo mode has no backend chat store).
        const cachedChats = readCachedChats();
        if (cachedChats) {
          set({
            chats: cachedChats,
            chatSummaries: demoSummariesFromChats(cachedChats),
          });
        }
      } else {
        // Signed-in web: load the server-side chat list so the sidebar
        // populates on first paint, not only after the first send.
        await get().refreshChats().catch(() => {});
      }
      return;
    }

    // Wait for the backend to be fully healthy before loading any data.
    // The Rust side already spawned the backend; this polls until it responds.
    try {
      await api.waitForBackend(60);
      set({ backendReady: true, backendOffline: false });
    } catch (e) {
      console.warn("Backend failed to start. Running in offline fallback mode.");
      set({ backendReady: true, backendOffline: true });
    }

    if (get().backendOffline) {
      set({ onboardingDone: hasCompletedOnboardingLocally() ? true : false });
      try {
        const cachedSummaries = localStorage.getItem("zwork:cached-summaries");
        if (cachedSummaries) {
          set({ chatSummaries: JSON.parse(cachedSummaries) });
        }
        const cachedChats = readCachedChats();
        if (cachedChats) {
          set({ chats: cachedChats });
        }
      } catch (err) {
        console.warn("Failed to load cached offline data:", err);
      }
      return;
    }

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
      get().refreshComposio(),
      get().refreshChats(),
      get().refreshMe(),
      get().refreshProjects(),
      get().fetchCrew(),
      get().checkMacOSPermissions().catch(() => {}),
      // Inbox + Scheduled are polled by their own pages, but we also seed them
      // at bootstrap so the Inbox unread badge and the Scheduled sidebar state
      // are correct from first paint instead of going stale until opened.
      get().fetchInbox().catch(() => {}),
      get().fetchSchedules().catch(() => {}),
      get().fetchTasks().catch(() => {}),
      get().fetchEvents().catch(() => {}),
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
          } else {
            set({ onboardingDone: false });
          }
        }),
    ]);
    const fallback = pickAvailableModel(get().providers, get().model);
    if (fallback !== get().model) set({ model: fallback });
  },

  refreshChats: async () => {
    // Demo mode: no server-side chat persistence. History lives in the local
    // store (hydrated from the localStorage cache at bootstrap) — derive the
    // sidebar list from it so new/deleted/renamed demo chats show up.
    if (isDemoMode()) {
      set({ chatSummaries: demoSummariesFromChats(get().chats) });
      return;
    }
    if (get().backendOffline) {
      const cached = localStorage.getItem("zwork:cached-summaries");
      if (cached) set({ chatSummaries: JSON.parse(cached) });
      return;
    }
    try {
      const { chats } = await api.listChats();
      // Filter out automation chats (scheduled-task runs) — they surface inside
      // the scheduled task's run history, not in the main chat list.
      const visible = chats.filter((c) => c.kind !== "automation");
      set({ chatSummaries: visible, backendOffline: false });
    } catch (e) {
      console.warn("refreshChats failed:", e);
      // The offline banner is about the desktop's local backend.
      if (!IS_WEB) set({ backendOffline: true });
      const cached = localStorage.getItem("zwork:cached-summaries");
      if (cached) set({ chatSummaries: JSON.parse(cached) });
    }
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

  refreshComposio: async () => {
    // Always ensure the static app list is present so the Connectors grid renders
    const STATIC_APPS = [
      { id: "gmail",          name: "Gmail",           color: "#EA4335", icon: null },
      { id: "googlecalendar", name: "Google Calendar", color: "#4285F4", icon: null },
      { id: "outlook",        name: "Outlook",         color: "#0078D4", icon: null },
      { id: "googledrive",    name: "Google Drive",    color: "#34A853", icon: null },
      { id: "one_drive",      name: "OneDrive",        color: "#0078D4", icon: null },
      { id: "excel",          name: "Excel",           color: "#217346", icon: null },
      { id: "notion",         name: "Notion",          color: "#000000", icon: null },
    ];
    // Seed immediately so grid doesn't flash empty
    if (get().composioApps.length === 0) {
      set({ composioApps: STATIC_APPS });
    }
    try {
      const [status, accounts, apps] = await Promise.all([
        api.composioStatus().catch(() => null),
        api.composioAccounts().catch(() => ({ accounts: [] })),
        api.composioApps().catch(() => null), // null = don't overwrite on failure
      ]);
      set({
        composioStatus: status,
        composioAccounts: accounts.accounts,
        // Only update apps if the call succeeded and returned a non-empty list
        ...(apps && apps.apps && apps.apps.length > 0
          ? { composioApps: apps.apps }
          : {}),
      });
    } catch (e) { console.warn("refreshComposio failed:", e) }
  },

  connectComposioApp: async (app: string) => {
    // Desktop-only: the public web demo has no Connectors UI, but guard the
    // action so it can't be reached via devtools/console in demo mode.
    if (isDemoMode()) return;
    const { url } = await api.composioConnect(app);
    await invoke("open_external", { url });
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const { accounts } = await api.composioAccounts();
        const connected = accounts.some((a) => a.app === app && a.status === "ACTIVE");
        if (connected || attempts > 40) {
          clearInterval(poll);
          await get().refreshComposio();
        }
      } catch { /* keep polling */ }
    }, 3000);
  },

  disconnectComposioApp: async (app: string) => {
    try {
      await api.composioDisconnect(app);
      await get().refreshComposio();
    } catch (e) { console.warn("disconnectComposioApp failed:", e) }
  },

  setComposioConfig: async (body: { enabled?: boolean; api_key?: string }) => {
    try {
      await api.composioSetConfig(body);
      await get().refreshComposio();
    } catch (e) { console.warn("setComposioConfig failed:", e) }
  },

  refreshMe: async () => {
    try {
      const me = await api.me();
      set({ me });
    } catch (e) { console.warn("refreshMe failed:", e) }
  },

  openLanding: () => set({ activeChatId: null, view: "chat", activeProjectId: null, newChatCrewId: "" }),

  openChat: async (id) => {
    const existing = get().chats[id];
    const projectId = existing?.projectId || null;
    set({
      activeChatId: id,
      view: "chat",
      activeProjectId: projectId,
    });
    if (get().backendOffline) {
      const allChats = readCachedChats();
      if (allChats && allChats[id]) {
        set((s) => ({
          activeProjectId: allChats[id].projectId || null,
          chats: {
            ...s.chats,
            [id]: allChats[id],
          }
        }));
        return;
      }
    }
    // Fetch full chat lazily
    if (!get().chats[id]) {
      try {
        const full = await api.getChat(id);
        const messages: Message[] = full.messages
          .filter((m) => m.role !== "system")
          .map((m) => {
            const activities = m.activities || [];
            const parts = normalizeToParts({
              content: m.content,
              activities,
            });
            return {
              id: m.id,
              role: m.role as Role,
              content: contentToText(m.content),
              parts,
              createdAt: m.created_at,
              activities,
              usage: usageFromRow((m as { usage?: unknown }).usage),
            } as Message;
          });
        const latestActivities = [...messages].reverse().find((m) => m.role === "assistant" && (m.activities || []).length > 0)?.activities || [];
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          if (m.role === "assistant" && /\[\[(ARTIFACT|DOCUMENT)\s/.test(m.content)) {
            messages[i] = withParts(m, replaceTextParts(m.parts, inlineArtifactTags(m.content)));
          }
        }
        const fetchedProjectId = (full as any).project_id || null;
        // A run that failed before its answer leaves a reply with no text;
        // say so instead of showing a blank bubble.
        const last = messages[messages.length - 1];
        const unfinished = !full.running && last?.role === "assistant" && !last.content.trim();
        set((s) => ({
          activeProjectId: fetchedProjectId,
          view: "chat",
          chats: {
            ...s.chats,
            [id]: {
              id,
              title: full.title,
              updatedAt: full.updated_at,
              messages,
              activities: latestActivities,
              projectId: fetchedProjectId,
              crewId: full.crew_id || null,
              error: unfinished ? "This reply didn't finish. Send your message again to retry." : undefined,
            },
          },
        }));
        // The run outlived a reload or a closed window: show it working and keep streaming it.
        if (full.running && get().activeChatId === id) void get().send("", { resume: true });
      } catch (e) {
        // Fallback to cache if available
        const allChats = readCachedChats();
        if (allChats && allChats[id]) {
          set((s) => ({
            activeProjectId: allChats[id].projectId || null,
            chats: {
              ...s.chats,
              [id]: allChats[id],
            }
          }));
          return;
        }
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
    const wasActive = get().activeChatId === id;
    set((s) => {
      const { [id]: _, ...rest } = s.chats;
      void _;
      return {
        chats: rest,
        activeChatId: wasActive ? null : s.activeChatId,
      };
    });
    await get().refreshChats();
    void emitChatListChanged();
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
    void emitChatListChanged();
  },

  answerQuestion: async (chatId, answer) => {
    const questionId = get().chats[chatId]?.pendingQuestion?.questionId;
    set((s) => {
      const c = s.chats[chatId];
      if (!c) return {};
      return {
        chats: {
          ...s.chats,
          [chatId]: { ...c, pendingQuestion: null },
        },
      };
    });
    try {
      await api.answerQuestion(chatId, answer, questionId);
    } catch (e) {
      console.warn("answerQuestion failed:", e);
    }
  },

  resolveGate: async (chatId, messageId, gateId, allow) => {
    // Optimistically clear the gate on the tool part so the UI flips out of
    // the "awaiting decision" state immediately; the backend resolves the
    // gate's oneshot and either runs or aborts the tool, which drives the
    // subsequent tool_result event that sets ok/done.
    set((s) => {
      const c = s.chats[chatId];
      if (!c) return s;
      const msgs = c.messages.map((m) => {
        if (m.id !== messageId) return m;
        const parts = m.parts.map((p) =>
          p.kind === "tool" && p.pendingGate?.gateId === gateId
            ? { ...p, pendingGate: undefined }
            : p,
        );
        return { ...m, parts };
      });
      return { chats: { ...s.chats, [chatId]: { ...c, messages: msgs } } };
    });
    try {
      if (allow) await api.approveGate(chatId, gateId);
      else await api.rejectGate(chatId, gateId);
    } catch (e) {
      console.warn("resolveGate failed:", e);
    }
  },

  stop: async () => {
    const id = get().activeChatId;
    // Unconsumed steer / follow-up texts come back so the composer can
    // restore them — stopping shouldn't eat what the user queued.
    let restore: string[] = [];
    if (id && !id.startsWith("tmp_")) {
      try {
        const res = await api.stopChat(id);
        restore = [...(res.steer ?? []), ...(res.follow_up ?? [])];
      } catch (e) {
        console.warn("stopChat failed:", e);
      }
    }
    get()._abort?.abort();
    set((s) => {
      const activeId = s.activeChatId;
      if (!activeId) return { _abort: null };
      const c = s.chats[activeId];
      if (!c) return { _abort: null };
      return {
        _abort: null,
        chats: {
          ...s.chats,
          [activeId]: { ...c, working: false, status: undefined, queuedItems: [] },
        },
        ...(restore.length
          ? { draftInject: { chatId: activeId, text: restore.join("\n\n"), nonce: Date.now() } }
          : {}),
      };
    });
  },

  sendWhileBusy: async (text, kind = "follow_up") => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = get().activeChatId;
    if (!id || id.startsWith("tmp_")) return; // no server chat → no live run to queue against
    const call = kind === "steer" ? api.steerChat : kind === "next_run" ? api.queueNextRun : api.queueFollowUp;
    try {
      const res = await call(id, trimmed);
      if (!res.queued) {
        // Race lost: the run finished between typing and sending. A normal
        // send is exactly what the user meant. (Errors fall through silently —
        // the message stays in the composer for a deliberate retry.)
        if (res.reason === "not-busy") {
          await get().send(trimmed);
        }
        return;
      }
      // Optimistic chip; the next `queue` event brings the authoritative list.
      set((s) => {
        const c = s.chats[id];
        if (!c) return s;
        const queuedItems = [
          ...(c.queuedItems ?? []),
          { entry_id: res.result ?? uid(), kind, text: trimmed } as QueuedItem,
        ];
        return { chats: { ...s.chats, [id]: { ...c, queuedItems } } };
      });
    } catch (e) {
      console.warn("queue-while-busy failed:", e);
    }
  },

  cancelQueued: async (entryId) => {
    const id = get().activeChatId;
    if (!id) return;
    let consumed = false;
    try {
      const res = await api.cancelChatQueue(id, entryId);
      consumed = res.result === "consumed";
    } catch {
      /* fall through to local removal */
    }
    if (consumed) return; // the run already took it — the queue event will show it
    set((s) => {
      const c = s.chats[id];
      if (!c) return s;
      return {
        chats: {
          ...s.chats,
          [id]: { ...c, queuedItems: (c.queuedItems ?? []).filter((q) => q.entry_id !== entryId) },
        },
      };
    });
  },

  setQueueModes: async (modes) => {
    const id = get().activeChatId;
    if (!id || id.startsWith("tmp_")) return;
    try {
      await api.setChatQueueMode(id, modes);
    } catch (e) {
      console.warn("setQueueMode failed:", e);
    }
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

  regenerateMessage: async (messageId: string) => {
    const id = get().activeChatId;
    if (!id) return;
    const chat = get().chats[id];
    if (!chat) return;

    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    const msg = chat.messages[idx];
    if (msg.role !== "assistant") return;

    let userMsgText = "";
    let userMsgId = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") {
        userMsgText = chat.messages[i].content;
        userMsgId = chat.messages[i].id;
        break;
      }
    }
    if (!userMsgText) return;

    try {
      await api.truncateMessage(id, userMsgId, userMsgText);
    } catch (e) {
      console.warn("truncateMessage failed:", e);
    }

    set((s) => {
      const c = s.chats[id];
      if (!c) return s;
      return {
        chats: {
          ...s.chats,
          [id]: {
            ...c,
            messages: c.messages.slice(0, idx),
          },
        },
      };
    });

    await get().refreshProviders();
    const p = get().providers;
    const fallback = pickAvailableModel(p, get().model);
    if (fallback !== get().model) set({ model: fallback });
    await get().send(userMsgText);
  },

  flagBadResponse: (messageId: string) => {
    const id = get().activeChatId;
    if (!id) return;
    set((s) => {
      const chat = s.chats[id];
      if (!chat) return s;
      const nextMsgs = chat.messages.map((m) =>
        m.id === messageId ? { ...m, feedback: "bad" as const } : m
      );
      return {
        chats: {
          ...s.chats,
          [id]: { ...chat, messages: nextMsgs },
        },
      };
    });
    // Fire-and-forget; respects the telemetry opt-out (post() early-returns
    // when disabled) and fans out to PostHog + the sidecar telemetry log.
    recordTelemetry("feedback_bad", {
      chat_id: id,
      message_id: messageId,
      model: get().model,
    });
  },

  startEditMessage: (messageId) => {
    const id = get().activeChatId;
    if (!id) return;
    const chat = get().chats[id];
    const msg = chat?.messages.find((m) => m.id === messageId);
    if (!chat || !msg || msg.role !== "user" || chat.working) return;
    set({ editing: { chatId: id, messageId, text: msg.content, attachments: msg.attachments ?? [] } });
  },

  cancelEditMessage: () => set({ editing: null }),

  editAndResend: async (messageId, newText, attachments) => {
    const trimmed = newText.trim();
    const files = attachments ?? [];
    set({ editing: null });
    if (!trimmed && files.length === 0) return;
    const id = get().activeChatId;
    if (!id) return;
    const c = get().chats[id];
    if (!c || c.working) return;

    const idx = c.messages.findIndex((m) => m.id === messageId);
    if (idx === -1 || c.messages[idx].role !== "user") return;

    // Roll the stored history back first. If that fails, don't run the
    // edit on top of the old history: the model would still see the
    // message being replaced and every reply after it.
    if (!IS_WEB && !isDemoMode() && !id.startsWith("tmp_")) {
      const userIndex = c.messages.slice(0, idx).filter((m) => m.role === "user").length;
      let ok = false;
      try {
        const res = await api.rewindMessage(id, messageId, userIndex, c.messages[idx].content);
        ok = res.success;
      } catch (e) {
        console.warn("rewindMessage failed:", e);
      }
      if (!ok) {
        set((s) => ({
          chats: {
            ...s.chats,
            [id]: { ...s.chats[id], error: "Couldn't edit that message. Reopen the chat and try again." },
          },
        }));
        return;
      }
    }

    set((s) => ({
      chats: {
        ...s.chats,
        [id]: {
          ...s.chats[id],
          messages: s.chats[id].messages.slice(0, idx),
          needsSetup: false,
          error: undefined,
        },
      },
    }));

    await get().send(trimmed, files.length ? { attachments: files } : undefined);
  },

  forkFromMessage: async (messageId, before) => {
    const id = get().activeChatId;
    if (!id) return;
    try {
      const res = await api.forkChat(id, messageId, before);
      if (res.success && res.chat?.id) {
        await get().openChat(res.chat.id);
      }
    } catch (e) {
      console.warn("forkChat failed:", e);
    }
  },

  restoreBranch: async (branchId) => {
    const id = get().activeChatId;
    if (!id) return;
    try {
      const res = await api.restoreBranch(id, branchId);
      if (res.success && res.chat) {
        await get().openChat(id);
      }
    } catch (e) {
      console.warn("restoreBranch failed:", e);
    }
  },

  deleteBranch: async (branchId) => {
    const id = get().activeChatId;
    if (!id) return;
    try {
      await api.deleteBranch(id, branchId);
    } catch (e) {
      console.warn("deleteBranch failed:", e);
    }
  },

  send: async (text, options) => {
    const attachments = options?.attachments ?? [];
    const resume = !!options?.resume;
    const trimmed = resume ? "" : text.trim();
    if (!resume && !trimmed && attachments.length === 0) return;

    const runId = uid();
    const currentId = get().view === "projects" ? null : get().activeChatId;

    // Clear any previous subagent state
    set({ subagents: [] });

    const model = pickAvailableModel(get().providers, get().model);
    const planMode = options?.planMode ?? get().planMode;
    const autoApproveDestructive = options?.autoApproveDestructive ?? get().autoApproveDestructive;
    const activeProjectId = get().activeProjectId;
    const crewId = currentId ? get().chats[currentId]?.crewId ?? "" : get().newChatCrewId;

    // The web app has no server-side agent, so it sends the thread itself.
    const priorHistory = IS_WEB && currentId ? webHistory(get().chats[currentId]) : undefined;

    // Optimistically place the user message into a local chat.
    // If there's no active chat yet, create a provisional client-side one; the
    // server will assign the real id via the "chat" SSE event and we reconcile.
    let localId = currentId ?? `tmp_${uid()}`;
    const userMsgText = trimmed;
    const hasImageAttachment = attachments.some((a) => a.kind === "image");
    const chatTitle = userMsgText
      ? userMsgText.slice(0, 56) + (userMsgText.length > 56 ? "…" : "")
      : hasImageAttachment
        ? "Image"
        : "New chat";
    const userMsg: Message = {
      id: uid(),
      role: "user",
      content: userMsgText,
      parts: userMsgText.trim()
        ? [{ kind: "text", text: userMsgText }]
        : [],
      createdAt: Date.now(),
      attachments: attachments.length
        ? attachments.map((a) => ({
            name: a.name,
            mime: a.mime,
            kind: a.kind,
            size: a.size,
            previewUrl: a.previewUrl,
            path: a.path,
            dataUrl: a.data_url,
          }))
        : undefined,
    };

    set((s) => {
      const existing = s.chats[localId];
      const chat: Chat = existing
        ? {
          ...existing,
          messages: resume ? existing.messages : [...existing.messages, userMsg],
          working: true,
          status: "Thinking",
          error: undefined,
          needsSetup: false,
          lastUserMessage: resume ? existing.lastUserMessage : userMsgText || chatTitle,
          activities: resume ? existing.activities : [],
          updatedAt: Date.now(),
        }
        : {
          id: localId,
          title: chatTitle,
          updatedAt: Date.now(),
          messages: [userMsg],
          working: true,
          status: "Thinking",
          lastUserMessage: userMsgText || chatTitle,
          activities: [],
          // Preserve the project context so the "back to project" arrow in
          // ChatView renders immediately — without this it only appears after
          // a reload via openChat, since the server-assigned id reconciliation
          // below spreads `...c` but never sets projectId itself.
          projectId: activeProjectId ?? null,
          crewId: crewId || null,
        };
      return {
        chats: { ...s.chats, [localId]: chat },
        activeChatId: localId,
        view: "chat",
      };
    });

    // Prepare assistant message placeholder for streaming; a resume keeps
    // streaming into the reply the run has been writing.
    const resumeMsgs = resume ? get().chats[localId]?.messages ?? [] : [];
    const resumeTarget = resumeMsgs[resumeMsgs.length - 1];
    const asstId = resumeTarget?.role === "assistant" ? resumeTarget.id : uid();
    if (asstId !== resumeTarget?.id) set((s) => {
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
                parts: [],
                createdAt: Date.now(),
              },
            ],
          },
        },
      };
    });

    // Rotation target for streamed output. Starts as this send's placeholder;
    // a consumed queued message (user_message event) rotates it so the rest of
    // the run streams into a fresh assistant bubble.
    let activeAsstId = asstId;

    const controller = new AbortController();
    set({ _abort: controller });

    // Silence watchdog: multi-step agent work (capture → act → re-capture …)
    // streams events continuously and legitimately runs well past a few
    // minutes. A fixed wall-clock cap aborts those tasks mid-flight (the
    // "random termination" on long browser/desktop jobs), so instead we
    // re-arm this timer on every received event. It only fires if the stream
    // goes truly silent (dead connection / stuck spinner) for this long.
    // Cleared in the finally block below.
    const SILENCE_MS = 5 * 60 * 1000;
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = () => {
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => {
        if (get().chats[localId]?.working) {
          controller.abort();
          set((s) => {
            const c = s.chats[localId];
            if (!c) return s;
            return {
              chats: {
                ...s.chats,
                [localId]: { ...c, working: false, status: undefined, error: "The stream went quiet for too long and was disconnected. Try again, or press Stop to cancel." },
              },
            };
          });
        }
      }, SILENCE_MS);
    };
    armWatchdog();

    try {
      await streamChat(
        {
          chat_id: currentId && !currentId.startsWith("tmp_") ? currentId : undefined,
          run_id: runId,
          message: trimmed,
          model,
          project_id: activeProjectId ?? undefined,
          crew_id: crewId || undefined,
          plan_mode: planMode,
          auto_approve_destructive: autoApproveDestructive,
          attachments,
          web_search_enabled: get().webSearchEnabled,
          effort: get().effort,
          history: priorHistory,
          resume,
        },
        (evt) => {
          // Any event means the stream is alive — push the silence watchdog
          // out so long multi-step tasks aren't aborted on a wall-clock cap.
          armWatchdog();
          if (evt.type === "chat") {
            // Server assigned an id — reconcile if we were provisional.
            const prevId = localId;
            if (prevId !== evt.id) {
              set((s) => {
                const c = s.chats[prevId];
                if (!c) return s;
                const { [prevId]: _, ...rest } = s.chats;
                void _;
                // Trust the server's title, but never let a stale placeholder
                // ("New chat") overwrite a meaningful local title we already
                // derived from the user's first message.
                const serverTitle =
                  evt.title && evt.title !== "New chat" && evt.title !== "New Chat"
                    ? evt.title
                    : c.title;
                const updated: Chat = { ...c, id: evt.id, title: serverTitle };
                return {
                  chats: { ...rest, [evt.id]: updated },
                  // Don't yank the user back if they already opened something else.
                  activeChatId: s.activeChatId === prevId ? evt.id : s.activeChatId,
                };
              });
              localId = evt.id;
              // The server has saved the row by now: list it in this sidebar
              // immediately (not only after the run ends) and in the other window.
              void get().refreshChats();
              void emitChatListChanged();
            } else if (evt.title && evt.title !== "New chat" && get().chats[evt.id]?.title !== evt.title) {
              // The backend named the chat from its first message.
              const title = evt.title;
              set((s) => {
                const c = s.chats[evt.id];
                return {
                  chats: c ? { ...s.chats, [evt.id]: { ...c, title } } : s.chats,
                  chatSummaries: s.chatSummaries.map((x) => (x.id === evt.id ? { ...x, title } : x)),
                };
              });
              void emitChatListChanged();
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
                m.id === activeAsstId
                  ? withParts(m, appendTextPart(m.parts, evt.text))
                  : m,
              );
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, messages: msgs },
                },
              };
            });
          } else if (evt.type === "thinking_delta") {
            // Reasoning / chain-of-thought: a distinct segment kind, rendered
            // as a collapsible "thinking" dropdown — never blended into the
            // answer text. A `thinking_delta` implicitly closes any open text
            // segment (appendThinkingPart opens a new part if the trailing
            // one isn't thinking).
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const msgs = c.messages.map((m) =>
                m.id === activeAsstId
                  ? withParts(m, appendThinkingPart(m.parts, evt.text))
                  : m,
              );
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, messages: msgs },
                },
              };
            });
          } else if (evt.type === "thinking_end") {
            // No-op on parts: the next event (text/tool_use) naturally opens a
            // new segment. Kept as a distinct event so future UI work can mark
            // a thinking segment "finalized" (e.g. auto-collapse) if desired.
          } else if (evt.type === "todo_update") {
            // Agent called `update_todos`. Replace the chat's todo snapshot
            // with the full list, and auto-open the panel the first time a
            // non-empty list arrives (subsequent updates never auto-close —
            // once the user has dismissed it, we respect that until they reopen).
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const hadTodos = (c.todos?.length ?? 0) > 0;
              const wasOpen = c.todoPanelOpen === true;
              const isFirstBatch = !hadTodos && !wasOpen;
              return {
                chats: {
                  ...s.chats,
                  [localId]: {
                    ...c,
                    todos: evt.todos,
                    todoPanelOpen: isFirstBatch && evt.todos.length > 0 ? true : c.todoPanelOpen,
                  },
                },
              };
            });
          } else if (evt.type === "tool_use") {
            // The model requested a tool call. Open a `tool` part at this
            // position in the timeline — before the activity/tool_result
            // frames arrive from the execution task. This is what places the
            // tool-call accordion at the right spot between text segments.
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const msgs = c.messages.map((m) => {
                if (m.id !== activeAsstId) return m;
                // If a tool part with this id already exists (e.g. a replayed
                // event), don't duplicate.
                if (m.parts.some((p) => p.kind === "tool" && p.id === evt.id)) return m;
                const toolPart: MessagePart = {
                  kind: "tool",
                  id: evt.id,
                  tool: evt.name,
                  label: `Running ${evt.name}`,
                  input: evt.input,
                  done: false,
                };
                // Text streamed before this tool call is narration, not the
                // answer — demote it into the process panel.
                return withParts(m, [...demoteTrailingTextToNarration(m.parts), toolPart]);
              });
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
                m.id === activeAsstId
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
          } else if (evt.type === "usage") {
            // Running token/cost total for the run — stamped on the working
            // assistant message; the last event equals the run total.
            const u = usageFromWire(evt as unknown as Parameters<typeof usageFromWire>[0]);
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const msgs = c.messages.map((m) => (m.id === activeAsstId ? { ...m, usage: u } : m));
              return { chats: { ...s.chats, [localId]: { ...c, messages: msgs } } };
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
          } else if (evt.type === "ask_question") {
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              return {
                chats: {
                  ...s.chats,
                  [localId]: {
                    ...c,
                    pendingQuestion: {
                      questionId: evt.question_id,
                      question: evt.question,
                      options: evt.options,
                    },
                  },
                },
              };
            });
          } else if (evt.type === "permission_recovery") {
            // A desktop_* tool failed with a CuaDriver permission-shaped error.
            // Surface a user-facing recovery card so the user can fix the grant
            // without parsing the model-facing tool error — closes the loop on
            // "automation failed, nothing happens".
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const partId = `recovery-${evt.tool_use_id ?? crypto.randomUUID()}`;
              const msgs = c.messages.map((m) => {
                if (m.id !== activeAsstId) return m;
                // De-duplicate: one recovery card per tool_use_id.
                if (m.parts.some((p) => p.kind === "permission_recovery" && p.id === partId)) return m;
                const recoveryPart: MessagePart = {
                  kind: "permission_recovery",
                  id: partId,
                  recoveryKind: evt.kind ?? "cuadriver_permissions",
                  message: evt.message,
                };
                return withParts(m, [...m.parts, recoveryPart]);
              });
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, messages: msgs },
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
              // Legacy side-channel list (kept for persistence back-compat).
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
              // Update the matching `tool` part in the timeline, correlated by
              // the model's tool_use_id (preferred) or the activity id. If no
              // tool part exists yet (activity arrived before tool_use, or a
              // legacy tool without a tool_use event), open a synthetic one so
              // the activity still renders in the timeline.
              const toolKey = evt.tool_use_id || evt.id;
              const msgs = c.messages.map((m) => {
                if (m.id !== activeAsstId) return m;
                const idx = m.parts.findIndex(
                  (p) => p.kind === "tool" && p.id === toolKey,
                );
                if (idx >= 0) {
                  const part = m.parts[idx];
                  if (part.kind !== "tool") return m;
                  const updated: MessagePart = {
                    ...part,
                    label: evt.label || part.label,
                    icon: evt.icon ?? part.icon,
                    done: evt.done ?? part.done,
                  };
                  const parts = [...m.parts];
                  parts[idx] = updated;
                  return withParts(m, parts);
                }
                // No tool part yet — open a synthetic one at the end.
                const toolPart: MessagePart = {
                  kind: "tool",
                  id: toolKey,
                  tool: evt.label,
                  label: evt.label,
                  icon: evt.icon,
                  done: evt.done ?? false,
                };
                return withParts(m, [...demoteTrailingTextToNarration(m.parts), toolPart]);
              });
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, activities, messages: msgs },
                },
              };
            });
          } else if (evt.type === "permission") {
            // Permission gate event. When `blocked && gate_id` are present the
            // backend has paused the tool and is waiting for the user's Allow /
            // Deny decision on the gate — surface an inline prompt on the tool
            // part (pendingGate) rather than a final verdict. Otherwise it's a
            // post-decision verdict (e.g. auto-approved or auto-deny) that we
            // record as done.
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const awaiting = evt.blocked && !!evt.gate_id;
              const toolKey = evt.tool_use_id || evt.gate_id;
              const baseLabel = evt.tool ?? "action";
              const permIcon = awaiting || evt.blocked ? "shield-alert" : "check";
              const msgs = toolKey
                ? c.messages.map((m) => {
                    if (m.id !== activeAsstId) return m;
                    const idx = m.parts.findIndex(
                      (p) => p.kind === "tool" && p.id === toolKey,
                    );
                    if (idx < 0) {
                      const toolPart: MessagePart = {
                        kind: "tool",
                        id: toolKey,
                        tool: evt.tool,
                        label: awaiting ? "Waiting for your OK" : `${evt.blocked ? "Blocked" : "Allowed"} ${baseLabel}`,
                        icon: permIcon,
                        ...(awaiting
                          ? { ok: undefined, done: false, pendingGate: { gateId: evt.gate_id!, reason: evt.reason } }
                          : { ok: !evt.blocked, done: true }),
                      };
                      return withParts(m, [...demoteTrailingTextToNarration(m.parts), toolPart]);
                    }
                    const part = m.parts[idx];
                    if (part.kind !== "tool") return m;
                    const updated: MessagePart = awaiting
                      ? {
                          ...part,
                          icon: permIcon,
                          ok: undefined,
                          done: false,
                          pendingGate: { gateId: evt.gate_id!, reason: evt.reason },
                        }
                      : {
                          ...part,
                          label: `${evt.blocked ? "Blocked" : "Allowed"} ${baseLabel}`,
                          icon: permIcon,
                          ok: !evt.blocked,
                          done: true,
                          pendingGate: undefined,
                        };
                    const parts = [...m.parts];
                    parts[idx] = updated;
                    return withParts(m, parts);
                  })
                : c.messages;
              // Only mirror a final (non-awaiting) verdict to the legacy
              // activities list; an open gate is not a completed activity.
              const activities = !awaiting
                ? [
                    ...c.activities,
                    {
                      id: toolKey || `perm_${evt.tool}_${Date.now()}`,
                      label: `${evt.blocked ? "Blocked" : "Allowed"} ${baseLabel}`,
                      icon: permIcon,
                      done: true,
                    } as Activity,
                  ]
                : c.activities;
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, activities, messages: msgs },
                },
              };
            });
          } else if (evt.type === "tool_result") {
            // Attach the final result/ok to the matching tool part. Closes
            // the accordion's "running" shimmer and shows the output when
            // expanded. (tool_complete, if emitted, is handled the same way.)
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const toolKey = evt.tool_use_id;
              if (!toolKey) return s;
              const msgs = c.messages.map((m) => {
                if (m.id !== activeAsstId) return m;
                const idx = m.parts.findIndex(
                  (p) => p.kind === "tool" && p.id === toolKey,
                );
                if (idx < 0) return m;
                const part = m.parts[idx];
                if (part.kind !== "tool") return m;
                const updated: MessagePart = {
                  ...part,
                  result: evt.message,
                  ok: evt.ok,
                  done: true,
                };
                const parts = [...m.parts];
                parts[idx] = updated;
                return withParts(m, parts);
              });
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, messages: msgs },
                },
              };
            });
          } else if (evt.type === "compaction") {
            // Compaction result. The backend emits `complete` (history was
            // summarized to fit the context window) or `failed`. There's no
            // pre-"summarizing" frame, so surface a transient status here and
            // let the next delta/done event clear it.
            const statusText =
              evt.status === "complete"
                ? `Compacted conversation${evt.before_chars && evt.after_chars ? ` (${Math.round((1 - evt.after_chars / evt.before_chars) * 100)}% smaller)` : ""}`
                : evt.status === "failed"
                  ? "Compaction failed"
                  : "Compacting conversation…";
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, status: statusText },
                },
              };
            });
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
          } else if (evt.type === "queue") {
            // Live queue snapshot (drives the composer chips).
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, queuedItems: evt.items },
                },
              };
            });
          } else if (evt.type === "message_ids") {
            // The sidecar saved this turn's rows under its own ids; adopt the
            // user message's so edit / regenerate can address it later.
            const storedId = evt.user;
            if (storedId && storedId !== userMsg.id) {
              set((s) => {
                const c = s.chats[localId];
                if (!c) return s;
                const messages = c.messages.map((m) => (m.id === userMsg.id ? { ...m, id: storedId } : m));
                return { chats: { ...s.chats, [localId]: { ...c, messages } } };
              });
            }
          } else if (evt.type === "queued") {
            // The chat's earlier run was still going (the app had lost track of it), so the
            // sidecar queued this message onto it. Drop the optimistic bubbles, show the queue
            // chip, and keep streaming the run's own reply; user_message brings the bubble back.
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const msgs = c.messages.filter((m) => m.id !== userMsg.id && m.id !== asstId);
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") activeAsstId = last.id;
              const queuedItems = [
                ...(c.queuedItems ?? []),
                { entry_id: evt.entry_id, kind: "follow_up", text: trimmed } as QueuedItem,
              ];
              // The send cleared the live activity list; the run's reply still owns its steps.
              const activities = last?.role === "assistant" ? last.activities ?? [] : c.activities;
              return { chats: { ...s.chats, [localId]: { ...c, messages: msgs, activities, queuedItems, status: "Working" } } };
            });
          } else if (evt.type === "user_message") {
            // A queued message (steer / follow-up / next-run) was consumed
            // and committed mid-run: it becomes a real user bubble, and the
            // run's remaining output streams into a fresh assistant bubble.
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              const msgs = [...c.messages];
              // Stamp the closing bubble's activities (mirrors the done
              // handler) so they stay on the message they belong to.
              const closingIdx = msgs.findIndex((m) => m.id === activeAsstId);
              if (closingIdx >= 0) {
                msgs[closingIdx] = { ...msgs[closingIdx], activities: [...c.activities] };
              }
              msgs.push(
                {
                  id: uid(),
                  role: "user",
                  content: evt.text,
                  parts: [{ kind: "text", text: evt.text }],
                  createdAt: Date.now(),
                },
                {
                  id: evt.assistant_id ?? uid(),
                  role: "assistant",
                  content: "",
                  parts: [],
                  createdAt: Date.now(),
                },
              );
              activeAsstId = msgs[msgs.length - 1].id;
              // The authoritative queue event lands within moments; drop the
              // matching chip immediately so it doesn't flash twice.
              const queuedItems = (c.queuedItems ?? []).filter((q) => q.text !== evt.text);
              return {
                chats: {
                  ...s.chats,
                  [localId]: { ...c, messages: msgs, queuedItems },
                },
              };
            });
          } else if (evt.type === "heartbeat") {
            return;
          } else if (evt.type === "done" || evt.type === "end") {
            void get().fetchSchedules(); // the run may have saved a schedule
            set((s) => {
              const c = s.chats[localId];
              if (!c) return s;
              // Final sync of activities to the assistant message
              const msgs = c.messages.map((m) =>
                m.id === activeAsstId ? { ...m, activities: [...c.activities] } : m,
              );
              return {
                chats: {
                  ...s.chats,
                  [localId]: {
                    ...c,
                    working: false,
                    status: undefined,
                    messages: msgs,
                    queuedItems: [],
                  },
                },
              };
            });
          }
        },
        controller.signal,
      );

      const assistantContent = get().chats[localId]?.messages.find((m) => m.id === activeAsstId)?.content || "";
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
      if (/\[\[(ARTIFACT|DOCUMENT)\s/.test(assistantContent)) {
        set((s) => {
          const c = s.chats[localId];
          if (!c) return s;
          const msgs = c.messages.map((m) =>
            m.id === activeAsstId ? withParts(m, replaceTextParts(m.parts, inlineArtifactTags(assistantContent))) : m,
          );
          return { chats: { ...s.chats, [localId]: { ...c, messages: msgs } } };
        });
      }
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      if (!isAbort) {
        trackError("chat_error", String(e));
      }
      set((s) => {
        const c = s.chats[localId];
        if (!c) return s;
        return {
          chats: {
            ...s.chats,
            [localId]: { ...c, working: false, status: undefined, error: isAbort ? undefined : String(e) },
          },
        };
      });
    } finally {
      clearTimeout(safetyTimer);
      set({ _abort: null });
      // Refresh history so the new chat shows up in the sidebar.
      get().refreshChats();
      // Notify the other window (overlay ↔ main) so its sidebar updates too.
      void emitChatListChanged();
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

}));

if (typeof window !== "undefined") {
  // Serialising every chat on each streamed token blocked the UI thread, so
  // write at most once a second; the cache is only an offline fallback.
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  useApp.subscribe(() => {
    if (cacheTimer) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      const state = useApp.getState();
      try {
        // Version the cache shape so a message-model change (e.g. the
        // content→parts migration) doesn't hydrate stale messages that crash
        // the renderer. Bump this whenever the persisted Message shape changes.
        localStorage.setItem("zwork:cache-version", CHAT_CACHE_VERSION);
        localStorage.setItem("zwork:cached-chats", JSON.stringify(state.chats));
        localStorage.setItem("zwork:cached-summaries", JSON.stringify(state.chatSummaries));
      } catch (e) {
        console.warn("Failed to write offline cache:", e);
      }
    }, 1000);
  });
}

// Cross-window chat-list sync (overlay ↔ main). The two windows are separate
// OS webviews with independent stores; Tauri's event bus is the only channel.
// The overlay is an independent quick-chat surface, so we deliberately sync
// only the chat LIST (so a quick question asked in the overlay shows up in
// the main window's sidebar afterward), NOT the active chat — the overlay
// opens to a fresh pill every time and never disturbs the main window's view.
// Registration is a no-op in browser dev mode. See lib/windowSync.ts.
if (typeof window !== "undefined") {
  void registerWindowSync({
    onListChanged: () => useApp.getState().refreshChats(),
  });
}

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
