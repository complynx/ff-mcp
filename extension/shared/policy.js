(function (root) {
  "use strict";

  const MAX_EXPRESSION_LENGTH = 4096;
  const MAX_REGEX_LENGTH = 512;

  class PolicySyntaxError extends Error {}

  class Lexer {
    constructor(source) {
      if (typeof source !== "string" || source.length > MAX_EXPRESSION_LENGTH) {
        throw new PolicySyntaxError("Policy expression is missing or too long");
      }
      this.source = source;
      this.offset = 0;
    }

    next() {
      while (/\s/.test(this.source[this.offset] || "")) this.offset += 1;
      if (this.offset >= this.source.length) return { type: "EOF" };
      const start = this.offset;
      const char = this.source[this.offset];
      if (char === "(" || char === ")" || char === ",") {
        this.offset += 1;
        return { type: char, value: char, offset: start };
      }
      if (char === '"') {
        this.offset += 1;
        let escaped = false;
        while (this.offset < this.source.length) {
          const current = this.source[this.offset++];
          if (!escaped && current === '"') {
            const raw = this.source.slice(start, this.offset);
            try {
              return { type: "STRING", value: JSON.parse(raw), offset: start };
            } catch (_) {
              throw new PolicySyntaxError(`Invalid string at offset ${start}`);
            }
          }
          escaped = !escaped && current === "\\";
          if (current !== "\\") escaped = false;
        }
        throw new PolicySyntaxError(`Unterminated string at offset ${start}`);
      }
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.offset));
      if (match) {
        this.offset += match[0].length;
        const value = match[0];
        const upper = value.toUpperCase();
        if (["AND", "OR", "NOT", "TRUE", "FALSE"].includes(upper)) {
          return { type: upper, value: upper, offset: start };
        }
        return { type: "IDENT", value: value.toLowerCase(), offset: start };
      }
      throw new PolicySyntaxError(`Unexpected character at offset ${start}`);
    }
  }

  class Parser {
    constructor(source) {
      this.lexer = new Lexer(source);
      this.token = this.lexer.next();
    }

    parse() {
      const expression = this.parseOr();
      this.expect("EOF");
      return expression;
    }

    parseOr() {
      let node = this.parseAnd();
      while (this.token.type === "OR") {
        this.advance();
        node = { kind: "or", left: node, right: this.parseAnd() };
      }
      return node;
    }

    parseAnd() {
      let node = this.parseUnary();
      while (this.token.type === "AND") {
        this.advance();
        node = { kind: "and", left: node, right: this.parseUnary() };
      }
      return node;
    }

    parseUnary() {
      if (this.token.type === "TRUE" || this.token.type === "FALSE") {
        const value = this.token.type === "TRUE";
        this.advance();
        return { kind: "constant", value };
      }
      if (this.token.type === "NOT") {
        this.advance();
        return { kind: "not", value: this.parseUnary() };
      }
      if (this.token.type === "(") {
        this.advance();
        const node = this.parseOr();
        this.expect(")");
        return node;
      }
      return this.parsePredicate();
    }

    parsePredicate() {
      const name = this.expect("IDENT").value;
      if (!["host", "glob", "regex", "scheme"].includes(name)) {
        throw new PolicySyntaxError(`Unknown predicate: ${name}`);
      }
      this.expect("(");
      const value = this.expect("STRING").value;
      this.expect(")");
      return { kind: name, value };
    }

    expect(type) {
      if (this.token.type !== type) {
        throw new PolicySyntaxError(`Expected ${type} at offset ${this.token.offset || 0}`);
      }
      const token = this.token;
      this.advance();
      return token;
    }

    advance() {
      this.token = this.lexer.next();
    }
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function safeRegex(pattern) {
    if (pattern.length > MAX_REGEX_LENGTH) throw new PolicySyntaxError("Regex is too long");
    if (/\\(?:[1-9]|k<)|\(\?<?[=!]|\([^)]*(?:[+*?]|\{\d+(?:,\d*)?\})[^)]*\)[+*{]|\([^)]*\|[^)]*\)[+*{]/.test(pattern)) {
      throw new PolicySyntaxError("Regex uses unsupported backtracking constructs");
    }
    try {
      return new RegExp(pattern, "u");
    } catch (_) {
      throw new PolicySyntaxError("Invalid regular expression");
    }
  }

  function globRegex(pattern) {
    let result = "^";
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (char === "*") {
        result += ".*";
        if (pattern[index + 1] === "*") index += 1;
      } else if (char === "?") {
        result += ".";
      } else {
        result += escapeRegex(char);
      }
    }
    return new RegExp(`${result}$`, "u");
  }

  function normalizedUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.hash = "";
    return {
      href: url.href,
      hostname: url.hostname.toLowerCase(),
      protocol: url.protocol.slice(0, -1).toLowerCase(),
    };
  }

  function hostMatches(hostname, pattern) {
    const expected = pattern.toLowerCase().replace(/\.$/, "");
    if (expected.startsWith("*.")) {
      const base = expected.slice(2);
      return hostname === base || hostname.endsWith(`.${base}`);
    }
    return hostname === expected;
  }

  function evaluateNode(node, url) {
    switch (node.kind) {
      case "and": return evaluateNode(node.left, url) && evaluateNode(node.right, url);
      case "or": return evaluateNode(node.left, url) || evaluateNode(node.right, url);
      case "not": return !evaluateNode(node.value, url);
      case "constant": return node.value;
      case "host": return hostMatches(url.hostname, node.value);
      case "glob": return globRegex(node.value).test(url.href);
      case "regex": return safeRegex(node.value).test(url.href);
      case "scheme": return url.protocol === node.value.toLowerCase().replace(/:$/, "");
      default: return false;
    }
  }

  function validateNode(node) {
    if (node.kind === "and" || node.kind === "or") {
      validateNode(node.left);
      validateNode(node.right);
    } else if (node.kind === "not") {
      validateNode(node.value);
    } else if (node.kind === "constant") {
      if (typeof node.value !== "boolean") throw new PolicySyntaxError("Invalid Boolean constant");
    } else if (node.kind === "regex") {
      safeRegex(node.value);
    } else if (node.kind === "glob") {
      globRegex(node.value);
    } else if ((node.kind === "host" || node.kind === "scheme") && !node.value) {
      throw new PolicySyntaxError(`${node.kind} predicate cannot be empty`);
    }
  }

  function parse(expression) {
    const node = new Parser(expression).parse();
    validateNode(node);
    return node;
  }

  function matches(expression, rawUrl) {
    return evaluateNode(parse(expression), normalizedUrl(rawUrl));
  }

  function isLocalhost(rawUrl) {
    const hostname = normalizedUrl(rawUrl).hostname;
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
    if (hostname === "[::1]" || hostname === "::1") return true;
    const octets = hostname.split(".").map(Number);
    return octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 127;
  }

  root.FFMCPPolicy = { PolicySyntaxError, parse, matches, isLocalhost };
})(typeof globalThis === "object" ? globalThis : this);
