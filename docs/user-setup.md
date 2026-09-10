# Set up ff-mcp

This guide explains how to install ff-mcp on the same computer as Firefox.

## Connection diagnostics

If the popup says `Server disconnected; retrying…`, it also shows the last Firefox
native-messaging error. **Rules and audit log** keeps the error with its timestamp.
If Firefox supplies no error, the popup distinguishes a startup failure from a later disconnect.

Run `ff-mcp diagnostics` to print the installed version, Python path, configuration path,
and native host log path. This command does not start a server or read configuration contents.
The host writes `native-host.log` beside its configuration, with two rotated backups
of at most 256 KiB each. It records startup, readiness, shutdown, and failure types with
stack locations. It excludes exception messages, local variables, and browser request data.

No log can be written if Firefox cannot locate or execute the host, Python cannot import
its dependencies, or the log directory is not writable. In these cases, use the popup error
and Firefox's Browser Console to check the native host registration and executable.

## Before you start

You need:

- Firefox 150 or newer.
- Python 3.14.
- [`uv`](https://docs.astral.sh/uv/).
- A local MCP client that supports stateful Streamable HTTP.

You must choose the Firefox profile that will contain the extension. Firefox will ask you to
confirm the extension installation. ff-mcp will ask you to approve access to websites.

## Use a coding agent

You can give this repository to Codex, Claude Code, Gemini CLI, Copilot, or another local coding
agent. Ask the agent to set up ff-mcp. The agent instructions are in [AGENTS.md](../AGENTS.md).

The agent will ask you to select a Firefox profile. It will also ask before it opens Firefox or
changes your MCP client configuration.

## Install without an agent

Run these commands from the repository root.

### 1. Install the native companion

On Windows, use [Windows installation and repair](#windows-installation-and-repair) below.
On other platforms:

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
2. It creates a private local configuration.
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

The enabled extension starts ff-mcp automatically, including after Firefox restarts.
Use **Stop** in the toolbar popup to disable listening and clear temporary grants.
Use **Start** to enable it again.

Firefox starts the native companion. The companion listens only on `127.0.0.1`. The MCP endpoint
stops when the extension closes its connection.

A Snap or Flatpak installation can show an additional native-messaging portal prompt. Approve the
prompt if you want ff-mcp to connect.

## Connect your MCP client

Run `ff-mcp connection` to get the local URL. No token is needed.
If you have an older client entry, remove its bearer-token header or environment setting.

### Codex CLI

Run:

```sh
codex mcp add ff-mcp \
  --url http://127.0.0.1:8765/mcp
codex mcp get ff-mcp --json
```

See the [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp) for more configuration options.

### Claude Code

Run:

```sh
claude mcp add \
  --transport http \
  --scope local \
  ff-mcp http://127.0.0.1:8765/mcp
claude mcp get ff-mcp
```

See the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) for more configuration options.

### Other MCP clients

Add a Streamable HTTP server to your client. Use this connection shape:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:8765/mcp"
}
```

No shared token or connection approval is needed. Your client must retain its MCP session header.

## Test the connection

1. Confirm that your client lists the ff-mcp browser tools.
2. Call `browser_tabs`.
3. Request `READ` access with `browser_request_access`, including agent, model, harness, and task reason.
4. Approve the request in Firefox.
5. Read the page.
6. Revoke the grant with `browser_revoke`.

## Repair or remove ff-mcp

On Windows, use the following procedure for both installation and repair.

### Windows installation and repair

Open an ordinary PowerShell from the Windows Start menu, outside Codex. Run these commands
from the repository root, with Python 3.14 and `uv` already installed:

```powershell
$env:UV_TOOL_DIR = "$env:USERPROFILE\.local\share\uv\tools"
$env:UV_TOOL_BIN_DIR = "$env:USERPROFILE\.local\bin"
uv tool install --force --python 3.14 .
if ($LASTEXITCODE -ne 0) { throw "ff-mcp installation failed" }
& "$env:UV_TOOL_BIN_DIR\ff-mcp.exe" install-native --executable "$env:UV_TOOL_BIN_DIR\ff-mcp-native.exe"
if ($LASTEXITCODE -ne 0) { throw "Native host registration failed" }
& "$env:UV_TOOL_BIN_DIR\ff-mcp.exe" diagnostics
```

If `uv` is not on PATH but is installed at `$env:USERPROFILE\.local\bin\uv.exe`, use that
full path with PowerShell's `&` operator. Use the same two `UV_TOOL_*` variables for future
tool updates or removal. They apply only to this PowerShell session; these commands do not edit
your shell startup files. Use the full `ff-mcp.exe` path for subsequent setup commands too.

Packaged Windows apps, including Codex, can redirect AppData writes into their private LocalCache.
An installation can appear correct inside Codex while Firefox cannot find the manifest or Python
runtime. The explicit tool directory avoids a launcher that points at an absent AppData runtime.
Registration must also run outside Codex so Firefox sees the same files and registry values.
Starting PowerShell through `cmd /c` inside Codex is not sufficient: that wrapper retained redirected
AppData in the verified Windows setup.

For a new installation, continue with [profile selection](#2-select-a-firefox-profile) and confirm
the add-on installation in Firefox. For an existing, current add-on, use **Stop → Start** in its
popup after repair. No profile change or add-on reinstall is needed.

If Firefox still reports `No such native application io.github.ff_mcp`, inspect the registration
in the same ordinary PowerShell:

```powershell
$hostKey = Get-Item 'HKCU:\Software\Mozilla\NativeMessagingHosts\io.github.ff_mcp'
$manifestPath = $hostKey.GetValue('')
Test-Path -LiteralPath $manifestPath
$nativeManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Test-Path -LiteralPath $nativeManifest.path
```

Both path checks must return `True`. This reads the native manifest, not `config.json`.
If the CLI reports `uv trampoline failed to canonicalize script path`, repeat the tool installation
above before attempting registration. A missing log is expected if Firefox cannot start Python.

An open port alone is not full verification: confirm MCP initialization, the tool list, and a
successful `browser_tabs` response. Reading a page is a separate capability check.

### Other platforms

Run this command again to repair the Python companion:

```sh
uv tool install --force .
```

Run `ff-mcp install-native --executable "/absolute/path/to/ff-mcp-native"` to repair only the
Native Messaging registration. This does not change profiles or Firefox capability rules.

### Removal

To remove ff-mcp:

1. Open `about:addons` in each Firefox profile that contains ff-mcp.
2. Remove the add-on.
3. Remove the ff-mcp entry from your MCP client.
4. Run `ff-mcp diagnostics` to locate the configuration and logs without changing the installation.
   On Windows, read the native manifest path from the registry as shown above. On Linux it is
   `~/.mozilla/native-messaging-hosts/io.github.ff_mcp.json`; on macOS it is
   `~/Library/Application Support/Mozilla/NativeMessagingHosts/io.github.ff_mcp.json`.
5. Check each path before you delete its file.
