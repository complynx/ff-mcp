"""Install the Firefox Native Messaging host manifest."""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

HOST_NAME = "io.github.ff_mcp"
EXTENSION_ID = "ff-mcp@local"


def native_manifest_directory() -> Path:
    """Return Firefox's user-level native host directory for this platform.

    Returns:
        The platform-specific native host directory.

    """
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Mozilla/NativeMessagingHosts"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "ff-mcp"
    return Path.home() / ".mozilla/native-messaging-hosts"


def install_native_manifest(executable: str | None = None) -> Path:
    """Register an executable as the ff-mcp Firefox native host.

    Returns:
        The installed manifest path.

    Raises:
        FileNotFoundError: If the selected native host executable does not exist.

    """
    candidate = executable or shutil.which("ff-mcp-native") or sys.argv[0]
    executable_path = Path(candidate).expanduser().resolve()
    if not executable_path.is_file():
        error = f"Native host executable does not exist: {executable_path}"
        raise FileNotFoundError(error)

    directory = native_manifest_directory()
    directory.mkdir(parents=True, exist_ok=True)
    manifest_path = directory / f"{HOST_NAME}.json"
    manifest = {
        "name": HOST_NAME,
        "description": "Capability-gated Firefox MCP native host",
        "path": str(executable_path),
        "type": "stdio",
        "allowed_extensions": [EXTENSION_ID],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if os.name != "nt":
        manifest_path.chmod(0o600)
    else:  # Firefox discovers Windows manifests through the registry.
        import winreg  # ruff: ignore[import-outside-top-level] - unavailable on non-Windows platforms

        key_path = rf"Software\Mozilla\NativeMessagingHosts\{HOST_NAME}"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
    return manifest_path
