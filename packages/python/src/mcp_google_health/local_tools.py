from __future__ import annotations

import re

from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import Json, JsonObject, object_value
from mcp_google_health.spec import Bundle


def list_data_types(bundle: Bundle) -> JsonObject:
    return {"discoveryRevision": bundle.revision, "dataTypes": bundle.data_types}


def inline_schema(
    value: Json, schemas: JsonObject, depth: int = 4, path: frozenset[str] = frozenset()
) -> Json:
    if depth <= 0 or not isinstance(value, (dict, list)):
        return value
    if isinstance(value, list):
        return [inline_schema(child, schemas, depth, path) for child in value]
    reference = value.get("$ref")
    if isinstance(reference, str):
        if reference in path or reference not in schemas:
            return value
        rest = {key: child for key, child in value.items() if key != "$ref"}
        expanded = object_value(
            inline_schema(schemas[reference], schemas, depth - 1, path | {reference})
        )
        return {**rest, **expanded}
    return {key: inline_schema(child, schemas, depth, path) for key, child in value.items()}


def describe_schema(name: str, bundle: Bundle) -> Json:
    schema = bundle.schemas.get(name)
    if schema is None:
        field = re.sub(r"-([a-z])", lambda match: match[1].upper(), name)
        for parent in ("DataPoint", "RollupDataPoint", "DailyRollupDataPoint"):
            root = object_value(bundle.schemas.get(parent, {}))
            properties = object_value(root.get("properties", {}))
            candidate = properties.get(field)
            if candidate is not None:
                reference = object_value(candidate).get("$ref")
                schema = bundle.schemas.get(str(reference))
                break
    if schema is None:
        raise HealthError(f"No schema named {name}. Use a data type slug or schema name.")
    return inline_schema(schema, bundle.schemas)
