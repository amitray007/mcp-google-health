from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from mcp import Client, types

from mcp_google_health.api import HealthApi
from mcp_google_health.credentials import TokenProvider
from mcp_google_health.json_types import Json, JsonObject, compact_json, object_value, parse_json
from mcp_google_health.server import create_server

ROOT = Path(__file__).resolve().parents[3]


def cases(filename: str) -> list[JsonObject]:
    data = object_value(parse_json((ROOT / "spec" / "conformance" / filename).read_text()))
    value = data["cases"]
    assert isinstance(value, list)
    return [object_value(case) for case in value]


def substitute(value: Json, tmp_path: Path, credentials_file: Path) -> Json:
    if isinstance(value, str):
        return value.replace("{tmpdir}", str(tmp_path)).replace(
            "{credentialsPath}", str(credentials_file)
        )
    if isinstance(value, list):
        return [substitute(child, tmp_path, credentials_file) for child in value]
    if isinstance(value, dict):
        return {key: substitute(child, tmp_path, credentials_file) for key, child in value.items()}
    return value


def response(spec: JsonObject) -> httpx.Response:
    status = spec["status"]
    assert isinstance(status, int)
    if "text" in spec:
        return httpx.Response(status, text=str(spec["text"]))
    return httpx.Response(status, json=spec.get("body", {}))


def subset(actual: Json, expected: Json) -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict)
        for key, value in expected.items():
            subset(actual[key], value)
    elif isinstance(expected, list):
        assert isinstance(actual, list)
        assert len(actual) >= len(expected)
        for index, value in enumerate(expected):
            subset(actual[index], value)
    else:
        assert actual == expected


def result_text(result: types.CallToolResult) -> str:
    assert len(result.content) == 1
    content = result.content[0]
    assert isinstance(content, types.TextContent)
    return content.text


ALL_CASES = [
    (category, case)
    for category in ("requests", "errors", "validation")
    for case in cases(f"{category}.json")
]


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("category", "case"),
    ALL_CASES,
    ids=[f"{category}: {case['name']}" for category, case in ALL_CASES],
)
async def test_conformance(
    category: str, case: JsonObject, tmp_path: Path, credentials_file: Path
) -> None:
    case = object_value(substitute(case, tmp_path, credentials_file))
    api_requests: list[JsonObject] = []
    token_requests: list[httpx.Request] = []
    credentials = case.get("credentials")
    if credentials == "missing":
        credentials_file.unlink()
    elif credentials == "malformed":
        credentials_file.write_text('{"type":"service_account"}')

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            token_requests.append(request)
            if "token" in case:
                return response(object_value(case["token"]))
            return httpx.Response(200, json={"access_token": "access-value", "expires_in": 3600})
        captured: JsonObject = {
            "method": request.method,
            "path": request.url.path,
            "query": dict(request.url.params),
        }
        if request.content:
            captured["body"] = parse_json(request.content.decode())
        api_requests.append(captured)
        if "api" in case:
            return response(object_value(case["api"]))
        return httpx.Response(200, json=case.get("apiResponse", {}))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        api = HealthApi(http, TokenProvider(http, credentials_file, "https://fake.test/token"))
        async with Client(create_server(api)) as client:
            result = await client.call_tool(str(case["tool"]), object_value(case["arguments"]))
    text = result_text(result)
    expect = object_value(case.get("expect", {}))
    if category == "validation":
        assert result.is_error
        assert api_requests == []
        assert token_requests == []
        return
    if category == "errors":
        assert result.is_error
        assert text == expect["text"]
        return
    assert not result.is_error
    parsed = parse_json(text)
    assert text == compact_json(parsed)
    if "request" in expect:
        assert api_requests == [expect["request"]]
        assert len(token_requests) == 1
        if "result" not in expect:
            assert parsed == case.get("apiResponse", {})
    else:
        assert api_requests == []
        assert token_requests == []
    if "result" in expect:
        assert parsed == expect["result"]
    if "resultSubset" in expect:
        subset(parsed, expect["resultSubset"])
    if "file" in expect:
        file = object_value(expect["file"])
        assert Path(str(file["path"])).read_text(encoding="utf-8") == file["content"]
