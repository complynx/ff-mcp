(function (root) {
  "use strict";

  const PREDICATES = new Set(["host", "glob", "regex", "scheme"]);

  function group(operator, children = [], negated = false) {
    return { type: "group", operator, negated, children };
  }

  function predicate(kind = "host", value = "") {
    return { type: "predicate", predicate: kind, value };
  }

  function blankTree() {
    return group("and", [
      group("or"),
      group("and", [], true),
    ]);
  }

  function defaultTree() {
    return group("and", [
      group("or", [
        predicate("host", "localhost"),
        predicate("host", "*.localhost"),
        predicate("host", "[::1]"),
        predicate("regex", "^https?://127\\.[0-9]+\\.[0-9]+\\.[0-9]+(:[0-9]+)?/"),
      ]),
      group("and", [], true),
    ]);
  }

  function fromAst(node) {
    if (node.kind === "constant") return group("and", [], node.value);
    if (PREDICATES.has(node.kind)) return predicate(node.kind, node.value);
    if (node.kind === "not") {
      const value = fromAst(node.value);
      if (value.type === "group") return { ...value, negated: !value.negated };
      return group("and", [value], true);
    }
    if (node.kind === "and" || node.kind === "or") {
      const children = [];
      function append(value) {
        if (value.kind === node.kind) {
          append(value.left);
          append(value.right);
        } else {
          children.push(fromAst(value));
        }
      }
      append(node);
      return group(node.kind, children);
    }
    throw new Error(`Unsupported policy node: ${node.kind}`);
  }

  function fromExpression(expression) {
    const value = fromAst(root.FFMCPPolicy.parse(expression));
    const canonical = value.type === "group" && value.operator === "and" && !value.negated &&
      value.children.length === 2 && value.children[0].type === "group" &&
      value.children[0].operator === "or" && !value.children[0].negated &&
      value.children[1].type === "group" && value.children[1].operator === "and" &&
      value.children[1].negated;
    if (canonical) return value;
    return group("and", [group("or", [value]), group("and", [], true)]);
  }

  function fromData(value) {
    if (value && value.type === "predicate" && PREDICATES.has(value.predicate) && typeof value.value === "string") {
      return predicate(value.predicate, value.value);
    }
    if (value && value.type === "group" && ["and", "or"].includes(value.operator) &&
        typeof value.negated === "boolean" && Array.isArray(value.children)) {
      return group(value.operator, value.children.map(fromData), value.negated);
    }
    throw new Error("Stored visual rule is invalid");
  }

  function toExpression(node) {
    if (node.type === "predicate") {
      if (!PREDICATES.has(node.predicate)) throw new Error("Choose a valid condition type");
      if (!String(node.value || "").trim()) throw new Error(`${node.predicate} condition cannot be empty`);
      return `${node.predicate}(${JSON.stringify(String(node.value))})`;
    }
    if (node.type !== "group" || !["and", "or"].includes(node.operator) || !Array.isArray(node.children)) {
      throw new Error("Invalid rule container");
    }
    if (node.children.length === 0) return node.negated ? "TRUE" : "FALSE";
    const separator = ` ${node.operator.toUpperCase()} `;
    const joined = node.children.map(toExpression).join(separator);
    const expression = node.children.length === 1 ? joined : `(${joined})`;
    return node.negated ? `NOT (${expression})` : expression;
  }

  root.FFMCPRuleModel = { blankTree, defaultTree, fromData, fromExpression, group, predicate, toExpression };
})(typeof globalThis === "object" ? globalThis : this);
