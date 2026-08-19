"use strict";

const assert = require("assert");

let nextId = 0;
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: { randomUUID: () => `test-id-${nextId += 1}` },
});
require("../extension/shared/policy.js");
require("../extension/shared/rule-model.js");

let runtimeListener;
let nativeMessageListener;
let nativeDisconnectListener;
let tabUpdatedListener;
let currentInfo = { documentToken: "new-document", url: "https://new.example/", title: "New" };
let failAuditPersistence = false;
let failRulePersistence = false;
let holdRulePersistence = false;
let releaseRulePersistence;
let navigateOnGetFrame = false;
let scriptExecutions = 0;
const outbound = [];
const consoleErrors = [];

const port = {
  onMessage: { addListener(listener) { nativeMessageListener = listener; } },
  onDisconnect: { addListener(listener) { nativeDisconnectListener = listener; } },
  postMessage(message) { outbound.push(message); },
  disconnect() {},
};

globalThis.browser = {
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
  },
  permissions: { async contains() { return true; } },
  userScripts: {
    async execute() {
      scriptExecutions += 1;
      return [];
    },
  },
  webNavigation: {
    async getFrame() {
      if (navigateOnGetFrame) {
        navigateOnGetFrame = false;
        currentInfo = { ...currentInfo, documentToken: "reloaded-document" };
      }
      return { documentId: currentInfo.documentToken, url: currentInfo.url };
    },
  },
  runtime: {
    lastError: null,
    connectNative() { return port; },
    getManifest() { return { version: "test" }; },
    onMessage: { addListener(listener) { runtimeListener = listener; } },
  },
  storage: {
    local: {
      async get() {
        return {
          audit: [],
          rulesRevision: 3,
          rules: [{
            id: "old-host-read",
            name: "Old host",
            expression: 'host("old.example")',
            capabilities: ["READ"],
            enabled: true,
          }],
        };
      },
      async set(values) {
        if (holdRulePersistence && values.rules) {
          await new Promise((resolve) => { releaseRulePersistence = resolve; });
          releaseRulePersistence = undefined;
        }
        if (failRulePersistence && values.rules) throw new Error("rule storage unavailable");
        if (failAuditPersistence) throw new Error("storage unavailable");
      },
    },
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener(listener) { tabUpdatedListener = listener; } },
    async get() { return { id: 1, url: "https://old.example/", title: "Old" }; },
    async sendMessage(_tabId, message) {
      if (message.type === "document.info") return { ...currentInfo };
      if (message.type === "page.interact") {
        return { documentToken: currentInfo.documentToken, performed: message.action.kind };
      }
      throw new Error(`Unexpected content message: ${message.type}`);
    },
    async captureTab() {
      currentInfo = { documentToken: "after-capture", url: "https://private.example/", title: "Private" };
      return "data:image/png;base64,AAAA";
    },
  },
};

const originalConsoleError = console.error;
console.error = (...values) => consoleErrors.push(values);
require("../extension/background.js");

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function bridgeRequest(id, method, params) {
  nativeMessageListener({ type: "bridge.request", id, method, params, clientId: "test-client" });
  for (let attempt = 0; attempt < 5; attempt += 1) await tick();
  const response = outbound.find((message) => message.type === "bridge.response" && message.id === id);
  assert(response, `Missing bridge response for ${id}`);
  return response;
}

