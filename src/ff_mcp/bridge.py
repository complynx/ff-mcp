"""Frame Native Messaging data and correlate Firefox bridge requests."""

from __future__ import annotations

import asyncio
import json
import struct
import threading
from typing import TYPE_CHECKING, Any, BinaryIO
from uuid import uuid4

MAX_NATIVE_INPUT_BYTES = 64 * 1024 * 1024
MAX_NATIVE_OUTPUT_BYTES = 1024 * 1024
NATIVE_HEADER_BYTES = 4

if TYPE_CHECKING:
    from collections.abc import Callable


class BridgeError(RuntimeError):
    """An operation failed at the Firefox authorization boundary."""


def encode_native_message(message: dict[str, Any]) -> bytes:
    """Encode one JSON object as a Firefox Native Messaging frame.

    Returns:
        The length-prefixed UTF-8 JSON frame.

    Raises:
        BridgeError: If the encoded message exceeds the safety limit.

    """
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_NATIVE_OUTPUT_BYTES:
        error = "Native message exceeds Firefox's 1 MiB output limit"
        raise BridgeError(error)
    return struct.pack("=I", len(payload)) + payload


def read_native_message(stream: BinaryIO) -> dict[str, Any] | None:
    """Read one Firefox Native Messaging frame.

    Returns:
        The decoded JSON object, or `None` at EOF.

    Raises:
        BridgeError: If the frame is truncated, oversized, or not a JSON object.

    """
    header = stream.read(NATIVE_HEADER_BYTES)
    if not header:
        return None
    if len(header) != NATIVE_HEADER_BYTES:
        error = "Truncated native message header"
        raise BridgeError(error)
    (length,) = struct.unpack("=I", header)
    if length > MAX_NATIVE_INPUT_BYTES:
        error = "Native message exceeds the 64 MiB safety limit"
        raise BridgeError(error)
    payload = stream.read(length)
    if len(payload) != length:
        error = "Truncated native message body"
        raise BridgeError(error)
    value = json.loads(payload)
    if not isinstance(value, dict):
        error = "Native message must be a JSON object"
        raise BridgeError(error)
    return value


class NativeWriter:
    """Serialize writes to a Native Messaging output stream."""

    def __init__(self, stream: BinaryIO) -> None:
        """Initialize a writer for the given binary stream."""
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        """Write one framed message atomically."""
        frame = encode_native_message(message)
        with self._lock:
            self._stream.write(frame)
            self._stream.flush()


class NativeBridge:
    """Correlate asynchronous requests with Firefox responses."""

    def __init__(self, send: Callable[[dict[str, Any]], None], timeout: float = 30.0) -> None:
        """Initialize the bridge with a transport callback and timeout."""
        self._send = send
        self._timeout = timeout
        self._pending: dict[str, asyncio.Future[Any]] = {}

    # Bridge responses are dynamic JSON values until individual MCP tools validate them.
    async def request(self, method: str, params: dict[str, Any], client_id: str) -> Any:  # ruff: ignore[any-type]
        """Send a request and await its correlated Firefox response.

        Returns:
            The dynamic JSON value returned by Firefox.

        Raises:
            BridgeError: If Firefox rejects or does not answer the request.

        """
        request_id = str(uuid4())
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            self._send(
                {
                    "type": "bridge.request",
                    "id": request_id,
                    "method": method,
                    "params": params,
                    "clientId": client_id,
                }
            )
            return await asyncio.wait_for(future, timeout=self._timeout)
        except TimeoutError as exc:
            error = "Firefox did not answer the request in time"
            raise BridgeError(error) from exc
        finally:
            self._pending.pop(request_id, None)

    def receive(self, message: dict[str, Any]) -> bool:
        """Resolve a pending request if `message` is a bridge response.

        Returns:
            Whether the message was a bridge response.

        """
        if message.get("type") != "bridge.response":
            return False
        future = self._pending.get(str(message.get("id", "")))
        if future is None or future.done():
            return True
        if message.get("ok"):
            future.set_result(message.get("result"))
        else:
            error = message.get("error") or {}
            future.set_exception(
                BridgeError(str(error.get("message", "Firefox rejected the request")))
            )
        return True

    def close(self, reason: str = "Firefox disconnected") -> None:
        """Reject all pending requests because the bridge disconnected."""
        for future in self._pending.values():
            if not future.done():
                future.set_exception(BridgeError(reason))
