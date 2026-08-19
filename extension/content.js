(function () {
  "use strict";

  const documentToken = crypto.randomUUID();
  const SAFE_ATTRIBUTES = ["aria-label", "aria-describedby", "href", "name", "placeholder", "role", "title", "type"];
  const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
  const MAX_SNAPSHOT_FIELDS = 200;

  function clipped(value, length = 2000) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, length);
  }

  function elementData(element) {
    const attributes = {};
    for (const name of SAFE_ATTRIBUTES) {
      if (element.hasAttribute(name)) attributes[name] = clipped(element.getAttribute(name), 1000);
    }
    return {
      tag: element.tagName.toLowerCase(),
      text: clipped(element.innerText || element.textContent),
      attributes,
      disabled: Boolean(element.disabled),
      checked: typeof element.checked === "boolean" ? element.checked : undefined,
    };
  }

  function query(selector, limit) {
    if (typeof selector !== "string" || !selector || selector.length > 1000) {
      throw new Error("selector must contain 1 to 1000 characters");
    }
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return Array.from(document.querySelectorAll(selector)).slice(0, boundedLimit).map(elementData);
  }

  function snapshot(params) {
    const maxChars = Math.max(1000, Math.min(Number(params.maxChars) || 50000, 200000));
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .slice(0, 200)
      .map((element) => ({ level: Number(element.tagName.slice(1)), text: clipped(element.innerText) }));
    let remainingFields = MAX_SNAPSHOT_FIELDS;
    const forms = Array.from(document.forms).slice(0, 100).map((form) => {
      const fields = Array.from(form.elements).slice(0, remainingFields).map(elementData);
      remainingFields -= fields.length;
      return {
        action: clipped(form.action),
        method: clipped(form.method, 20),
        fields,
      };
    });
    const result = {
      documentToken,
      url: clipped(location.href),
      title: clipped(document.title),
      language: clipped(document.documentElement.lang, 100) || null,
      text: clipped(document.body ? document.body.innerText : "", maxChars),
      headings,
      forms,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    };
    if (params.includeLinks !== false) {
      result.links = Array.from(document.links).slice(0, 500).map((link) => ({
        text: clipped(link.innerText),
        href: clipped(link.href),
      }));
    }
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error("Snapshot exceeds the 4 MiB result limit");
    }
    return result;
  }

  function target(selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`No element matches selector: ${selector}`);
    return element;
  }

  function sameAuthorizationUrl(expectedUrl) {
    return new URL(expectedUrl).href === new URL(location.href).href;
  }

  function interact(action) {
    if (!action || typeof action.kind !== "string") throw new Error("Missing interaction kind");
    if (action.kind === "click") {
      const element = target(action.selector);
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return { performed: "click" };
    }
    if (action.kind === "type") {
      const element = target(action.selector);
      const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      if (!editable && !element.isContentEditable) throw new Error("Target is not editable");
      element.focus();
      if (editable) {
        element.value = action.clear === false ? element.value + String(action.text || "") : String(action.text || "");
      } else {
        element.textContent = action.clear === false ? element.textContent + String(action.text || "") : String(action.text || "");
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(action.text || "") }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { performed: "type" };
    }
    if (action.kind === "scroll") {
      const destination = action.selector ? target(action.selector) : window;
      destination.scrollBy({ left: Number(action.x) || 0, top: Number(action.y) || 0, behavior: "instant" });
      return { performed: "scroll" };
    }
    if (action.kind === "navigate") {
      location.assign(action.url);
      return { performed: "navigate", url: action.url };
    }
    throw new Error(`Unsupported interaction: ${action.kind}`);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message && message.expectedDocumentToken && message.expectedDocumentToken !== documentToken) {
      return Promise.reject(new Error("The document changed after access was authorized"));
    }
    if (message && message.expectedUrl && !sameAuthorizationUrl(message.expectedUrl)) {
      return Promise.reject(new Error("The document URL changed after access was authorized"));
    }
    switch (message && message.type) {
      case "document.info": return Promise.resolve({ documentToken, url: location.href, title: document.title });
      case "page.snapshot": return Promise.resolve(snapshot(message.params || {}));
      case "page.query": return Promise.resolve({ documentToken, elements: query(message.selector, message.limit) });
      case "page.interact": return Promise.resolve({ documentToken, ...interact(message.action) });
      default: return undefined;
    }
  });
})();
