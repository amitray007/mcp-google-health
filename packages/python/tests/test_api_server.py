from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from mcp import Client, types
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server

from mcp_google_health.api import HealthApi, api_failure
from mcp_google_health.credentials import TokenProvider
from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import Json, compact_json, parse_json
from mcp_google_health.request import ApiRequest
from mcp_google_health.server import create_server, empty_lifespan, save_tcx
from mcp_google_health.spec import load_bundle
from tests.test_conformance import result_text


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (
            403,
            {"error": {"status": "PERMISSION_DENIED", "message": "No access"}},
            "Google Health API PERMISSION_DENIED: No access",
        ),
        (404, {"error": {"message": "Missing"}}, "Google Health API 404: Missing"),
        (500, {"error": "Oops"}, "Google Health API returned HTTP 500."),
        (502, {"error": {"message": 42}}, "Google Health API returned HTTP 502."),
        (400, {"error": {"status": {}, "message": "Bad"}}, "Google Health API returned HTTP 400."),
        (503, [], "Google Health API returned HTTP 503."),
    ],
)
def test_api_errors(status: int, body: Json, expected: str) -> None:
    assert str(api_failure(httpx.Response(status, content=compact_json(body)))) == expected


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status", "text", "message"),
    [
        (200, "", None),
        (200, "not JSON", "Google Health API returned invalid JSON."),
        (502, "not JSON", "Google Health API returned HTTP 502."),
    ],
)
async def test_api_empty_and_invalid_json(
    credentials_file: Path, status: int, text: str, message: str | None
) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(200, json={"access_token": "ok", "expires_in": 3600})
        return httpx.Response(status, text=text)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        api = HealthApi(client, TokenProvider(client, credentials_file, "https://test/token"))
        request = ApiRequest("GET", "https://test/profile", {})
        if message is None:
            assert await api.call(request) == {}
        else:
            with pytest.raises(HealthError) as error:
                await api.call(request)
            assert str(error.value) == message


@pytest.mark.anyio
async def test_api_transport_error(credentials_file: Path) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(200, json={"access_token": "ok", "expires_in": 3600})
        raise httpx.ReadTimeout("SECRET authorization: Bearer ok")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        api = HealthApi(client, TokenProvider(client, credentials_file, "https://test/token"))
        async with Client(create_server(api)) as session:
            result = await session.call_tool("get_profile")
    assert result.is_error
    assert result_text(result) == "Google Health API request failed."


@pytest.mark.anyio
async def test_api_base_url_and_token_header(
    credentials_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GOOGLE_HEALTH_API_BASE_URL", "https://proxy.test/prefix/")
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=(
                {"access_token": "ok", "expires_in": 3600}
                if request.url.path == "/token"
                else {"name": "é"}
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        api = HealthApi(client, TokenProvider(client, credentials_file, "https://test/token"))
        async with Client(create_server(api)) as session:
            result = await session.call_tool("get_profile")
    assert result_text(result) == '{"name":"é"}'
    assert str(requests[1].url) == "https://proxy.test/prefix/v4/users/me/profile"
    assert requests[1].headers["authorization"] == "Bearer ok"
    assert "content-type" not in requests[1].headers


@pytest.mark.anyio
async def test_tools_list_is_lazy_and_matches_spec(tmp_path: Path) -> None:
    def handle(_: httpx.Request) -> httpx.Response:
        pytest.fail("Listing tools must not send requests")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        api = HealthApi(client, TokenProvider(client, tmp_path / "missing"))
        server = create_server(api)
        async with Client(server) as session:
            tools = (await session.list_tools()).tools
            unknown = await session.call_tool("unknown")
    bundle = load_bundle()
    assert len(tools) == 19
    assert {tool.name for tool in tools} == set(bundle.by_name)
    for tool in tools:
        spec = bundle.by_name[tool.name]
        assert tool.description == spec.description
        assert tool.input_schema == spec.input_schema
    assert result_text(unknown) == "Unknown tool unknown."
    assert unknown.is_error
    assert server.instructions == bundle.tools.server.instructions
    assert server.get_tool_input_schema is not None
    assert server.get_tool_input_schema("unknown") is None
    assert server.get_tool_input_schema("get_profile") == bundle.by_name["get_profile"].input_schema


@pytest.mark.anyio
async def test_installed_sdk_does_not_validate_call_arguments() -> None:
    called: list[str] = []

    async def call(
        _ctx: ServerRequestContext[None], params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        called.append(params.name)
        return types.CallToolResult(content=[])

    async def listing(
        _ctx: ServerRequestContext[None], _params: types.PaginatedRequestParams | None
    ) -> types.ListToolsResult:
        return types.ListToolsResult(
            tools=[
                types.Tool(
                    name="probe",
                    input_schema={
                        "type": "object",
                        "properties": {"x": {"type": "integer"}},
                        "required": ["x"],
                    },
                )
            ]
        )

    server = Server[None](
        "validation-probe",
        lifespan=empty_lifespan,
        on_call_tool=call,
        on_list_tools=listing,
        get_tool_input_schema=lambda _: {"type": "object", "required": ["x"]},
    )
    async with Client(server) as client:
        result = await client.call_tool("probe", {})
    assert not result.is_error
    assert called == ["probe"]


@pytest.mark.anyio
async def test_write_failure_is_tool_error(credentials_file: Path, tmp_path: Path) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json=(
                    {"access_token": "ok", "expires_in": 3600}
                    if request.url.path == "/token"
                    else {"tcxData": "abc"}
                ),
            )
        )
    ) as client:
        api = HealthApi(client, TokenProvider(client, credentials_file, "https://test/token"))
        async with Client(create_server(api)) as session:
            result = await session.call_tool(
                "export_exercise_tcx",
                {"exerciseId": "x", "outputPath": str(tmp_path / "missing" / "run.tcx")},
            )
    assert result.is_error
    assert result_text(result) == "Could not write the requested output file."


def test_tcx_missing_and_invalid_content(tmp_path: Path) -> None:
    tool = load_bundle().by_name["export_exercise_tcx"]
    path = tmp_path / "run.tcx"
    assert save_tcx(tool, {"outputPath": str(path)}, {}) == {"outputPath": str(path), "bytes": 0}
    assert path.read_bytes() == b""
    with pytest.raises(HealthError, match="invalid TCX"):
        save_tcx(tool, {"outputPath": str(path)}, {"tcxData": []})
    assert parse_json(compact_json({"a": 1})) == {"a": 1}


@pytest.mark.anyio
async def test_api_error_redacts_tokens_and_credentials(credentials_file: Path) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(200, json={"access_token": "access-value", "expires_in": 3600})
        return httpx.Response(
            403,
            json={
                "error": {"message": "access-value secret-value refresh-value", "status": "DENIED"}
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        api = HealthApi(client, TokenProvider(client, credentials_file, "https://test/token"))
        async with Client(create_server(api)) as session:
            result = await session.call_tool("get_profile")
    assert result_text(result) == "Google Health API DENIED: [redacted] [redacted] [redacted]"
