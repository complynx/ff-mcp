"""Bounded native-host diagnostics without request data or exception values."""

from __future__ import annotations

import logging
import os
import sys
import traceback
from contextlib import contextmanager
from logging.handlers import RotatingFileHandler
from typing import TYPE_CHECKING

from . import __version__
from .config import default_config_path

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

LOG = logging.getLogger("ff_mcp.lifecycle")
LOG.propagate = False


def log_path() -> Path:
    """Locate the native host log.

    Returns:
        The log path beside the configuration.

    """
    return default_config_path().with_name("native-host.log")


def diagnostic_paths() -> dict[str, str | bool]:
    """Inspect installation paths without reading configuration or starting the host.

    Returns:
        Version, runtime and file locations, and log availability.

    """
    path = log_path()
    return {
        "version": __version__,
        "python": sys.executable,
        "config_path": str(default_config_path()),
        "log_path": str(path),
        "log_exists": path.is_file(),
    }


@contextmanager
def host_diagnostics() -> Iterator[None]:
    """Record lifecycle failures; never attach payloads, locals, or exception text."""
    handler = None
    try:  # ruff: ignore[too-many-statements-in-try-clause] - optional logging setup
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.close(descriptor)
        handler = RotatingFileHandler(path, maxBytes=262_144, backupCount=2, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        LOG.addHandler(handler)
        LOG.setLevel(logging.INFO)
    except OSError:
        # A read-only log directory must not prevent a browser connection.
        sys.stderr.write("ff-mcp: cannot open native host diagnostic log\n")
    try:
        LOG.info(
            "Host starting; version=%s python=%s pid=%s",
            __version__,
            sys.version.split()[0],
            os.getpid(),
        )
        yield
    except BaseException as error:
        frames = " -> ".join(
            f"{frame.filename}:{frame.lineno} ({frame.name})"
            for frame in traceback.extract_tb(error.__traceback__)
        )
        # Exception formatting would include potentially private exception values.
        LOG.error(  # ruff: ignore[error-instead-of-exception]
            "Host exited: %s errno=%s; %s",
            type(error).__name__,
            getattr(error, "errno", None),
            frames,
        )
        raise
    finally:
        LOG.info("Host stopped")
        if handler is not None:
            LOG.removeHandler(handler)
            handler.close()
