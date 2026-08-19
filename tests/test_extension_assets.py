"""Validate static Firefox extension assets."""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ROOT = PROJECT_ROOT / "extension"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_DIMENSION_OFFSET = 16
PNG_DIMENSION_BYTES = 8
PNG_COLOR_TYPE_OFFSET = 25
PNG_RGBA_COLOR_TYPE = 6
UPDATE_URL = "https://github.com/complynx/ff-mcp/releases/latest/download/updates.json"


def _manifest() -> dict[str, Any]:
    return json.loads((EXTENSION_ROOT / "manifest.json").read_text(encoding="utf-8"))


def _png_metadata(path: Path) -> tuple[int, int, int]:
    payload = path.read_bytes()
    assert payload.startswith(PNG_SIGNATURE)
    width, height = struct.unpack(
        ">II", payload[PNG_DIMENSION_OFFSET : PNG_DIMENSION_OFFSET + PNG_DIMENSION_BYTES]
    )
    return width, height, payload[PNG_COLOR_TYPE_OFFSET]


def test_manifest_icons_exist_at_declared_sizes_with_alpha() -> None:
    """Keep icon dimensions and alpha channels synchronized with the manifest."""
    manifest = _manifest()
    declared = {**manifest["icons"], **manifest["action"]["default_icon"]}

    for raw_size, relative_path in declared.items():
        size = int(raw_size)
        assert _png_metadata(EXTENSION_ROOT / relative_path) == (
            size,
            size,
            PNG_RGBA_COLOR_TYPE,
        )


def test_manifest_uses_canonical_update_url() -> None:
    """Keep self-distributed Firefox installs on the stable update channel."""
    assert _manifest()["browser_specific_settings"]["gecko"]["update_url"] == UPDATE_URL
