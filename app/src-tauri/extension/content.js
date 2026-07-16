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
    const direct =
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
      "";
    if (direct) return direct.trim().replace(/\s+/g, " ");

    // Role-based containers (radio/checkbox/option, common in Google Forms,
    // Typeform, SurveyMonkey) often carry no aria-label — their label is the
    // text content of the element or its nearest ancestor "label" wrapper.
    // Walk descendants first (most specific), then fall back to a short
    // ancestor climb to find the associated label text.
    const own = getTextContent(el);
    if (own) return own.slice(0, 80).trim().replace(/\s+/g, " ");

    const role = el.getAttribute("role");
    if (role === "radio" || role === "checkbox" || role === "option") {
      let p = el.parentElement;
      for (let depth = 0; depth < 3 && p; depth++, p = p.parentElement) {
        const t = getTextContent(p);
        if (t) return t.slice(0, 80).trim().replace(/\s+/g, " ");
      }
    }
    return "";
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
        const role = getRole(node);
        const isToggle = role === "radio" || role === "checkbox" ||
          node.tagName === "INPUT" && (node.type === "radio" || node.type === "checkbox");
        // Record checked state BEFORE clicking so we can verify it flipped.
        const wasChecked = isToggle ? !!node.checked : null;

        node.focus();
        node.click();

        // Google Forms (and many frameworks) put the click handler on a wrapping
        // <label> or role="radio" container, not the <input> itself. If a toggle
        // didn't actually flip, try the nearest ancestor <label> / [role="radio"]
        // / [role="checkbox"], then a real MouseEvent as a last resort.
        let verified = true;
        if (isToggle && !!node.checked === wasChecked) {
          const alt = node.closest('label, [role="radio"], [role="checkbox"], [role="menuitemradio"], [role="menuitemcheckbox"]');
          if (alt && alt !== node) {
            alt.click();
          }
          if (!!node.checked === wasChecked) {
            node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          }
          verified = !!node.checked !== wasChecked;
        }

        const out = { ok: true };
        if (isToggle) out.checked = !!node.checked;
        if (isToggle && !verified) {
          // We clicked but the checked state did not change. Don't claim success —
          // tell the model so it can re-snapshot and find the real clickable target.
          out.ok = false;
          out.error = `Clicked element ${params.elementId} but its checked state did not change (still ${wasChecked ? "checked" : "unchecked"}). The real click target may be a parent <label> or role="radio" wrapper — re-snapshot and try clicking the wrapper.`;
        }
        return out;
      }

      case "type": {
        const node = getNodeById(params.elementId);
        if (!node)
          return { ok: false, error: `Element ${params.elementId} not found` };

        // Only real text-entry elements accept typed text. Setting .value on a
        // radio/checkbox/button/select is a silent no-op, but historically
        // returned ok:true — which caused the agent to believe it had filled a
        // form when nothing happened. Reject explicitly with actionable guidance.
        const role = getRole(node);
        const isTextTarget = node.isContentEditable ||
          node.tagName === "TEXTAREA" ||
          (node.tagName === "INPUT" && !["radio", "checkbox", "button", "submit", "reset", "image", "file", "hidden", "range"].includes((node.type || "text").toLowerCase())) ||
          role === "textbox" || role === "searchbox" || role === "spinbutton";
        if (!isTextTarget) {
          const hint = (role === "radio" || role === "checkbox")
            ? `Element ${params.elementId} is a ${role} — use browser_click to select it, not browser_type.`
            : `Element ${params.elementId} (role=${role || node.tagName}) is not a text input — use browser_click instead.`;
          return { ok: false, error: hint };
        }

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
        // Handled in the background via chrome.scripting MAIN-world injection
        // (CSP-safe). If this reaches the content script, the background path
        // is unavailable — return a clear pointer rather than tripping CSP.
        return {
          ok: false,
          error:
            "eval must run via background MAIN-world injection; this content-script path is deprecated.",
        };
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

      // For mutating actions, wait for the page to settle, then respond with a
      // fresh snapshot so the agent sees the post-action state.
      //
      // IMPORTANT: use LOCAL timers here, NOT the module-level `settleTimer`.
      // That timer belongs to the push-based MutationObserver path (see above).
      // Reusing it across concurrent onMessage invocations — which happens when
      // the agent fires several clicks in one turn — caused each new message to
      // `clearTimeout` the previous message's settle timer, orphaning its
      // sendResponse and producing "message channel closed before a response
      // was received" errors. Each request gets its own independent timers.
      if (["click", "type", "scroll", "upload"].includes(action)) {
        // If the action itself failed synchronously, respond immediately — no
        // point waiting for mutations that won't come.
        if (!result.ok) {
          sendResponse({ id, ...result });
          return false;
        }

        let settled = false;
        let settleLocal = null;
        let maxLocal = null;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (settleLocal) clearTimeout(settleLocal);
          if (maxLocal) clearTimeout(maxLocal);
          const snapshot = generateSnapshot();
          sendResponse({ id, ...result, snapshot });
        };

        settleLocal = setTimeout(finish, SETTLE_MS);
        maxLocal = setTimeout(finish, SETTLE_MAX_MS);

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
