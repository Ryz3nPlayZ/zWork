import { api } from "./api";

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
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

