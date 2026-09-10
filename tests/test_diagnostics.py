"""Native diagnostics must stay bounded and exclude exception values."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import patch

import pytest

from ff_mcp import diagnostics

if TYPE_CHECKING:
    from pathlib import Path


def test_failure_log_omits_sensitive_exception_text(tmp_path: Path) -> None:
    """Keep a useful stack location without recording secrets in exception text.

    Raises:
        ValueError: Simulated host failure, caught by pytest.

    """
    path = tmp_path / "native-host.log"
    message = "private-token"
    handlers = list(diagnostics.LOG.handlers)
    with (
        patch.object(diagnostics, "log_path", return_value=path),
        pytest.raises(ValueError, match="private-token"),
        diagnostics.host_diagnostics(),
    ):
        raise ValueError(message)
    output = path.read_text(encoding="utf-8")
    assert "ValueError" in output
    assert "test_failure_log_omits_sensitive_exception_text" in output
    assert "Host stopped" in output
    assert "private-token" not in output
    assert diagnostics.LOG.handlers == handlers


def test_unwritable_log_does_not_block_host(tmp_path: Path) -> None:
    """Continue serving when diagnostics cannot open a file."""
    handlers = list(diagnostics.LOG.handlers)
    with (
        patch.object(diagnostics, "log_path", return_value=tmp_path / "native-host.log"),
        patch.object(diagnostics.os, "open", side_effect=PermissionError),
        diagnostics.host_diagnostics(),
    ):
        pass
    assert diagnostics.LOG.handlers == handlers


def test_logs_rotate(tmp_path: Path) -> None:
    """Repeated failures must not grow the log without a bound."""
    path = tmp_path / "native-host.log"
    with patch.object(diagnostics, "log_path", return_value=path), diagnostics.host_diagnostics():
        for _ in range(800):
            diagnostics.LOG.info("x" * 1024)
    assert path.with_suffix(".log.1").exists()
    assert path.with_suffix(".log.2").exists()
    file_count = 3
    max_bytes = 262_144
    assert len(list(tmp_path.iterdir())) == file_count
    assert all(item.stat().st_size <= max_bytes for item in tmp_path.iterdir())
