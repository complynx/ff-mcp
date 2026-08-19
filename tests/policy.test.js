"use strict";

const assert = require("assert");
require("../extension/shared/policy.js");

const policy = globalThis.FFMCPPolicy;

assert.strictEqual(policy.matches('host("example.com")', "https://example.com/path"), true);
assert.strictEqual(policy.matches('host("*.example.com")', "https://a.b.example.com/path"), true);
assert.strictEqual(policy.matches('scheme("https") AND NOT glob("*/settings/*")', "https://example.com/pull/1"), true);
assert.strictEqual(policy.matches('scheme("https") AND NOT glob("*/settings/*")', "https://example.com/settings/profile"), false);
assert.strictEqual(policy.matches('regex("^https://github\\\\.com/[^/]+/[^/]+/pull/[0-9]+")', "https://github.com/a/b/pull/42"), true);
assert.strictEqual(policy.matches("TRUE", "https://example.com/"), true);
assert.strictEqual(policy.matches("FALSE", "https://example.com/"), false);
assert.strictEqual(policy.isLocalhost("http://localhost:3000"), true);
assert.strictEqual(policy.isLocalhost("http://app.localhost"), true);
assert.strictEqual(policy.isLocalhost("http://127.99.1.2"), true);
assert.strictEqual(policy.isLocalhost("http://[::1]"), true);
assert.strictEqual(policy.isLocalhost("https://example.com"), false);
assert.throws(() => policy.parse('host("x") AND'), /Expected/);
assert.throws(() => policy.matches('regex("(a+)+")', "https://example.com/aaaa"), /unsupported/);
assert.throws(() => policy.matches('regex("^https://x/(a|aa)+$")', `https://x/${"a".repeat(500)}b`), /unsupported/);
assert.throws(() => policy.matches('regex("^https://x/(a{1,2})+$")', `https://x/${"a".repeat(500)}b`), /unsupported/);
assert.throws(() => policy.matches('regex("^https://x/(a?)+$")', `https://x/${"a".repeat(500)}b`), /unsupported/);
assert.throws(() => policy.parse('regex("(?<letter>a)\\\\k<letter>")'), /unsupported/);

console.log("policy tests passed");
