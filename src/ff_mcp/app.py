"""Expose capability-gated Firefox operations through MCP."""

from __future__ import annotations

import base64
import hmac
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import TYPE_CHECKING, Any

from mcp.server.fastmcp import Context, FastMCP, Image
from mcp.server.fastmcp.server import Settings

if TYPE_CHECKING:
    from .bridge import NativeBridge


def _client_id(ctx: Context) -> str:
    value = ctx.client_id or "local-mcp-client"
    return str(value)[:128]


def create_mcp(bridge: NativeBridge) -> FastMCP:  # ruff: ignore[complex-structure]
    """Create the MCP server and register its Firefox tools.

    Returns:
        The configured MCP server.

    """
    # mcp 1.29 leaves this generic forward reference unresolved on Python 3.14.
    if not Settings.__pydantic_complete__:
        Settings.model_rebuild(
            _types_namespace={
                "AbstractAsyncContextManager": AbstractAsyncContextManager,
                "Any": Any,
                "Callable": Callable,
                "FastMCP": FastMCP,
                "LifespanResultT": Any,
            }
        )
    mcp = FastMCP(
        "ff-mcp",
        instructions=(
            "Controls the user's existing Firefox only after Firefox-side capability checks. "
            "Call browser_request_access when an operation reports that access is required."
        ),
        json_response=True,
        stateless_http=True,
    )

    # MCP tool payloads are intentionally dynamic JSON values at this boundary.
    async def call(ctx: Context, method: str, params: dict[str, Any]) -> Any:  # ruff: ignore[any-type]
        return await bridge.request(method, params, _client_id(ctx))

    @mcp.tool(description="List open Firefox tabs. This reveals metadata, not page content.")
    async def browser_tabs(ctx: Context) -> dict[str, Any]:
        return await call(ctx, "tabs.list", {})

    @mcp.tool(description="Ask Firefox for revocable capabilities on one tab.")
    async def browser_request_access(
        tab_id: int,
        capabilities: list[str],
        ctx: Context,
        lifetime: str = "document",
        reason: str = "",
    ) -> dict[str, Any]:
        return await call(
            ctx,
            "grants.request",
            {
                "tabId": tab_id,
                "capabilities": capabilities,
                "lifetime": lifetime,
                "reason": reason[:500],
            },
        )

    @mcp.tool(description="List active and pending Firefox access grants for this client.")
    async def browser_grants(ctx: Context) -> dict[str, Any]:
        return await call(ctx, "grants.list", {})

    @mcp.tool(description="Immediately revoke a Firefox tab grant.")
    async def browser_revoke(grant_id: str, ctx: Context) -> dict[str, Any]:
        return await call(ctx, "grants.revoke", {"grantId": grant_id})

    @mcp.tool(description="Read a serialized, non-live snapshot of an authorized tab.")
    async def browser_snapshot(
        tab_id: int,
        ctx: Context,
        *,
        include_links: bool = True,
        max_chars: int = 50_000,
    ) -> dict[str, Any]:
        return await call(
            ctx,
            "page.snapshot",
            {"tabId": tab_id, "includeLinks": include_links, "maxChars": max_chars},
        )

    @mcp.tool(description="Query authorized page elements and return serialized data.")
    async def browser_query(
        tab_id: int, selector: str, ctx: Context, limit: int = 50
    ) -> dict[str, Any]:
        return await call(
            ctx, "page.query", {"tabId": tab_id, "selector": selector, "limit": limit}
        )

    @mcp.tool(description="Click an element in a tab with INTERACT access.")
    async def browser_click(tab_id: int, selector: str, ctx: Context) -> dict[str, Any]:
        return await call(
            ctx,
            "page.interact",
            {"tabId": tab_id, "action": {"kind": "click", "selector": selector}},
        )

    @mcp.tool(description="Type into a form control in a tab with INTERACT access.")
    async def browser_type(
        tab_id: int,
        selector: str,
        text: str,
        ctx: Context,
        *,
        clear: bool = True,
    ) -> dict[str, Any]:
        return await call(
            ctx,
            "page.interact",
            {
                "tabId": tab_id,
                "action": {"kind": "type", "selector": selector, "text": text, "clear": clear},
            },
        )

    @mcp.tool(description="Scroll a tab or an element in a tab with INTERACT access.")
    async def browser_scroll(
        tab_id: int,
        ctx: Context,
        x: int = 0,
        y: int = 0,
        selector: str | None = None,
    ) -> dict[str, Any]:
        return await call(
            ctx,
            "page.interact",
            {
                "tabId": tab_id,
                "action": {"kind": "scroll", "selector": selector, "x": x, "y": y},
            },
        )

    @mcp.tool(description="Navigate a tab with INTERACT access.")
    async def browser_navigate(tab_id: int, url: str, ctx: Context) -> dict[str, Any]:
        return await call(ctx, "page.navigate", {"tabId": tab_id, "url": url})

    @mcp.tool(description="Capture an authorized tab. SCREENSHOT access is separate from READ.")
    async def browser_screenshot(
        tab_id: int,
        ctx: Context,
        format: str = "png",  # ruff: ignore[builtin-argument-shadowing] - public MCP parameter name
        quality: int = 90,
    ) -> Image:
        result = await call(
            ctx,
            "page.screenshot",
            {"tabId": tab_id, "format": format, "quality": quality},
        )
        data_url = result.get("dataUrl", "")
        if not isinstance(data_url, str) or "," not in data_url:
            message = "Firefox returned an invalid screenshot"
            raise ValueError(message)
        header, encoded = data_url.split(",", 1)
        image_format = "jpeg" if "image/jpeg" in header else "png"
        return Image(data=base64.b64decode(encoded, validate=True), format=image_format)

    @mcp.tool(
        description=(
            "Execute arbitrary JavaScript in an authorized tab. Requires the separate, high-risk "
            "SCRIPT capability and Firefox's optional userScripts permission."
        )
    )
    async def browser_evaluate(
        tab_id: int,
        code: str,
        ctx: Context,
        world: str = "MAIN",
    ) -> dict[str, Any]:
        return await call(
            ctx,
            "page.script",
            {"tabId": tab_id, "code": code, "world": world},
        )

    @mcp.tool(description="Read recent extension-side authorization and operation audit events.")
    async def browser_audit(ctx: Context, limit: int = 100) -> dict[str, Any]:
        return await call(ctx, "audit.list", {"limit": limit})

    return mcp


