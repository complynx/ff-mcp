"""Tests for native companion command dispatch."""

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

from ff_mcp import __main__ as native_main


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
