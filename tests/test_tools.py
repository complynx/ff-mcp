"""Tests for the public ff-mcp tool surface."""

import pytest

from ff_mcp.app import create_mcp
from ff_mcp.bridge import NativeBridge

EXPECTED_TOOL_COUNT = 13


@pytest.mark.asyncio
async def test_expected_tools_are_registered() -> None:
    """Register the complete supported browser tool surface."""
    mcp = create_mcp(NativeBridge(lambda _: None))
    tools = {tool.name for tool in await mcp.list_tools()}
    assert len(tools) == EXPECTED_TOOL_COUNT
    assert "browser_evaluate" in tools
    assert "browser_request_access" in tools
