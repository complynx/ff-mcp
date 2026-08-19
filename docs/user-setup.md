# Set up ff-mcp

This guide explains how to install ff-mcp on the same computer as Firefox.

## Before you start

You need:

- Firefox 150 or newer.
- Python 3.14.
- [`uv`](https://docs.astral.sh/uv/).
- A local MCP client that supports Streamable HTTP and custom headers.

You must choose the Firefox profile that will contain the extension. Firefox will ask you to
confirm the extension installation. ff-mcp will ask you to approve access to websites.

## Use a coding agent

You can give this repository to Codex, Claude Code, Gemini CLI, Copilot, or another local coding
agent. Ask the agent to set up ff-mcp. The agent instructions are in [AGENTS.md](../AGENTS.md).

The agent will ask you to select a Firefox profile. It will also ask before it opens Firefox or
changes your MCP client configuration. Do not send your ff-mcp token to the agent.

## Install without an agent

Run these commands from the repository root.

### 1. Install the native companion

```sh
uv tool install --force .
```

If your shell cannot find `ff-mcp`, run this command:

```sh
uv tool dir --bin
```

Use the full path to `ff-mcp` from that directory. You can also run `uv tool update-shell` if you
want `uv` to change your shell configuration.

### 2. Select a Firefox profile

```sh
ff-mcp profiles --json
```

Choose the `path` for the profile that you want to use. Use the path instead of the profile name if
two installations have the same profile name.

If the command does not find your profile, open `about:profiles` in Firefox. Find the profile and
copy its **Root Directory**.

### 3. Install the add-on

Replace the example path with the profile path that you selected:

```sh
ff-mcp setup \
  --profile "/path/to/your/firefox/profile" \
  --install-addon
```

This command performs these actions:

1. It registers the Firefox Native Messaging host for your user account.
2. It creates a private local configuration and bearer token.
3. It downloads the Mozilla-signed XPI for this version.
4. It verifies the XPI with the published SHA-256 value.
5. It opens the XPI in the profile that you selected.

Confirm the installation in Firefox.

If Firefox does not open the XPI, prepare it for manual installation:

```sh
ff-mcp setup \
  --profile "/path/to/your/firefox/profile" \
  --download-addon
```

The command prints the XPI path. Open the selected Firefox profile. Open `about:addons`. Select the
gear menu. Select **Install Add-on From File…**. Select the XPI.

Do not copy the XPI directly into the Firefox profile. Use the Firefox installation prompt.
Mozilla also documents this process in
[Install Add-on From File](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-add-features-to-firefox).

### 4. Start ff-mcp

Open the ff-mcp toolbar popup. Select **Start**.

Firefox starts the native companion. The companion listens only on `127.0.0.1`. The MCP endpoint
stops when the extension closes its connection.

A Snap or Flatpak installation can show an additional native-messaging portal prompt. Approve the
prompt if you want ff-mcp to connect.

## Connect your MCP client

Get the connection information in a private terminal:

```sh
ff-mcp connection --show-token
```

Treat the bearer token as a password. Do not paste it into chat, an issue, or a file in this
repository. Store it in an environment variable or your client's secret store.

### Codex CLI

Set the token in the environment that starts Codex:

```sh
export FF_MCP_TOKEN="your private token"
codex mcp add ff-mcp \
  --url http://127.0.0.1:8765/mcp \
  --bearer-token-env-var FF_MCP_TOKEN
codex mcp get ff-mcp --json
```

The environment variable must be present when you start Codex in the future.
See the [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp) for more configuration options.

### Claude Code

Set the token in the environment that starts Claude Code:

```sh
export FF_MCP_TOKEN="your private token"
claude mcp add \
  --transport http \
  --scope local \
  --header 'Authorization: Bearer ${FF_MCP_TOKEN}' \
  ff-mcp http://127.0.0.1:8765/mcp
claude mcp get ff-mcp
```

See the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) for more configuration options.

### Other MCP clients

Add a Streamable HTTP server to your client. Use this connection shape:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:8765/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_LOCAL_TOKEN"
  }
}
```

Use your client's environment-variable support or secret store when possible.

## Test the connection

1. Confirm that your client lists the ff-mcp browser tools.
2. Call `browser_tabs`.
3. Request `READ` access to a harmless page with `browser_request_access`.
4. Approve the request in Firefox.
5. Read the page.
6. Revoke the grant with `browser_revoke`.

## Repair or remove ff-mcp

Run this command again to repair the Python companion:

```sh
uv tool install --force .
```

Run `ff-mcp setup --profile "/path/to/profile"` again to repair the Native Messaging manifest.
This command does not change your Firefox capability rules.

To remove ff-mcp:

1. Open `about:addons` in each Firefox profile that contains ff-mcp.
2. Remove the add-on.
3. Remove the ff-mcp entry from your MCP client.
4. Run `ff-mcp setup --json` to see the native manifest and configuration paths.
5. Check each path before you delete its file.
