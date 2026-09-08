"use strict";

const assert = require("assert");
const { TextEncoder } = require("util");

globalThis.TextEncoder = TextEncoder;
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: { randomUUID: () => "document-token" },
});
globalThis.location = { href: "https://example.test/" };
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.scrollX = 0;
globalThis.scrollY = 0;
globalThis.getComputedStyle = () => ({ visibility: "visible" });

const repeated = "x".repeat(1000);
const field = {
  tagName: "INPUT",
  innerText: repeated.repeat(2),
  textContent: repeated.repeat(2),
  disabled: false,
  hasAttribute() { return true; },
  getAttribute() { return repeated; },
};
const largeForms = Array.from({ length: 4 }, () => ({
  action: "https://example.test/submit",
  method: "post",
  elements: Array.from({ length: 200 }, () => field),
}));
const largeHeadings = Array.from({ length: 200 }, () => ({
  tagName: "H2",
  innerText: repeated.repeat(2),
}));
const largeLinks = Array.from({ length: 500 }, () => ({
  innerText: repeated.repeat(2),
  href: repeated.repeat(2),
}));

globalThis.document = {
  body: { innerText: "body" },
  documentElement: { lang: "en" },
  title: "Snapshot",
  forms: largeForms,
  links: largeLinks,
  getElementById() { return null; },
  querySelectorAll(selector) { return selector === "h1,h2,h3,h4,h5,h6" ? largeHeadings : []; },
};

let messageListener;
globalThis.browser = {
  runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
};

require("../extension/content.js");

(async () => {
assert.throws(
  () => messageListener({ type: "page.snapshot", params: { maxChars: 1000, compact: false } }),
  /Snapshot exceeds the 4 MiB result limit/,
);

document.forms = [{ action: "https://example.test/submit", method: "post", elements: [field] }];
document.links = [];
document.querySelectorAll = () => [];
const snapshot = messageListener({ type: "page.snapshot", params: { maxChars: 1000 } });
assert.strictEqual(snapshot instanceof Promise, true);

location.href = "https://example.test/settings/account";
await assert.rejects(
  () => messageListener({
    type: "page.snapshot",
    params: { maxChars: 1000 },
    expectedDocumentToken: "document-token",
    expectedUrl: "https://example.test/allowed",
  }),
  /document URL changed/i,
);

location.href = "https://example.test/allowed#section-two";
await assert.rejects(
  () => messageListener({
    type: "page.snapshot",
    params: { maxChars: 1000 },
    expectedDocumentToken: "document-token",
    expectedUrl: "https://example.test/allowed#section-one",
  }),
  /document URL changed/i,
);

location.href = "https://example.test/";
let clicks = 0;
const button = {
  tagName: "BUTTON", innerText: "Submit", isConnected: true,
  hasAttribute() { return false; },
  getAttribute() { return null; },
  matches() { return false; },
  getClientRects() { return [{}]; },
  scrollIntoView() {},
  click() { clicks += 1; },
};
document.forms = [];
document.querySelectorAll = (selector) => selector.includes("button") ? [button] : [];
document.querySelector = () => null;
const first = await messageListener({ type: "page.snapshot", params: {} });
const second = await messageListener({ type: "page.snapshot", params: {} });
assert.strictEqual(first.elements[0].ref, second.elements[0].ref);
assert.strictEqual(first.elements[0].name, "Submit");
assert.strictEqual(first.forms, undefined);
assert.strictEqual(first.links, undefined);
assert.strictEqual(first.elements[0].attributes, undefined);
const attributes = { "aria-labelledby": "label", "aria-label": "Fallback", "aria-expanded": "false" };
button.getAttribute = (key) => attributes[key] ?? null;
button.hasAttribute = (key) => key in attributes;
document.getElementById = (id) => id === "label" ? { textContent: "Send request" } : null;
document.forms = [{ action: "https://example.test/send", method: "post", elements: [button] }];
const labelled = await messageListener({ type: "page.snapshot" });
const full = await messageListener({ type: "page.snapshot", params: { compact: false } });
assert.strictEqual(labelled.elements[0].name, "Send request");
assert.strictEqual(labelled.elements[0].expanded, "false");
assert.strictEqual(full.forms[0].fields[0].ref, labelled.elements[0].ref);
assert(JSON.stringify(labelled).length < JSON.stringify(full).length);
const link = {
  ...button, tagName: "A", innerText: "Guide", href: "https://cdn.test/docs/guide",
  getAttribute: (key) => key === "href" ? "guide" : null,
};
document.querySelectorAll = (selector) => selector.includes("a[href]") ? [link] : [];
const linked = await messageListener({ type: "page.snapshot" });
assert.strictEqual(linked.elements[0].href, "https://cdn.test/docs/guide");
link.href = `https://cdn.test/${"x".repeat(1100)}`;
const longLink = await messageListener({ type: "page.snapshot" });
assert.strictEqual(longLink.elements[0].href.length, 1000);
assert.strictEqual(longLink.elements[0].hrefTruncated, true);
const hidden = { ...button, getClientRects: () => [] };
document.body.innerText = "x".repeat(1100);
document.querySelectorAll = (selector) => selector.includes("button") ?
  [hidden, ...Array.from({ length: 201 }, () => ({ ...button }))] : [];
const bounded = await messageListener({ type: "page.snapshot", params: { maxChars: 1000 } });
assert.strictEqual(bounded.elements.length, 200);
assert.strictEqual(bounded.truncation.omittedElements, 1);
assert.strictEqual(bounded.truncation.text, true);
document.body.innerText = "body";
document.querySelectorAll = (selector) => selector.includes("button") ? [button] : [];
button.getAttribute = () => null;
const batch = await messageListener({
  type: "page.actions", expectedDocumentToken: "document-token", expectedUrl: location.href,
  actions: [
    { kind: "click", selector: first.elements[0].ref },
    { kind: "click", selector: "@missing" },
    { kind: "click", selector: first.elements[0].ref },
  ],
});
assert.strictEqual(batch.completed, 1);
assert.strictEqual(clicks, 1);
assert.match(batch.error, /No element/);
assert(batch.snapshot);
button.isConnected = false;
assert.throws(() => messageListener({
  type: "page.interact", action: { kind: "click", selector: first.elements[0].ref },
}), /stale/);

button.isConnected = true;
button.getAttribute = () => null;
button.matches = () => false;
document.querySelector = (selector) => selector === "button" ? button : null;
globalThis.getComputedStyle = () => ({ visibility: "visible" });
document.readyState = "complete";
const condition = async (value) => (await messageListener({
  type: "page.wait", condition: value, expectedDocumentToken: "document-token", expectedUrl: location.href,
})).matched;
assert.strictEqual(await condition({ selector: "button", state: "enabled", text: "Submit", url: location.href }), true);
button.disabled = true;
assert.strictEqual(await condition({ selector: "button", state: "enabled" }), false);
assert.strictEqual(await condition({ selector: "missing", state: "detached" }), true);
assert.strictEqual(await condition({ selector: "missing", state: "visible" }), false);
assert.strictEqual(await condition({ selector: "button", text: "different text" }), false);
globalThis.getComputedStyle = () => ({ visibility: "hidden" });
assert.strictEqual(await condition({ selector: "button", state: "hidden" }), true);
assert.strictEqual(await condition({ selector: "button", state: "visible" }), false);
assert.strictEqual(await condition({ url: "https://other.test/" }), false);
document.readyState = "loading";
assert.strictEqual(await condition({}), false);

console.log("content tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
