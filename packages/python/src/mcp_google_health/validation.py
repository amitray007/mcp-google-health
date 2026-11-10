from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from functools import cache
from typing import Protocol, cast

from jsonschema import Draft202012Validator, ValidationError, validators

from mcp_google_health.json_types import Json, JsonObject


class InputValidator(Protocol):
    def is_valid(self, instance: Json) -> bool: ...


class _TypeChecking(Protocol):
    def is_type(self, instance: object, type: str) -> bool: ...


@cache
def ecma_pattern(pattern: str) -> re.Pattern[str]:
    """Compiles a JSON Schema (ECMA-262) pattern so `$` matches only at the end, as in JavaScript.

    Python's `$` also matches before a final newline, which would let `"steps\\n"` pass.
    """
    translated: list[str] = []
    escaped = in_class = False
    for char in pattern:
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "[":
            in_class = True
        elif char == "]":
            in_class = False
        elif char == "$" and not in_class:
            translated.append(r"\Z")
            continue
        translated.append(char)
    return re.compile("".join(translated))


def _pattern(
    validator: _TypeChecking, pattern: str, instance: object, _schema: object
) -> Iterator[ValidationError]:
    if isinstance(instance, str) and not ecma_pattern(pattern).search(instance):
        yield ValidationError(f"{instance!r} does not match {pattern!r}")


_ecma_validator = cast(
    Callable[[JsonObject], InputValidator],
    validators.extend(Draft202012Validator, {"pattern": _pattern}),  # pyright: ignore[reportUnknownMemberType]
)


def input_validator(schema: JsonObject) -> InputValidator:
    return _ecma_validator(schema)


def normalize_numbers(value: Json) -> Json:
    """Turns integral floats such as 1.0 into ints, so requests match the TypeScript package."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [normalize_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_numbers(item) for key, item in value.items()}
    return value
