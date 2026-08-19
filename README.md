# ff-mcp

`ff-mcp` gives local MCP clients controlled access to the Firefox profile you already use. It is
made of a Firefox Manifest V3 WebExtension and a Python Native Messaging host that serves MCP over
Streamable HTTP on `127.0.0.1`.

The extension—not the localhost process—is the final authorization boundary. Listing tab metadata
does not grant access to page content. Reading, interaction, and screenshots require independent,
revocable capabilities.

## Current capabilities

- List tab metadata without page access.
- Request `READ`, `INTERACT`, `SCRIPT`, and `SCREENSHOT` on a specific tab.
- Grant access once, for a document, for a tab session, or persistently for a host.
- Read bounded serialized snapshots and CSS-query results. Live DOM objects never cross the bridge.
- Click, type, scroll, and navigate through structured operations.
- Capture a tab only with a separate screenshot grant.
- Execute arbitrary JavaScript in the isolated user-script world or the page's main world only with
  a separate `SCRIPT` grant and Firefox's optional `userScripts` permission.
- Match persistent policies with `host`, `glob`, `regex`, and `scheme` predicates composed with
  `AND`, `OR`, and `NOT`.
- Audit authorization decisions and sensitive operations inside Firefox.
- Bind MCP to loopback only, require a generated bearer token, and reject HTTP origins by default.

## Requirements

- Firefox 150 or newer.
- Python 3.14 (the package is pinned to the 3.14 minor line).
- [`uv`](https://docs.astral.sh/uv/) is recommended for installation.

## Install from a checkout

Install the native companion as a persistent tool, then register it with Firefox:

```sh
uv tool install .
ff-mcp install-native
```

For development, load [`extension/manifest.json`](extension/manifest.json) from
`about:debugging` → **This Firefox** → **Load Temporary Add-on**.

Open the ff-mcp toolbar popup and press **Start**. The first start creates a private configuration
file containing a random token:

- Linux: `$XDG_CONFIG_HOME/ff-mcp/config.json` or `~/.config/ff-mcp/config.json`
- macOS: `~/.config/ff-mcp/config.json`
- Windows: `%APPDATA%\ff-mcp\config.json`

The popup shows and can copy a generic connection object:

```json
{
  "url": "http://127.0.0.1:8765/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_GENERATED_TOKEN"
  }
}
```

Configure those values in an MCP client that supports Streamable HTTP and custom headers. The
endpoint exists only while the extension holds its Native Messaging connection open.

## Permission flow

1. Call `browser_tabs` and choose a tab ID.
2. Call `browser_request_access` with one or more capabilities.
3. Approve the toolbar request in Firefox.
4. Call the read, interaction, or screenshot tool.
5. Revoke the grant from the toolbar or with `browser_revoke`.

`READ` is allowed by default only for `localhost`, subdomains of `.localhost`, `127.0.0.0/8`, and
`::1`. This default does not include interaction, scripting, or screenshots.

## Policy rules

The options page has a visual policy editor. Each new rule starts with a main `AND` container that
contains an `OR` allow group and a `NAND` exclusion group. Add host, URL-pattern, regex, or scheme
conditions; nest more `AND`, `OR`, `NAND`, or `NOR` containers when needed; then choose the
capabilities the matching rule grants.

Empty non-negated containers match nothing. Empty negated containers match everything, so a new
rule remains inactive until its allow group has at least one condition. The always-enabled localhost
READ rule is shown separately and cannot be edited or removed.

Existing expression-based rules are migrated into the visual tree when the settings page opens.
The expression format remains the stored representation for backward compatibility.

Regex patterns are length-limited and reject backreferences, lookarounds, and obvious nested
quantifiers. This is a safety subset, not a complete RE2 implementation.

## Development

```sh
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv sync --group dev
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run pytest -q
# Opt-in: launches the installed Firefox headlessly with a fresh temporary profile.
FF_MCP_RUN_FIREFOX_TESTS=1 UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run pytest -q tests/test_firefox_integration.py
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run ruff check .
UV_CACHE_DIR=/tmp/ff-mcp-uv-cache uv run ruff format --check .
node tests/policy.test.js
node tests/rule-model.test.js
node tests/background.test.js
node tests/content.test.js
node --check extension/background.js
node --check extension/content.js
node --check extension/options.js
```

Set `FIREFOX_BINARY` for installations Selenium cannot discover automatically. The integration test
recognizes the standard Linux Snap location without extra configuration.

The Firefox extension has no runtime third-party dependencies or build step.

## Security limits

- The extension necessarily requests broad site access so it can mediate arbitrary tabs and use
  Firefox's background-tab screenshot API. Its internal capability checks are therefore critical.
- Firefox-restricted pages such as `about:` and the add-ons store cannot be read by content scripts.
- A tab-session grant intentionally survives navigation in that tab; document grants do not.
- MCP client identity is descriptive within the one bearer-token trust domain. Use a separate config
  and token if mutually untrusted local clients need isolation.
- Structured clicks and input can still trigger page behavior. Grant `INTERACT` sparingly.
- `SCRIPT` is effectively full page control. Firefox asks for its optional `userScripts` permission
  during approval, and ff-mcp still requires a separate tab capability. `MAIN`-world scripts can
  access and alter page-owned JavaScript state; grant this only to clients and sites you trust.

See [`firefox_mcp_extension_findings.html`](firefox_mcp_extension_findings.html) for the design
research that preceded this implementation.

## License

MIT. See [`LICENSE`](LICENSE) and [`THIRD_PARTY.md`](THIRD_PARTY.md).
