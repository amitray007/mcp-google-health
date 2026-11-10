from __future__ import annotations

import pytest
from pydantic import ValidationError

from mcp_google_health.json_types import JsonObject
from mcp_google_health.spec import Bundle, ToolSpec, ToolsSpec, load_bundle, read_resource


def test_bundle_is_cached() -> None:
    assert load_bundle() is load_bundle()
    assert "skin-temperature-sensors" in load_bundle().beta_types


@pytest.mark.parametrize(
    "handlers",
    [{}, {"local": "listDataTypes", "request": {"method": "GET", "path": "users/me/profile"}}],
)
def test_tool_requires_one_handler(handlers: JsonObject) -> None:
    with pytest.raises(ValidationError, match="exactly one handler"):
        ToolSpec.model_validate(
            {"name": "x", "description": "x", "annotations": {}, "inputSchema": {}, **handlers}
        )


@pytest.mark.parametrize("empty", [False, True])
def test_duplicate_and_empty_tools(empty: bool) -> None:
    spec = read_resource("tools.json")
    tools = spec["tools"]
    assert isinstance(tools, list)
    spec["tools"] = [] if empty else [tools[0], tools[0]]
    with pytest.raises(ValidationError, match="unique names"):
        ToolsSpec.model_validate(spec)


@pytest.mark.parametrize(
    "discovery",
    [
        {"revision": 1, "schemas": {}},
        {"revision": "1", "schemas": []},
        {"revision": "1", "schemas": {"A": "bad"}},
    ],
)
def test_discovery_shape(discovery: JsonObject) -> None:
    with pytest.raises(ValueError, match=r"revision must be a string|Expected a JSON object"):
        Bundle(
            read_resource("tools.json"),
            read_resource("data-types.json"),
            discovery,
            read_resource("scopes.json"),
        )
