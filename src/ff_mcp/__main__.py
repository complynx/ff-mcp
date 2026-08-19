"""Run or install the Firefox MCP native companion."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import threading
from contextlib import suppress
from typing import Any
from uuid import uuid4

import uvicorn

from .app import BearerAuthMiddleware, create_mcp
from .bridge import BridgeError, NativeBridge, NativeWriter, read_native_message
from .config import load_or_create_config
from .installer import HOST_NAME, install_native_manifest

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
    subparsers.add_parser("serve", help="Run as a Firefox Native Messaging host")
    return parser


def main() -> None:
    """Run the requested native companion command."""
    arguments = _native_arguments(sys.argv[1:])
    args = build_parser().parse_args(arguments)
    if args.command == "install-native":
        path = install_native_manifest(args.executable)
        sys.stdout.write(f"Installed Firefox Native Messaging manifest: {path}\n")
        return
    _configure_native_stdio()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    with suppress(KeyboardInterrupt):
        asyncio.run(serve_native())


if __name__ == "__main__":
    main()