ASGIApp = Callable[
    [
        dict[str, Any],
        Callable[[], Awaitable[dict[str, Any]]],
        Callable[[dict[str, Any]], Awaitable[None]],
    ],
    Awaitable[None],
]


class BearerAuthMiddleware:
    """Small localhost auth layer that also rejects unexpected browser origins."""

    def __init__(self, app: ASGIApp, token: str, allowed_origins: tuple[str, ...] = ()) -> None:
        """Initialize the middleware with its downstream app and access policy."""
        self.app = app
        self.token = token
        self.allowed_origins = set(allowed_origins)

    async def __call__(self, scope: dict[str, Any], receive: Callable, send: Callable) -> None:
        """Authenticate an ASGI request before forwarding it downstream."""
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        supplied = headers.get(b"authorization", b"").decode("latin-1")
        expected = f"Bearer {self.token}"
        origin = headers.get(b"origin")
        origin_value = origin.decode("latin-1") if origin else None
        if not hmac.compare_digest(supplied, expected):
            await self._reject(send, 401, b"Missing or invalid bearer token")
            return
        if origin_value is not None and origin_value not in self.allowed_origins:
            await self._reject(send, 403, b"Origin is not allowed")
            return
        await self.app(scope, receive, send)

    @staticmethod
    async def _reject(send: Callable, status: int, body: bytes) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"text/plain; charset=utf-8")],
            }
        )
        await send({"type": "http.response.body", "body": body})
