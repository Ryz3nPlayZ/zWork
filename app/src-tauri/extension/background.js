// zbctl background service worker.
//
// ROLE CHANGE: this worker used to own the backend WebSocket directly. That was
// the bug — Chrome suspends MV3 workers after ~30s of idleness, killing the
// socket and cancelling its reconnect timer, so the bridge silently dropped
// while the user wasn't interacting with Chrome. The WebSocket now lives in the
// offscreen document (offscreen.js), which is never suspended. This worker is
// the ACTION EXECUTOR only: all chrome.tabs / chrome.scripting calls happen
// here. Commands arrive from the offscreen doc over a private named Port; that
// delivery wakes this worker on demand if Chrome had suspended it, and the
// response is posted back over the same port.

// ─── Offscreen document (persistent WS transport) ─────────────
async function ensureOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existing && existing.length > 0) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WEB_RTC"],
      justification:
        "Holds the persistent WebSocket bridge to the zWork backend so it survives service-worker suspension.",
    });
  } catch (e) {
    console.warn("[zbctl/bg] ensureOffscreen failed:", e && e.message);
  }
}

// ─── Action routing ───────────────────────────────────────────
async function handleAction(id, action, params) {
  // Browser-level actions (no content script needed)
  switch (action) {
    case "tabs":
      return { result: await chrome.tabs.query({}) };

    case "active-tab": {
      const tabs = await chrome.tabs.query({ active: true });
      const tab = tabs[0] || null;
      return { result: tab };
    }

    case "open":
      return { result: await chrome.tabs.create({ url: params.url }) };

    case "close": {
      const tabId = params.tabId || (await getActiveTabId());
      await chrome.tabs.remove(tabId);
      return { result: { success: true } };
    }

    case "screenshot": {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "png",
      });
      return { result: { dataUrl } };
    }

    case "navigate": {
      const tabId = params.tabId || (await getActiveTabId());
      await chrome.tabs.update(tabId, { url: params.url });
      // Don't wait for page load here — content script's MutationObserver
      // will detect the new page and push a settled event
      return { result: { success: true } };
    }

    case "switch-tab": {
      await chrome.tabs.update(params.tabId, { active: true });
      return { result: { success: true } };
    }

    case "new-tab": {
      const newTab = await chrome.tabs.create(params.url ? { url: params.url } : {});
      return { result: newTab };
    }
  }

  // Page-level actions — forward to content script
  const pageActions = ["snapshot", "click", "type", "scroll", "eval", "upload", "download"];
  if (pageActions.includes(action)) {
    return await sendToContentScript(id, action, params);
  }

  throw new Error(`Unknown action: ${action}`);
}

// ─── Content script communication ─────────────────────────────
async function sendToContentScript(id, action, params) {
  const tabId = params.tabId || (await getActiveTabId());

  // Ensure content script is loaded (fallback for tabs opened before extension)
  await ensureContentScript(tabId);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Content script timed out for action: ${action}`));
    }, 10000);

    chrome.tabs.sendMessage(tabId, { id, action, params }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(
        response || { ok: false, error: "No response from content script" },
      );
    });
  });
}

async function ensureContentScript(tabId) {
  // Ping the content script to see if it's already loaded
  try {
    await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
    return; // already loaded
  } catch {
    // Not loaded — inject it
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    throw new Error(`Failed to inject content script: ${e.message}`);
  }
}

// ─── Control port from the offscreen WS document ──────────────
let bgPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "zbctl-ws") return;
  bgPort = port;

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.dir !== "cmd") return;
    const { id, action, params } = msg;
    let body;
    try {
      const result = await handleAction(id, action, params || {});
      // Page actions return the content script response directly (has id/ok/snapshot)
      // Browser actions return { result: <value> }
      body = result && result.id
        ? result
        : { id, ok: true, result: result?.result ?? null };
    } catch (error) {
      body = { id, ok: false, error: (error && error.message) ? error.message : String(error) };
    }
    try {
      port.postMessage({ dir: "res", body });
    } catch {
      /* port went away; offscreen will reconnect */
    }
  });

  port.onDisconnect.addListener(() => {
    if (bgPort === port) bgPort = null;
  });
});

// ─── Push events from content script → offscreen → backend ────
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === "settled" && sender.tab && bgPort) {
    try {
      bgPort.postMessage({
        dir: "settled",
        tabId: sender.tab.id,
        url: sender.tab.url,
        snapshot: message.snapshot,
      });
    } catch {
      /* port gone */
    }
  }
});

// ─── Tab lifecycle ────────────────────────────────────────────
// When a tab finishes loading, ensure the content script is present so its
// MutationObserver can detect settle and push snapshots.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    try {
      await ensureContentScript(tabId);
    } catch {
      // Can't inject on this tab (chrome:// pages, etc.)
    }
  }
});

// ─── Helpers ──────────────────────────────────────────────────
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true });
  if (!tab) throw new Error("No active tab");
  return tab.id;
}

// ─── Start ────────────────────────────────────────────────────
// Run on every worker startup (initial load and each wake after suspension).
ensureOffscreen();
