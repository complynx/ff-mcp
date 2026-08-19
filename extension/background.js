"use strict";

const HOST_NAME = "io.github.ff_mcp";
const CAPABILITIES = new Set(["READ", "INTERACT", "SCRIPT", "SCREENSHOT"]);
const LIFETIMES = new Set(["once", "document", "tab_session", "persistent"]);
const state = {
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

const ready = browser.storage.local.get(["rules", "rulesRevision", "audit"]).then((stored) => {
  state.rules = Array.isArray(stored.rules) ? stored.rules : [];
  state.rulesRevision = Number.isSafeInteger(stored.rulesRevision) && stored.rulesRevision >= 0 ? stored.rulesRevision : 0;
  state.audit = Array.isArray(stored.audit) ? stored.audit : [];
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

function startHost() {
  if (state.port) return;
  const port = browser.runtime.connectNative(HOST_NAME);
  state.port = port;
  state.host = null;
  port.onMessage.addListener((message) => {
    if (message.type === "host.ready") {
      state.host = {
        url: message.url,
        token: message.token,
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
      state.port = null;
      state.host = null;
      updateBadge();
    }
    audit("host.stopped", error ? { error: error.message } : {});
  });
  port.postMessage({ type: "extension.ready", version: browser.runtime.getManifest().version });
  updateBadge();
}

function stopHost() {
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
  if (capability === "READ" && FFMCPPolicy.isLocalhost(url)) {
    return { id: "builtin-localhost-read", name: "Localhost read-only default" };
  }
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
  const info = await documentInfo(tabId);
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

async function requestGrant(clientId, params) {
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
  const existing = state.pending.find((pending) =>
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
    reason: String(params.reason || "").slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  state.pending.push(pending);
  await audit("grant.requested", { clientId, tabId, capabilities });
  await updateBadge();
  return { status: "pending", requestId: pending.id, message: "Approve the request from the ff-mcp toolbar popup." };
}

async function approvePending(requestId, lifetime) {
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
          let restore = !invalidatedApprovals.has(requestId);
          if (restore) {
            try {
              const rollbackInfo = await documentInfo(pending.tabId);
              restore = !invalidatedApprovals.has(requestId) &&
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

async function executeBridge(method, params, clientId) {
  await ready;
  switch (method) {
    case "tabs.list": {
      const tabs = await browser.tabs.query({});
      return { tabs: tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active, pinned: tab.pinned })) };
    }
    case "grants.request": return requestGrant(clientId, params);
    case "grants.list": return { grants: state.grants.filter((grant) => grant.clientId === clientId), pending: state.pending.filter((pending) => pending.clientId === clientId) };
    case "grants.revoke": {
      const before = state.grants.length;
      state.grants = state.grants.filter((grant) => !(grant.id === params.grantId && grant.clientId === clientId));
      await audit("grant.revoked", { clientId, grantId: params.grantId });
      return { revoked: state.grants.length < before };
    }
    case "page.snapshot": {
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
    case "page.navigate": {
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
      return { tabId, url: destination.href };
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
    case "audit.list": return { events: state.audit.slice(-Math.max(1, Math.min(Number(params.limit) || 100, 500))).reverse() };
    default: throw new Error(`Unknown bridge method: ${method}`);
  }
}

async function handleBridgeRequest(message) {
  try {
    const result = await executeBridge(message.method, message.params || {}, String(message.clientId || "local-mcp-client"));
    state.port.postMessage({ type: "bridge.response", id: message.id, ok: true, result });
  } catch (error) {
    await audit("operation.denied", { clientId: message.clientId, method: message.method, error: error.message });
    if (state.port) state.port.postMessage({ type: "bridge.response", id: message.id, ok: false, error: { message: error.message } });
  }
}

browser.runtime.onMessage.addListener(async (message) => {
  await ready;
  switch (message && message.type) {
    case "ui.state": return publicState();
    case "host.start": startHost(); return publicState();
    case "host.stop": stopHost(); return publicState();
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
      const nextRules = normalized.map((rule) => ({ ...rule, id: rule.id || randomId(), enabled: rule.enabled !== false }));
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

ready.then(updateBadge);
