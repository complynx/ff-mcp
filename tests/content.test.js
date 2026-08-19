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

console.log("content tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
