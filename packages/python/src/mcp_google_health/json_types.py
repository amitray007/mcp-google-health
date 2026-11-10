from __future__ import annotations

import json
from typing import TypeAlias, cast

Json: TypeAlias = "dict[str, Json] | list[Json] | str | int | float | bool | None"
JsonObject: TypeAlias = dict[str, Json]


def parse_json(text: str) -> Json:
    return cast(Json, json.loads(text))


def compact_json(value: Json) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def object_value(value: Json) -> JsonObject:
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object.")
    return value
