"use strict";

const elements = {
  status: document.querySelector("#status"),
  toggle: document.querySelector("#toggle"),
  connection: document.querySelector("#connection"),
  url: document.querySelector("#server-url"),
  token: document.querySelector("#server-token"),
  copy: document.querySelector("#copy"),
  pending: document.querySelector("#pending"),
  grants: document.querySelector("#grants"),
  settings: document.querySelector("#settings"),
};

let currentState;

function node(name, text, className) {
  const value = document.createElement(name);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
}

function renderPending(request) {
  const card = node("article", undefined, "card warning");
  card.append(node("strong", request.title || `Tab ${request.tabId}`));
  card.append(node("p", request.url, "truncate muted"));
  card.append(node("p", `${request.clientId} requests ${request.capabilities.join(", ")}`));
  if (request.reason) card.append(node("p", request.reason, "reason"));
  const select = document.createElement("select");
  for (const [value, label] of [["once", "One operation"], ["document", "Until navigation"], ["tab_session", "Until tab closes"], ["persistent", "Always for this host"]]) {
    const option = node("option", label);
    option.value = value;
    option.selected = value === request.requestedLifetime;
    select.append(option);
  }
  const actions = node("div", undefined, "actions");
  const deny = node("button", "Deny", "secondary");
  const allow = node("button", "Allow");
  deny.addEventListener("click", async () => update(await browser.runtime.sendMessage({ type: "pending.deny", requestId: request.id })));
  allow.addEventListener("click", async () => {
    if (request.capabilities.includes("SCRIPT")) {
      const granted = await browser.permissions.request({ permissions: ["userScripts"] });
      if (!granted) {
        allow.textContent = "Permission denied";
        return;
      }
    }
    update(await browser.runtime.sendMessage({ type: "pending.approve", requestId: request.id, lifetime: select.value }));
  });
  actions.append(deny, select, allow);
  card.append(actions);
  return card;
}

function renderGrant(grant) {
  const card = node("article", undefined, "card");
  card.append(node("strong", grant.title || `Tab ${grant.tabId}`));
  card.append(node("p", `${grant.capabilities.join(", ")} · ${grant.lifetime}`, "muted"));
  const revoke = node("button", "Revoke", "secondary");
  revoke.addEventListener("click", async () => update(await browser.runtime.sendMessage({ type: "grant.revoke", grantId: grant.id })));
  card.append(revoke);
  return card;
}

function update(state) {
  currentState = state;
  elements.status.textContent = state.running ? "Server running on localhost" : state.starting ? "Server starting…" : "Server stopped";
  elements.toggle.textContent = state.running || state.starting ? "Stop" : "Start";
  elements.connection.classList.toggle("hidden", !state.running);
  elements.url.value = state.host ? state.host.url : "";
  elements.token.value = state.host ? state.host.token : "";

  elements.pending.replaceChildren();
  if (state.pending.length) state.pending.forEach((request) => elements.pending.append(renderPending(request)));
  else elements.pending.append(node("p", "No pending requests.", "muted"));

  elements.grants.replaceChildren();
  if (state.grants.length) state.grants.forEach((grant) => elements.grants.append(renderGrant(grant)));
  else elements.grants.append(node("p", "No temporary grants.", "muted"));
}

async function refreshWhileStarting() {
  const state = await browser.runtime.sendMessage({ type: "ui.state" });
  update(state);
  if (state.starting) setTimeout(refreshWhileStarting, 250);
}

elements.toggle.addEventListener("click", async () => {
  const type = currentState && (currentState.running || currentState.starting) ? "host.stop" : "host.start";
  update(await browser.runtime.sendMessage({ type }));
  if (type === "host.start") setTimeout(refreshWhileStarting, 250);
});

elements.copy.addEventListener("click", async () => {
  if (!currentState || !currentState.host) return;
  const connection = { url: currentState.host.url, headers: { Authorization: `Bearer ${currentState.host.token}` } };
  await navigator.clipboard.writeText(JSON.stringify(connection, null, 2));
  elements.copy.textContent = "Copied";
});

elements.settings.addEventListener("click", () => browser.runtime.openOptionsPage());
browser.runtime.sendMessage({ type: "ui.state" }).then(update);
