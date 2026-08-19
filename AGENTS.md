# Agent rules

Goal: set up local ff-mcp from repo. Full runbook: [docs/agent-setup.md](docs/agent-setup.md).
User guide: [docs/user-setup.md](docs/user-setup.md).

## Hard limits

- Need explicit user profile choice. Never guess profile.
- Ask before system-software install, GUI launch, shell-startup edit, or client-config edit outside repo.
- Firefox confirmation stays. Never sideload into profile or auto-grant capability.
- Token stays private. Never run `ff-mcp connection --show-token` in captured tool output.
- Never commit token, print token, paste token, or bind MCP outside loopback.
- Do not run `ff-mcp serve`. Firefox starts native host.

## Setup

1. Check OS, Firefox 150+, Python 3.14, `uv`.
2. Run `uv tool install --force .`.
3. If command missing: run `uv tool dir --bin`; use absolute binary. Ask before `uv tool update-shell`.
4. Run `ff-mcp profiles --json`.
5. Show profiles. Ask user for exact path.
6. Ask before Firefox launch.
7. Run:

   ```sh
   ff-mcp setup --profile "/exact/profile/path" --install-addon --json
   ```

8. User confirms Firefox install. User opens popup and presses **Start**.
9. Snap/Flatpak may show portal prompt. User approves.
10. User privately runs `ff-mcp connection --show-token` and sets `FF_MCP_TOKEN`.
11. Configure chosen client from runbook. Ask before external config write.
12. Verify tool list, `browser_tabs`, approved `READ`, then `browser_revoke`.

No profile found: user opens `about:profiles`, copies **Root Directory**, gives exact path.

Launch fails: run `--download-addon`; give XPI path. User installs through `about:addons` → gear →
**Install Add-on From File…**.

## Checks

```sh
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv sync --locked --group dev
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run ruff check .
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run ruff format --check .
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run pytest -q
node --test tests/background.test.js tests/content.test.js tests/policy.test.js tests/rule-model.test.js
```

Preserve Firefox capability boundary. Setup convenience must not weaken consent, token secrecy, or
loopback binding.
