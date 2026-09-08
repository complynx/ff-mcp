"""Load and validate the native companion configuration."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_PORT = 8765
MAX_PORT = 65_535
CONFIG_MODE = 0o600


@dataclass(frozen=True)
class HostConfig:
    """Validated native companion configuration."""

    port: int = DEFAULT_PORT


def default_config_path() -> Path:
    """Return the platform-specific configuration path.

    Returns:
        The configured override or the platform default path.

    """
    override = os.environ.get("FF_MCP_CONFIG")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home()))
        return base / "ff-mcp" / "config.json"
    return (
        Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "ff-mcp" / "config.json"
    )


def _create_config(path: Path, data: dict[str, Any]) -> None:
    payload = json.dumps(data, indent=2) + "\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, CONFIG_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(payload)


def load_or_create_config(path: Path | None = None) -> HostConfig:
    """Load a validated config, creating a secure default when absent.

    Returns:
        The validated host configuration.

    Raises:
        ValueError: If a stored configuration value is invalid.

    """
    config_path = path or default_config_path()
    if not config_path.exists():
        config_path.parent.mkdir(parents=True, exist_ok=True)
        new_data: dict[str, Any] = {
            "port": DEFAULT_PORT,
        }
        try:
            _create_config(config_path, new_data)
        except FileExistsError:
            data = json.loads(config_path.read_text(encoding="utf-8"))
        else:
            data = new_data
    else:
        if os.name != "nt":
            config_path.chmod(0o600)
        data = json.loads(config_path.read_text(encoding="utf-8"))

    if os.name != "nt":
        config_path.chmod(CONFIG_MODE)

    port = data.get("port", DEFAULT_PORT)
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= MAX_PORT:
        error = f"config port must be between 1 and {MAX_PORT}"
        raise ValueError(error)
    # Ignore legacy token/origin fields. Existing config files remain compatible.
    return HostConfig(port=port)
