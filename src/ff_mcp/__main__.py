"""Run or install the Firefox MCP native companion."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import threading
from contextlib import suppress
from pathlib import Path
from typing import Any
from uuid import uuid4

import uvicorn

from .app import BearerAuthMiddleware, create_mcp
from .bridge import BridgeError, NativeBridge, NativeWriter, read_native_message
from .config import default_config_path, load_or_create_config
from .installer import HOST_NAME, install_native_manifest
from .onboarding import (
    FirefoxProfile,
    addon_cache_directory,
    discover_firefox_profiles,
    download_signed_addon,
    find_firefox_binary,
    launch_addon_install,
    resolve_firefox_profile,
)

LOG = logging.getLogger("ff_mcp")


def _native_arguments(arguments: list[str]) -> list[str]:
    """Normalize Firefox's platform-specific native-host arguments.

    Returns:
        Arguments suitable for the command parser.

    """
    if arguments and (
        arguments[0].endswith(".json") or arguments[0].startswith("moz-extension://")
    ):
        return ["serve"]
    return arguments


def _configure_native_stdio() -> None:
    """Disable Windows CRT newline translation for Native Messaging frames."""
    if os.name != "nt":
        return
    import msvcrt  # ruff: ignore[import-outside-top-level] - Windows-only standard library

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def _dispatch_message(
    message: dict[str, Any], bridge: NativeBridge, stopping: asyncio.Event
) -> None:
    if not bridge.receive(message) and message.get("type") == "host.shutdown":
        stopping.set()


def _read_messages(
    loop: asyncio.AbstractEventLoop, bridge: NativeBridge, stopping: asyncio.Event
) -> None:
    try:
        while message := read_native_message(sys.stdin.buffer):
            loop.call_soon_threadsafe(_dispatch_message, message, bridge, stopping)
            if message.get("type") == "host.shutdown":
                break
    except BridgeError, ValueError:
        LOG.exception("Native messaging input failed")
    finally:
        loop.call_soon_threadsafe(stopping.set)


def _connection_payload(*, show_token: bool) -> dict[str, Any]:
    config = load_or_create_config()
    token = config.token if show_token else "<redacted; run with --show-token>"
    return {
        "url": f"http://127.0.0.1:{config.port}/mcp",
        "headers": {"Authorization": f"Bearer {token}"},
        "token_env": "FF_MCP_TOKEN",
    }


def _print_profiles(*, json_output: bool) -> None:
    profiles = discover_firefox_profiles()
    if json_output:
        sys.stdout.write(json.dumps([profile.as_dict() for profile in profiles], indent=2) + "\n")
        return
    if not profiles:
        sys.stdout.write(
            "No Firefox profiles found. Open about:profiles to locate or create one.\n"
        )
        return
    for profile in profiles:
        flags = []
        if profile.default:
            flags.append("default")
        if profile.as_dict()["ff_mcp_installed"]:
            flags.append("ff-mcp installed")
        suffix = f" ({', '.join(flags)})" if flags else ""
        sys.stdout.write(f"{profile.name}{suffix}\n  {profile.path}\n")


def _prepare_addon(
    args: argparse.Namespace,
    selected_profile: FirefoxProfile | None,
    result: dict[str, Any],
) -> Path | None:
    """Prepare a signed XPI when requested and add its metadata to the result.

    Returns:
        The prepared XPI path, or ``None`` when preparation was not requested.

    Raises:
        ValueError: If add-on preparation was requested without a profile.

    """
    if args.install_addon or args.download_addon:
        if selected_profile is None:
            msg = "add-on preparation requires --profile with a profile name or path"
            raise ValueError(msg)
        if args.xpi:
            xpi_path = Path(args.xpi).expanduser().resolve()
        else:
            download_directory = (
                Path(args.download_directory).expanduser()
                if args.download_directory
                else addon_cache_directory(selected_profile)
            )
            xpi_path = download_signed_addon(destination=download_directory)
        result["addon"] = {
            "xpi": str(xpi_path),
            "downloaded_and_checksum_verified": not bool(args.xpi),
        }
        return xpi_path
    return None


def _launch_addon_prompt(
    args: argparse.Namespace,
    selected_profile: FirefoxProfile | None,
    xpi_path: Path | None,
) -> tuple[str, ...] | None:
    """Launch Firefox's confirmation prompt when installation was requested.

    Returns:
        The launched command, or ``None`` when installation was not requested.

    Raises:
        FileNotFoundError: If Firefox cannot be found.
        RuntimeError: If the profile or XPI was not prepared.

    """
    if not args.install_addon:
        return None
    if selected_profile is None or xpi_path is None:
        msg = "add-on installation requires an explicit profile and a prepared XPI"
        raise RuntimeError(msg)
    firefox_binary = find_firefox_binary(args.firefox_binary)
    if firefox_binary is None:
        msg = f"Firefox executable not found; verified XPI is available at {xpi_path}"
        raise FileNotFoundError(msg)
    return launch_addon_install(selected_profile, xpi_path, firefox_binary)


def _run_setup(args: argparse.Namespace) -> None:
    manifest_path = install_native_manifest(args.executable)
    config_path = default_config_path()
    load_or_create_config(config_path)
    profiles = discover_firefox_profiles()
    result: dict[str, Any] = {
        "native_manifest": str(manifest_path),
        "config": str(config_path),
        "connection": _connection_payload(show_token=False),
        "profiles": [profile.as_dict() for profile in profiles],
    }

    selected_profile = None
    if args.profile:
        selected_profile = resolve_firefox_profile(args.profile, profiles)
        result["selected_profile"] = selected_profile.as_dict()
    xpi_path = _prepare_addon(args, selected_profile, result)
    install_command = _launch_addon_prompt(args, selected_profile, xpi_path)
    if install_command is not None:
        result["addon_install"] = {
            "xpi": str(xpi_path),
            "command": list(install_command),
            "requires_user_confirmation": True,
        }

    if args.json:
        sys.stdout.write(json.dumps(result, indent=2) + "\n")
        return
    sys.stdout.write(f"Installed Firefox Native Messaging manifest: {manifest_path}\n")
    sys.stdout.write(f"Configuration: {config_path}\n")
    if args.install_addon:
        sys.stdout.write(
            "Opened the signed XPI in the selected Firefox profile. "
            "Confirm the installation in Firefox.\n"
        )
    elif args.download_addon:
        sys.stdout.write(f"Prepared signed XPI for manual installation: {xpi_path}\n")
    elif selected_profile is not None:
        sys.stdout.write(
            f"Selected profile: {selected_profile.name} ({selected_profile.path})\n"
            "Run this command again with --install-addon to open Firefox's installation prompt.\n"
        )
    else:
        sys.stdout.write("Choose a profile from `ff-mcp profiles`, then rerun with --profile.\n")
    sys.stdout.write(
        "After installing, open the ff-mcp toolbar popup, press Start, and configure your MCP "
        "client with the private-token steps in docs/agent-setup.md.\n"
    )


async def _wait_until_started(server: uvicorn.Server, server_task: asyncio.Task[None]) -> None:
    while not server.started and not server_task.done():  # ruff: ignore[async-busy-wait]
        await asyncio.sleep(0.01)


async def serve_native() -> None:
    """Serve MCP over localhost while bridging requests through Firefox."""
    config = load_or_create_config()
    loop = asyncio.get_running_loop()
    writer = NativeWriter(sys.stdout.buffer)
    bridge = NativeBridge(writer.send)
    stopping = asyncio.Event()

    mcp = create_mcp(bridge)
    app = BearerAuthMiddleware(mcp.streamable_http_app(), config.token, config.allowed_origins)
    uvicorn_config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=config.port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(uvicorn_config)
    server.install_signal_handlers = lambda: None
    server_task = asyncio.create_task(server.serve())
    reader = threading.Thread(
        target=_read_messages,
        args=(loop, bridge, stopping),
        name="native-message-reader",
        daemon=True,
    )
    reader.start()

    await _wait_until_started(server, server_task)
    if server_task.done():
        await server_task
        return

    writer.send(
        {
            "type": "host.ready",
            "hostName": HOST_NAME,
            "url": f"http://127.0.0.1:{config.port}/mcp",
            "token": config.token,
            "serverInstanceId": str(uuid4()),
        }
    )
    stopping_task = asyncio.create_task(stopping.wait())
    try:
        done, _ = await asyncio.wait(
            {stopping_task, server_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if server_task in done:
            await server_task
        else:
            server.should_exit = True
            await server_task
    finally:
        bridge.close()
        if not stopping_task.done():
            stopping_task.cancel()
        with suppress(asyncio.CancelledError):
            await stopping_task


def build_parser() -> argparse.ArgumentParser:
    """Build the native companion command-line parser.

    Returns:
        The configured argument parser.

    """
    parser = argparse.ArgumentParser(description="Firefox MCP native companion")
    subparsers = parser.add_subparsers(dest="command")
    install = subparsers.add_parser("install-native", help="Register the host with Firefox")
    install.add_argument("--executable", help="Absolute path to ff-mcp-native")
    profiles = subparsers.add_parser("profiles", help="List local Firefox profiles")
    profiles.add_argument("--json", action="store_true", help="Write machine-readable JSON")
    connection = subparsers.add_parser("connection", help="Print the local MCP connection object")
    connection.add_argument(
        "--show-token",
        action="store_true",
        help="Include the sensitive bearer token in output",
    )
    setup = subparsers.add_parser("setup", help="Prepare ff-mcp for a local Firefox profile")
    setup.add_argument("--profile", help="Explicit Firefox profile name or directory")
    setup.add_argument(
        "--install-addon",
        action="store_true",
        help="Download the signed XPI and open Firefox's installation prompt",
    )
    setup.add_argument(
        "--download-addon",
        action="store_true",
        help="Download and verify the signed XPI without launching Firefox",
    )
    setup.add_argument("--xpi", help="Use this signed XPI instead of downloading the release")
    setup.add_argument("--download-directory", help="Directory in which to cache the signed XPI")
    setup.add_argument("--firefox-binary", help="Firefox executable name or absolute path")
    setup.add_argument("--executable", help="Absolute path to ff-mcp-native")
    setup.add_argument("--json", action="store_true", help="Write machine-readable JSON")
    subparsers.add_parser("serve", help="Run as a Firefox Native Messaging host")
    return parser


def main() -> None:
    """Run the requested native companion command."""
    arguments = _native_arguments(sys.argv[1:])
    parser = build_parser()
    args = parser.parse_args(arguments)
    if args.command == "install-native":
        path = install_native_manifest(args.executable)
        sys.stdout.write(f"Installed Firefox Native Messaging manifest: {path}\n")
        return
    if args.command == "profiles":
        _print_profiles(json_output=args.json)
        return
    if args.command == "connection":
        sys.stdout.write(
            json.dumps(_connection_payload(show_token=args.show_token), indent=2) + "\n"
        )
        return
    if args.command == "setup":
        preparing_addon = args.install_addon or args.download_addon
        if preparing_addon and not args.profile:
            parser.error("add-on preparation requires --profile with a profile name or path")
        if args.xpi and not args.install_addon:
            parser.error("--xpi requires --install-addon")
        if args.download_directory and not preparing_addon:
            parser.error("--download-directory requires --install-addon or --download-addon")
        try:
            _run_setup(args)
        except (OSError, RuntimeError, ValueError) as error:
            parser.error(str(error))
        return
    _configure_native_stdio()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    with suppress(KeyboardInterrupt):
        asyncio.run(serve_native())


if __name__ == "__main__":
    main()
