# ff-mcp

`ff-mcp` connects a local MCP client to Firefox. It gives the client only the browser access that
you approve.

The project has two parts:

- A Firefox Manifest V3 extension controls browser access.
- A Python Native Messaging host serves MCP on `127.0.0.1`.

The Firefox extension makes the final access decision. The local MCP server cannot bypass this
decision. A client can list tab metadata without page access. The client needs separate grants to
read a page, interact with a page, run a script, or take a screenshot.

## Features

- List tab metadata.
- Request `READ`, `INTERACT`, `SCRIPT`, or `SCREENSHOT` access for one tab.
- Grant access once, for one document, for one tab session, or for a host until you remove the rule.
- Read bounded page snapshots and CSS query results.
- Click, type, scroll, and navigate with structured operations.
- Run JavaScript only after a separate `SCRIPT` grant.
- Build persistent rules with a visual editor.
- Audit access decisions and sensitive operations in Firefox.
- Use a generated bearer token on a loopback-only MCP server.

## Requirements

- Firefox 150 or newer.
- Python 3.14.
- [`uv`](https://docs.astral.sh/uv/).

One-time `SCRIPT` execution needs Firefox 153 or newer. Firefox 153 added
`userScripts.execute()`. Other features support Firefox 150 or newer.

## Install

Read the [user setup guide](docs/user-setup.md) for complete instructions.

You can also give this repository to a local coding agent. The agent will read [AGENTS.md](AGENTS.md)
and guide you through setup. You must still select a Firefox profile and approve the add-on in
Firefox.

The main commands are:

```sh
uv tool install --force .
ff-mcp profiles --json
ff-mcp setup --profile "/path/to/your/profile" --install-addon
```

Confirm the installation in Firefox. Then open the ff-mcp toolbar popup and select **Start**.

For extension development, open `about:debugging`. Select **This Firefox**. Select
**Load Temporary Add-on**. Then select [extension/manifest.json](extension/manifest.json).

## Connect an MCP client

Run this command in a private terminal:

```sh
ff-mcp connection --show-token
```

Do not paste the token into chat, an issue, or a tracked file. Put the token in your MCP client's
secret store or environment. The endpoint is available only while the extension is connected.

See the [user setup guide](docs/user-setup.md#connect-your-mcp-client) for Codex, Claude Code, and
generic MCP client examples.

## Permission flow

1. Call `browser_tabs` and select a tab ID.
2. Call `browser_request_access` with the required capabilities.
3. Approve or reject the request in Firefox.
4. Use the approved browser tool.
5. Revoke the grant in Firefox or with `browser_revoke`.

`READ` access is enabled by default for these local addresses:

- `localhost`
- Subdomains of `.localhost`
- `127.0.0.0/8`
- `::1`

This default does not grant `INTERACT`, `SCRIPT`, or `SCREENSHOT` access.

## Policy rules

Open the extension options page to use the visual policy editor. Each new rule has one main `AND`
group. The main group contains an `OR` allow group and a `NAND` exclusion group.

Add host, URL pattern, regular expression, or scheme conditions. You can nest `AND`, `OR`, `NAND`,
and `NOR` groups. Then select the capabilities that the rule grants.

An empty positive group matches nothing. An empty negated group matches everything. Therefore, a
new rule stays inactive until you add a condition to its allow group.

The built-in localhost `READ` rule is always active. You cannot edit or remove it. A persistent
approval is automatically added to the main allow group.

Regular expressions have a length limit. They cannot use backreferences, lookarounds, or clear
nested quantifiers. This is a safety subset. It is not a complete RE2 implementation.

## Development

```sh
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv sync --locked --group dev
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run ruff check .
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run ruff format --check .
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run pytest -q
node --test tests/background.test.js tests/content.test.js tests/policy.test.js tests/rule-model.test.js
```

Run the Firefox integration test only when you want to start Firefox with a temporary profile:

```sh
FF_MCP_RUN_FIREFOX_TESTS=1 \
  UV_CACHE_DIR=/tmp/ff-mcp-uv-cache \
  uv run pytest -q tests/test_firefox_integration.py
```

Set `FIREFOX_BINARY` if Selenium cannot find Firefox. The test can find the standard Linux Snap
installation without this variable.

The Firefox extension has no runtime third-party dependencies. It also has no build step.

## Releases

A tag in the form `vX.Y.Z` starts the release workflow. The tag version must match the versions in
`pyproject.toml` and `extension/manifest.json`.

The workflow sends the extension to Mozilla Add-ons for unlisted signing. It verifies the returned
XPI. It then attaches the signed XPI and its SHA-256 file to a GitHub release. These generated files
stay untracked.

Set these secrets in the GitHub `release` environment:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

Create the credentials on the [AMO API keys page](https://addons.mozilla.org/developers/addon/api/key/).
Unlisted signing does not add the extension to AMO search results.

## Security limits

- The extension requests broad site access because it must support user-approved access to many
  sites. Its internal capability checks are critical.
- Approved page data and browser activity go to the local native host and MCP client.
- Firefox blocks content scripts on restricted pages such as `about:` pages and the add-ons store.
- A tab-session grant stays active after navigation in that tab. A document grant does not.
- One bearer token defines one local trust domain. Use separate configurations for clients that do
  not trust each other.
- A click or input operation can cause page actions. Grant `INTERACT` access with care.
- `SCRIPT` gives full page control. A main-world script can read and change page-owned JavaScript
  state. Grant it only to clients and sites that you trust.

See [firefox_mcp_extension_findings.html](firefox_mcp_extension_findings.html) for the design
research.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md).
