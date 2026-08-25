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
  type CustomModel,
  type MeResponse,
  type Project,
  type ScheduledTask,
  type InboxItem,
} from "./api";
import { fetchCloudSession, getCloudToken, logoutCloudSession, startDesktopGoogleSignIn } from "./cloud";
import { isDemoMode } from "./preview";
import { invoke } from "@tauri-apps/api/core";
import { setTelemetryEnabled, trackError, trackArtifactCreated, recordTelemetry } from "./telemetry";
import {
  emitChatListChanged,
  registerWindowSync,
} from "./windowSync";

const LEGACY_MANAGED_BASE_URLS = new Set(["https://ollama.com/v1"]);
const LEGACY_MANAGED_MODEL_IDS = new Set([
  "ollama-minimax-m2-7-cloud",
  "zwork-managed-proxy",
  "minimax-m2.7:cloud",
]);
const ROUTER_BASE_URL = "https://api.tryzwork.app/api";
const ONBOARDING_DONE_KEY = "zwork:onboarding-completed";
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
      tool: a.label,
      label: a.label,
      icon: a.icon,
      done: a.done,
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
  /** Chat-scoped artifact panel state. */
  artifactPanelOpen?: boolean;
  activeArtifactId?: string | null;
  /** Chat-scoped agent todo list + panel open state (driven by `todo_update` events). */
  todos?: AgentTodo[];
  todoPanelOpen?: boolean;
  pendingQuestion?: {
    questionId?: string;
    question: string;
    options: string[];
  } | null;
  projectId?: string | null;
}

export type View = "chat" | "settings" | "projects" | "analytics" | "plan" | "connectors" | "admin" | "tasks" | "inbox" | "scheduled";

export type SettingsSection =
  | "account"
  | "plan"
  | "general"
  | "memory"
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
  const re = /\[\[(?:ARTIFACT|DOCUMENT)\s+([^\]]+)\]\]([\s\S]*?)\[\[\/(?:ARTIFACT|DOCUMENT)\]\]/g;
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
  const flash = customModels.find((m) => m.id === "zwork-flash");
  const pro = customModels.find((m) => m.id === "zwork-pro");
  const vision = customModels.find((m) => m.id === "zwork-vision");
  const ultimate = customModels.find((m) => m.id === "zwork-ultimate");
  const hasOldRouter = customModels.some((model) => model.id === "zwork-router");
  const hasLegacyCustomModel = customModels.some((model) => LEGACY_MANAGED_MODEL_IDS.has(model.id) || LEGACY_MANAGED_MODEL_IDS.has(model.model_id));

  // Check that flash/pro/vision/ultimate exist AND have correct names/model_ids
  const flashCorrupted = !flash
    || flash.name !== "zWork Flash"
    || flash.model_id !== "deepseek-v4-flash"
    || flash.credential !== "zwork_router";
  const proCorrupted = !pro
    || pro.name !== "zWork Pro"
    || pro.model_id !== "deepseek-v4-pro"
    || pro.credential !== "zwork_router";
  const visionMissing = !vision
    || vision.name !== "zWork Vision"
    || vision.model_id !== "zwork-vision"
    || vision.credential !== "zwork_router";
  const ultimateMissing = !ultimate
    || ultimate.name !== "zWork Ultimate"
    || ultimate.model_id !== "zwork-ultimate"
    || ultimate.credential !== "zwork_router";

  return (
    LEGACY_MANAGED_BASE_URLS.has(settings.provider_config?.openai?.base_url || "") ||
    LEGACY_MANAGED_BASE_URLS.has(settings.provider_config?.zwork_router?.base_url || "") ||
    LEGACY_MANAGED_MODEL_IDS.has(defaultModel) ||
    hasLegacyCustomModel ||
    hasOldRouter ||
    flashCorrupted ||
    proCorrupted ||
    visionMissing ||
    ultimateMissing
  );
}

