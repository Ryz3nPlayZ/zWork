import { api } from "./api";
import { capturePostHogEvent, registerPostHogProperties, setPostHogTelemetryEnabled } from "./posthog";

type TelemetryProps = Record<string, unknown>;

type TelemetryContext = {
  appVersion: string;
  os: string;
  screen: string;
};

let enabled = false;
let sessionId = "";
let sessionStartedAt = 0;
let activeSegmentStartedAt = 0;
let activeAccumulatedMs = 0;
let heartbeatTimer: number | null = null;
let visibilityHandler: (() => void) | null = null;
let unloadHandler: (() => void) | null = null;

function uid() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(36)}-${performance.now().toString(36).replace(".", "")}`;
}

function canUseDom() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function visible() {
  return !canUseDom() || document.visibilityState === "visible";
}

function clearTimers() {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  if (unloadHandler) {
    window.removeEventListener("beforeunload", unloadHandler);
    unloadHandler = null;
  }
}

async function post(event: string, properties: TelemetryProps = {}) {
  if (!enabled || !sessionId) return;
  capturePostHogEvent(event, {
    session_id: sessionId,
    ...properties,
    ts: Date.now(),
  });
  await api
    .telemetryEvent({
      event,
      session_id: sessionId,
      properties,
      ts: Date.now(),
    })
    .catch(() => {
      /* ignore telemetry transport failures */
    });
}

function flushActive(reason: string) {
  if (!enabled || !sessionId || activeSegmentStartedAt <= 0) return;
  const now = Date.now();
  const activeMs = now - activeSegmentStartedAt;
  if (activeMs <= 0) return;
  activeAccumulatedMs += activeMs;
  activeSegmentStartedAt = now;
  void post("session_heartbeat", {
    reason,
    active_ms: activeMs,
    active_total_ms: activeAccumulatedMs,
    session_ms: now - sessionStartedAt,
  });
}

export function setTelemetryEnabled(next: boolean) {
  enabled = next;
  setPostHogTelemetryEnabled(next);
  if (!enabled) {
    stopTelemetrySession("disabled");
  }
}

export function startTelemetrySession(context: TelemetryContext) {
  if (!enabled || !canUseDom() || sessionId) return;

  sessionId = uid();
  sessionStartedAt = Date.now();
  activeAccumulatedMs = 0;
  activeSegmentStartedAt = visible() ? sessionStartedAt : 0;
  registerPostHogProperties({
    app_version: context.appVersion,
    os: context.os,
    current_screen: context.screen,
  });

  visibilityHandler = () => {
    if (!sessionId) return;
    if (document.visibilityState === "hidden") {
      flushActive("hidden");
      activeSegmentStartedAt = 0;
      return;
    }
    if (activeSegmentStartedAt === 0) {
      activeSegmentStartedAt = Date.now();
    }
  };
  unloadHandler = () => {
    stopTelemetrySession("unload");
  };

  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("beforeunload", unloadHandler);
  heartbeatTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      flushActive("interval");
    }
  }, 60_000);

  void post("app_opened", {
    app_version: context.appVersion,
    os: context.os,
    screen: context.screen,
    visible: visible(),
  });
}

export function stopTelemetrySession(reason: string) {
  if (!sessionId) return;

  flushActive(reason);
  void post("app_closed", {
    reason,
    session_ms: Date.now() - sessionStartedAt,
    active_ms: activeAccumulatedMs,
  });

  sessionId = "";
  sessionStartedAt = 0;
  activeSegmentStartedAt = 0;
  activeAccumulatedMs = 0;
  clearTimers();
}

export function recordTelemetry(event: string, properties: TelemetryProps = {}) {
  void post(event, properties);
}

// Analytics Helpers
export function trackFeatureUsage(featureName: string, properties: TelemetryProps = {}) {
  void post("feature_used", { feature: featureName, ...properties });
}

export function trackOnboardingStep(step: string, completed: boolean) {
  void post("onboarding_step", { step, completed });
}

export function trackTokenConsumption(model: string, inputTokens: number, outputTokens: number) {
  void post("token_consumption", { model, input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens });
}

export function trackError(errorType: string, message: string, component?: string) {
  void post("error_encountered", { type: errorType, message, component });
}

export function trackNavigation(fromPath: string, toPath: string) {
  void post("page_navigated", { from: fromPath, to: toPath });
}

export function trackArtifactCreated(kind: string, sizeBytes?: number) {
  void post("artifact_created", { kind, size_bytes: sizeBytes });
}
