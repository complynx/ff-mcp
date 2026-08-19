"""Tests for localhost MCP bearer authentication."""

import asyncio
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from typing import Any

import pytest

from ff_mcp.app import BearerAuthMiddleware

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

    middleware = BearerAuthMiddleware(app, "x" * 32)
    await middleware({"type": "http", "headers": headers}, receive, send)
    return called, messages


@pytest.mark.asyncio
async def test_valid_bearer_without_origin_is_allowed() -> None:
    """Allow a valid bearer token when the request has no browser origin."""
    called, _ = await _request([(b"authorization", b"Bearer " + b"x" * 32)])
    assert called


@pytest.mark.asyncio
async def test_missing_bearer_is_rejected() -> None:
    """Reject requests that omit the bearer token."""
    called, messages = await _request([])
    assert not called
    assert messages[0]["status"] == HTTPStatus.UNAUTHORIZED


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
