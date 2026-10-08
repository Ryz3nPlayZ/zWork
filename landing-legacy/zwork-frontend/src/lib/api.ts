/**
 * zWork backend client.
 *
 * In `vite dev`, requests to `/api/*` are proxied to :8787 by Vite.
 * In a bundled Tauri app, the frontend is served from `tauri://`, so we must
 * rewrite `/api/*` to an absolute `http://127.0.0.1:8787/api/*`. The Tauri
 * Rust side launches the backend on that port at app startup.
 */
import { invoke } from "@tauri-apps/api/core";

const IS_TAURI =
  typeof window !== "undefined" &&
  // Tauri v2 exposes this; keep broad checks for v1 fallback too.
  (!!(window as any).__TAURI_INTERNALS__ ||
    !!(window as any).__TAURI__ ||
    (window.location && window.location.protocol === "tauri:"));

const API_BASE = IS_TAURI ? "http://127.0.0.1:8787" : "";

function u(path: string): string {
  // `path` always starts with "/api/..."
  return API_BASE + path;
}

export interface ApiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  activities?: Array<{
    id: string;
    label: string;
    icon?: string;
    done: boolean;
  }>;
}

export interface ApiChat {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string;
  messages: ApiMessage[];
}

export interface ApiChatSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  model: string;
}

export interface Integration {
  id: string;
  name: string;
  detected: boolean;
  can_reuse_credentials: boolean;
  detail: string;
  path: string;
}

export interface CredentialStatus {
  configured: boolean;
  source: "byok" | "claude_code" | "env" | null;
  base_url: string | null;
  shape: "anthropic" | "openai";
}

export interface ModelEntry {
  id: string;
  name: string;
  subtitle: string;
  shape: "anthropic" | "openai";
  credential: string;
  model_id: string;
  base_url_override?: string;
  configured: boolean;
  synthesized: boolean;
}

export interface ProvidersResponse {
  credentials: Record<string, CredentialStatus>;
  models: ModelEntry[];
  default_model: string;
}

export interface CustomModel {
  id: string;
  name: string;
  shape: string;
  credential: string;
  model_id: string;
  base_url_override: string;
}

export interface SettingsPublic {
  default_model: string;
  use_claude_code_config: boolean;
  telemetry_enabled: boolean;
  api_keys: Record<string, string>;
  provider_config: Record<string, Record<string, string>>;
  custom_models: CustomModel[];
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return (await r.json()) as T;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function invokeBackendCommand(command: "ensure_backend" | "restart_backend") {
  if (!IS_TAURI) return;
  try {
    await invoke(command);
  } catch {
    // The HTTP health check below is authoritative; ignore invoke failures in
    // browser/dev contexts where the command may not exist yet.
  }
}

async function healthFetch() {
  return fetch(u("/api/health")).then((r) => j<{ ok: boolean }>(r));
}

async function waitForBackendReady(attempts = 60) {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (i === 0) await invokeBackendCommand("ensure_backend");
      if (IS_TAURI && i === 15) await invokeBackendCommand("restart_backend");
      return await healthFetch();
    } catch (err) {
      lastError = err;
      await sleep(i < 6 ? 250 : 900);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Backend did not become ready.");
}

async function localFetch(path: string, init?: RequestInit) {
  if (IS_TAURI) {
    await waitForBackendReady(6);
  }
  return fetch(u(path), init);
}

export interface MeResponse {
  name: string;
  os: string;
  cwd: string;
}

export interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  path: string;
}

export interface OnboardingStatus {
  completed: boolean;
  skipped?: boolean;
  zwork_md_path?: string;
  zwork_md_exists?: boolean;
}

export interface OnboardingAnswer {
  key: string;
  question: string;
  answer: string;
}

export interface OnboardingCredential {
  shape: "anthropic" | "openai";
  credential: "anthropic" | "openai" | "claude_code" | "zwork_router";
  api_key: string;
  base_url: string;
  model_id: string;
  model_name: string;
}

export interface OnboardingPayload {
  answers: OnboardingAnswer[];
  credential?: OnboardingCredential;
  prefer_theme?: "light" | "dark" | "system";
  telemetry_enabled?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  chat_ids: string[];
}

