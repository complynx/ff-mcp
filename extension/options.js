"use strict";

const CAPABILITIES = ["READ", "INTERACT", "SCREENSHOT", "SCRIPT"];
const PREDICATES = {
  host: { label: "Host", placeholder: "example.com or *.example.com" },
  glob: { label: "URL pattern", placeholder: "https://example.com/projects/*" },
  regex: { label: "URL regex", placeholder: "^https://example\\.com/" },
  scheme: { label: "Scheme", placeholder: "https" },
};
const BUILTIN_RULE_ID = "builtin-localhost-read";

const rulesElement = document.querySelector("#rules");
const saveResult = document.querySelector("#save-result");
const testResult = document.querySelector("#test-result");
const testRule = document.querySelector("#test-rule");
const audit = document.querySelector("#audit");
let ruleModels = [];
let rulesRevision = 0;

function node(name, text, className) {
  const value = document.createElement(name);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
}

function selectOption(value, text, selected) {
  const option = node("option", text);
  option.value = value;
  option.selected = selected;
  return option;
}

function builtinRule() {
  return {
    id: BUILTIN_RULE_ID,
    name: "Localhost read access",
    enabled: true,
    capabilities: ["READ"],
    tree: FFMCPRuleModel.defaultTree(),
    builtin: true,
  };
}

function newRule() {
  return {
    id: crypto.randomUUID(),
    name: "New website rule",
    enabled: true,
    capabilities: ["READ"],
    tree: FFMCPRuleModel.blankTree(),
    builtin: false,
  };
}

function groupDescription(group) {
  if (group.negated && group.operator === "and") return "NAND: allow unless every condition below matches.";
  if (group.negated) return "NOR: allow only when none of the conditions below match.";
  if (group.operator === "and") return "AND: every condition below must match.";
  return "OR: at least one condition below must match.";
}

function renderPredicate(predicate, remove, readOnly) {
  const row = node("div", undefined, "predicate-row");
  const kind = document.createElement("select");
  for (const [value, details] of Object.entries(PREDICATES)) {
    kind.append(selectOption(value, details.label, predicate.predicate === value));
  }
  kind.disabled = readOnly;
  const input = document.createElement("input");
  input.type = "text";
  input.value = predicate.value;
  input.placeholder = PREDICATES[predicate.predicate].placeholder;
  input.readOnly = readOnly;
  input.setAttribute("aria-label", "Condition value");
  kind.addEventListener("change", () => {
    predicate.predicate = kind.value;
    input.placeholder = PREDICATES[kind.value].placeholder;
  });
  input.addEventListener("input", () => { predicate.value = input.value; });
  row.append(kind, input);
  if (!readOnly) {
    const removeButton = node("button", "Remove", "secondary compact");
    removeButton.type = "button";
    removeButton.addEventListener("click", remove);
    row.append(removeButton);
  }
  return row;
}

function renderGroup(group, remove, isRoot = false, readOnly = false) {
  const container = node("div", undefined, `rule-group${group.negated ? " negated" : ""}`);
  const header = node("div", undefined, "group-header");
  if (isRoot) {
    header.append(node("strong", "Main container · AND"));
  } else if (readOnly) {
    const name = group.negated ? `NOT ${group.operator.toUpperCase()}` : group.operator.toUpperCase();
    header.append(node("strong", name));
  } else {
    const operator = document.createElement("select");
    operator.className = "operator-select";
    operator.append(
      selectOption("and", "All conditions (AND)", group.operator === "and"),
      selectOption("or", "Any condition (OR)", group.operator === "or"),
    );
    operator.addEventListener("change", () => {
      group.operator = operator.value;
      renderRules();
    });
    const negated = node("label", undefined, "inline-check");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = group.negated;
    checkbox.addEventListener("change", () => {
      group.negated = checkbox.checked;
      renderRules();
    });
    negated.append(checkbox, document.createTextNode(" NOT"));
    const removeButton = node("button", "Remove group", "secondary compact");
    removeButton.type = "button";
    removeButton.addEventListener("click", remove);
    header.append(operator, negated, removeButton);
  }
  container.append(header, node("p", isRoot ? "Every child container must allow the URL." : groupDescription(group), "group-description"));

  const children = node("div", undefined, "group-children");
  group.children.forEach((child, index) => {
    const removeChild = () => {
      group.children.splice(index, 1);
      renderRules();
    };
    children.append(child.type === "group" ? renderGroup(child, removeChild, false, readOnly) : renderPredicate(child, removeChild, readOnly));
  });
  if (!group.children.length) {
    children.append(node("p", group.negated ? "Empty: permits every URL." : "Empty: dismisses every URL.", "empty-group"));
  }
  container.append(children);

  if (!readOnly) {
    const actions = node("div", undefined, "group-actions");
    const addCondition = node("button", "+ Condition", "secondary compact");
    addCondition.type = "button";
    addCondition.addEventListener("click", () => {
      group.children.push(FFMCPRuleModel.predicate());
      renderRules();
    });
    const addGroup = node("button", "+ Container", "secondary compact");
    addGroup.type = "button";
    addGroup.addEventListener("click", () => {
      group.children.push(FFMCPRuleModel.group("or"));
      renderRules();
    });
    actions.append(addCondition, addGroup);
    container.append(actions);
  }
  return container;
}

