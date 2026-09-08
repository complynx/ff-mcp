"""Expose capability-gated Firefox operations through MCP."""

from __future__ import annotations

import base64
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import TYPE_CHECKING, Any, Literal, NotRequired, TypedDict
from uuid import uuid4
from weakref import WeakKeyDictionary

from mcp.server.fastmcp import Context, FastMCP, Image
from mcp.server.fastmcp.server import Settings
from mcp.types import ToolAnnotations

if TYPE_CHECKING:
    from mcp.server.session import ServerSession

    from .bridge import NativeBridge


_SESSION_IDS: WeakKeyDictionary[ServerSession, str] = WeakKeyDictionary()


class ClickAction(TypedDict):
    """Click one CSS selector or snapshot reference."""

    kind: Literal["click"]
    selector: str


class TypeAction(TypedDict):
    """Fill or append text in an editable element."""

    kind: Literal["type"]
    selector: str
    text: str
    clear: NotRequired[bool]


class ScrollAction(TypedDict):
    """Scroll the page or a selected element by pixel offsets."""

    kind: Literal["scroll"]
    selector: NotRequired[str]
    x: NotRequired[int]
    y: NotRequired[int]


type BrowserAction = ClickAction | TypeAction | ScrollAction


def _client_id(ctx: Context) -> str:
    # Bind grants to the server session, never client-supplied metadata.
    session = ctx.session
    if session not in _SESSION_IDS:
        _SESSION_IDS[session] = str(uuid4())
    return _SESSION_IDS[session]


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
            "Call browser_request_access with agent, model, harness and task before page access. "
            "Use tab_session lifetime to retain approval through navigation. "
            "Snapshots return @ref selectors; use browser_actions to batch known actions. "
            "Inspect results before choosing subsequent actions."
        ),
        json_response=True,
        stateless_http=False,
    )

    # MCP tool payloads are intentionally dynamic JSON values at this boundary.
    async def call(ctx: Context, method: str, params: dict[str, Any]) -> Any:  # ruff: ignore[any-type]
        return await bridge.request(method, params, _client_id(ctx))

    @mcp.tool(
        description="List open Firefox tabs. This reveals metadata, not page content.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=True,
        ),
    )
    async def browser_tabs(ctx: Context) -> dict[str, Any]:
        return await call(ctx, "tabs.list", {})

    @mcp.tool(
        description=(
            "Ask Firefox for revocable capabilities on one tab. Supply your agent name, model, "
            "harness (1-128 characters each) and task reason (1-500 characters). "
            "Persistent approvals apply to all sessions."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=True,
        ),
    )
    async def browser_request_access(  # ruff: ignore[too-many-arguments] - explicit consent fields
        tab_id: int,
        capabilities: list[str],
        ctx: Context,
        *,
        agent: str,
        model: str,
        harness: str,
        reason: str,
        lifetime: str = "tab_session",
    ) -> dict[str, Any]:
        return await call(
            ctx,
            "grants.request",
            {
                "tabId": tab_id,
                "capabilities": capabilities,
                "lifetime": lifetime,
                "reason": reason,
                "agent": agent,
                "model": model,
                "harness": harness,
            },
        )

    @mcp.tool(
        description="List active and pending Firefox access grants for this client.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    async def browser_grants(ctx: Context) -> dict[str, Any]:
        return await call(ctx, "grants.list", {})

    @mcp.tool(
        description="Immediately revoke a Firefox tab grant.",
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    async def browser_revoke(grant_id: str, ctx: Context) -> dict[str, Any]:
        return await call(ctx, "grants.revoke", {"grantId": grant_id})

    @mcp.tool(
        description="Read a serialized, non-live snapshot of an authorized tab.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=True,
        ),
    )
    async def browser_snapshot(
        tab_id: int,
        ctx: Context,
        *,
        include_links: bool = True,
        max_chars: int = 12_000,
    ) -> dict[str, Any]:
        return await call(
            ctx,
            "page.snapshot",
            {"tabId": tab_id, "includeLinks": include_links, "maxChars": max_chars},
        )

    @mcp.tool(
        description="Query authorized page elements and return serialized data.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=True,
        ),
    )
    async def browser_query(
        tab_id: int, selector: str, ctx: Context, limit: int = 50
    ) -> dict[str, Any]:
        return await call(
            ctx, "page.query", {"tabId": tab_id, "selector": selector, "limit": limit}
        )

    @mcp.tool(
        description="Click an element in a tab with INTERACT access.",
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=True,
        ),
    )
    async def browser_click(tab_id: int, selector: str, ctx: Context) -> dict[str, Any]:
        return await call(
            ctx,
            "page.interact",
            {"tabId": tab_id, "action": {"kind": "click", "selector": selector}},
        )

    @mcp.tool(
        description="Type into a form control in a tab with INTERACT access.",
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=True,
        ),
    )
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

    @mcp.tool(
        description="Scroll a tab or an element in a tab with INTERACT access.",
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=True,
        ),
    )
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

    @mcp.tool(
        description=(
            "Run up to 20 known click/type/scroll actions in order on one document, then "
            "return a snapshot. Uses CSS or @ref selectors. Requires READ and INTERACT. "
            "Stops on the first error and reports completed actions; do not blindly retry."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=True
        ),
    )
    async def browser_actions(
        tab_id: int, actions: list[BrowserAction], ctx: Context
    ) -> dict[str, Any]:
        return await call(ctx, "page.actions", {"tabId": tab_id, "actions": actions})

    @mcp.tool(
        description="Navigate a tab with INTERACT access.",
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=True,
        ),
    )
    async def browser_navigate(tab_id: int, url: str, ctx: Context) -> dict[str, Any]:
        return await call(ctx, "page.navigate", {"tabId": tab_id, "url": url})

    @mcp.tool(
        description="Capture an authorized tab. SCREENSHOT access is separate from READ.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=True,
        ),
    )
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
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=True,
            idempotentHint=False,
            openWorldHint=True,
        ),
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

    @mcp.tool(
        description="Read this session's recent authorization and operation audit events.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
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


class LocalOriginMiddleware:
    """Reject browser-origin requests to the local MCP endpoint."""

    def __init__(self, app: ASGIApp) -> None:
        """Initialize the middleware with its downstream app and access policy."""
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Callable, send: Callable) -> None:
        """Authenticate an ASGI request before forwarding it downstream."""
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        if b"origin" in headers or headers.get(b"sec-fetch-site") not in {None, b"none"}:
            await self._reject(send, 403, b"Browser-origin requests are not allowed")
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