export interface UploadedFile {
  client_id?: string | null;
  name: string;
  path: string;
  mime: string;
  kind: string;
  size: number;
}

export const api = {
  health: healthFetch,

  waitForBackend: waitForBackendReady,

  me: () => localFetch("/api/me").then((r) => j<MeResponse>(r)),

  integrations: () =>
    localFetch("/api/integrations").then((r) =>
      j<{ integrations: Integration[] }>(r),
    ),

  providers: () =>
    localFetch("/api/providers").then((r) => j<ProvidersResponse>(r)),

  getSettings: () =>
    localFetch("/api/settings").then((r) => j<SettingsPublic>(r)),

  putSettings: (patch: Partial<{
    api_keys: Record<string, string>;
    provider_config: Record<string, Record<string, string>>;
    default_model: string;
    use_claude_code_config: boolean;
    telemetry_enabled: boolean;
  }>) =>
    localFetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<SettingsPublic>(r)),

  telemetryEvent: (body: {
    event: string;
    session_id?: string;
    properties?: Record<string, unknown>;
    ts?: number;
  }) =>
    localFetch("/api/telemetry/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).then((r) => j<{ ok: boolean }>(r)),

  upsertCustomModel: (body: Omit<CustomModel, "id"> & { id?: string }) =>
    localFetch("/api/custom-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<{ custom_models: CustomModel[]; id: string }>(r)),

  deleteCustomModel: (id: string) =>
    localFetch(`/api/custom-models/${id}`, { method: "DELETE" }).then((r) =>
      j<{ custom_models: CustomModel[] }>(r),
    ),

  listChats: () =>
    localFetch("/api/chats").then((r) => j<{ chats: ApiChatSummary[] }>(r)),

  getChat: (id: string) =>
    localFetch(`/api/chats/${id}`).then((r) => j<ApiChat>(r)),

  deleteChat: (id: string) =>
    localFetch(`/api/chats/${id}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r),
    ),

  renameChat: (id: string, title: string) =>
    localFetch(`/api/chats/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).then((r) => j<ApiChat>(r)),

  // ---- Skills + onboarding ----
  skills: () =>
    localFetch("/api/skills").then((r) => j<{ skills: SkillMeta[] }>(r)),

  onboardStatus: () =>
    localFetch("/api/onboard/status").then((r) => j<OnboardingStatus>(r)),

  onboardSkip: () =>
    localFetch("/api/onboard/skip", { method: "POST" }).then((r) =>
      j<{ ok: boolean }>(r),
    ),

  onboardComplete: (body: OnboardingPayload) =>
    localFetch("/api/onboard/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) =>
      j<{ ok: boolean; zwork_md_path: string; preview: string }>(r),
    ),

  // ---- Memory ----
  getMemory: () =>
    localFetch("/api/memory").then((r) => j<{ content: string }>(r)),

  putMemory: (content: string) =>
    localFetch("/api/memory", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }).then((r) => j<{ ok: boolean }>(r)),

  // ---- User MD (zwork.md) ----
  getUserMd: () =>
    localFetch("/api/user-md").then((r) => j<{ content: string }>(r)),

  putUserMd: (content: string) =>
    localFetch("/api/user-md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }).then((r) => j<{ ok: boolean }>(r)),

  uploadFiles: (files: Array<{
    client_id?: string | null;
    name: string;
    mime: string;
    kind: string;
    text_content?: string | null;
    data_url?: string | null;
  }>) =>
    localFetch("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    }).then((r) => j<{ files: UploadedFile[] }>(r)),

  // ---- Projects ----
  listProjects: () =>
    localFetch("/api/projects").then((r) => j<{ projects: Project[] }>(r)),

  createProject: (name: string, description?: string) =>
    localFetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description: description || "" }),
    }).then((r) => j<{ project: Project }>(r)),

  updateProject: (id: string, data: { name?: string; description?: string }) =>
    localFetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }).then((r) => j<{ project: Project }>(r)),

  deleteProject: (id: string) =>
    localFetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) =>
      j<{ ok: boolean }>(r),
    ),

  getProjectContext: (id: string) =>
    localFetch(`/api/projects/${id}/context`).then((r) =>
      j<{ content: string }>(r),
    ),

  ollamaModels: (base_url: string, api_key: string) =>
    localFetch(`/api/ollama/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_url, api_key }),
    }).then((r) =>
      j<{ models: { id: string; name: string }[]; error?: string }>(r),
    ),

  putProjectContext: (id: string, content: string) =>
    localFetch(`/api/projects/${id}/context`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }).then((r) => j<{ ok: boolean }>(r)),
};

// ------ SSE streaming for chat ------

export type StreamEvent =
  | { type: "chat"; id: string; title: string }
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "meta"; provider: string; resolved_model: string; upstream_provider?: string }
  | { type: "done" }
  | { type: "end" }
  | { type: "heartbeat" }
  | { type: "error"; text: string }
  | { type: "needs_setup" }
  | { type: "activity"; id: string; label: string; icon?: string; done?: boolean }
  | { type: "tool_result"; tool: string; ok: boolean; message: string }
  | { type: "tool_progress"; tool_id: string; label: string }
  | { type: "permission"; tool: string; risk: "safe" | "sensitive" | "destructive"; reason: string; blocked: boolean }
  | { type: "compaction"; summarized_messages: number; kept_recent: number; summary_chars?: number; status: "summarizing" | "done" | "failed"; error?: string }
  | { type: "subagent_started"; task_id: string; description: string }
  | { type: "subagent_progress"; task_id: string; status: "pending" | "running" | "completed" | "failed" }
  | { type: "subagent_delta"; task_id: string; text: string }
  | { type: "subagent_activity"; task_id: string; event: StreamEvent }
  | { type: "subagent_done"; task_id: string; result?: string; error?: string };

export async function streamChat(
  body: {
    chat_id?: string;
    message: string;
    model?: string;
    artifact_mode?: boolean;
    project_id?: string;
    plan_mode?: boolean;
    auto_approve_destructive?: boolean;
    attachments?: Array<{
      client_id?: string | null;
      name: string;
      path: string;
      mime: string;
      kind: string;
    }>;
  },
  onEvent: (evt: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let sawEvent = false;
  let sawTerminal = false;
  let sawServerError = false;
  let attemptedRecovery = false;
  const parseFrame = (frame: string) => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        const evt = JSON.parse(data) as StreamEvent;
        sawEvent = true;
        if (evt.type === "done" || evt.type === "end") {
          sawTerminal = true;
        }
        if (evt.type === "error") {
          sawServerError = true;
        }
        onEvent(evt);
      } catch {
        /* ignore malformed partial event */
      }
    }
  };

  const readStream = async () => {
    const resp = await fetch(u("/api/chat/stream"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      onEvent({ type: "error", text: `${resp.status}: ${text}` });
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE frames are separated by blank lines
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        parseFrame(frame);
      }
    }
    if (buf.trim()) {
      parseFrame(buf);
    }
    if (sawEvent && !sawTerminal && !sawServerError) {
      onEvent({
        type: "error",
        text: "The local backend ended this response without a terminal event. Partial progress is preserved above.",
      });
      onEvent({ type: "end" });
    }
  };

  while (true) {
    try {
      if (IS_TAURI) {
        await api.waitForBackend(attemptedRecovery ? 30 : 12).catch(() => {});
      }
      await readStream();
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      if (sawTerminal) {
        return;
      }
      if (sawEvent && !sawServerError) {
        onEvent({
          type: "error",
          text: "The local backend ended this response unexpectedly. Partial progress is preserved above.",
        });
        onEvent({ type: "end" });
        return;
      }
      if (IS_TAURI && !sawEvent && !attemptedRecovery) {
        attemptedRecovery = true;
        onEvent({ type: "status", text: "Restarting local backend" });
        await invokeBackendCommand("restart_backend");
        await api.waitForBackend(30).catch(() => {});
        continue;
      }
      const detail =
        error instanceof Error && error.message
          ? error.message
          : String(error || "unknown error");
      onEvent({
        type: "error",
        text: `Lost connection to the local backend. Partial progress may be shown above. ${detail}`,
      });
      return;
    }
  }
}
