"""Tests for native companion configuration creation and validation."""

from __future__ import annotations

import json
import os
import stat
from typing import TYPE_CHECKING

import pytest

from ff_mcp.config import CONFIG_MODE, DEFAULT_PORT, MIN_TOKEN_LENGTH, load_or_create_config

if TYPE_CHECKING:
    from pathlib import Path


def test_creates_secure_random_config(tmp_path: Path) -> None:
    """Create a random token and the default port when config is absent."""
    path = tmp_path / "nested" / "config.json"
    config = load_or_create_config(path)
    assert len(config.token) >= MIN_TOKEN_LENGTH
    assert config.port == DEFAULT_PORT
    assert path.exists()


def test_rejects_short_token(tmp_path: Path) -> None:
    """Reject a token that lacks sufficient entropy."""
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps({"token": "short", "port": DEFAULT_PORT}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match=f"at least {MIN_TOKEN_LENGTH}"):
        load_or_create_config(path)


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are not available on Windows")
def test_created_config_is_owner_only(tmp_path: Path) -> None:
    """Create the bearer-token file without a group/world-readable window."""
    path = tmp_path / "config.json"
    load_or_create_config(path)
    assert stat.S_IMODE(path.stat().st_mode) == CONFIG_MODE


@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits are not available on Windows")
def test_existing_config_permissions_are_repaired(tmp_path: Path) -> None:
    """Restrict an existing bearer-token file before loading it."""
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps({"token": "x" * MIN_TOKEN_LENGTH, "port": DEFAULT_PORT}),
        encoding="utf-8",
    )
    path.chmod(0o644)
    load_or_create_config(path)
    assert stat.S_IMODE(path.stat().st_mode) == CONFIG_MODE
