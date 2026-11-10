from __future__ import annotations

import pytest

from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import JsonObject, object_value
from mcp_google_health.local_tools import describe_schema, inline_schema, list_data_types
from mcp_google_health.spec import load_bundle


def test_schema_inlining_depth_and_merge() -> None:
    schemas: JsonObject = {
        "A": {"type": "object", "properties": {"next": {"$ref": "B"}}},
        "B": {"type": "string", "description": "target wins"},
    }
    assert inline_schema({"$ref": "A", "description": "outer"}, schemas, depth=1) == {
        "type": "object",
        "description": "outer",
        "properties": {"next": {"$ref": "B"}},
    }
    assert inline_schema({"$ref": "B", "description": "outer"}, schemas) == {
        "type": "string",
        "description": "target wins",
    }
    assert inline_schema({"$ref": "A"}, schemas, depth=0) == {"$ref": "A"}


def test_cycles_do_not_expand_but_siblings_do() -> None:
    schemas: JsonObject = {
        "A": {
            "properties": {"cycle": {"$ref": "A"}, "left": {"$ref": "B"}, "right": {"$ref": "B"}}
        },
        "B": {"type": "string"},
    }
    assert inline_schema({"$ref": "A"}, schemas) == {
        "properties": {
            "cycle": {"$ref": "A"},
            "left": {"type": "string"},
            "right": {"type": "string"},
        }
    }
    assert inline_schema([{"$ref": "B"}, {"$ref": "unknown"}], schemas) == [
        {"type": "string"},
        {"$ref": "unknown"},
    ]


def test_inlining_four_references() -> None:
    schemas: JsonObject = {str(i): {"next": {"$ref": str(i + 1)}} for i in range(6)}
    assert inline_schema({"$ref": "0"}, schemas) == {
        "next": {"next": {"next": {"next": {"$ref": "4"}}}}
    }


@pytest.mark.parametrize("name", ["heart-rate", "weight", "total-calories", "Profile", "DataPoint"])
def test_describe_real_schemas(name: str) -> None:
    assert object_value(describe_schema(name, load_bundle()))["type"] == "object"


def test_unknown_schema() -> None:
    with pytest.raises(HealthError, match="No schema named nope"):
        describe_schema("nope", load_bundle())


def test_catalog_revision() -> None:
    result = list_data_types(load_bundle())
    assert result["discoveryRevision"] == load_bundle().revision
    assert result["dataTypes"] == load_bundle().data_types
