// zbctl content script - persistent pushbased snapshot driven
// Loaded via manifest.json or one time injection for existing tabs
// never injected more than once

if (typeof window.__zbctl === "undefined") {
  window.__zbctl = true;

  const nodeToId = new WeakMap();
  let nextId = 1;

  function getNodeId(node) {
    if (nodeToId.has(node)) return nodeToId.get(node);
    const id = nextId++;
    nodeToId.set(node, id);
    return id;
  }

  // reverse map id -> node. keep in sync during snapshot gen
  const idToNode = new Map();

  function getNodeById(id) {
    // we dont maintain reverse WeakMap
    // for action targets, the snapshot includes enough to refind node
    return idToNode.get(id);
  }

  // visibility check
  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    )
      return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  // skiip these elements entirely
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "META",
    "LINK",
    "NOSCRIPT",
    "HEAD",
    "PATH",
    "SVG",
    "BR",
    "HR",
  ]);

  // interactive elements
  const INTERACTIVE_TAGS = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "SUMMARY",
    "DETAILS",
    "OPTION",
    "OPTGROUP",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "menuitem",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "treeitem",
    "option",
    "menuitemradio",
    "menuitemcheckbox",
  ]);

  function isInteractive(el) {
    if (el.getAttribute("tabindex") !== null) return true;
    if (el.getAttribute("contenteditable") === "true") return true;
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    return false;
  }

  // get accessible name
  function getName(el) {
    return (
      el.getAttribute("aria-label") ||
      (el.getAttribute("aria-labelledby") &&
        document
          .getElementById(el.getAttribute("aria-labelledby"))
          ?.textContent?.trim()) ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      // for inputs associated <label>
      (el.id &&
        document
          .querySelector(`label[for="${CSS.escape(el.id)}"]`)
          ?.textContent?.trim()) ||
      // button/link text content (first line, trimmed)
      (el.childNodes.length > 0 && getTextContent(el).slice(0, 80)) ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ");
  }

  function getTextContent(el) {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (
        node.nodeType === Node.ELEMENT_NODE &&
        !SKIP_TAGS.has(node.tagName)
      ) {
        text += " " + getTextContent(node);
      }
    }
    return text.trim();
  }

  // get element values
  function getValue(el) {
    if ("value" in el) return el.value || "";
    return "";
  }
  // get ARIA role (explicit or implicit)
  function getRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;

    // implicit role
    const tag = el.tagName;
    const implicit = {
      A: el.hasAttribute("href") ? "link" : null,
      BUTTON: "button",
      INPUT: getInputRole(el),
      SELECT: "combobox",
      TEXTAREA: "textbox",
      SUMMARY: "button",
      H1: "heading",
      H2: "heading",
      H3: "heading",
      H4: "heading",
      H5: "heading",
      H6: "heading",
      NAV: "navigation",
      MAIN: "main",
      HEADER: "banner",
      FOOTER: "contentinfo",
      FORM: "form",
      TABLE: "table",
      UL: "list",
      OL: "list",
      LI: "listitem",
      IMG: "img",
    };

    return implicit[tag] || null;
  }

  function getInputRole(el) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const roles = {
      checkbox: "checkbox",
      radio: "radio",
      range: "slider",
      number: "spinbutton",
      search: "searchbox",
      button: "button",
      submit: "button",
      reset: "button",
    };
    return roles[type] || "textbox";
  }

  // ─── Snapshot generation ─────────────────────────────────────
  function generateSnapshot() {
    idToNode.clear(); // rebuild reverse map each snapshot

    const elements = [];
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const scrollY = window.scrollY;
    const scrollX = window.scrollX;

    walkDOM(document.body, elements);

    // Collect visible text from non-interactive text blocks
    const textBlocks = [];
    collectText(document.body, textBlocks);
    const pageText = textBlocks.join("\n");

    return {
      url: location.href,
      title: document.title,
      scroll: {
        x: scrollX,
        y: scrollY,
        totalHeight: document.documentElement.scrollHeight,
        totalWidth: document.documentElement.scrollWidth,
        viewportHeight,
        viewportWidth,
        atTop: scrollY <= 0,
        atBottom:
          scrollY + viewportHeight >= document.documentElement.scrollHeight - 2,
      },
      elements,
      pageText,
    };
  }

  function walkDOM(node, elements) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (SKIP_TAGS.has(node.tagName)) return;
    if (!isVisible(node)) return;

    // If it's interactive, capture it
    if (isInteractive(node)) {
      const id = getNodeId(node);
      const rect = node.getBoundingClientRect();
      const role = getRole(node);
      const name = getName(node);
      const value = getValue(node);

      idToNode.set(id, node);

      elements.push({
        id,
        tag: node.tagName.toLowerCase(),
        role,
        name,
        value: value || undefined,
        rect: [
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
        ],
        disabled: node.disabled || undefined,
        checked: node.checked || undefined,
        focused: document.activeElement === node || undefined,
      });
    }

    // Recurse into children
    for (const child of node.children) {
      walkDOM(child, elements);
    }
  }

  const TEXT_TAGS = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "TD",
    "TH",
    "SPAN",
    "DIV",
    "SECTION",
    "ARTICLE",
    "BLOCKQUOTE",
    "PRE",
    "FIGCAPTION",
    "LABEL",
  ]);

  function collectText(node, blocks) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (SKIP_TAGS.has(node.tagName)) return;
    if (!isVisible(node)) return;

    // Only collect text from leaf-ish text containers
    if (TEXT_TAGS.has(node.tagName) || node.children.length === 0) {
      const text = getTextContent(node);
      if (text.length > 0 && text.length < 500) {
        blocks.push(text);
        return; // don't recurse into children — we got their text
      }
    }

    for (const child of node.children) {
      collectText(child, blocks);
    }
  }

  // ─── MutationObserver + settle detection ─────────────────────
  let settleTimer = null;
  const SETTLE_MS = 200;
  const SETTLE_MAX_MS = 3000;

  const observer = new MutationObserver(() => {
    // Reset settle timer on every mutation
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      // Page settled — push snapshot to background
      const snapshot = generateSnapshot();
      chrome.runtime
        .sendMessage({
          type: "settled",
          snapshot,
        })
        .catch(() => {}); // background might not be listening
    }, SETTLE_MS);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "hidden",
      "disabled",
      "aria-expanded",
      "aria-selected",
    ],
  });

  // ─── Action execution ────────────────────────────────────────
  function executeAction(action, params) {
    switch (action) {
      case "snapshot":
        return { ok: true, snapshot: generateSnapshot() };

      case "click": {
        const node = getNodeById(params.elementId);
        if (!node)
          return {
            ok: false,
            error: `Element ${params.elementId} not found (may have been removed)`,
          };
        node.focus();
        node.click();
        return { ok: true };
      }

      case "type": {
        const node = getNodeById(params.elementId);
        if (!node)
          return { ok: false, error: `Element ${params.elementId} not found` };
        node.focus();
        if (node.isContentEditable) {
          node.textContent = params.text;
        } else {
          node.value = params.text;
        }
        // Dispatch events
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }

      case "scroll": {
        const amount = params.amount || 500;
        switch (params.direction) {
          case "up":
            window.scrollBy(0, -amount);
            break;
          case "down":
            window.scrollBy(0, amount);
            break;
          case "left":
            window.scrollBy(-amount, 0);
            break;
          case "right":
            window.scrollBy(amount, 0);
            break;
        }
        return { ok: true };
      }

      case "eval": {
        try {
          const result = eval(params.expression);
          return { ok: true, result };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      case "upload": {
        const node = getNodeById(params.elementId);
        if (!node) {
          return { ok: false, error: `Element ${params.elementId} not found` };
        }
        if (node.tagName !== "INPUT" || node.type !== "file") {
          return { ok: false, error: `Element ${params.elementId} is not a file input` };
        }
        
        // Convert base64 to blob
        const byteCharacters = atob(params.fileData);
        const byteArrays = [];
        for (let offset = 0; offset < byteCharacters.length; offset += 512) {
          const slice = byteCharacters.slice(offset, offset + 512);
          const byteNumbers = new Array(slice.length);
          for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          byteArrays.push(byteArray);
        }
        const blob = new Blob(byteArrays, { type: params.mimeType });
        
        // Create file from blob
        const file = new File([blob], params.fileName, { type: params.mimeType });
        
        // Create DataTransfer to set files
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        node.files = dataTransfer.files;
        
        // Dispatch events
        node.dispatchEvent(new Event("change", { bubbles: true }));
        
        return { ok: true };
      }

      case "download": {
        // Create a temporary link to trigger download
        const link = document.createElement("a");
        link.href = params.url;
        if (params.filename) {
          link.download = params.filename;
        }
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  }

  // ─── Message handler (from background script) ────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { action, params, id } = message;

    try {
      // Generate a fresh snapshot for this message cycle
      generateSnapshot();

      const result = executeAction(action, params || {});

    // For mutating actions, wait for settle then send snapshot
    if (["click", "type", "scroll", "upload"].includes(action)) {
      // Start settle wait
      if (settleTimer) clearTimeout(settleTimer);

      let settled = false;
      let maxTimer = null;

      const onSettle = () => {
        if (settled) return;
        settled = true;
        if (maxTimer) clearTimeout(maxTimer);
        const snapshot = generateSnapshot();
        sendResponse({ id, ...result, snapshot });
      };

      settleTimer = setTimeout(onSettle, SETTLE_MS);
      maxTimer = setTimeout(onSettle, SETTLE_MAX_MS);

      // If action itself failed, respond immediately
      if (!result.ok) {
        settled = true;
        if (settleTimer) clearTimeout(settleTimer);
        if (maxTimer) clearTimeout(maxTimer);
        sendResponse({ id, ...result });
      }

      return true; // keep channel open for async response
    }

    // For non-mutating actions (snapshot, eval), respond immediately
      sendResponse({ id, ...result });
      return false;
    } catch (e) {
      sendResponse({ id, ok: false, error: `${e.name}: ${e.message}` });
      return false;
    }
  });
} // end if __zbctl guard
