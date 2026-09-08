# Agent setup runbook

Audience: local coding agent on same desktop as Firefox. Goal: install ff-mcp while user keeps
profile, add-on, and capability control.

## Boundaries

- Need explicit profile path from user.
- Ask before GUI launch or external config write.
- Never accept Firefox prompt for user.
- Never bypass prompt by copying XPI into profile.
- Never start `ff-mcp serve`; Firefox owns host lifecycle.

## 1. Check

```sh
firefox --version
uv --version
uv python find 3.14
```

Need Firefox 150+, Python 3.14, `uv`. Alternate Firefox path: retain for `--firefox-binary`.
Missing `uv`: point user to [official install guide](https://docs.astral.sh/uv/getting-started/installation/).
Ask before installing system software.

## 2. Install host

```sh
uv tool install --force .
ff-mcp profiles --json
```

`ff-mcp` missing from `PATH`: run `uv tool dir --bin`; use absolute path. Ask before
`uv tool update-shell` because it edits shell startup files.

Show profile list. Ask user which exact `path` to use. Never infer from `default`. Duplicate names
possible. `ff_mcp_installed` informational; Firefox state can be stale.

No result: user opens `about:profiles`, copies wanted **Root Directory**. `--profile` accepts existing
unregistered directory.

## 3. Prepare add-on

Ask before Firefox launch. Then run:

```sh
ff-mcp setup \
  --profile "/exact/user-selected/path" \
  --install-addon \
  --json
```

Command installs user Native Messaging manifest, creates owner-only config, downloads matching
Mozilla-signed XPI, checks release SHA-256, opens Firefox prompt.

User confirms prompt. Agent does not.

Useful flags:

- `--firefox-binary /path/to/firefox`: binary discovery failed.
- `--xpi /path/to/signed.xpi`: use existing signed XPI.
- `--download-directory /path`: choose XPI cache.
- `--download-addon`: verify XPI, do not launch Firefox.

Launch/profile conflict: run download-only command. Give XPI path. User opens selected profile,
opens `about:addons`, chooses gear → **Install Add-on From File…**, selects XPI.

Dev-only temporary load: user opens `about:debugging` → **This Firefox** → **Load Temporary Add-on**
→ `extension/manifest.json`. Firefox removes temporary extension on restart.

## 4. Start

The enabled extension starts the host automatically. The popup can stop or restart it. Snap/Flatpak may ask for native-messaging portal
access. User approves.

Host listens on `127.0.0.1` only. Endpoint exists only while popup connection remains active.

Run `ff-mcp connection` to get the local URL. No token is needed.

## 5. Configure client

Ask before changing client config outside repo. Inspect existing `ff-mcp` entry before replacement.

### Codex

Run:

```sh
codex mcp add ff-mcp \
  --url http://127.0.0.1:8765/mcp
codex mcp get ff-mcp --json
```

Restart if the client cannot reload. Reference:
[Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp).

### Claude Code

Run:

```sh
claude mcp add \
  --transport http \
  --scope local \
  ff-mcp http://127.0.0.1:8765/mcp
claude mcp get ff-mcp
```

Local scope keeps config outside repo. Reference:
[Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

### Other client

Use this Streamable HTTP endpoint:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:8765/mcp"
}
```

No shared token or connection approval is needed. Keep the MCP session header returned by initialization.

## 6. Verify

1. Client lists ff-mcp tools.
2. Call `browser_tabs`.
3. Request harmless-page `READ` with `browser_request_access`, including agent, model, harness, and task reason.
4. User approves in Firefox.
5. Read page.
6. Revoke with `browser_revoke`.

Confined Firefox says host missing: check WebExtensions native-messaging portal; user approves portal
prompt. Reference: [Mozilla portal design](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/native-messaging-portal-design.html).

## Repair/remove

- Repair tool: `uv tool install --force .`.
- Repair manifest: `ff-mcp setup --profile "/exact/path"`.
- Remove add-on: user uses `about:addons` in each profile.
- Remove client entry: use client command after inspecting exact entry.
- Manifest/config paths: `ff-mcp setup --json` prints them. Inspect exact path before delete.
