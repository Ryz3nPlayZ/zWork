// zbctl background service worker
// Maintains WebSocket to daemon, routes commands to content scripts,
// handles browser-level actions, and forwards push events.

const PORT = 8787;
let socket = null;

// ─── WebSocket connection ─────────────────────────────────────
function connect() {
  socket = new WebSocket(`ws://localhost:${PORT}/ws`);

  socket.onopen = () => {
    console.log("[zbctl] connected to daemon");
  };

  socket.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    const { id, action, params } = data;

    try {
      const result = await handleAction(id, action, params || {});
      // Page actions return the content script response directly (has id/ok/snapshot)
      // Browser actions return { result: <value> }
      if (result && result.id) {
        socketSend(result);
      } else {
        socketSend({ id, ok: true, result: result?.result ?? null });
      }
    } catch (error) {
      socketSend({ id, ok: false, error: error.message });
    }
  };

  socket.onclose = () => {
    console.log("[zbctl] disconnected, reconnecting in 3s...");
    setTimeout(connect, 3000);
  };

  socket.onerror = (err) => {
    console.error("[zbctl] socket error", err);
  };
}

function socketSend(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
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

// ─── Push events from content script → daemon ─────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "settled" && sender.tab) {
    // Content script detected page settled — forward to daemon
    socketSend({
      type: "settled",
      tabId: sender.tab.id,
      url: sender.tab.url,
      snapshot: message.snapshot,
    });
  }
  // Respond to pings from ensureContentScript
  if (message.action === "ping") {
    sendResponse({ ok: true });
  }
});

// ─── Tab lifecycle ────────────────────────────────────────────
// When a tab finishes loading, push an initial snapshot
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    try {
      await ensureContentScript(tabId);
      // Content script's MutationObserver will handle settle detection
      // and push a snapshot automatically. No need to request one here.
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
connect();
