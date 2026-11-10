"""Regression tests for the PR #1 review findings."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from mcp_google_health.api import HealthApi
from mcp_google_health.credentials import AuthorizedUser, TokenProvider, save_credentials
from mcp_google_health.errors import HealthError
from mcp_google_health.request import ApiRequest
from mcp_google_health.validation import ecma_pattern, normalize_numbers


@pytest.mark.anyio
async def test_refresh_reloads_credentials_after_new_sign_in(credentials_file: Path) -> None:
    now = [0.0]
    seen: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        refresh_token = parse_qs(request.content.decode())["refresh_token"][0]
        seen.append(refresh_token)
        if refresh_token == "refresh-value":
            return httpx.Response(400, json={"error": "invalid_grant"})
        return httpx.Response(200, json={"access_token": "fresh", "expires_in": 3600})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        tokens = TokenProvider(client, credentials_file, "https://test/token", lambda: now[0])
        with pytest.raises(HealthError, match="invalid_grant"):
            await tokens.access_token()
        save_credentials(
            credentials_file,
            AuthorizedUser(
                client_id="client-id", client_secret="secret-value", refresh_token="new"
            ),
        )
        assert await tokens.access_token() == "fresh"
    assert seen == ["refresh-value", "new"]


@pytest.mark.anyio
async def test_api_error_redacts_the_request_token_after_a_refresh(credentials_file: Path) -> None:
    now = [0.0]
    issued = iter(["token-a", "token-b"])

    async def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(200, json={"access_token": next(issued), "expires_in": 100})
        # The token rotates while this request is in flight.
        now[0] = 1000.0
        await tokens.access_token()
        bearer = request.headers["authorization"].removeprefix("Bearer ")
        return httpx.Response(403, json={"error": {"status": "DENIED", "message": bearer}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        tokens = TokenProvider(client, credentials_file, "https://test/token", lambda: now[0])
        api = HealthApi(client, tokens)
        request = ApiRequest("GET", "https://test/v4/users/me/profile", {})
        with pytest.raises(HealthError) as error:
            await api.call(request)
    assert str(error.value) == "Google Health API DENIED: [redacted]"


@pytest.mark.anyio
@pytest.mark.parametrize("token", ["access\r\nX-Leak: 1", "tab\there", "", "naïve"])
async def test_unusable_access_token_is_a_sign_in_failure(
    credentials_file: Path, token: str
) -> None:
    def handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": token, "expires_in": 3600})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        tokens = TokenProvider(client, credentials_file, "https://test/token")
        with pytest.raises(HealthError) as error:
            await tokens.access_token()
    assert str(error.value) == "Google sign-in failed. Run the auth command again."


@pytest.mark.parametrize(
    ("pattern", "value", "matches"),
    [
        ("^[a-z]+$", "steps", True),
        ("^[a-z]+$", "steps\n", False),
        ("^(?!\\.{1,2}$)[a-z.]+$", "..", False),
        ("^(?!\\.{1,2}$)[a-z.]+$", "..\n", False),
        ("^[$]+$", "$$", True),
        ("^a\\$$", "a$", True),
        ("^a\\$$", "a$\n", False),
    ],
)
def test_ecma_end_anchor(pattern: str, value: str, matches: bool) -> None:
    assert (ecma_pattern(pattern).search(value) is not None) is matches


def test_integral_floats_become_ints() -> None:
    assert normalize_numbers({"pageSize": 1.0, "nested": [2.0, 2.5, True], "s": "1.0"}) == {
        "pageSize": 1,
        "nested": [2, 2.5, True],
        "s": "1.0",
    }
