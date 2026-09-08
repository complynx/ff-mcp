"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { webcrypto } = require("node:crypto");

async function harness() {
  let nativeListener, uiListener;
  let info = { documentToken: "document", url: "https://example.test/", title: "Test", readyState: "complete" };
  let getInfo = () => info;
  let probe = () => ({ matched: true, snapshot: { text: "ready" } });
  let navigate = () => { info = { ...info, documentToken: "next", url: "https://next.test/" }; };
  let navigations = 0;
  let nextId = 0;
  const pending = new Map();
  const context = vm.createContext({
    crypto: webcrypto, URL, console, setTimeout, clearTimeout,
    browser: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        onMessage: { addListener: (listener) => { uiListener = listener; } },
        connectNative: () => ({
          onMessage: { addListener: (listener) => { nativeListener = listener; } },
          onDisconnect: { addListener() {} },
          postMessage(message) {
            if (message.type === "bridge.response") {
              pending.get(message.id)(message);
              pending.delete(message.id);
            }
          },
          disconnect() {},
        }),
      },
      storage: { local: { async get() { return {}; }, async set() {} } },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async openPopup() {} },
      alarms: { create() {}, async clear() {}, onAlarm: { addListener() {} } },
      windows: { async update() {} },
      tabs: {
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        async get() { return { windowId: 1 }; },
        async sendMessage(_tabId, message) {
          if (message.type === "document.info") return getInfo();
          if (message.type === "page.wait") return probe(message);
          if (message.type === "page.interact" && message.action.kind === "navigate") {
            navigations += 1;
            navigate();
            return { performed: "navigate" };
          }
          throw new Error(`Unexpected message ${message.type}`);
        },
      },
    },
  });
  for (const file of ["shared/policy.js", "shared/rule-model.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(require.resolve(`../extension/${file}`), "utf8"), context);
  }
  await new Promise((resolve) => setImmediate(resolve));
  function request(method, params = {}) {
    const id = String(++nextId);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      nativeListener({ type: "bridge.request", id, method, clientId: "client", params });
    });
  }
  async function grant(capabilities, lifetime = "tab_session") {
    const response = await request("grants.request", {
      tabId: 1, capabilities, lifetime, agent: "Agent", model: "Model", harness: "Harness", reason: "Test waits",
    });
    assert.equal(response.ok, true);
    const state = await uiListener({ type: "pending.approve", requestId: response.result.requestId, lifetime });
    return state.grants.at(-1).id;
  }
  return {
    request, grant, ui: (message) => uiListener(message),
    setInfo: (value) => { getInfo = value; },
    setProbe: (value) => { probe = value; },
    setNavigate: (value) => { navigate = value; },
    navigations: () => navigations,
    info: () => info,
  };
}

test("wait retries unavailable content scripts and pending conditions, consuming once on success", async () => {
  const h = await harness();
  await h.grant(["READ"], "once");
  let infoCalls = 0, probes = 0;
  h.setInfo(() => { if (++infoCalls === 1) throw new Error("No receiver"); return h.info(); });
  h.setProbe((message) => {
    assert.equal(message.expectedDocumentToken, "document");
    return { matched: ++probes === 2, snapshot: { text: "now ready" } };
  });
  const response = await h.request("page.wait", { tabId: 1, waitFor: { selector: "button", state: "enabled" }, timeoutMs: 1000 });
  assert.equal(response.ok, true);
  assert.equal(response.result.status, "ready");
  assert.equal(response.result.snapshot.text, "now ready");
  assert.equal((await h.ui({ type: "ui.state" })).grants.length, 0);
});

test("timeout preserves once grants and bounds a content request that never settles", async () => {
  const h = await harness();
  await h.grant(["READ"], "once");
  h.setProbe(() => ({ matched: false }));
  const unmatched = await h.request("page.wait", { tabId: 1, timeoutMs: 20 });
  assert.equal(unmatched.result.status, "timeout");
  assert.equal((await h.ui({ type: "ui.state" })).grants.length, 1);
  h.setProbe(() => new Promise(() => {}));
  const hung = await h.request("page.wait", { tabId: 1, timeoutMs: 20 });
  assert.equal(hung.result.status, "timeout");
  assert.equal((await h.ui({ type: "ui.state" })).grants.length, 1);
});

test("revocation during the probe suppresses the snapshot", async () => {
  const h = await harness();
  const grantId = await h.grant(["READ"]);
  let release;
  h.setProbe(() => new Promise((resolve) => { release = resolve; }));
  const waiting = h.request("page.wait", { tabId: 1, timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert(release);
  await h.ui({ type: "grant.revoke", grantId });
  release({ matched: true, snapshot: { text: "private" } });
  const response = await waiting;
  assert.equal(response.ok, false);
  assert.match(response.error.message, /READ access is required/);
  assert.equal(response.result, undefined);
});

test("document grants cannot authorize a replacement document", async () => {
  const h = await harness();
  await h.grant(["READ"], "document");
  h.setInfo(() => ({ ...h.info(), documentToken: "replacement" }));
  h.setProbe(() => { throw new Error("Must not inspect unauthorized content"); });
  const response = await h.request("page.wait", { tabId: 1, timeoutMs: 20 });
  assert.equal(response.ok, false);
  assert.match(response.error.message, /READ access is required/);
});

test("snapshot waits return the matched snapshot without a second read", async () => {
  const h = await harness();
  await h.grant(["READ"]);
  const response = await h.request("page.snapshot", { tabId: 1, waitFor: {}, timeoutMs: 20 });
  assert.equal(response.result.text, "ready");
});

test("navigation waits for replacement document and never retries the mutation", async () => {
  const h = await harness();
  await h.grant(["INTERACT"]);
  const ready = await h.request("page.navigate", { tabId: 1, url: "https://next.test/", timeoutMs: 100 });
  assert.equal(ready.result.wait.status, "ready");
  assert.equal(h.navigations(), 1);
  h.setNavigate(() => h.setInfo(() => new Promise(() => {})));
  const timeout = await h.request("page.navigate", { tabId: 1, url: "https://last.test/", timeoutMs: 20 });
  assert.equal(timeout.ok, true);
  assert.equal(timeout.result.url, "https://last.test/");
  assert.equal(timeout.result.wait.status, "timeout");
  assert.equal(h.navigations(), 2);
});

test("invalid wait timeout fails before navigation", async () => {
  const h = await harness();
  await h.grant(["INTERACT"]);
  const response = await h.request("page.navigate", { tabId: 1, url: "https://next.test/", timeoutMs: 30000 });
  assert.equal(response.ok, false);
  assert.equal(h.navigations(), 0);
});
