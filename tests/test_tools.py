"""Tests for the public ff-mcp tool surface."""

import pytest

from ff_mcp.app import create_mcp
from ff_mcp.bridge import NativeBridge

EXPECTED_TOOL_COUNT = 13
EXPECTED_ANNOTATIONS = {
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
