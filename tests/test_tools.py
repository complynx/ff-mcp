"""Tests for the public ff-mcp tool surface."""

import pytest

from ff_mcp.app import create_mcp
from ff_mcp.bridge import NativeBridge

EXPECTED_TOOL_COUNT = 15
EXPECTED_ANNOTATIONS = {
    "browser_wait": (True, False, True, True),
    "browser_actions": (False, True, False, True),
    "browser_audit": (True, False, True, False),
    "browser_click": (False, True, False, True),
    "browser_evaluate": (False, True, False, True),
    "browser_grants": (True, False, True, False),
    "browser_navigate": (False, False, False, True),
    "browser_query": (True, False, True, True),
    "browser_request_access": (False, False, False, True),
    "browser_revoke": (False, True, True, False),
    "browser_screenshot": (True, False, True, True),
    "browser_scroll": (False, False, False, True),
    "browser_snapshot": (True, False, True, True),
    "browser_tabs": (True, False, True, True),
    "browser_type": (False, False, False, True),
}


@pytest.mark.asyncio
async def test_expected_tools_are_registered() -> None:
    """Register the complete supported browser tool surface."""
    mcp = create_mcp(NativeBridge(lambda _: None))
    tools = {tool.name for tool in await mcp.list_tools()}
    assert len(tools) == EXPECTED_TOOL_COUNT
    assert "browser_evaluate" in tools
    assert "browser_request_access" in tools


@pytest.mark.asyncio
async def test_all_tools_declare_complete_behavior_annotations() -> None:
    """Declare every OpenAI directory behavior hint as an explicit boolean."""
    mcp = create_mcp(NativeBridge(lambda _: None))

    for tool in await mcp.list_tools():
        annotations = tool.annotations
        assert annotations is not None
        actual = (
            annotations.readOnlyHint,
            annotations.destructiveHint,
            annotations.idempotentHint,
            annotations.openWorldHint,
        )
        assert all(isinstance(value, bool) for value in actual)
        assert actual == EXPECTED_ANNOTATIONS[tool.name]


@pytest.mark.asyncio
async def test_http_sessions_have_distinct_grant_owners() -> None:
    """Use transport sessions, ignoring client-supplied IDs when selecting grant owners."""
    import httpx  # ruff: ignore[import-outside-top-level] - integration-only dependency

    from ff_mcp.app import LocalOriginMiddleware  # ruff: ignore[import-outside-top-level]

    owners = []
    bridge = NativeBridge(lambda _: None)

    async def request(  # ruff: ignore[unused-async] - bridge test double
        method: str, params: dict, client_id: str
    ) -> dict:
        owners.append(client_id)
        return {"method": method, "params": params}

    bridge.request = request
    mcp = create_mcp(bridge)
    transport = httpx.ASGITransport(app=LocalOriginMiddleware(mcp.streamable_http_app()))
    async with (
        mcp.session_manager.run(),
        httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as client,
    ):
        headers = {"accept": "application/json, text/event-stream"}
        sessions = []
        for _ in range(2):
            response = await client.post(
                "/mcp",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-11-25",
                        "capabilities": {},
                        "clientInfo": {"name": "same-client", "version": "1"},
                    },
                },
            )
            response.raise_for_status()
            sessions.append(response.headers["mcp-session-id"])
        for session in [sessions[0], sessions[1], sessions[0]]:
            response = await client.post(
                "/mcp",
                headers={**headers, "mcp-session-id": session},
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "browser_tabs",
                        "arguments": {},
                        "_meta": {"client_id": "spoofed-shared-id"},
                    },
                },
            )
            response.raise_for_status()
            assert not response.json()["result"].get("isError")
        assert owners[0] != owners[1]
        assert owners[0] == owners[2]
