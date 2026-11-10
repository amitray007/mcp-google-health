from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import quote

from mcp_google_health.json_types import Json, JsonObject, compact_json
from mcp_google_health.spec import RequestSpec


@dataclass(frozen=True)
class Absent:
    pass


ABSENT = Absent()


def evaluate(expression: Json, arguments: JsonObject) -> Json | Absent:
    if not isinstance(expression, dict):
        return expression
    if "arg" not in expression:
        result: JsonObject = {}
        for key, child in expression.items():
            value = evaluate(child, arguments)
            if not isinstance(value, Absent):
                result[key] = value
        return result
    name = str(expression["arg"])
    if name not in arguments:
        return ABSENT
    value = arguments[name]
    form = expression.get("format")
    if form == "sourceFamily":
        return f"users/me/dataSourceFamilies/{value}"
    if form == "civilDateTime":
        year, month, day = (int(part) for part in str(value).split("-"))
        return {"date": {"year": year, "month": month, "day": day}}
    if form == "dataPointNames":
        if not isinstance(value, list):
            raise ValueError("Data point IDs must be an array.")
        return [f"users/me/dataTypes/{arguments['dataType']}/dataPoints/{item}" for item in value]
    return value


def query_string(value: Json) -> str:
    return value if isinstance(value, str) else compact_json(value)


@dataclass(frozen=True)
class ApiRequest:
    method: str
    url: str
    query: dict[str, str]
    body: Json | Absent = ABSENT


def build_request(
    spec: RequestSpec,
    arguments: JsonObject,
    beta_types: set[str],
    base_url: str = "https://health.googleapis.com",
) -> ApiRequest:
    version = "v4"
    if spec.versioned:
        data_type = str(arguments.get("dataType", ""))
        version = str(arguments.get("apiVersion", "v4beta" if data_type in beta_types else "v4"))
    path = re.sub(
        r"\{([^}]+)\}", lambda match: quote(str(arguments[match[1]]), safe="~()*!.'-"), spec.path
    )
    query: dict[str, str] = {}
    for key, expression in spec.query.items():
        value = evaluate(expression, arguments)
        if not isinstance(value, Absent):
            query[key] = query_string(value)
    body = evaluate(spec.body, arguments) if "body" in spec.model_fields_set else ABSENT
    return ApiRequest(spec.method, f"{base_url.rstrip('/')}/{version}/{path}", query, body)
