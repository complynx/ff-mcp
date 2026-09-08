"use strict";

const HOST_NAME = "io.github.ff_mcp";
const CAPABILITIES = new Set(["READ", "INTERACT", "SCRIPT", "SCREENSHOT"]);
const LIFETIMES = new Set(["once", "document", "tab_session", "persistent"]);
const state = {
  enabled: true,
  port: null,
  host: null,
  grants: [],
  pending: [],
  rules: [],
  rulesRevision: 0,
  audit: [],
};
const pendingApprovals = new Set();
const approvalTabs = new Map();
const invalidatedApprovals = new Set();
let rulesQueue = Promise.resolve();
let hostGeneration = 0;

const ready = browser.storage.local.get(["rules", "rulesRevision", "audit", "enabled"]).then(async (stored) => {
  state.enabled = stored.enabled !== false;
  state.rules = Array.isArray(stored.rules) ? stored.rules : [];
  state.rulesRevision = Number.isSafeInteger(stored.rulesRevision) && stored.rulesRevision >= 0 ? stored.rulesRevision : 0;
  state.audit = Array.isArray(stored.audit) ? stored.audit : [];
  if (!state.rules.some((rule) => rule.id === FFMCPRuleModel.DEFAULT_RULE_ID)) {
    state.rules = [FFMCPRuleModel.defaultRule(), ...state.rules];
    state.rulesRevision += 1;
    await browser.storage.local.set({ rules: state.rules, rulesRevision: state.rulesRevision });
  }
});

function randomId() {
  return crypto.randomUUID();
}

function serializeRules(operation) {
  const result = rulesQueue.then(operation, operation);
  rulesQueue = result.then(() => undefined, () => undefined);
  return result;
}

function publicState() {
  return {
    enabled: state.enabled,
    running: Boolean(state.port && state.host),
    starting: Boolean(state.port && !state.host),
    host: state.host,
    grants: state.grants,
    pending: state.pending,
    rules: state.rules,
    rulesRevision: state.rulesRevision,
    audit: state.audit.slice(-100).reverse(),
  };
}

async function audit(event, details = {}) {
  state.audit.push({ id: randomId(), at: new Date().toISOString(), event, ...details });
  state.audit = state.audit.slice(-500);
  try {
    await browser.storage.local.set({ audit: state.audit });
  } catch (error) {
    console.error("ff-mcp audit persistence failed:", error);
  }
}

async function updateBadge() {
  const pendingCount = state.pending.length;
  await browser.action.setBadgeText({ text: pendingCount ? String(pendingCount) : state.host ? "ON" : "" });
  await browser.action.setBadgeBackgroundColor({ color: pendingCount ? "#b45309" : "#167d4c" });
}

function currentHost(generation) {
  return state.enabled && state.port && generation === hostGeneration;
}

async function openPendingPopup(tabId, generation) {
  try {
    if (!currentHost(generation)) return;
    const tab = await browser.tabs.get(tabId);
    if (!currentHost(generation)) return;
    await browser.windows.update(tab.windowId, { focused: true });
    if (!currentHost(generation)) return;
    await browser.action.openPopup({ windowId: tab.windowId });
  } catch (error) {
    console.warn("ff-mcp could not open the access request popup; the request remains pending:", error);
  }
}

function startHost() {
  if (state.port) return;
  const port = browser.runtime.connectNative(HOST_NAME);
  const generation = ++hostGeneration;
  state.port = port;
  state.host = null;
  port.onMessage.addListener((message) => {
    if (!currentHost(generation)) return;
    if (message.type === "host.ready") {
      state.host = {
        url: message.url,
        serverInstanceId: message.serverInstanceId,
      };
      audit("host.started", { url: message.url });
      updateBadge();
    } else if (message.type === "bridge.request") {
      handleBridgeRequest(message);
    }
  });
  port.onDisconnect.addListener(() => {
    const error = browser.runtime.lastError;
    if (error) console.warn("ff-mcp native host disconnected:", error.message);
    if (state.port === port) {
      hostGeneration += 1;
      state.port = null;
      state.host = null;
      state.grants = [];
      state.pending = [];
      if (state.enabled) browser.alarms.create("reconnect", { delayInMinutes: 0.1 });
      updateBadge();
    }
    audit("host.stopped", error ? { error: error.message } : {});
  });
  port.postMessage({ type: "extension.ready", version: browser.runtime.getManifest().version });
  updateBadge();
}