function renderRule(rule, index) {
  const card = node("article", undefined, `card rule-card${rule.builtin ? " builtin-rule" : ""}`);
  const header = node("div", undefined, "rule-card-header");
  const name = document.createElement("input");
  name.className = "rule-name";
  name.value = rule.name;
  name.readOnly = rule.builtin;
  name.setAttribute("aria-label", "Rule name");
  name.addEventListener("input", () => {
    rule.name = name.value;
    renderTester();
  });
  const enabled = node("label", undefined, "inline-check");
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.checked = rule.enabled;
  enabledInput.disabled = rule.builtin;
  enabledInput.addEventListener("change", () => { rule.enabled = enabledInput.checked; });
  enabled.append(enabledInput, document.createTextNode(rule.builtin ? " Always enabled" : " Enabled"));
  header.append(name, enabled);
  if (rule.builtin) {
    header.append(node("span", "Built in", "badge"));
  } else {
    const remove = node("button", "Delete rule", "secondary compact");
    remove.type = "button";
    remove.addEventListener("click", () => {
      ruleModels.splice(index, 1);
      renderRules();
    });
    header.append(remove);
  }
  card.append(header);

  const capabilities = document.createElement("fieldset");
  capabilities.className = "capabilities";
  capabilities.append(node("legend", "Capabilities granted when this rule matches"));
  for (const capability of CAPABILITIES) {
    const label = node("label", undefined, "inline-check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rule.capabilities.includes(capability);
    input.disabled = rule.builtin;
    input.addEventListener("change", () => {
      if (input.checked && !rule.capabilities.includes(capability)) rule.capabilities.push(capability);
      if (!input.checked) rule.capabilities = rule.capabilities.filter((value) => value !== capability);
    });
    label.append(input, document.createTextNode(` ${capability}`));
    capabilities.append(label);
  }
  card.append(capabilities, renderGroup(rule.tree, null, true, rule.builtin));
  return card;
}

function renderTester() {
  const selected = testRule.value;
  testRule.replaceChildren();
  for (const rule of ruleModels) {
    testRule.append(selectOption(rule.id, rule.name || "Unnamed rule", rule.id === selected));
  }
  if (!testRule.value && ruleModels.length) testRule.value = ruleModels[0].id;
}

function renderRules() {
  rulesElement.replaceChildren();
  ruleModels.forEach((rule, index) => rulesElement.append(renderRule(rule, index)));
  renderTester();
}

function renderAudit(events) {
  audit.replaceChildren();
  for (const event of events) {
    audit.append(node("p", `${event.at}  ${event.event}  ${event.method || ""} ${event.tabId || ""}`, "audit-row"));
  }
  if (!events.length) audit.textContent = "No audit events.";
}

function loadState(state) {
  rulesRevision = state.rulesRevision;
  const storedRules = state.rules
    .filter((rule) => rule.id !== BUILTIN_RULE_ID)
    .map((rule) => ({
      id: rule.id || crypto.randomUUID(),
      name: String(rule.name || "Unnamed rule"),
      enabled: rule.enabled !== false,
      capabilities: Array.isArray(rule.capabilities) ? [...rule.capabilities] : ["READ"],
      tree: rule.visual ? FFMCPRuleModel.fromData(rule.visual) : FFMCPRuleModel.fromExpression(rule.expression),
      builtin: false,
    }));
  ruleModels = [builtinRule(), ...storedRules];
  renderRules();
  renderAudit(state.audit);
}

document.querySelector("#add-rule").addEventListener("click", () => {
  ruleModels.push(newRule());
  renderRules();
});

document.querySelector("#save").addEventListener("click", async () => {
  try {
    const values = ruleModels.filter((rule) => !rule.builtin).map((rule) => {
      if (!rule.capabilities.length) throw new Error(`${rule.name || "Rule"} needs at least one capability`);
      return {
        id: rule.id,
        name: rule.name || "Unnamed rule",
        enabled: rule.enabled,
        capabilities: rule.capabilities,
        expression: FFMCPRuleModel.toExpression(rule.tree),
        visual: rule.tree,
      };
    });
    const state = await browser.runtime.sendMessage({
      type: "rules.save",
      rules: values,
      rulesRevision,
    });
    saveResult.textContent = "Saved";
    loadState(state);
  } catch (error) {
    saveResult.textContent = error.message;
  }
});

document.querySelector("#test").addEventListener("click", async () => {
  try {
    const rule = ruleModels.find((value) => value.id === testRule.value);
    if (!rule) throw new Error("Add a rule before testing");
    const result = await browser.runtime.sendMessage({
      type: "rules.test",
      expression: FFMCPRuleModel.toExpression(rule.tree),
      url: document.querySelector("#test-url").value,
    });
    testResult.textContent = result.matches ? "Matches" : "Does not match";
  } catch (error) {
    testResult.textContent = error.message;
  }
});

document.querySelector("#clear-audit").addEventListener("click", async () => {
  const state = await browser.runtime.sendMessage({ type: "audit.clear" });
  renderAudit(state.audit);
});

browser.runtime.sendMessage({ type: "ui.state" }).then(loadState);
