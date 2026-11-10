from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from mcp_google_health.credentials import (
    AuthorizedUser,
    TokenProvider,
    credentials_path,
    load_credentials,
    save_credentials,
)
from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import Json, compact_json


def test_path_precedence(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    assert credentials_path({}) == tmp_path / ".config/mcp-google-health/credentials.json"
    assert credentials_path({"GOOGLE_APPLICATION_CREDENTIALS": "fallback"}) == Path("fallback")
    assert credentials_path(
        {"GOOGLE_HEALTH_CREDENTIALS": "primary", "GOOGLE_APPLICATION_CREDENTIALS": "fallback"}
    ) == Path("primary")
    monkeypatch.setenv("GOOGLE_HEALTH_CREDENTIALS", "environment")
    assert credentials_path() == Path("environment")


@pytest.mark.parametrize(
    "contents",
    [
        "not JSON",
        "[]",
        "null",
        "{}",
        '{"type":"service_account"}',
        '{"type":"authorized_user","client_id":"x"}',
        '{"type":"authorized_user","client_id":"","client_secret":"secret","refresh_token":"r"}',
        '{"type":"authorized_user","client_id":1,"client_secret":"secret","refresh_token":"r"}',
        '{"type":"authorized_user","client_id":"x","client_secret":"secret","refresh_token":""}',
    ],
)
def test_malformed(credentials_file: Path, contents: str) -> None:
    credentials_file.write_text(contents)
    with pytest.raises(HealthError, match="not a Google authorized_user credentials file") as error:
        load_credentials(credentials_file)
    assert "secret" not in str(error.value)


def test_missing_and_unreadable(tmp_path: Path) -> None:
    for path in (tmp_path / "missing", tmp_path):
        with pytest.raises(HealthError, match="No Google Health credentials"):
            load_credentials(path)


def test_save_permissions(tmp_path: Path) -> None:
    path = tmp_path / "private" / "user.json"
    user = AuthorizedUser(client_id="c", client_secret="s", refresh_token="r")
    save_credentials(path, user)
    path.chmod(0o644)
    path.parent.chmod(0o755)
    save_credentials(path, user)
    assert load_credentials(path) == user
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert "refresh_token" not in repr(user)
    assert "client_secret" not in repr(user)


@pytest.mark.anyio
async def test_refresh_cache_and_expiry(credentials_file: Path) -> None:
    now = [100.0]
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200, json={"access_token": f"token-{len(requests)}", "expires_in": 120}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        tokens = TokenProvider(client, credentials_file, "https://test/token", lambda: now[0])
        assert await tokens.access_token() == "token-1"
        now[0] = 159.9
        assert await tokens.access_token() == "token-1"
        now[0] = 160.0
        assert await tokens.access_token() == "token-2"
    assert len(requests) == 2
    assert parse_qs(requests[0].content.decode()) == {
        "grant_type": ["refresh_token"],
        "client_id": ["client-id"],
        "client_secret": ["secret-value"],
        "refresh_token": ["refresh-value"],
    }
    assert requests[0].headers["content-type"] == "application/x-www-form-urlencoded"


@pytest.mark.anyio
async def test_retry_after_load_failure(tmp_path: Path) -> None:
    path = tmp_path / "credentials.json"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"access_token": "ok", "expires_in": 3600})
        )
    ) as client:
        tokens = TokenProvider(client, path)
        with pytest.raises(HealthError, match="No Google Health credentials"):
            await tokens.access_token()
        save_credentials(path, AuthorizedUser(client_id="c", client_secret="s", refresh_token="r"))
        assert await tokens.access_token() == "ok"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status", "body", "message"),
    [
        (
            400,
            {"error": "invalid_grant", "error_description": "secret-value"},
            "Google sign-in failed: invalid_grant. Run the auth command again.",
        ),
        (500, ["secret-value"], "Google sign-in failed. Run the auth command again."),
        (
            400,
            {"error": {"token": "secret-value"}},
            "Google sign-in failed. Run the auth command again.",
        ),
        (200, {}, "Google sign-in failed. Run the auth command again."),
        (
            200,
            {"access_token": 42, "expires_in": 3600},
            "Google sign-in failed. Run the auth command again.",
        ),
        (
            200,
            {"access_token": "", "expires_in": 3600},
            "Google sign-in failed. Run the auth command again.",
        ),
        (
            200,
            {"access_token": "secret-value", "expires_in": True},
            "Google sign-in failed. Run the auth command again.",
        ),
        (
            200,
            {"access_token": "secret-value", "expires_in": -1},
            "Google sign-in failed. Run the auth command again.",
        ),
    ],
)
async def test_refresh_failures(
    credentials_file: Path, status: int, body: Json, message: str
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(status, content=compact_json(body)))
    ) as client:
        with pytest.raises(HealthError) as error:
            await TokenProvider(client, credentials_file).access_token()
    assert str(error.value) == message
    assert "secret-value" not in str(error.value)


@pytest.mark.anyio
@pytest.mark.parametrize("status", [200, 400])
async def test_refresh_non_json(credentials_file: Path, status: int) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(status, text="secret-value"))
    ) as client:
        with pytest.raises(
            HealthError, match=r"^Google sign-in failed\. Run the auth command again\.$"
        ):
            await TokenProvider(client, credentials_file).access_token()


@pytest.mark.anyio
async def test_refresh_transport_failure(credentials_file: Path) -> None:
    def handle(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("secret-value")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(
            HealthError, match=r"^Google sign-in failed\. Run the auth command again\.$"
        ):
            await TokenProvider(client, credentials_file).access_token()


@pytest.mark.anyio
async def test_environment_token_url(
    credentials_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GOOGLE_HEALTH_TOKEN_URL", "https://test/custom-token")
    monkeypatch.setenv("GOOGLE_HEALTH_CREDENTIALS", str(credentials_file))
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"access_token": "ok", "expires_in": 3600})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        assert await TokenProvider(client).access_token() == "ok"
    assert str(requests[0].url) == "https://test/custom-token"


@pytest.mark.anyio
async def test_refresh_error_redacts_credentials(credentials_file: Path) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(400, json={"error": "secret-value refresh-value"})
        )
    ) as client:
        with pytest.raises(HealthError) as error:
            await TokenProvider(client, credentials_file).access_token()
    assert str(error.value) == (
        "Google sign-in failed: [redacted] [redacted]. Run the auth command again."
    )