function stopHost() {
  hostGeneration += 1;
  state.grants = [];
  state.pending = [];
  if (!state.port) return;
  const port = state.port;
  state.port = null;
  state.host = null;
  port.postMessage({ type: "host.shutdown" });
  port.disconnect();
  updateBadge();
}

async function documentInfo(tabId) {
  try {
    const info = await browser.tabs.sendMessage(tabId, { type: "document.info" });
    if (!info || typeof info.documentToken !== "string" || typeof info.url !== "string") {
      throw new Error("Firefox returned invalid document information");
    }
    return info;
  } catch (_) {
    throw new Error("This page cannot be accessed by a Firefox content script");
  }
}

function validCapabilities(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("At least one capability is required");
  const normalized = Array.from(new Set(values.map((value) => String(value).toUpperCase())));
  if (!normalized.every((value) => CAPABILITIES.has(value))) throw new Error("Unknown capability requested");
  return normalized;
}

function matchingRule(url, capability) {
  for (const rule of state.rules) {
    if (!rule.enabled || !Array.isArray(rule.capabilities) || !rule.capabilities.includes(capability)) continue;
    try {
      if (FFMCPPolicy.matches(rule.expression, url)) return rule;
    } catch (_) {
      continue;
    }
  }
  return null;
}

async function authorization(clientId, tabId, capability, consume = true) {
  return authorizationForInfo(clientId, tabId, capability, await documentInfo(tabId), consume);
}

function authorizationForInfo(clientId, tabId, capability, info, consume = true) {
  const rule = matchingRule(info.url, capability);
  if (rule) return { source: "rule", ruleId: rule.id, documentToken: info.documentToken, url: info.url };

  const index = state.grants.findIndex((grant) =>
    grant.clientId === clientId && grant.tabId === tabId && grant.capabilities.includes(capability) &&
    (grant.lifetime === "tab_session" ||
      (grant.documentToken === info.documentToken && new URL(grant.url).href === new URL(info.url).href))
  );
  if (index < 0) throw new Error(`${capability} access is required for tab ${tabId}`);
  const grant = state.grants[index];
  if (consume && grant.lifetime === "once") state.grants.splice(index, 1);
  return { source: "grant", grantId: grant.id, documentToken: info.documentToken, url: info.url };
}

const WAIT_STATES = new Set(["attached", "detached", "visible", "hidden", "enabled"]);

function waitOptions(params) {
  const timeout = params.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 20000) {
    throw new Error("timeout_ms must be an integer from 1 to 20000");
  }
  const condition = params.waitFor ?? {};
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) throw new Error("Invalid wait condition");
  for (const key of Object.keys(condition)) {
    if (!["selector", "state", "text", "url"].includes(key)) throw new Error(`Unknown wait field: ${key}`);
  }
  for (const [key, limit] of [["selector", 1000], ["text", 2000], ["url", 10000]]) {
    if (condition[key] !== undefined && (typeof condition[key] !== "string" || !condition[key] || condition[key].length > limit)) {
      throw new Error(`${key} must contain 1 to ${limit} characters`);
    }
  }
  if (condition.state !== undefined && (!condition.selector || !WAIT_STATES.has(condition.state))) {
    throw new Error("An element state requires a selector and a supported state");
  }
  if (condition.url !== undefined) {
    const url = new URL(condition.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Wait URL must use HTTP(S)");
  }
  return { condition, timeout };
}

class WaitTimeout extends Error {}

