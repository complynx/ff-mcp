"""Tests for native companion configuration creation and validation."""

from __future__ import annotations

import json
import os
import stat
from typing import TYPE_CHECKING

import pytest

from ff_mcp.config import CONFIG_MODE, DEFAULT_PORT, load_or_create_config

if TYPE_CHECKING:
    from pathlib import Path


def test_creates_config(tmp_path: Path) -> None:
    """Create the default port configuration when config is absent."""
    path = tmp_path / "nested" / "config.json"
    config = load_or_create_config(path)
    assert "token" not in json.loads(path.read_text())
    assert config.port == DEFAULT_PORT
    assert path.exists()


def test_accepts_legacy_token_config(tmp_path: Path) -> None:
    """Load older configurations without requiring their unused token."""
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps({"token": "short", "port": DEFAULT_PORT}),
        encoding="utf-8",
    )
    assert load_or_create_config(path).port == DEFAULT_PORT


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are not available on Windows")
def test_created_config_is_owner_only(tmp_path: Path) -> None:
    """Create the configuration file without a group/world-readable window."""
    path = tmp_path / "config.json"
    load_or_create_config(path)
    assert stat.S_IMODE(path.stat().st_mode) == CONFIG_MODE


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are not available on Windows")
def test_existing_config_permissions_are_repaired(tmp_path: Path) -> None:
    """Restrict an existing configuration file before loading it."""
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps({"token": "x" * 32, "port": DEFAULT_PORT}),
        encoding="utf-8",
    )
    path.chmod(0o644)
    load_or_create_config(path)
    assert stat.S_IMODE(path.stat().st_mode) == CONFIG_MODE
