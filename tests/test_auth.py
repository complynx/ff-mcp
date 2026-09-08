"""Tests for localhost MCP origin isolation."""

import asyncio
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from typing import Any

import pytest

from ff_mcp.app import LocalOriginMiddleware

type Message = dict[str, Any]
type Receive = Callable[[], Awaitable[Message]]
type Send = Callable[[Message], Awaitable[None]]


async def _request(headers: list[tuple[bytes, bytes]]) -> tuple[bool, list[Message]]:
    called = False
    messages: list[Message] = []

    async def app(_scope: Message, _receive: Receive, _send: Send) -> None:
        nonlocal called
        await asyncio.sleep(0)
        called = True

    async def receive() -> Message:
        await asyncio.sleep(0)
        return {"type": "http.request"}

    async def send(message: Message) -> None:
        await asyncio.sleep(0)
        messages.append(message)

    middleware = LocalOriginMiddleware(app)
    await middleware({"type": "http", "headers": headers}, receive, send)
    return called, messages


@pytest.mark.asyncio
async def test_valid_bearer_without_origin_is_allowed() -> None:
    """Allow a valid bearer token when the request has no browser origin."""
    called, _ = await _request([(b"authorization", b"Bearer " + b"x" * 32)])
    assert called


@pytest.mark.asyncio
async def test_local_client_needs_no_bearer() -> None:
    """Allow local MCP clients to connect without a shared secret."""
    called, messages = await _request([])
    assert called
    assert not messages


@pytest.mark.asyncio
async def test_browser_origin_is_rejected() -> None:
    """Reject browser requests from an origin outside the allowlist."""
    called, messages = await _request(
        [
            (b"authorization", b"Bearer " + b"x" * 32),
            (b"origin", b"https://attacker.example"),
        ]
    )
    assert not called
    assert messages[0]["status"] == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [[(b"origin", b"null")], [(b"origin", b"")], [(b"sec-fetch-site", b"same-site")]],
)
async def test_browser_requests_without_bearer_are_rejected(
    headers: list[tuple[bytes, bytes]],
) -> None:
    """Reject opaque origins and browser fetches without consulting a bearer token."""
    called, messages = await _request(headers)
    assert not called
    assert messages[0]["status"] == HTTPStatus.FORBIDDEN