// Bound even a content-script request that never settles; always clear its timer.
async function beforeDeadline(operation, deadline) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new WaitTimeout()), Math.max(0, deadline - Date.now())); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPage(clientId, tabId, params, generation, navigationFrom = null) {
  const { condition, timeout } = waitOptions(params);
  const deadline = Date.now() + timeout;
  do {
    if (!currentHost(generation)) throw new Error("MCP session disconnected");
    try {
      let info;
      try { info = await beforeDeadline(documentInfo(tabId), deadline); }
      catch (error) { if (error instanceof WaitTimeout) throw error; }
      if (!currentHost(generation)) throw new Error("MCP session disconnected");
      if (info && info.readyState !== "loading") {
        if (navigationFrom) {
          if (info.documentToken !== navigationFrom.documentToken || info.url !== navigationFrom.url) {
            return { status: "ready", url: info.url };
          }
        } else {
          const auth = authorizationForInfo(clientId, tabId, "READ", info, false);
          let result;
          try {
            result = await beforeDeadline(browser.tabs.sendMessage(tabId, {
              type: "page.wait", condition, params,
              expectedDocumentToken: auth.documentToken, expectedUrl: auth.url,
            }), deadline);
          } catch (error) {
            if (!/document changed|document URL changed|Receiving end|message port|Could not establish/i.test(error.message)) throw error;
          }
          if (!currentHost(generation)) throw new Error("MCP session disconnected");
          // Revocation during the probe must prevent the result from escaping.
          authorizationForInfo(clientId, tabId, "READ", info, false);
          if (result?.matched) {
            authorizationForInfo(clientId, tabId, "READ", info);
            return { status: "ready", snapshot: result.snapshot };
          }
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    } catch (error) {
      if (error instanceof WaitTimeout) break;
      throw error;
    }
  } while (Date.now() <= deadline);
  return { status: "timeout", timeoutMs: timeout };
}

function identity(params) {
  const result = {};
  for (const key of ["agent", "model", "harness", "reason"]) {
    const limit = key === "reason" ? 500 : 128;
    if (typeof params[key] !== "string" || !params[key].trim() || params[key].length > limit) {
      throw new Error(`${key} must contain 1 to ${limit} characters`);
    }
    result[key] = params[key].trim();
  }
  return result;
}

async function requestGrant(clientId, params, generation) {
  const requester = identity(params);
  const tabId = Number(params.tabId);
  const capabilities = validCapabilities(params.capabilities);
  const lifetime = LIFETIMES.has(params.lifetime) ? params.lifetime : "document";
  let info = await documentInfo(tabId);
  const alreadyAllowed = [];
  for (const capability of capabilities) {
    try {
      const auth = await authorization(clientId, tabId, capability, false);
      if (auth.documentToken === info.documentToken) alreadyAllowed.push(capability);
    } catch (_) {}
  }
  if (capabilities.includes("SCRIPT")) {
    const scriptingEnabled = await browser.permissions.contains({ permissions: ["userScripts"] });
    if (!scriptingEnabled) {
      const index = alreadyAllowed.indexOf("SCRIPT");
      if (index >= 0) alreadyAllowed.splice(index, 1);
    }
  }
  if (alreadyAllowed.length === capabilities.length) {
    return { status: "granted", capabilities };
  }
  info = await documentInfo(tabId);
  if (!currentHost(generation)) throw new Error("MCP session disconnected");
  const existing = state.pending.find((pending) =>
    Object.keys(requester).every((key) => pending[key] === requester[key]) &&
    pending.clientId === clientId && pending.tabId === tabId &&
    pending.documentToken === info.documentToken && pending.requestedLifetime === lifetime &&
    pending.capabilities.length === capabilities.length &&
    capabilities.every((capability) => pending.capabilities.includes(capability))
  );
  if (existing) {
    return { status: "pending", requestId: existing.id };
  }
  const pending = {
    id: randomId(),
    clientId,
    tabId,
    documentToken: info.documentToken,
    title: info.title,
    url: info.url,
    capabilities,
    requestedLifetime: lifetime,
    ...requester,
    createdAt: new Date().toISOString(),
  };
  state.pending.push(pending);
  await audit("grant.requested", { clientId, tabId, capabilities });
  await updateBadge();
  await openPendingPopup(tabId, generation);
  return { status: "pending", requestId: pending.id, message: "Approve the request from the ff-mcp toolbar popup." };
}

async function approvePending(requestId, lifetime) {
  const generation = hostGeneration;
  const requested = state.pending.find((pending) => pending.id === requestId);
  if (!requested) throw new Error("Pending request no longer exists");
  if (pendingApprovals.has(requestId)) throw new Error("Pending request is already being approved");
  pendingApprovals.add(requestId);
  approvalTabs.set(requestId, requested.tabId);
  invalidatedApprovals.delete(requestId);
  try {
    const info = await documentInfo(requested.tabId);
    const index = state.pending.findIndex((pending) => pending.id === requestId);
    if (index < 0) throw new Error("Pending request no longer exists");
    const pending = state.pending[index];
    if (info.documentToken !== pending.documentToken || new URL(info.url).href !== new URL(pending.url).href) {
      state.pending.splice(index, 1);
      await updateBadge();
      throw new Error("The document or URL changed before access was approved");
    }
    const selectedLifetime = LIFETIMES.has(lifetime) ? lifetime : "document";
    if (selectedLifetime === "persistent") {
      const url = new URL(pending.url);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
        throw new Error("Persistent grants require an HTTP(S) hostname");
      }
      const hostname = url.hostname.toLowerCase();
      await serializeRules(async () => {
        const lockedIndex = state.pending.findIndex((value) => value.id === requestId);
        if (lockedIndex < 0) throw new Error("Pending request no longer exists");
        const lockedInfo = await documentInfo(pending.tabId);
        const currentIndex = state.pending.findIndex((value) => value.id === requestId);
        if (currentIndex < 0) throw new Error("Pending request no longer exists");
        if (lockedInfo.documentToken !== pending.documentToken || new URL(lockedInfo.url).href !== new URL(pending.url).href) {
          state.pending.splice(currentIndex, 1);
          await updateBadge();
          throw new Error("The document or URL changed before access was approved");
        }
        const visual = FFMCPRuleModel.blankTree();
        visual.children[0].children.push(FFMCPRuleModel.predicate("host", hostname));
        const rule = {
          id: randomId(),
          name: `Always allow ${hostname}`,
          expression: FFMCPRuleModel.toExpression(visual),
          visual,
          capabilities: pending.capabilities,
          enabled: true,
        };
        const nextRules = [...state.rules, rule];
        const nextRevision = state.rulesRevision + 1;
        state.pending.splice(currentIndex, 1);
        try {
          await browser.storage.local.set({ rules: nextRules, rulesRevision: nextRevision });
        } catch (error) {
          let restore = currentHost(generation) && !invalidatedApprovals.has(requestId);
          if (restore) {
            try {
              const rollbackInfo = await documentInfo(pending.tabId);
              restore = currentHost(generation) && !invalidatedApprovals.has(requestId) &&
                rollbackInfo.documentToken === pending.documentToken &&
                new URL(rollbackInfo.url).href === new URL(pending.url).href;
            } catch (_) {
              restore = false;
            }
          }
          if (restore) state.pending.push(pending);
          await updateBadge();
          throw error;
        }
        state.rules = nextRules;
        state.rulesRevision = nextRevision;
      });
    } else {
      state.pending.splice(index, 1);
      state.grants.push({
        id: randomId(),
        clientId: pending.clientId,
        tabId: pending.tabId,
        documentToken: pending.documentToken,
        capabilities: pending.capabilities,
        lifetime: selectedLifetime,
        createdAt: new Date().toISOString(),
        agent: pending.agent,
        model: pending.model,
        harness: pending.harness,
        reason: pending.reason,
        title: pending.title,
        url: pending.url,
      });
    }
    await audit("grant.approved", { clientId: pending.clientId, tabId: pending.tabId, capabilities: pending.capabilities, lifetime: selectedLifetime });
    await updateBadge();
    return publicState();
  } finally {
    pendingApprovals.delete(requestId);
    approvalTabs.delete(requestId);
    invalidatedApprovals.delete(requestId);
  }
}

async function denyPending(requestId) {
  if (pendingApprovals.has(requestId)) throw new Error("Pending request is already being approved");
  const index = state.pending.findIndex((pending) => pending.id === requestId);
  if (index < 0) return publicState();
  const pending = state.pending[index];
  state.pending.splice(index, 1);
  await audit("grant.denied", { clientId: pending.clientId, tabId: pending.tabId });
  await updateBadge();
  return publicState();
}

async function executeBridge(method, params, clientId, generation) {
  await ready;
  if (!currentHost(generation)) throw new Error("MCP session disconnected");
  switch (method) {
    case "tabs.list": {
      const tabs = await browser.tabs.query({});
      return { tabs: tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active, pinned: tab.pinned })) };
    }
    case "grants.request": return requestGrant(clientId, params, generation);
    case "grants.list": return { grants: state.grants.filter((grant) => grant.clientId === clientId), pending: state.pending.filter((pending) => pending.clientId === clientId) };
    case "grants.revoke": {
      const before = state.grants.length;
      state.grants = state.grants.filter((grant) => !(grant.id === params.grantId && grant.clientId === clientId));
      await audit("grant.revoked", { clientId, grantId: params.grantId });
      return { revoked: state.grants.length < before };
    }
    case "page.wait": {
      const result = await waitForPage(clientId, Number(params.tabId), params, generation);
      await audit("page.wait", { clientId, tabId: params.tabId, status: result.status });
      return result;
    }
    case "page.snapshot": {
      if (params.waitFor !== undefined) {
        const waited = await waitForPage(clientId, Number(params.tabId), params, generation);
        await audit("page.snapshot", { clientId, tabId: params.tabId, status: waited.status });
        return waited.status === "ready" ? waited.snapshot : waited;
      }
      const auth = await authorization(clientId, Number(params.tabId), "READ");
      const result = await browser.tabs.sendMessage(Number(params.tabId), { type: "page.snapshot", params, expectedDocumentToken: auth.documentToken, expectedUrl: auth.url });
      await audit("page.snapshot", { clientId, tabId: params.tabId, auth });
      return result;
    }
    case "page.query": {
      const auth = await authorization(clientId, Number(params.tabId), "READ");
      const result = await browser.tabs.sendMessage(Number(params.tabId), { type: "page.query", selector: params.selector, limit: params.limit, expectedDocumentToken: auth.documentToken, expectedUrl: auth.url });
      await audit("page.query", { clientId, tabId: params.tabId, auth });
      return result;
    }
    case "page.interact": {
      const auth = await authorization(clientId, Number(params.tabId), "INTERACT");
      const result = await browser.tabs.sendMessage(Number(params.tabId), { type: "page.interact", action: params.action, expectedDocumentToken: auth.documentToken, expectedUrl: auth.url });
      await audit("page.interact", { clientId, tabId: params.tabId, action: params.action && params.action.kind, auth });
      return result;
    }
    case "page.actions": {
      const tabId = Number(params.tabId);
      if (!Array.isArray(params.actions) || !params.actions.length || params.actions.length > 20 ||
          params.actions.some((action) => !action || !["click", "type", "scroll"].includes(action.kind))) {
        throw new Error("Provide 1 to 20 click/type/scroll actions");
      }
      // Check both capabilities before consuming a one-operation grant.
      const read = await authorization(clientId, tabId, "READ", false);
      const auth = await authorization(clientId, tabId, "INTERACT", false);
      if (read.documentToken !== auth.documentToken || read.url !== auth.url) {
        throw new Error("Document changed while authorizing actions");
      }
      // Another request can consume or revoke READ while INTERACT is being checked.
      for (const [access, capability] of [[read, "READ"], [auth, "INTERACT"]]) {
        const current = access.source === "rule"
          ? matchingRule(access.url, capability)
          : state.grants.find((grant) => grant.id === access.grantId);
        if (!current) throw new Error("Access was revoked while authorizing actions");
      }
      state.grants = state.grants.filter((grant) =>
        grant.lifetime !== "once" || (grant.id !== read.grantId && grant.id !== auth.grantId)
      );
      const result = await browser.tabs.sendMessage(tabId, {
        type: "page.actions", actions: params.actions,
        expectedDocumentToken: auth.documentToken, expectedUrl: auth.url,
      });
      await audit("page.actions", { clientId, tabId, count: params.actions.length, auth });
      return result;
    }
    case "page.navigate": {
      waitOptions(params);
      const auth = await authorization(clientId, Number(params.tabId), "INTERACT");
      const destination = new URL(params.url);
      if (!["http:", "https:"].includes(destination.protocol)) throw new Error("Only HTTP(S) navigation is allowed");
      const tabId = Number(params.tabId);
      await browser.tabs.sendMessage(tabId, {
        type: "page.interact",
        action: { kind: "navigate", url: destination.href },
        expectedDocumentToken: auth.documentToken,
        expectedUrl: auth.url,
      });
      await audit("page.navigate", { clientId, tabId: params.tabId, url: destination.href, auth });
      const result = { tabId, url: destination.href };
      if (params.waitUntil !== "none") {
        try { result.wait = await waitForPage(clientId, tabId, params, generation, auth); }
        catch (error) { result.wait = { status: "error", message: error.message }; }
      }
      return result;
    }
    case "page.screenshot": {
      const tabId = Number(params.tabId);
      const auth = await authorization(clientId, tabId, "SCREENSHOT");
      const format = params.format === "jpeg" ? "jpeg" : "png";
      const options = { format };
      if (format === "jpeg") options.quality = Math.max(1, Math.min(Number(params.quality) || 90, 100));
      const dataUrl = await browser.tabs.captureTab(tabId, options);
      const after = await documentInfo(tabId);
      if (after.documentToken !== auth.documentToken || after.url !== auth.url) {
        throw new Error("The document changed while the screenshot was captured");
      }
      await audit("page.screenshot", { clientId, tabId, auth });
      return { dataUrl };
    }
    case "page.script": {
      const tabId = Number(params.tabId);
      let auth = await authorization(clientId, tabId, "SCRIPT");
      const hasPermission = await browser.permissions.contains({ permissions: ["userScripts"] });
      if (!hasPermission || !browser.userScripts) {
        throw new Error("Enable Firefox's optional userScripts permission from a SCRIPT request in the ff-mcp popup");
      }
      if (typeof browser.userScripts.execute !== "function") {
        throw new Error("One-off SCRIPT execution requires Firefox 153 or newer");
      }
      const code = String(params.code || "");
      if (!code || code.length > 200000) throw new Error("Script must contain 1 to 200000 characters");
      const world = params.world === "USER_SCRIPT" ? "USER_SCRIPT" : "MAIN";
      let frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
      let after = await documentInfo(tabId);
      if (after.documentToken !== auth.documentToken || after.url !== auth.url) {
        auth = await authorization(clientId, tabId, "SCRIPT", false);
        frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
        after = await documentInfo(tabId);
      }
      if (after.documentToken !== auth.documentToken || after.url !== auth.url || !frame || !frame.documentId || frame.url !== auth.url) {
        throw new Error("The document changed after SCRIPT access was authorized");
      }
      await audit("page.script", { clientId, tabId, world, auth: { source: auth.source, grantId: auth.grantId, ruleId: auth.ruleId } });
      const results = await browser.userScripts.execute({
        js: [{ code }],
        target: { tabId, documentIds: [frame.documentId] },
        world,
        injectImmediately: true,
      });
      const failed = results.find((result) => result.error);
      if (failed) throw new Error(failed.error);
      return {
        world,
        results: results.map((result) => ({ documentId: result.documentId, frameId: result.frameId, result: result.result })),
      };
    }
    case "audit.list": return { events: state.audit.filter((event) => event.clientId === clientId).slice(-Math.max(1, Math.min(Number(params.limit) || 100, 500))).reverse() };
    default: throw new Error(`Unknown bridge method: ${method}`);
  }
}

