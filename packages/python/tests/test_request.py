from __future__ import annotations

import pytest

from mcp_google_health.json_types import Json, JsonObject
from mcp_google_health.request import ABSENT, ApiRequest, build_request, evaluate, query_string
from mcp_google_health.spec import RequestSpec


@pytest.mark.parametrize(
    ("expression", "arguments", "expected"),
    [
        ("literal", {}, "literal"),
        (2.5, {}, 2.5),
        (True, {}, True),
        ({"arg": "x"}, {"x": None}, None),
        ({"arg": "x"}, {"x": [1, "é"]}, [1, "é"]),
        (
            {"arg": "x", "format": "sourceFamily"},
            {"x": "all-sources"},
            "users/me/dataSourceFamilies/all-sources",
        ),
        (
            {"arg": "x", "format": "civilDateTime"},
            {"x": "2026-01-03"},
            {"date": {"year": 2026, "month": 1, "day": 3}},
        ),
        (
            {"arg": "ids", "format": "dataPointNames"},
            {"ids": ["x", "y"], "dataType": "sleep"},
            ["users/me/dataTypes/sleep/dataPoints/x", "users/me/dataTypes/sleep/dataPoints/y"],
        ),
        (
            {"keep": {"arg": "x"}, "drop": {"arg": "missing"}, "nested": {"a": {"arg": "missing"}}},
            {"x": False},
            {"keep": False, "nested": {}},
        ),
    ],
)
def test_value_expressions(expression: Json, arguments: JsonObject, expected: Json) -> None:
    assert evaluate(expression, arguments) == expected


def test_absent_formatted_argument() -> None:
    assert evaluate({"arg": "x", "format": "civilDateTime"}, {}) is ABSENT


def test_invalid_data_point_names() -> None:
    with pytest.raises(ValueError, match="array"):
        evaluate({"arg": "ids", "format": "dataPointNames"}, {"ids": "x"})


@pytest.mark.parametrize(
    ("value", "expected"), [(False, "false"), (1, "1"), (2.5, "2.5"), (True, "true"), ("é", "é")]
)
def test_query_values(value: Json, expected: str) -> None:
    assert query_string(value) == expected


@pytest.mark.parametrize(
    ("versioned", "arguments", "expected"),
    [
        (False, {"dataType": "beta", "apiVersion": "v4beta"}, "v4"),
        (True, {"dataType": "beta"}, "v4beta"),
        (True, {"dataType": "beta", "apiVersion": "v4"}, "v4"),
        (True, {"dataType": "unknown"}, "v4"),
        (True, {"dataType": "known", "apiVersion": "v4beta"}, "v4beta"),
    ],
)
def test_versions(versioned: bool, arguments: JsonObject, expected: str) -> None:
    spec = RequestSpec(method="GET", path="users/me/{dataType}", versioned=versioned)
    request = build_request(spec, arguments, {"beta"}, "https://example.test/base/")
    assert request.url == f"https://example.test/base/{expected}/users/me/{arguments['dataType']}"
    assert request.body is ABSENT


def test_percent_encoding_and_pruning() -> None:
    spec = RequestSpec.model_validate(
        {
            "method": "POST",
            "path": "users/me/{id}",
            "query": {"drop": {"arg": "missing"}, "keep": {"arg": "present"}},
            "body": {"arg": "body"},
        }
    )
    assert build_request(
        spec, {"id": "a/b ?#é%", "present": False, "body": {}}, set()
    ) == ApiRequest(
        "POST",
        "https://health.googleapis.com/v4/users/me/a%2Fb%20%3F%23%C3%A9%25",
        {"keep": "false"},
        {},
    )