async function migrateManagedRouterSettings(settings: SettingsPublic): Promise<SettingsPublic> {
  const cloudToken = getCloudToken().trim();
  await api.putSettings({
    ...(cloudToken ? { api_keys: { zwork_router: cloudToken } } : {}),
    provider_config: {
      zwork_router: { base_url: ROUTER_BASE_URL },
    },
    default_model: "zwork-flash",
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

  await api.upsertCustomModel({
    id: "zwork-flash",
    name: "zWork Flash",
    shape: "anthropic",
    credential: "zwork_router",
    model_id: "deepseek-v4-flash",
    base_url_override: ROUTER_BASE_URL,
  });

  await api.upsertCustomModel({
    id: "zwork-pro",
    name: "zWork Pro",
    shape: "anthropic",
    credential: "zwork_router",
    model_id: "deepseek-v4-pro",
    base_url_override: ROUTER_BASE_URL,
  });

  await api.upsertCustomModel({
    id: "zwork-vision",
    name: "zWork Vision",
    shape: "openai",
    credential: "zwork_router",
    model_id: "zwork-vision",
    base_url_override: ROUTER_BASE_URL,
  });

  await api.upsertCustomModel({
    id: "zwork-ultimate",
    name: "zWork Ultimate",
    shape: "openai",
    credential: "zwork_router",
    model_id: "zwork-ultimate",
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
  
  await api.upsertCustomModel({
    id: "zwork-flash",
    name: "zWork Flash",
    shape: "anthropic",
    credential: "zwork_router",
    model_id: "deepseek-v4-flash",
    base_url_override: ROUTER_BASE_URL,
  });

  await api.upsertCustomModel({
    id: "zwork-pro",
    name: "zWork Pro",
    shape: "anthropic",
    credential: "zwork_router",
    model_id: "deepseek-v4-pro",
    base_url_override: ROUTER_BASE_URL,
  });

  await api.upsertCustomModel({
    id: "zwork-vision",
    name: "zWork Vision",
    shape: "openai",
    credential: "zwork_router",
    model_id: "zwork-vision",
    base_url_override: ROUTER_BASE_URL,
  });

  await api.upsertCustomModel({
    id: "zwork-ultimate",
    name: "zWork Ultimate",
    shape: "openai",
    credential: "zwork_router",
    model_id: "zwork-ultimate",
    base_url_override: ROUTER_BASE_URL,
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

  // Artifacts
  artifacts: Artifact[];
  openArtifact: (a: Artifact) => void;
  closeArtifactPanel: () => void;
  clearArtifacts: () => void;
  updateArtifact: (id: string, patch: Partial<Artifact>) => Promise<void>;

  // Agent todo panel (chat-scoped, driven by `todo_update` events)
  closeTodoPanel: () => void;
  toggleTodoPanel: () => void;

  // Projects
  projects: Project[];
  activeProjectId: string | null;
  setActiveProject: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
  createProject: (name: string, description?: string, icon?: string) => Promise<void>;
  updateProject: (id: string, data: { name?: string; description?: string; starred?: boolean; icon?: string }) => Promise<void>;
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
      artifactMode?: boolean;
      planMode?: boolean;
      autoApproveDestructive?: boolean;
      attachments?: Array<{
        client_id?: string | null;
        name: string;
        path: string;
        data_url?: string;
        mime: string;
        kind: string;
        size?: number;
        previewUrl?: string;
      }>;
    },
  ) => Promise<void>;
  retry: () => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  flagBadResponse: (messageId: string) => void;
  /** Edit a previously sent user message and re-run the conversation from that point. */
  editAndResend: (messageId: string, newText: string) => Promise<void>;
  stop: () => void;

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
  accessibilityPermissionGranted: null,
  screenRecordingPermissionGranted: null,
  driverOk: null,
  wrongIdentityHint: null,
  zworkSelfTrusted: null,
  extensionConnected: null,
  webSearchEnabled: false,
  setWebSearchEnabled: (v) => set({ webSearchEnabled: v }),
  securityPreset: loadSecurityPreset(),
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
    if (IS_WEB) return;
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
    await api.createProject(name, description, icon);
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

  // ─── Scheduled Tasks + Inbox ──────────────────────────────────────────────

  fetchSchedules: async () => {
    try {
      const { tasks } = await api.listSchedules();
      set({ scheduledTasks: tasks });
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

      // Provide a synthetic providers object so the model picker shows zWork Flash/Pro
      const webProviders: ProvidersResponse = {
        credentials: {},
        default_model: "zwork-flash",
        models: [
          {
            id: "zwork-flash",
            name: "zWork Flash",
            subtitle: "Fast and efficient",
            shape: "openai",
            credential: "managed",
            model_id: "zwork-flash",
            configured: true,
            synthesized: false,
          },
          {
            id: "zwork-pro",
            name: "zWork Pro",
            subtitle: "Most capable model",
            shape: "openai",
            credential: "managed",
            model_id: "zwork-pro",
            configured: true,
            synthesized: false,
          },
          {
            id: "zwork-vision",
            name: "zWork Vision",
            subtitle: "Vision and images",
            shape: "openai",
            credential: "managed",
            model_id: "zwork-vision",
            configured: true,
            synthesized: false,
          },
          {
            id: "zwork-ultimate",
            name: "zWork Ultimate",
            subtitle: "Frontier model · Max plan",
            shape: "openai",
            credential: "managed",
            model_id: "zwork-ultimate",
            configured: true,
            synthesized: false,
          },
        ],
      };

      set({ onboardingDone: true, model: "zwork-flash", providers: webProviders, backendReady: true });
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
    // Demo mode: no server-side chat persistence. Chat history lives only in
    // the local store for the session; nothing to refresh from a backend.
    if (isDemoMode()) return;
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
      set({ backendOffline: true });
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
      { id: "notion",         name: "Notion",          color: "#000000", icon: null },
      { id: "googledrive",    name: "Google Drive",    color: "#34A853", icon: null },
      { id: "github",         name: "GitHub",          color: "#181717", icon: null },
      { id: "linear",         name: "Linear",          color: "#5E6AD2", icon: null },
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

  openLanding: () => set({ activeChatId: null, view: "chat", activeProjectId: null }),

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
            } as Message;
          });
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
              messages[i] = { ...m, content: cleaned || (artifacts.length === 1 ? "Here's the document:" : "Here are the documents:") };
              loadedArtifacts.push(...artifacts);
            }
          }
        }
        const fetchedProjectId = (full as any).project_id || null;
        set((s) => ({
          activeProjectId: fetchedProjectId,
          view: "chat",
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
              projectId: fetchedProjectId,
            },
          },
        }));
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
    if (id && !id.startsWith("tmp_")) {
      try {
        await api.stopChat(id);
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
          [activeId]: { ...c, working: false, status: undefined },
        },
      };
    });
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

  editAndResend: async (messageId, newText) => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    const id = get().activeChatId;
    if (!id) return;
    const c = get().chats[id];
    if (!c) return;

    // Find the index of the target message.
    const idx = c.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    try {
      await api.truncateMessage(id, messageId, trimmed);
    } catch (e) {
      console.warn("truncateMessage failed:", e);
    }

    // Drop the target user message + everything after (assistant reply, etc.)
    const trimmedMessages = c.messages.slice(0, idx);

    set((s) => ({
      chats: {
        ...s.chats,
        [id]: {
          ...s.chats[id],
          messages: trimmedMessages,
          needsSetup: false,
          error: undefined,
        },
      },
    }));

    await get().send(trimmed);
  },

  send: async (text, options) => {
    const attachments = options?.attachments ?? [];
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    const runId = uid();
    const currentId = get().view === "projects" ? null : get().activeChatId;

    // Clear any previous subagent state
    set({ subagents: [] });

    const model = pickAvailableModel(get().providers, get().model);
    const inferredArtifactKind = inferArtifactKind(trimmed);
    const artifactMode = (options?.artifactMode ?? get().artifactMode) || !!inferredArtifactKind;
    const planMode = options?.planMode ?? get().planMode;
    const autoApproveDestructive = options?.autoApproveDestructive ?? get().autoApproveDestructive;
    const activeProjectId = get().activeProjectId;

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
          lastUserMessage: userMsgText || chatTitle,
          activities: [],
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
          artifactPanelOpen: false,
          activeArtifactId: null,
          // Preserve the project context so the "back to project" arrow in
          // ChatView renders immediately — without this it only appears after
          // a reload via openChat, since the server-assigned id reconciliation
          // below spreads `...c` but never sets projectId itself.
          projectId: activeProjectId ?? null,
        };
      return {
        chats: { ...s.chats, [localId]: chat },
        activeChatId: localId,
        view: "chat",
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
                parts: [],
                createdAt: Date.now(),
              },
            ],
          },
        },
      };
    });

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
          artifact_mode: artifactMode,
          project_id: activeProjectId ?? undefined,
          plan_mode: planMode,
          auto_approve_destructive: autoApproveDestructive,
          attachments,
          web_search_enabled: get().webSearchEnabled,
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
                  activeChatId: evt.id,
                };
              });
              localId = evt.id;
              // A brand-new chat just got its real id — tell the other window
              // so its sidebar picks it up.
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
                m.id === asstId
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
                m.id === asstId
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
                if (m.id !== asstId) return m;
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
                return withParts(m, [...m.parts, toolPart]);
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
                if (m.id !== asstId) return m;
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
                if (m.id !== asstId) return m;
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
                return withParts(m, [...m.parts, toolPart]);
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
              const baseLabel = `${evt.tool} (${evt.risk})`;
              const permIcon = evt.risk === "destructive" ? "shield-alert" : evt.risk === "sensitive" ? "shield" : "check";
              const msgs = toolKey
                ? c.messages.map((m) => {
                    if (m.id !== asstId) return m;
                    const idx = m.parts.findIndex(
                      (p) => p.kind === "tool" && p.id === toolKey,
                    );
                    if (idx < 0) {
                      const toolPart: MessagePart = {
                        kind: "tool",
                        id: toolKey,
                        tool: evt.tool,
                        label: awaiting ? `Needs permission: ${baseLabel}` : `${evt.blocked ? "Blocked" : "Allowed"} ${baseLabel}`,
                        icon: permIcon,
                        ...(awaiting
                          ? { ok: undefined, done: false, pendingGate: { gateId: evt.gate_id!, reason: evt.reason } }
                          : { ok: !evt.blocked, done: true }),
                      };
                      return withParts(m, [...m.parts, toolPart]);
                    }
                    const part = m.parts[idx];
                    if (part.kind !== "tool") return m;
                    const updated: MessagePart = awaiting
                      ? {
                          ...part,
                          label: `Needs permission: ${baseLabel}`,
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
                if (m.id !== asstId) return m;
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
          const replacement = cleaned || (artifacts.length === 1 ? "Here's the artifact:" : "Here are the artifacts:");
          const msgs = c.messages.map((m) =>
            m.id === asstId ? withParts(m, replaceTextParts(m.parts, replacement)) : m,
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
            const replacement = cleaned || "Here's the artifact:";
            const msgs = c.messages.map((m) =>
              m.id === asstId ? withParts(m, replaceTextParts(m.parts, replacement)) : m,
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

  updateArtifact: async (id, patch) => {
    // 1. Apply patch to in-memory state and capture the updated artifact list.
    let updatedArtifact: Artifact | undefined;
    set((s) => {
      const artifacts = s.artifacts.map((a) => {
        if (a.id !== id) return a;
        updatedArtifact = { ...a, ...patch };
        return updatedArtifact;
      });
      return { artifacts };
    });

    if (!updatedArtifact?.sourceMessageId) return;

    // 2. Rebuild the raw message content so the backend stores the
    //    updated artifact body inside [[ARTIFACT ...]] blocks.
    const { activeChatId, chats, artifacts } = get();
    const chatId = activeChatId;
    const msgId = updatedArtifact.sourceMessageId;
    if (!chatId) return;

    const chat = chats[chatId];
    if (!chat) return;

    const baseMsg = chat.messages.find((m) => m.id === msgId);
    if (!baseMsg) return;

    // Collect all artifacts that belong to this message (after applying patch).
    const msgArtifacts = artifacts.map((a) =>
      a.id === id ? (updatedArtifact as Artifact) : a
    ).filter((a) => a.sourceMessageId === msgId);

    // Serialize each artifact back into [[ARTIFACT ...]] wire format.
    const blocks = msgArtifacts
      .map((a) => {
        const titleAttr = a.title ? ` title="${a.title.replace(/"/g, "'")}"`  : "";
        const langAttr = a.language ? ` language="${a.language}"` : "";
        return `[[DOCUMENT kind=${a.kind}${titleAttr}${langAttr}]]\n${a.content}\n[[/DOCUMENT]]`;
      })
      .join("\n\n");

    const rawContent = blocks
      ? `${baseMsg.content}\n\n${blocks}`.trim()
      : baseMsg.content;

    // 3. Fire-and-forget PATCH; failures are non-fatal.
    api.patchMessage(chatId, msgId, { content: rawContent }).catch(() => {});
  },
}));

if (typeof window !== "undefined") {
  useApp.subscribe((state) => {
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
