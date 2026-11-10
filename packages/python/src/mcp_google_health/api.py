from __future__ import annotations

import httpx

from mcp_google_health.credentials import TokenProvider
from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import Json, compact_json, parse_json
from mcp_google_health.request import Absent, ApiRequest


def api_failure(response: httpx.Response) -> HealthError:
    fallback = f"Google Health API returned HTTP {response.status_code}."
    try:
        data = parse_json(response.text)
    except ValueError:
        return HealthError(fallback)
    error = data.get("error") if isinstance(data, dict) else None
    if not isinstance(error, dict) or not isinstance(error.get("message"), str):
        return HealthError(fallback)
    status = error.get("status", response.status_code)
    if not isinstance(status, (str, int)):
        return HealthError(fallback)
    return HealthError(f"Google Health API {status}: {error['message']}")


class HealthApi:
    def __init__(self, client: httpx.AsyncClient, tokens: TokenProvider) -> None:
        self.client = client
        self.tokens = tokens

    async def call(self, request: ApiRequest) -> Json:
        token = await self.tokens.access_token()
        headers = {"authorization": f"Bearer {token}"}
        content: bytes | None = None
        if not isinstance(request.body, Absent):
            headers["content-type"] = "application/json"
            content = compact_json(request.body).encode("utf-8")
        try:
            response = await self.client.request(
                request.method, request.url, params=request.query, headers=headers, content=content
            )
        except httpx.HTTPError:
            raise HealthError("Google Health API request failed.") from None
        if not response.is_success:
            raise HealthError(self.tokens.redact_message(str(api_failure(response))))
        try:
            return parse_json(response.text) if response.text else {}
        except ValueError:
            raise HealthError("Google Health API returned invalid JSON.") from None
