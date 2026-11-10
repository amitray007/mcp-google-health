from __future__ import annotations

from functools import lru_cache
from importlib.resources import files
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from mcp_google_health.json_types import JsonObject, object_value, parse_json


class SpecModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, strict=True)


class RequestSpec(SpecModel):
    method: Literal["GET", "POST", "PATCH"]
    path: str
    versioned: bool = False
    query: dict[str, JsonValue] = Field(default_factory=dict)
    body: JsonValue = None


class ResponseSpec(SpecModel):
    save_field: str = Field(alias="saveField")
    path_arg: str = Field(alias="pathArg")


class ToolSpec(SpecModel):
    name: str
    description: str
    annotations: dict[str, bool]
    input_schema: dict[str, JsonValue] = Field(alias="inputSchema")
    local: Literal["listDataTypes", "describeSchema"] | None = None
    request: RequestSpec | None = None
    response: ResponseSpec | None = None

    @model_validator(mode="after")
    def one_handler(self) -> ToolSpec:
        if (self.local is None) == (self.request is None):
            raise ValueError("A tool must have exactly one handler.")
        return self


class ServerSpec(SpecModel):
    name: str
    instructions: str


class ToolsSpec(SpecModel):
    server: ServerSpec
    tools: list[ToolSpec]

    @model_validator(mode="after")
    def unique_tools(self) -> ToolsSpec:
        if not self.tools or len({tool.name for tool in self.tools}) != len(self.tools):
            raise ValueError("The tool list must contain unique names.")
        return self


class DataType(SpecModel):
    slug: str
    kind: str
    scope: str
    operations: list[str] = Field(default_factory=list)
    beta: bool = False


class CatalogSpec(SpecModel):
    data_types: list[DataType] = Field(alias="dataTypes")


class ScopesSpec(SpecModel):
    prefix: str
    read: list[str]
    write: list[str]


class Bundle:
    def __init__(
        self, tools: JsonObject, catalog: JsonObject, discovery: JsonObject, scopes: JsonObject
    ) -> None:
        self.tools = ToolsSpec.model_validate(tools)
        self.catalog = CatalogSpec.model_validate(catalog)
        self.scopes = ScopesSpec.model_validate(scopes)
        self.data_types = catalog["dataTypes"]
        self.revision = discovery["revision"]
        self.schemas = object_value(discovery["schemas"])
        if not isinstance(self.revision, str):
            raise ValueError("The discovery revision must be a string.")
        for schema in self.schemas.values():
            object_value(schema)
        self.by_name = {tool.name: tool for tool in self.tools.tools}
        self.beta_types = {entry.slug for entry in self.catalog.data_types if entry.beta}


def read_resource(name: str) -> JsonObject:
    text = files("mcp_google_health").joinpath("spec").joinpath(name).read_text(encoding="utf-8")
    return object_value(parse_json(text))


@lru_cache(maxsize=1)
def load_bundle() -> Bundle:
    return Bundle(
        read_resource("tools.json"),
        read_resource("data-types.json"),
        read_resource("discovery.json"),
        read_resource("scopes.json"),
    )