async function handleBridgeRequest(message) {
  const port = state.port;
  const generation = hostGeneration;
  try {
    const result = await executeBridge(message.method, message.params || {}, String(message.clientId || "local-mcp-client"), generation);
    if (currentHost(generation)) port.postMessage({ type: "bridge.response", id: message.id, ok: true, result });
  } catch (error) {
    await audit("operation.denied", { clientId: message.clientId, method: message.method, error: error.message });
    if (currentHost(generation)) port.postMessage({ type: "bridge.response", id: message.id, ok: false, error: { message: error.message } });
  }
}

browser.runtime.onMessage.addListener(async (message) => {
  await ready;
  switch (message && message.type) {
    case "ui.state": return publicState();
    case "host.start":
      await browser.storage.local.set({ enabled: true });
      state.enabled = true;
      startHost();
      return publicState();
    case "host.stop":
      await browser.storage.local.set({ enabled: false });
      state.enabled = false;
      await browser.alarms.clear("reconnect");
      stopHost();
      return publicState();
    case "pending.approve": return approvePending(message.requestId, message.lifetime);
    case "pending.deny": return denyPending(message.requestId);
    case "grant.revoke": {
      const before = state.grants.length;
      state.grants = state.grants.filter((grant) => grant.id !== message.grantId);
      if (state.grants.length < before) await audit("grant.revoked", { grantId: message.grantId, source: "user" });
      return publicState();
    }
    case "rules.save": {
      if (!Array.isArray(message.rules)) throw new Error("Rules must be an array");
      if (!Number.isSafeInteger(message.rulesRevision) || message.rulesRevision < 0) {
        throw new Error("Rules revision is required");
      }
      const normalized = [];
      for (const rule of message.rules) {
        const capabilities = validCapabilities(rule.capabilities);
        FFMCPPolicy.parse(rule.expression);
        const value = { ...rule, capabilities };
        if (rule.visual !== undefined) {
          value.visual = FFMCPRuleModel.fromData(rule.visual);
          if (FFMCPRuleModel.toExpression(value.visual) !== rule.expression) {
            throw new Error("Visual rule does not match its policy expression");
          }
        }
        normalized.push(value);
      }
      const editableRules = normalized.map((rule) => ({ ...rule, id: rule.id || randomId(), enabled: rule.enabled !== false }));
      const submittedDefault = editableRules.find((rule) => rule.id === FFMCPRuleModel.DEFAULT_RULE_ID);
      const storedDefault = state.rules.find((rule) => rule.id === FFMCPRuleModel.DEFAULT_RULE_ID);
      const defaultRule = submittedDefault || storedDefault || FFMCPRuleModel.defaultRule();
      const nextRules = [
        defaultRule,
        ...editableRules.filter((rule) => rule.id !== FFMCPRuleModel.DEFAULT_RULE_ID),
      ];
      await serializeRules(async () => {
        if (message.rulesRevision !== state.rulesRevision) {
          throw new Error("Rules changed in another window. Reload settings and try again");
        }
        const nextRevision = state.rulesRevision + 1;
        await browser.storage.local.set({ rules: nextRules, rulesRevision: nextRevision });
        state.rules = nextRules;
        state.rulesRevision = nextRevision;
      });
      await audit("rules.saved", { count: state.rules.length });
      return publicState();
    }
    case "rules.test": return { matches: FFMCPPolicy.matches(message.expression, message.url) };
    case "audit.clear": state.audit = []; await browser.storage.local.set({ audit: [] }); return publicState();
    default: return undefined;
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  for (const [requestId, approvalTabId] of approvalTabs) {
    if (approvalTabId === tabId) invalidatedApprovals.add(requestId);
  }
  state.grants = state.grants.filter((grant) => grant.tabId !== tabId);
  state.pending = state.pending.filter((pending) => pending.tabId !== tabId);
  updateBadge();
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" && !changeInfo.url) return;
  for (const [requestId, approvalTabId] of approvalTabs) {
    if (approvalTabId === tabId) invalidatedApprovals.add(requestId);
  }
  state.grants = state.grants.filter((grant) => grant.tabId !== tabId || grant.lifetime === "tab_session");
  state.pending = state.pending.filter((pending) => pending.tabId !== tabId);
  updateBadge();
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === "reconnect" && state.enabled) startHost();
});
ready.then(() => {
  if (state.enabled) startHost();
  return updateBadge();
});
