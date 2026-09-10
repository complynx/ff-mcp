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
- Read bounded snapshots with stable document-scoped element references and CSS query results.
- Batch up to 20 known actions and return a snapshot in one tool call.
- Click, type, scroll, and navigate with structured operations.
- Run JavaScript only after a separate `SCRIPT` grant.
- Build persistent rules with a visual editor.
- Audit access decisions and sensitive operations in Firefox.
- Listen automatically while enabled on a loopback-only MCP server.

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

On Windows, follow [Windows installation and repair](docs/user-setup.md#windows-installation-and-repair).
It uses explicit uv directories outside AppData and registration from ordinary PowerShell outside
Codex. This avoids an installation visible to a packaged agent but unavailable to Firefox.

The main commands on other platforms are:

```sh
uv tool install --force .
ff-mcp profiles --json
ff-mcp setup --profile "/path/to/your/profile" --install-addon
```

Confirm the installation in Firefox. The enabled extension starts listening automatically.

For extension development, open `about:debugging`. Select **This Firefox**. Select
**Load Temporary Add-on**. Then select [extension/manifest.json](extension/manifest.json).

## Connect an MCP client

Run `ff-mcp connection` for the local URL. No token or connection approval is needed.
Remove bearer-token settings from older client entries. Each MCP instance uses a separate
stateful HTTP session. Browser-origin HTTP requests are rejected.

See the [user setup guide](docs/user-setup.md#connect-your-mcp-client) for Codex, Claude Code, and
generic MCP client examples.

## Permission flow

1. Call `browser_tabs` and select a tab ID.
2. Call `browser_request_access` with capabilities, agent name, model, harness, and a brief task reason.
3. Approve or reject the request in Firefox.
4. Use the approved browser tool.
5. Revoke the grant in Firefox or with `browser_revoke`.

`READ` access is enabled by default for these local addresses:

- `localhost`
- Subdomains of `.localhost`
- `127.0.0.0/8`
- `::1`

This default does not grant `INTERACT`, `SCRIPT`, or `SCREENSHOT` access.

## Efficient browser use

Request the needed capabilities together with `lifetime: "tab_session"` to keep approval through
navigation. The popup still lets the user choose a shorter lifetime. Request only what the task needs.
Use `browser_snapshot` to get visible controls with `@ref` selectors; pass these directly to click,
type, or batch actions. References become invalid when the document changes. CSS selectors also work.
The default text limit is 12,000 characters; increase `max_chars` when needed.

Snapshots are compact by default, including those returned by waits and action batches. Visible
controls appear once in `elements`, with stable references, short names (ARIA labels, associated
labels, or visible text), link targets, and relevant state. Compact snapshots omit the duplicate
`forms` and `links` lists and empty attributes. They retain page text and visible headings for context.
`truncation` reports text clipping and omitted controls or headings; individual shortened names and
link targets carry truncation flags. Controls are limited to 200. Use `browser_query` for controls
beyond that limit. Use `browser_snapshot(compact=false)` for full attributes, form structure, and
the separate links list; `include_links` controls that list only in full mode. Input values are not
included in either mode.

Use `browser_actions` for a known sequence such as filling several fields. It requires READ and
INTERACT, executes at most 20 click/type/scroll actions in order, and returns a snapshot. It stops on
failure and reports `completed`; inspect that result before retrying. A page navigation or transport
failure can interrupt the response after actions have run. Async UI updates can need another snapshot.

### Wait for page readiness

`browser_navigate` sends navigation once, then waits for the destination content script by default.
Its `wait` result reports `ready`, `timeout`, or `error`; a timeout does not undo the navigation.
Set `wait_until: "none"` for the previous immediate-return behavior.

Use `browser_wait` or `browser_snapshot(wait_for=...)` for asynchronous UI updates. Conditions are
combined with AND. An empty condition waits for an accessible document. Supported fields are:

- `selector`: CSS selector or a current-document `@ref`.
- `state`: `attached`, `detached`, `visible` (default), `hidden`, or `enabled`; requires a selector.
- `text`: case-sensitive substring in the element's rendered text, or the page text without a selector.
- `url`: exact absolute HTTP(S) URL, including query and fragment.

For example, after opening a review dialog:

```json
{
  "tab_id": 22,
  "wait_for": {"selector": "[role=dialog] button[type=submit]", "state": "enabled"},
  "timeout_ms": 10000
}
```

`browser_wait` returns `{status: "ready", snapshot: ...}` or `{status: "timeout", timeoutMs: ...}`.
A waiting `browser_snapshot` returns its normal snapshot on success or the same timeout object.
Both require READ access, recheck consent during waiting, and consume a one-use grant only on success.
Use a tab-session grant and CSS selectors for waits that span navigation.

Timeouts default to 10 seconds and accept 1–20,000 milliseconds. Polling is bounded even when a content script does not answer. Waits do not retry actions,
wait for network-idle, or guarantee that all asynchronous work is finished. Use a condition that
represents the next action's prerequisite. Batches remain synchronous; split a batch at an async
boundary, wait for the condition, then continue.

## Policy rules

Open the extension options page to use the visual policy editor. Each new rule has one main `AND`
group. The main group contains an `OR` allow group and a `NAND` exclusion group.

Add host, URL pattern, regular expression, or scheme conditions. You can nest `AND`, `OR`, `NAND`,
and `NOR` groups. Then select the capabilities that the rule grants.

An empty positive group matches nothing. An empty negated group matches everything. Therefore, a
new rule stays inactive until you add a condition to its allow group.

The default localhost rule starts with `READ` access. You can edit or disable it, but you cannot
delete it. A persistent approval is automatically added to the main allow group of a new rule.

Regular expressions have a length limit. They cannot use backreferences, lookarounds, or clear
nested quantifiers. This is a safety subset. It is not a complete RE2 implementation.

## Development

```sh
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv sync --locked --group dev
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run ruff check .
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run ruff format --check .
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run pytest -q
node --test tests/background.test.js tests/content.test.js tests/policy.test.js tests/rule-model.test.js tests/popup.test.js tests/waits.test.js
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

Check the four synchronized version sources, or bump all of them with one command:

```sh
python3 scripts/version.py check
python3 scripts/version.py bump patch  # also accepts minor, major, or an exact X.Y.Z
```

A tag in the form `vX.Y.Z` starts the release workflow. CI checks that `pyproject.toml`, the Python
package, the Firefox manifest, and `uv.lock` all have the same version. The release additionally
requires the tag to match that version.

The workflow sends the extension to Mozilla Add-ons for unlisted signing. It verifies the returned
XPI. It then attaches the signed XPI and its SHA-256 file to a GitHub release. These generated files
stay untracked. It also publishes `updates.json` at a stable latest-release URL. Signed versions
that contain this update URL use the file for automatic self-distributed updates.

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
- Temporary grants are bound to one MCP session. A reconnect with a new session needs new grants.
- Persistent rules (including default localhost READ) apply to every session and local client.
- Agent/model/harness labels are supplied by the client, not verified identities.
- Local clients can list tab metadata without approval. Approvals gate page operations.
- A click or input operation can cause page actions. Grant `INTERACT` access with care.
- `SCRIPT` gives full page control. A main-world script can read and change page-owned JavaScript
  state. Grant it only to clients and sites that you trust.

See [firefox_mcp_extension_findings.html](firefox_mcp_extension_findings.html) for the design
research.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md).
