from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

from mcp import types
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from mcp_google_health import __version__
from mcp_google_health.api import HealthApi
from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import Json, JsonObject, compact_json, object_value
from mcp_google_health.local_tools import describe_schema, list_data_types
from mcp_google_health.request import build_request
from mcp_google_health.spec import Bundle, ToolSpec, load_bundle
from mcp_google_health.validation import input_validator, normalize_numbers


@asynccontextmanager
async def empty_lifespan(_server: Server[None]) -> AsyncGenerator[None, None]:
    yield None


def tool_definition(tool: ToolSpec) -> types.Tool:
    return types.Tool.model_validate(
        {
            "name": tool.name,
            "description": tool.description,
            "annotations": tool.annotations,
            "inputSchema": tool.input_schema,
        }
    )


def save_tcx(tool: ToolSpec, arguments: JsonObject, result: Json) -> Json:
    response = tool.response
    if response is None or response.path_arg not in arguments:
        return result
    path = str(arguments[response.path_arg])
    data = object_value(result).get(response.save_field, "")
    if not isinstance(data, str):
        raise HealthError("Google Health API returned invalid TCX data.")
    encoded = data.encode("utf-8")
    Path(path).write_bytes(encoded)
    return {"outputPath": path, "bytes": len(encoded)}


async def execute(tool: ToolSpec, arguments: JsonObject, bundle: Bundle, api: HealthApi) -> Json:
    if tool.local == "listDataTypes":
        return list_data_types(bundle)
    if tool.local == "describeSchema":
        return describe_schema(str(arguments["name"]), bundle)
    if tool.request is None:
        raise HealthError("Tool has no request.")
    base_url = os.environ.get("GOOGLE_HEALTH_API_BASE_URL") or "https://health.googleapis.com"
    request = build_request(tool.request, arguments, bundle.beta_types, base_url)
    return save_tcx(tool, arguments, await api.call(request))


def create_server(api: HealthApi, bundle: Bundle | None = None) -> Server[None]:
    spec = load_bundle() if bundle is None else bundle
    validators = {tool.name: input_validator(tool.input_schema) for tool in spec.tools.tools}

    async def list_tools(
        _ctx: ServerRequestContext[None], _params: types.PaginatedRequestParams | None
    ) -> types.ListToolsResult:
        return types.ListToolsResult(tools=[tool_definition(tool) for tool in spec.tools.tools])

    async def call_tool(
        _ctx: ServerRequestContext[None], params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        tool = spec.by_name.get(params.name)
        arguments = cast(JsonObject, normalize_numbers(cast(Json, params.arguments or {})))
        message: str
        if tool is None:
            message = f"Unknown tool {params.name}."
        elif not validators[tool.name].is_valid(arguments):
            # The SDK's schema callback validates HTTP headers, not stdio arguments.
            message = f"Invalid arguments for {tool.name}."
        else:
            try:
                result = await execute(tool, arguments, spec, api)
                return types.CallToolResult(
                    content=[types.TextContent(type="text", text=compact_json(result))]
                )
            except HealthError as error:
                message = str(error)
            except OSError:
                message = "Could not write the requested output file."
        return types.CallToolResult(
            is_error=True, content=[types.TextContent(type="text", text=message)]
        )

    def input_schema(name: str) -> JsonObject | None:
        tool = spec.by_name.get(name)
        return None if tool is None else tool.input_schema

    return Server[None](
        spec.tools.server.name,
        version=__version__,
        instructions=spec.tools.server.instructions,
        lifespan=empty_lifespan,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
        get_tool_input_schema=input_schema,
    )


async def serve_stdio(server: Server[None]) -> None:
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())
