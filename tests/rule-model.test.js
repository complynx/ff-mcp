"use strict";

const assert = require("assert");

require("../extension/shared/policy.js");
require("../extension/shared/rule-model.js");

const model = globalThis.FFMCPRuleModel;
const policy = globalThis.FFMCPPolicy;

const defaults = model.defaultTree();
const defaultRule = model.defaultRule();
assert.strictEqual(defaultRule.id, model.DEFAULT_RULE_ID);
assert.strictEqual(defaultRule.expression, model.toExpression(defaultRule.visual));
assert.deepStrictEqual(defaultRule.capabilities, ["READ"]);
assert.strictEqual(policy.matches(model.toExpression(defaults), "http://localhost:3000/"), true);
assert.strictEqual(policy.matches(model.toExpression(defaults), "https://app.localhost/"), true);
assert.strictEqual(policy.matches(model.toExpression(defaults), "http://127.20.30.40:8080/"), true);
assert.strictEqual(policy.matches(model.toExpression(defaults), "http://[::1]/"), true);
assert.strictEqual(policy.matches(model.toExpression(defaults), "https://example.com/"), false);

const blank = model.blankTree();
assert.strictEqual(model.toExpression(blank), "(FALSE AND TRUE)");
assert.strictEqual(policy.matches(model.toExpression(blank), "https://example.com/"), false);

blank.children[0].children.push(model.predicate("host", "example.com"));
assert.strictEqual(policy.matches(model.toExpression(blank), "https://example.com/path"), true);

blank.children[1].children.push(model.predicate("glob", "*/admin/*"));
assert.strictEqual(policy.matches(model.toExpression(blank), "https://example.com/admin/users"), false);
assert.strictEqual(policy.matches(model.toExpression(blank), "https://example.com/docs/"), true);

const migrated = model.fromExpression('host("example.com") AND NOT glob("*/private/*")');
assert.strictEqual(migrated.operator, "and");
assert.strictEqual(migrated.children[0].operator, "or");
assert.strictEqual(migrated.children[1].operator, "and");
assert.strictEqual(migrated.children[1].negated, true);
const migratedExpression = model.toExpression(migrated);
assert.strictEqual(policy.matches(migratedExpression, "https://example.com/public/"), true);
assert.strictEqual(policy.matches(migratedExpression, "https://example.com/private/account"), false);

const emptyNand = model.group("and", [], true);
const emptyNor = model.group("or", [], true);
assert.strictEqual(policy.matches(model.toExpression(emptyNand), "https://example.com/"), true);
assert.strictEqual(policy.matches(model.toExpression(emptyNor), "https://example.com/"), true);
assert.throws(() => model.toExpression(model.predicate("host", "")), /cannot be empty/);
assert.deepStrictEqual(model.fromData(JSON.parse(JSON.stringify(blank))), blank);
assert.throws(() => model.fromData({ type: "group", operator: "xor", negated: false, children: [] }), /invalid/);

console.log("rule model tests passed");
