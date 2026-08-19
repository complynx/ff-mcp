"""Tests for Firefox Native Messaging framing and request correlation."""

import asyncio
import io
import json
import struct
from typing import Any

import pytest

from ff_mcp.bridge import BridgeError, NativeBridge, encode_native_message, read_native_message


def test_round_trip() -> None:
    """Round-trip a framed JSON object without losing Unicode text."""
    message = {"type": "hello", "unicode": "fox 🦊"}
    assert read_native_message(io.BytesIO(encode_native_message(message))) == message


def test_empty_stream_is_disconnect() -> None:
    """Treat an empty input stream as a clean disconnect."""
    assert read_native_message(io.BytesIO()) is None


def test_truncated_body_is_rejected() -> None:
    """Reject a Native Messaging frame shorter than its declared size."""
    stream = io.BytesIO(struct.pack("=I", 10) + b"{}")
    with pytest.raises(BridgeError, match="Truncated"):
        read_native_message(stream)


def test_non_object_is_rejected() -> None:
    """Reject JSON values that are not objects."""
    payload = json.dumps([1, 2]).encode()
    with pytest.raises(BridgeError, match="JSON object"):
        read_native_message(io.BytesIO(struct.pack("=I", len(payload)) + payload))


def test_output_larger_than_firefox_limit_is_rejected() -> None:
    """Reject host output that Firefox would disconnect for receiving."""
    with pytest.raises(BridgeError, match="1 MiB output limit"):
        encode_native_message({"value": "x" * (1024 * 1024)})


def test_input_may_exceed_output_limit() -> None:
    """Accept bounded extension input above Firefox's smaller output limit."""
    payload = json.dumps({"value": "x" * (1024 * 1024)}).encode()
    frame = struct.pack("=I", len(payload)) + payload
    assert read_native_message(io.BytesIO(frame)) == json.loads(payload)


@pytest.mark.asyncio
async def test_response_resolves_matching_request() -> None:
    """Resolve the future matching a successful Firefox response."""
    sent: list[dict[str, Any]] = []
    bridge = NativeBridge(sent.append, timeout=1)
    task = asyncio.create_task(bridge.request("tabs.list", {}, "test-client"))
    await asyncio.sleep(0)
    request = sent[0]
    bridge.receive(
        {"type": "bridge.response", "id": request["id"], "ok": True, "result": {"tabs": []}}
    )
    assert await task == {"tabs": []}


@pytest.mark.asyncio
async def test_extension_error_is_propagated() -> None:
    """Propagate a Firefox-side authorization error to the requester."""
    sent: list[dict[str, Any]] = []
    bridge = NativeBridge(sent.append, timeout=1)
    task = asyncio.create_task(bridge.request("page.snapshot", {}, "test-client"))
    await asyncio.sleep(0)
    bridge.receive(
        {
            "type": "bridge.response",
            "id": sent[0]["id"],
            "ok": False,
            "error": {"message": "READ required"},
        }
    )
    with pytest.raises(BridgeError, match="READ required"):
        await task