(async () => {
  await tick();
  await runtimeListener({ type: "host.start" });
  nativeMessageListener({
    type: "host.ready",
    url: "http://127.0.0.1:8765/mcp",
    token: "test-token",
    serverInstanceId: "test-server",
  });

  currentInfo = { documentToken: "consent-document", url: "https://new.example/", title: "Consent" };
  const readRequest = await bridgeRequest("request-read", "grants.request", {
    tabId: 1,
    capabilities: ["READ"],
    lifetime: "document",
  });
  const scriptRequest = await bridgeRequest("request-script-separately", "grants.request", {
    tabId: 1,
    capabilities: ["SCRIPT"],
    lifetime: "document",
  });
  assert.notStrictEqual(readRequest.result.requestId, scriptRequest.result.requestId);
  const consentState = await runtimeListener({ type: "ui.state" });
  assert.deepStrictEqual(
    consentState.pending.map((request) => request.capabilities),
    [["READ"], ["SCRIPT"]],
  );
  const readApproved = await runtimeListener({
    type: "pending.approve",
    requestId: readRequest.result.requestId,
    lifetime: "document",
  });
  assert.deepStrictEqual(readApproved.grants[readApproved.grants.length - 1].capabilities, ["READ"]);
  await runtimeListener({ type: "pending.deny", requestId: scriptRequest.result.requestId });

  currentInfo = { documentToken: "approval-document", url: "https://new.example/approval", title: "Approval" };
  const staleRequest = await bridgeRequest("request-stale", "grants.request", {
    tabId: 1,
    capabilities: ["INTERACT"],
    lifetime: "tab_session",
  });
  currentInfo = { documentToken: "approval-document", url: "https://private.example/", title: "Private" };
  await assert.rejects(
    runtimeListener({
      type: "pending.approve",
      requestId: staleRequest.result.requestId,
      lifetime: "tab_session",
    }),
    /document or URL changed before access was approved/i,
  );

  currentInfo = { documentToken: "double-document", url: "https://new.example/double", title: "Double" };
  const doubleRequest = await bridgeRequest("request-double", "grants.request", {
    tabId: 1,
    capabilities: ["SCREENSHOT"],
    lifetime: "document",
  });
  const grantsBeforeDoubleApproval = (await runtimeListener({ type: "ui.state" })).grants.length;
  const doubleApproval = await Promise.allSettled([
    runtimeListener({ type: "pending.approve", requestId: doubleRequest.result.requestId, lifetime: "document" }),
    runtimeListener({ type: "pending.approve", requestId: doubleRequest.result.requestId, lifetime: "document" }),
  ]);
  assert.strictEqual(doubleApproval.filter((result) => result.status === "fulfilled").length, 1);
  assert.strictEqual(doubleApproval.filter((result) => result.status === "rejected").length, 1);
  assert.strictEqual((await runtimeListener({ type: "ui.state" })).grants.length, grantsBeforeDoubleApproval + 1);

  currentInfo = { documentToken: "route-document", url: "https://new.example/allowed", title: "Route" };
  const routeRequest = await bridgeRequest("request-route", "grants.request", {
    tabId: 1,
    capabilities: ["INTERACT"],
    lifetime: "document",
  });
  await runtimeListener({
    type: "pending.approve",
    requestId: routeRequest.result.requestId,
    lifetime: "document",
  });
  currentInfo = { ...currentInfo, url: "https://new.example/settings" };
  const routeChanged = await bridgeRequest("route-changed", "page.interact", {
    tabId: 1,
    action: { kind: "click", selector: "button" },
  });
  assert.strictEqual(routeChanged.ok, false);
  assert(/INTERACT access is required/.test(routeChanged.error.message));

  currentInfo = { documentToken: "file-document", url: "file:///private/one.txt", title: "File" };
  const fileRequest = await bridgeRequest("request-file", "grants.request", {
    tabId: 1,
    capabilities: ["SCREENSHOT"],
    lifetime: "persistent",
  });
  await assert.rejects(
    runtimeListener({
      type: "pending.approve",
      requestId: fileRequest.result.requestId,
      lifetime: "persistent",
    }),
    /Persistent grants require an HTTP\(S\) hostname/,
  );
  assert((await runtimeListener({ type: "ui.state" })).pending.some((request) => request.id === fileRequest.result.requestId));
  await runtimeListener({ type: "pending.deny", requestId: fileRequest.result.requestId });

  currentInfo = { documentToken: "rule-storage-document", url: "https://persist.example/", title: "Persist" };
  const storageRequest = await bridgeRequest("request-rule-storage", "grants.request", {
    tabId: 1,
    capabilities: ["SCREENSHOT"],
    lifetime: "persistent",
  });
  const rulesBeforeFailure = (await runtimeListener({ type: "ui.state" })).rules.length;
  failRulePersistence = true;
  await assert.rejects(
    runtimeListener({
      type: "pending.approve",
      requestId: storageRequest.result.requestId,
      lifetime: "persistent",
    }),
    /rule storage unavailable/,
  );
  failRulePersistence = false;
  const stateAfterStorageFailure = await runtimeListener({ type: "ui.state" });
  assert.strictEqual(stateAfterStorageFailure.rules.length, rulesBeforeFailure);
  assert(stateAfterStorageFailure.pending.some((request) => request.id === storageRequest.result.requestId));
  await runtimeListener({ type: "pending.deny", requestId: storageRequest.result.requestId });

  currentInfo = { documentToken: "concurrent-rules-document", url: "https://concurrent.example/", title: "Concurrent" };
  const concurrentInteract = await bridgeRequest("request-concurrent-interact", "grants.request", {
    tabId: 1,
    capabilities: ["INTERACT"],
    lifetime: "persistent",
  });
  const concurrentScript = await bridgeRequest("request-concurrent-script", "grants.request", {
    tabId: 1,
    capabilities: ["SCRIPT"],
    lifetime: "persistent",
  });
  const rulesBeforeConcurrentApproval = (await runtimeListener({ type: "ui.state" })).rules.length;
  await Promise.all([
    runtimeListener({ type: "pending.approve", requestId: concurrentInteract.result.requestId, lifetime: "persistent" }),
    runtimeListener({ type: "pending.approve", requestId: concurrentScript.result.requestId, lifetime: "persistent" }),
  ]);
  const stateAfterConcurrentApproval = await runtimeListener({ type: "ui.state" });
  assert.strictEqual(stateAfterConcurrentApproval.rules.length, rulesBeforeConcurrentApproval + 2);
  assert.strictEqual(stateAfterConcurrentApproval.rulesRevision, 5);
  const generatedRules = stateAfterConcurrentApproval.rules.filter((rule) => rule.name === "Always allow concurrent.example");
  assert.strictEqual(generatedRules.length, 2);
  for (const rule of generatedRules) {
    assert.strictEqual(rule.visual.type, "group");
    assert.strictEqual(rule.visual.operator, "and");
    assert.strictEqual(rule.visual.children[0].operator, "or");
    assert.strictEqual(rule.visual.children[0].children[0].value, "concurrent.example");
    assert.strictEqual(rule.visual.children[1].operator, "and");
    assert.strictEqual(rule.visual.children[1].negated, true);
    assert.strictEqual(rule.expression, FFMCPRuleModel.toExpression(rule.visual));
  }

  const rulesBeforeFailedSave = (await runtimeListener({ type: "ui.state" })).rules;
  const revisionBeforeFailedSave = (await runtimeListener({ type: "ui.state" })).rulesRevision;
  failRulePersistence = true;
  await assert.rejects(
    runtimeListener({
      type: "rules.save",
      rulesRevision: revisionBeforeFailedSave,
      rules: [{
        id: "failed-save",
        name: "Must not activate",
        expression: 'host("failed.example")',
        capabilities: ["SCRIPT"],
        enabled: true,
      }],
    }),
    /rule storage unavailable/,
  );
  failRulePersistence = false;
  assert.deepStrictEqual((await runtimeListener({ type: "ui.state" })).rules, rulesBeforeFailedSave);
  assert.strictEqual((await runtimeListener({ type: "ui.state" })).rulesRevision, revisionBeforeFailedSave);

  await assert.rejects(
    runtimeListener({
      type: "rules.save",
      rulesRevision: revisionBeforeFailedSave - 1,
      rules: rulesBeforeFailedSave,
    }),
    /Rules changed in another window/i,
  );
  assert.deepStrictEqual((await runtimeListener({ type: "ui.state" })).rules, rulesBeforeFailedSave);

  currentInfo = { documentToken: "atomic-document", url: "https://atomic.example/", title: "Atomic" };
  const atomicApproval = await bridgeRequest("request-atomic-approval", "grants.request", {
    tabId: 1,
    capabilities: ["SCREENSHOT"],
    lifetime: "persistent",
  });
  const independentlyDenied = await bridgeRequest("request-independent-denial", "grants.request", {
    tabId: 1,
    capabilities: ["INTERACT"],
    lifetime: "document",
  });
  holdRulePersistence = true;
  const approvalInProgress = runtimeListener({
    type: "pending.approve",
    requestId: atomicApproval.result.requestId,
    lifetime: "persistent",
  });
  while (!releaseRulePersistence) await tick();
  await assert.rejects(
    runtimeListener({ type: "pending.deny", requestId: atomicApproval.result.requestId }),
    /already being approved/,
  );
  await runtimeListener({ type: "pending.deny", requestId: independentlyDenied.result.requestId });
  releaseRulePersistence();
  holdRulePersistence = false;
  await approvalInProgress;
  const stateAfterAtomicApproval = await runtimeListener({ type: "ui.state" });
  assert(!stateAfterAtomicApproval.pending.some((request) => request.id === atomicApproval.result.requestId));
  assert(!stateAfterAtomicApproval.pending.some((request) => request.id === independentlyDenied.result.requestId));

  currentInfo = { documentToken: "rollback-document", url: "https://rollback.example/", title: "Rollback" };
  const invalidatedRollback = await bridgeRequest("request-invalidated-rollback", "grants.request", {
    tabId: 1,
    capabilities: ["SCREENSHOT"],
    lifetime: "persistent",
  });
  holdRulePersistence = true;
  failRulePersistence = true;
  const failedApproval = runtimeListener({
    type: "pending.approve",
    requestId: invalidatedRollback.result.requestId,
    lifetime: "persistent",
  });
  while (!releaseRulePersistence) await tick();
  currentInfo = { ...currentInfo, url: "https://rollback.example/after-navigation" };
  tabUpdatedListener(1, { status: "loading", url: currentInfo.url });
  releaseRulePersistence();
  holdRulePersistence = false;
  await assert.rejects(failedApproval, /rule storage unavailable/);
  failRulePersistence = false;
  assert(!(await runtimeListener({ type: "ui.state" })).pending.some((request) => request.id === invalidatedRollback.result.requestId));

  currentInfo = { documentToken: "compatibility-document", url: "https://new.example/compatibility", title: "Compatibility" };
  const compatibilityGrant = await bridgeRequest("request-script-compatibility", "grants.request", {
    tabId: 1,
    capabilities: ["SCRIPT"],
    lifetime: "document",
  });
  await runtimeListener({
    type: "pending.approve",
    requestId: compatibilityGrant.result.requestId,
    lifetime: "document",
  });
  const executeUserScript = browser.userScripts.execute;
  browser.userScripts.execute = undefined;
  const unsupportedScript = await bridgeRequest("unsupported-script", "page.script", { tabId: 1, code: "1 + 1" });
  assert.strictEqual(unsupportedScript.ok, false);
  assert(/requires Firefox 153 or newer/.test(unsupportedScript.error.message));
  browser.userScripts.execute = executeUserScript;

  currentInfo = { documentToken: "script-document", url: "https://new.example/reload", title: "Script" };
  const scriptGrant = await bridgeRequest("request-script", "grants.request", {
    tabId: 1,
    capabilities: ["SCRIPT"],
    lifetime: "document",
  });
  await runtimeListener({
    type: "pending.approve",
    requestId: scriptGrant.result.requestId,
    lifetime: "document",
  });
  navigateOnGetFrame = true;
  const scriptRace = await bridgeRequest("script-race", "page.script", { tabId: 1, code: "1 + 1" });
  assert.strictEqual(scriptRace.ok, false);
  assert(/SCRIPT access is required/.test(scriptRace.error.message));
  assert.strictEqual(scriptExecutions, 0);

  const race = await bridgeRequest("rule-race", "page.snapshot", { tabId: 1 });
  assert.strictEqual(race.ok, false);
  assert(/READ access is required/.test(race.error.message));

  currentInfo = { documentToken: "screenshot-document", url: "https://new.example/", title: "New" };
  const requestedScreenshot = await bridgeRequest("request-screenshot", "grants.request", {
    tabId: 1,
    capabilities: ["SCREENSHOT"],
    lifetime: "document",
  });
  await runtimeListener({
    type: "pending.approve",
    requestId: requestedScreenshot.result.requestId,
    lifetime: "document",
  });
  const screenshot = await bridgeRequest("screenshot-race", "page.screenshot", { tabId: 1 });
  assert.strictEqual(screenshot.ok, false);
  assert(/document changed while the screenshot was captured/i.test(screenshot.error.message));

  currentInfo = { documentToken: "interaction-document", url: "https://new.example/", title: "New" };
  const requestedInteraction = await bridgeRequest("request-interaction", "grants.request", {
    tabId: 1,
    capabilities: ["INTERACT"],
    lifetime: "document",
  });
  await runtimeListener({
    type: "pending.approve",
    requestId: requestedInteraction.result.requestId,
    lifetime: "document",
  });
  failAuditPersistence = true;
  const interaction = await bridgeRequest("audit-failure", "page.interact", {
    tabId: 1,
    action: { kind: "click", selector: "button" },
  });
  assert.strictEqual(interaction.ok, true);
  assert.strictEqual(interaction.result.performed, "click");
  assert(consoleErrors.length > 0, "Audit persistence failure was not surfaced");

  const stopped = await runtimeListener({ type: "host.stop" });
  assert.strictEqual(stopped.running, false);
  assert(nativeDisconnectListener, "Native disconnect listener was not registered");

  console.error = originalConsoleError;
  console.log("background tests passed");
})().catch((error) => {
  console.error = originalConsoleError;
  console.error(error);
  process.exitCode = 1;
});
