"""Tests for native companion command dispatch."""

from __future__ import annotations

import json
import secrets
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


@patch("ff_mcp.__main__.asyncio.run")
def test_firefox_manifest_arguments_start_server(run: MagicMock) -> None:
    """Treat Firefox's manifest arguments as a request to serve."""
    with (
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


def test_connection_redacts_token_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    """Do not expose the local bearer token without an explicit CLI flag."""
    token = secrets.token_urlsafe(32)
    with (
        patch.object(sys, "argv", ["ff-mcp", "connection"]),
        patch("ff_mcp.__main__.load_or_create_config", return_value=HostConfig(token=token)),
    ):
        native_main.main()
    output = capsys.readouterr().out
    assert token not in output
    assert "<redacted; run with --show-token>" in output


def test_connection_can_explicitly_show_token(capsys: pytest.CaptureFixture[str]) -> None:
    """Return the token only when the local user explicitly requests it."""
    token = secrets.token_urlsafe(32)
    with (
        patch.object(sys, "argv", ["ff-mcp", "connection", "--show-token"]),
        patch("ff_mcp.__main__.load_or_create_config", return_value=HostConfig(token=token)),
    ):
        native_main.main()
    assert token in capsys.readouterr().out


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
    config = HostConfig(token=secrets.token_urlsafe(32))
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
