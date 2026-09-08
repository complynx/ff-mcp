(function () {
  "use strict";

  const documentToken = crypto.randomUUID();
  const references = new Map();
  const elementReferences = new WeakMap();
  let nextReference = 0;

  function reference(element) {
    let ref = elementReferences.get(element);
    if (!ref) {
      ref = `@${documentToken}:${++nextReference}`;
      elementReferences.set(element, ref);
    }
    references.set(ref, element);
    return ref;
  }
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
      ref: reference(element),
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

  function visible(element) {
    return Boolean(element.getClientRects().length &&
      !["hidden", "collapse"].includes(getComputedStyle(element).visibility));
  }

  // Keep one actionable record per control; never include input values.
  function compactElement(element) {
    const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
    const label = labelledBy || element.getAttribute("aria-label") ||
      Array.from(element.labels || []).map((item) => item.innerText).join(" ") ||
      element.innerText || element.getAttribute("title") || element.getAttribute("placeholder");
    const result = { ref: reference(element), tag: element.tagName.toLowerCase() };
    const name = clipped(label, 300);
    if (name) result.name = name;
    if (String(label || "").replace(/\s+/g, " ").trim().length > 300) result.nameTruncated = true;
    for (const key of ["role", "type", "href"]) {
      const value = key === "href" && typeof element.href === "string"
        ? element.href : element.getAttribute(key);
      if (value) {
        result[key] = clipped(value, 1000);
        if (String(value).length > 1000) result[`${key}Truncated`] = true;
      }
    }
    if (element.disabled || element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") result.disabled = true;
    if (["checkbox", "radio"].includes(element.type)) result.checked = Boolean(element.checked);
    for (const key of ["checked", "expanded", "selected", "pressed"]) {
      const value = element.getAttribute(`aria-${key}`);
      if (value !== null) result[key] = value;
    }
    return result;
  }

  function snapshot(params) {
    const compact = params.compact !== false;
    const maxChars = Math.max(1000, Math.min(Number(params.maxChars) || 12000, 200000));
    const headingElements = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .filter((element) => !compact || visible(element));
    const headings = headingElements
      .slice(0, 200)
      .map((element) => ({ level: Number(element.tagName.slice(1)), text: clipped(element.innerText) }));
    let remainingFields = MAX_SNAPSHOT_FIELDS;
    const forms = (compact ? [] : Array.from(document.forms).slice(0, 100)).map((form) => {
      const fields = Array.from(form.elements).slice(0, remainingFields).map(elementData);
      remainingFields -= fields.length;
      return {
        action: clipped(form.action),
        method: clipped(form.method, 20),
        fields,
      };
    });
    // Drop detached nodes while keeping references stable for the current document.
    for (const [ref, element] of references) {
      if (element.isConnected === false) references.delete(ref);
    }
    const controls = Array.from(document.querySelectorAll(
        "a[href],button,input,textarea,select,[role=button],[role=link],[contenteditable=true]"
      )).filter((element) => compact ? visible(element) : element.getClientRects().length);
    const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const result = {
      elements: controls.slice(0, 200).map(compact ? compactElement : elementData),
      documentToken,
      url: clipped(location.href),
      title: clipped(document.title),
      language: clipped(document.documentElement.lang, 100) || null,
      text: clipped(document.body ? document.body.innerText : "", maxChars),
      headings,
      ...(compact ? { compact: true, truncation: {
        text: bodyText.length > maxChars,
        omittedElements: Math.max(0, controls.length - 200),
        omittedHeadings: Math.max(0, headingElements.length - 200),
        headingText: headingElements.slice(0, 200).some((element) => String(element.innerText || "").replace(/\s+/g, " ").trim().length > 2000),
      } } : { forms }),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    };
    if (!compact && params.includeLinks !== false) {
      result.links = Array.from(document.links).slice(0, 500).map((link) => ({
        ref: reference(link),
        text: clipped(link.innerText),
        href: clipped(link.href),
      }));
    }
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error("Snapshot exceeds the 4 MiB result limit");
    }
    return result;
  }

  function conditionMatches(condition) {
    if (document.readyState === "loading") return false;
    if (condition.url !== undefined && new URL(condition.url).href !== location.href) return false;
    let element;
    if (condition.selector !== undefined) {
      element = condition.selector.startsWith("@")
        ? references.get(condition.selector) : document.querySelector(condition.selector);
      if (element?.isConnected === false) element = null;
      const visible = Boolean(element && element.getClientRects().length &&
        !["hidden", "collapse"].includes(getComputedStyle(element).visibility));
      switch (condition.state || "visible") {
        case "attached": if (!element) return false; break;
        case "detached": if (element) return false; break;
        case "visible": if (!visible) return false; break;
        case "hidden": if (visible) return false; break;
        case "enabled":
          if (!visible || element.disabled || element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return false;
          break;
        default: throw new Error("Unsupported wait state");
      }
    }
    if (condition.text !== undefined) {
      const text = condition.selector ? element?.innerText : document.body?.innerText;
      if (!String(text || "").includes(condition.text)) return false;
    }
    return true;
  }

  function target(selector) {
    const element = typeof selector === "string" && selector.startsWith("@")
      ? references.get(selector) : document.querySelector(selector);
    if (element && element.isConnected === false) throw new Error("Element reference is stale; take a new snapshot");
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
        const value = action.clear === false ? element.value + String(action.text || "") : String(action.text || "");
        // Use the native setter so controlled framework inputs see the change event.
        const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
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
      case "document.info": return Promise.resolve({ documentToken, url: location.href, title: document.title, readyState: document.readyState });
      case "page.wait": {
        const matched = conditionMatches(message.condition || {});
        return Promise.resolve({ matched, snapshot: matched ? snapshot(message.params || {}) : undefined });
      }
      case "page.snapshot": return Promise.resolve(snapshot(message.params || {}));
      case "page.query": return Promise.resolve({ documentToken, elements: query(message.selector, message.limit) });
      case "page.actions": {
        const results = [];
        let error;
        for (const action of message.actions) {
          try {
            if (!sameAuthorizationUrl(message.expectedUrl)) throw new Error("Page navigated during actions");
            results.push(interact(action));
          } catch (failure) {
            error = failure.message;
            break;
          }
        }
        let page;
        if (sameAuthorizationUrl(message.expectedUrl)) {
          try { page = snapshot({ maxChars: 12000 }); }
          catch (failure) { error = error || failure.message; }
        } else {
          error = error || "Page navigated during actions; take a new snapshot";
        }
        return Promise.resolve({ documentToken, results, completed: results.length, error, snapshot: page });
      }
      case "page.interact": return Promise.resolve({ documentToken, ...interact(message.action) });
      default: return undefined;
    }
  });
})();
