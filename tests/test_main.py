"""Tests for native companion command dispatch."""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, call, patch

import pytest

from ff_mcp import __main__ as native_main
from ff_mcp.config import HostConfig
from ff_mcp.onboarding import FirefoxProfile

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture(autouse=True)  # ruff: ignore[pytest-fixture-autouse] - isolate all CLI calls
def isolate_host_log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep command dispatch tests out of the user's diagnostic log."""
    monkeypatch.setattr("ff_mcp.diagnostics.log_path", lambda: tmp_path / "host.log")


@patch("ff_mcp.__main__.asyncio.run")
def test_firefox_manifest_arguments_start_server(run: MagicMock) -> None:
    """Treat Firefox's manifest arguments as a request to serve."""
    with (
        patch("ff_mcp.__main__._configure_native_stdio"),
        patch("ff_mcp.__main__.serve_native", new=lambda: "server"),
        patch.object(
            sys,
            "argv",
            [
                "ff-mcp-native",
                "/home/test/.mozilla/native-messaging-hosts/io.github.ff_mcp.json",
                "ff-mcp@local",
            ],
        ),
    ):
        native_main.main()
    run.assert_called_once_with("server")


@patch("ff_mcp.__main__.asyncio.run")
def test_firefox_windows_arguments_start_server(run: MagicMock) -> None:
    """Treat Firefox's Windows origin arguments as a request to serve."""
    with (
        patch("ff_mcp.__main__._configure_native_stdio"),
        patch("ff_mcp.__main__.serve_native", new=lambda: "server"),
        patch.object(
            sys,
            "argv",
            ["ff-mcp-native.exe", "moz-extension://extension-id/", "12345"],
        ),
    ):
        native_main.main()
    run.assert_called_once_with("server")


def test_windows_native_stdio_is_binary() -> None:
    """Put both Windows Native Messaging descriptors into binary mode."""
    setmode = MagicMock()
    fake_msvcrt = SimpleNamespace(setmode=setmode)
    stdin = MagicMock()
    stdout = MagicMock()
    stdin.fileno.return_value = 10
    stdout.fileno.return_value = 11
    with (
        patch.object(native_main.os, "name", "nt"),
        patch.object(native_main.os, "O_BINARY", 32768, create=True),
        patch.object(native_main.sys, "stdin", stdin),
        patch.object(native_main.sys, "stdout", stdout),
        patch.object(native_main.sys, "argv", ["ff-mcp-native", "serve"]),
        patch.dict(sys.modules, {"msvcrt": fake_msvcrt}),
        patch("ff_mcp.__main__.asyncio.run"),
        patch("ff_mcp.__main__.serve_native", new=lambda: "server"),
    ):
        native_main.main()
    assert setmode.call_args_list == [call(10, 32768), call(11, 32768)]


def test_connection_returns_url_without_authentication(capsys: pytest.CaptureFixture[str]) -> None:
    """Return the local URL without an authentication header."""
    with (
        patch.object(sys, "argv", ["ff-mcp", "connection"]),
        patch("ff_mcp.__main__.load_or_create_config", return_value=HostConfig()),
    ):
        native_main.main()
    output = capsys.readouterr().out
    assert json.loads(output) == {"url": "http://127.0.0.1:8765/mcp"}


def test_diagnostics_does_not_load_config_or_start_host(capsys: pytest.CaptureFixture[str]) -> None:
    """Print diagnostic locations without reading secrets or starting a server."""
    with (
        patch.object(sys, "argv", ["ff-mcp", "diagnostics"]),
        patch("ff_mcp.__main__.load_or_create_config") as config,
        patch("ff_mcp.__main__.serve_native") as serve,
    ):
        native_main.main()
    payload = json.loads(capsys.readouterr().out)
    assert payload["log_path"].endswith("host.log")
    assert payload["log_exists"] is False
    config.assert_not_called()
    serve.assert_not_called()


def test_legacy_show_token_flag_returns_only_url(capsys: pytest.CaptureFixture[str]) -> None:
    """Accept the deprecated flag without returning a token."""
    with (
        patch.object(sys, "argv", ["ff-mcp", "connection", "--show-token"]),
        patch("ff_mcp.__main__.load_or_create_config", return_value=HostConfig()),
    ):
        native_main.main()
    assert json.loads(capsys.readouterr().out) == {"url": "http://127.0.0.1:8765/mcp"}


def test_setup_requires_explicit_profile_for_addon_install() -> None:
    """Reject an add-on launch that does not identify the user's desired profile."""
    with (
        patch.object(sys, "argv", ["ff-mcp", "setup", "--install-addon"]),
        pytest.raises(SystemExit, match="2"),
    ):
        native_main.main()


def test_setup_requires_explicit_profile_for_addon_download() -> None:
    """Reject an add-on download that does not identify the target Firefox package."""
    with (
        patch.object(sys, "argv", ["ff-mcp", "setup", "--download-addon"]),
        pytest.raises(SystemExit, match="2"),
    ):
        native_main.main()


def test_prepares_download_without_launching_firefox(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Support a checksum-verified manual-install fallback for confined Firefox."""
    profile_path = tmp_path / "profile"
    profile_path.mkdir()
    profile = FirefoxProfile(
        name="Selected",
        path=profile_path,
        default=False,
        source=tmp_path / "profiles.ini",
    )
    download_directory = tmp_path / "downloads"
    xpi_path = download_directory / "signed.xpi"
    config = HostConfig()
    arguments = [
        "ff-mcp",
        "setup",
        "--profile",
        str(profile_path),
        "--download-addon",
        "--download-directory",
        str(download_directory),
        "--json",
    ]

    with (
        patch.object(sys, "argv", arguments),
        patch("ff_mcp.__main__.install_native_manifest", return_value=tmp_path / "host.json"),
        patch("ff_mcp.__main__.default_config_path", return_value=tmp_path / "config.json"),
        patch("ff_mcp.__main__.load_or_create_config", return_value=config),
        patch("ff_mcp.__main__.discover_firefox_profiles", return_value=(profile,)),
        patch("ff_mcp.__main__.download_signed_addon", return_value=xpi_path) as download,
        patch("ff_mcp.__main__.launch_addon_install") as launch,
    ):
        native_main.main()

    payload = json.loads(capsys.readouterr().out)
    assert payload["addon"] == {
        "xpi": str(xpi_path),
        "downloaded_and_checksum_verified": True,
    }
    download.assert_called_once_with(destination=download_directory)
    launch.assert_not_called()
