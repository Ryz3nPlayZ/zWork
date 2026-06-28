// offscreen.js — persistent WebSocket transport for the zbctl bridge.
//
// WHY THIS EXISTS: Chrome MV3 terminates the background service worker after
// ~30s of inactivity. When that happened, the socket the worker owned died and
// its setTimeout(connect, 3000) was cancelled by the teardown — so the bridge
// silently went "connected → disconnected" between the user glancing at
// Settings and the agent actually running a command, with no reconnect until
// some unrelated Chrome event woke the worker. Offscreen documents are not
// suspended like the worker, so the socket held here stays up.
//
// The offscreen doc is transport only. It does not touch chrome.tabs /
// chrome.scripting (those APIs aren't available here anyway). Commands that
// arrive over the socket are handed to the background service worker over a
// private named Port; that postMessage WAKES the worker if Chrome had
// suspended it, so the agent's command always reaches an executor. The
// worker's response is relayed back over the socket.

const PORT = 8787;
const HOST = "127.0.0.1";

let socket = null;
let port = null; // private control channel to the background SW
let wsBackoffMs = 1000;

// ─── Backend WebSocket ────────────────────────────────────────
function connectWs() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  try {
    socket = new WebSocket(`ws://${HOST}:${PORT}/ws`);
  } catch (e) {
    console.warn("[zbctl/offscreen] WebSocket ctor failed:", e && e.message);
    scheduleWs();
    return;
  }

  socket.onopen = () => {
    wsBackoffMs = 1000;
    console.log("[zbctl/offscreen] connected to backend");
  };

  socket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    const { id, action, params } = data;
    // Make sure the control port is up, then hand the command to the worker.
    if (!port) connectPort();
    if (port) {
      try {
        port.postMessage({ dir: "cmd", id, action, params: params || {} });
      } catch {
        // Port died between checks — drop and let onDisconnect reconnect.
      }
    }
  };

  socket.onclose = () => {
    socket = null;
    scheduleWs();
  };
  socket.onerror = () => {
    /* onclose will follow and trigger backoff */
  };
}

function scheduleWs() {
  // This timer reliably fires because offscreen documents aren't suspended.
  setTimeout(connectWs, wsBackoffMs);
  wsBackoffMs = Math.min(wsBackoffMs * 2, 5000);
}

function wsSend(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      /* drop */
    }
  }
}

// ─── Control port to the background service worker ───────────
function connectPort() {
  try {
    port = chrome.runtime.connect({ name: "zbctl-ws" });
  } catch (e) {
    port = null;
    setTimeout(connectPort, 500);
    return;
  }

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.dir === "res") {
      // Worker's response to a command — relay verbatim to the backend.
      wsSend(msg.body || {});
    } else if (msg.dir === "settled") {
      // Page-settled push event forwarded by the worker.
      wsSend({
        type: "settled",
        tabId: msg.tabId,
        url: msg.url,
        snapshot: msg.snapshot,
      });
    }
  });

  port.onDisconnect.addListener(() => {
    // The worker was suspended/restarted. Re-establish on the next tick.
    port = null;
    setTimeout(connectPort, 250);
  });
}

// ─── Start ────────────────────────────────────────────────────
connectPort();
connectWs();
