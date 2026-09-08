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
  querySelectorAll(selector) { return selector === "h1,h2,h3,h4,h5,h6" ? largeHeadings : []; },
};

let messageListener;
globalThis.browser = {
  runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
};

require("../extension/content.js");

(async () => {
assert.throws(
  () => messageListener({ type: "page.snapshot", params: { maxChars: 1000 } }),
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

console.log("content tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
