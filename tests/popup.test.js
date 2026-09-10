"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  get value() {
    return this.tagName === "select"
      ? this.children.find((option) => option.selected)?.value
      : this.textValue;
  }
  set value(value) {
    if (this.tagName === "select") {
      for (const option of this.children) option.selected = option.value === value;
    } else {
      this.textValue = value;
    }
  }
}

test("pending lifetime choices survive unrelated changes and expire with their request", async () => {
  const elements = new Map();
  const sent = [];
  const request = {
    id: "first", tabId: 1, title: "Test", url: "https://example.test/",
    agent: "Agent", model: "Model", harness: "Harness", reason: "Read the page",
    capabilities: ["READ"], requestedLifetime: "persistent",
  };
  let state = { enabled: true, running: true, starting: false, host: { url: "http://127.0.0.1:8765/mcp" }, pending: [request], grants: [] };
  const context = vm.createContext({
    document: {
      createElement: (tagName) => new Element(tagName),
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, new Element("div"));
        return elements.get(selector);
      },
    },
    browser: {
      runtime: {
        async sendMessage(message) { sent.push(message); return state; },
      },
    },
    setTimeout() {},
  });
  vm.runInContext(fs.readFileSync(require.resolve("../extension/popup.js"), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  const actions = () => elements.get("#pending").children[0].children.at(-1);
  const select = () => actions().children.find((element) => element.tagName === "select");
  select().value = "once";
  select().listeners.get("change")();

  // A second client must not reset the first client's approval to persistent.
  state = { ...state, pending: [request, { ...request, id: "second" }] };
  context.update(state);
  assert.equal(select().value, "once");
  await actions().children.find((element) => element.textContent === "Allow").listeners.get("click")();
  assert.equal(sent.at(-1).type, "pending.approve");
  assert.equal(sent.at(-1).requestId, "first");
  assert.equal(sent.at(-1).lifetime, "once");

  state = { ...state, running: false, starting: false, host: null };
  context.update(state);
  assert.equal(elements.get("#toggle").textContent, "Stop");
  assert.match(elements.get("#status").textContent, /retrying/);
  state = { ...state, lastHostError: "No such native application io.github.ff_mcp" };
  context.update(state);
  assert.match(elements.get("#host-error").textContent, /No such native application/);
  state = { ...state, lastHostError: "Native host exited" };
  context.update(state);
  assert.match(elements.get("#host-error").textContent, /Native host exited/);
  state = { ...state, lastHostError: null };
  context.update(state);
  assert.equal(elements.get("#host-error").textContent, "");
  await elements.get("#toggle").listeners.get("click")();
  assert.equal(sent.at(-1).type, "host.stop");

  state = { ...state, pending: [] };
  context.update(state);
  state = { ...state, pending: [request] };
  context.update(state);
  assert.equal(select().value, "persistent");
});
