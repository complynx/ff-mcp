"use strict";

const CAPABILITIES = ["READ", "INTERACT", "SCREENSHOT", "SCRIPT"];
const PREDICATES = {
  host: { label: "Host", placeholder: "example.com or *.example.com" },
  glob: { label: "URL pattern", placeholder: "https://example.com/projects/*" },
  regex: { label: "URL regex", placeholder: "^https://example\\.com/" },
  scheme: { label: "Scheme", placeholder: "https" },
};
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

function newRule() {
  return {
    id: crypto.randomUUID(),
    name: "New website rule",
    enabled: true,
    capabilities: ["READ"],
    tree: FFMCPRuleModel.blankTree(),
    required: false,
    collapsed: false,
  };
}

function groupDescription(group) {
  if (group.negated && group.operator === "and") return "NAND: allow unless every condition below matches.";
  if (group.negated) return "NOR: allow only when none of the conditions below match.";
  if (group.operator === "and") return "AND: every condition below must match.";
  return "OR: at least one condition below must match.";
}

function renderPredicate(predicate, remove) {
  const row = node("div", undefined, "predicate-row");
  const kind = document.createElement("select");
  for (const [value, details] of Object.entries(PREDICATES)) {
    kind.append(selectOption(value, details.label, predicate.predicate === value));
  }
  const input = document.createElement("input");
  input.type = "text";
  input.value = predicate.value;
  input.placeholder = PREDICATES[predicate.predicate].placeholder;
  input.setAttribute("aria-label", "Condition value");
  kind.addEventListener("change", () => {
    predicate.predicate = kind.value;
    input.placeholder = PREDICATES[kind.value].placeholder;
  });
  input.addEventListener("input", () => { predicate.value = input.value; });
  row.append(kind, input);
  const removeButton = node("button", "Remove", "secondary compact");
  removeButton.type = "button";
  removeButton.addEventListener("click", remove);
  row.append(removeButton);
  return row;
}

function renderGroup(group, remove, isRoot = false) {
  const container = document.createElement("details");
  container.className = `rule-group${group.negated ? " negated" : ""}`;
  container.open = !group.collapsed;
  container.addEventListener("toggle", () => { group.collapsed = !container.open; });
  const label = isRoot
    ? "Main container · AND"
    : `${group.negated ? "NOT " : ""}${group.operator.toUpperCase()}`;
  const summary = node("summary", label, "group-summary");
  const body = node("div", undefined, "group-body");
  container.append(summary);
  if (!isRoot) {
    const header = node("div", undefined, "group-header");
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
    body.append(header);
  }
  body.append(node("p", isRoot ? "Every child container must allow the URL." : groupDescription(group), "group-description"));

  const children = node("div", undefined, "group-children");
  group.children.forEach((child, index) => {
    const removeChild = () => {
      group.children.splice(index, 1);
      renderRules();
    };
    children.append(child.type === "group" ? renderGroup(child, removeChild) : renderPredicate(child, removeChild));
  });
  if (!group.children.length) {
    children.append(node("p", group.negated ? "Empty: permits every URL." : "Empty: dismisses every URL.", "empty-group"));
  }
  body.append(children);

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
  body.append(actions);
  container.append(body);
  return container;
}

function renderRule(rule, index) {
  const card = document.createElement("details");
  card.className = `card rule-card${rule.required ? " default-rule" : ""}`;
  card.open = !rule.collapsed;
  card.addEventListener("toggle", () => { rule.collapsed = !card.open; });
  const summary = node("summary", undefined, "rule-summary");
  const summaryName = node("strong", rule.name || "Unnamed rule");
  const summaryMeta = node("span", undefined, "rule-summary-meta");
  const updateSummary = () => {
    const status = rule.enabled ? "Enabled" : "Disabled";
    const capabilities = rule.capabilities.join(", ") || "No capabilities";
    summaryMeta.textContent = `${rule.required ? "Default · " : ""}${status} · ${capabilities}`;
  };
  updateSummary();
  summary.append(summaryName, summaryMeta);
  card.append(summary);
  const body = node("div", undefined, "rule-card-body");
  const header = node("div", undefined, "rule-card-header");
  const name = document.createElement("input");
  name.className = "rule-name";
  name.value = rule.name;
  name.setAttribute("aria-label", "Rule name");
  name.addEventListener("input", () => {
    rule.name = name.value;
    summaryName.textContent = name.value || "Unnamed rule";
    renderTester();
  });
  const enabled = node("label", undefined, "inline-check");
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.checked = rule.enabled;
  enabledInput.addEventListener("change", () => {
    rule.enabled = enabledInput.checked;
    updateSummary();
  });
  enabled.append(enabledInput, document.createTextNode(" Enabled"));
  header.append(name, enabled);
  if (rule.required) {
    header.append(node("span", "Default", "badge"));
  } else {
    const remove = node("button", "Delete rule", "secondary compact");
    remove.type = "button";
    remove.addEventListener("click", () => {
      ruleModels.splice(index, 1);
      renderRules();
    });
    header.append(remove);
  }
  body.append(header);

  const capabilities = document.createElement("fieldset");
  capabilities.className = "capabilities";
  capabilities.append(node("legend", "Capabilities granted when this rule matches"));
  for (const capability of CAPABILITIES) {
    const label = node("label", undefined, "inline-check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rule.capabilities.includes(capability);
    input.addEventListener("change", () => {
      if (input.checked && !rule.capabilities.includes(capability)) rule.capabilities.push(capability);
      if (!input.checked) rule.capabilities = rule.capabilities.filter((value) => value !== capability);
      updateSummary();
    });
    label.append(input, document.createTextNode(` ${capability}`));
    capabilities.append(label);
  }
  body.append(capabilities, renderGroup(rule.tree, null, true));
  card.append(body);
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
  ruleModels = state.rules.map((rule) => ({
      id: rule.id || crypto.randomUUID(),
      name: String(rule.name || "Unnamed rule"),
      enabled: rule.enabled !== false,
      capabilities: Array.isArray(rule.capabilities) ? [...rule.capabilities] : ["READ"],
      tree: rule.visual ? FFMCPRuleModel.fromData(rule.visual) : FFMCPRuleModel.fromExpression(rule.expression),
      required: rule.id === FFMCPRuleModel.DEFAULT_RULE_ID,
      collapsed: false,
    }));
  renderRules();
  renderAudit(state.audit);
}

document.querySelector("#add-rule").addEventListener("click", () => {
  ruleModels.push(newRule());
  renderRules();
});

document.querySelector("#save").addEventListener("click", async () => {
  try {
    const values = ruleModels.map((rule) => {
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
