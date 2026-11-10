from __future__ import annotations

import importlib
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import pytest

from mcp_google_health.auth_flow import load_client_config, requested_scopes, sign_in
from mcp_google_health.credentials import load_credentials
from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import JsonObject, compact_json
from mcp_google_health.spec import load_bundle


def test_scopes() -> None:
    scopes = load_bundle().scopes
    assert requested_scopes(scopes, False, []) == [scopes.prefix + value for value in scopes.read]
    result = requested_scopes(scopes, True, ["profile.readonly", "extra.readonly", "https://extra"])
    assert len(result) == len(scopes.read) + len(scopes.write) + 2
    assert result[-2:] == [scopes.prefix + "extra.readonly", "https://extra"]


@pytest.mark.parametrize(
    "contents",
    [
        "not json",
        "[]",
        "{}",
        '{"installed":{}}',
        '{"web":{"client_id":3,"client_secret":"secret"}}',
        '{"installed":{"client_id":"id","client_secret":""}}',
    ],
)
def test_invalid_client_secrets(contents: str, tmp_path: Path) -> None:
    path = tmp_path / "client.json"
    path.write_text(contents)
    with pytest.raises(HealthError, match="not a Google OAuth client secrets file") as error:
        load_client_config(path)
    assert 'secret"' not in str(error.value)


def test_missing_client_secrets(tmp_path: Path) -> None:
    with pytest.raises(HealthError, match="not a Google OAuth client secrets file"):
        load_client_config(tmp_path / "missing")


@pytest.mark.parametrize("kind", ["web", "installed"])
def test_client_config(kind: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_HEALTH_TOKEN_URL", "https://proxy/token")
    path = tmp_path / "client.json"
    path.write_text(compact_json({kind: {"client_id": "id", "client_secret": "secret"}}))
    config, identifier, secret = load_client_config(path)
    assert identifier == "id"
    assert secret == "secret"
    assert config == {
        kind: {
            "client_id": "id",
            "client_secret": "secret",
            "auth_uri": "https://accounts.google.com/o/oauth2/v2/auth",
            "token_uri": "https://proxy/token",
        }
    }


def test_full_loopback_flow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    posted: list[dict[str, list[str]]] = []
    consent_urls: list[str] = []
    callback_threads: list[threading.Thread] = []
    callback_statuses: list[int] = []

    class TokenHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["content-length"])).decode()
            posted.append(parse_qs(body))
            encoded = compact_json(
                {
                    "access_token": "access-value",
                    "refresh_token": "refresh-value",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                }
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: object) -> None:
            pass

    def callback(url: str) -> None:
        callback_statuses.append(httpx.get(url, timeout=5).status_code)

    class Browser:
        def open(self, url: str, new: int, autoraise: bool) -> bool:
            assert new == 1
            assert autoraise
            consent_urls.append(url)
            query = parse_qs(urlsplit(url).query)
            redirect = query["redirect_uri"][0]
            thread = threading.Thread(
                target=callback,
                args=(
                    redirect + "?" + urlencode({"code": "fake-code", "state": query["state"][0]}),
                ),
            )
            callback_threads.append(thread)
            thread.start()
            return True

    def browser_get(using: str | None = None) -> Browser:
        assert using is None
        return Browser()

    monkeypatch.setattr("webbrowser.get", browser_get)
    monkeypatch.setenv("OAUTHLIB_INSECURE_TRANSPORT", "1")
    with ThreadingHTTPServer(("127.0.0.1", 0), TokenHandler) as token_server:
        monkeypatch.setenv(
            "GOOGLE_HEALTH_TOKEN_URL", f"http://127.0.0.1:{token_server.server_port}/token"
        )
        token_thread = threading.Thread(target=token_server.serve_forever)
        token_thread.start()
        try:
            secrets = tmp_path / "client.json"
            secrets.write_text(
                compact_json({"installed": {"client_id": "id", "client_secret": "secret"}})
            )
            output = tmp_path / "private" / "credentials.json"
            sign_in(secrets, ["https://scope"], output)
        finally:
            token_server.shutdown()
            token_thread.join(timeout=5)
            for thread in callback_threads:
                thread.join(timeout=5)
    assert callback_statuses == [200]
    query = parse_qs(urlsplit(consent_urls[0]).query)
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["code_challenge"][0]) >= 43
    assert query["scope"] == ["https://scope"]
    redirect = urlsplit(query["redirect_uri"][0])
    assert redirect.hostname == "127.0.0.1"
    assert redirect.path == "/"
    assert posted[0]["grant_type"] == ["authorization_code"]
    assert posted[0]["code"] == ["fake-code"]
    assert len(posted[0]["code_verifier"][0]) >= 43
    assert load_credentials(output).refresh_token == "refresh-value"
    assert output.stat().st_mode & 0o777 == 0o600
    assert output.parent.stat().st_mode & 0o777 == 0o700
    captured = capsys.readouterr()
    assert consent_urls[0] in captured.err
    assert captured.out == ""
    assert "refresh-value" not in captured.err


@dataclass
class FakeCredentials:
    refresh_token: str | None


class FakeFlow:
    failure: ClassVar[bool] = False

    @classmethod
    def from_client_config(
        cls, config: JsonObject, scopes: list[str], *, autogenerate_code_verifier: bool
    ) -> FakeFlow:
        assert config
        assert scopes
        assert autogenerate_code_verifier
        return cls()

    def run_local_server(self, **kwargs: object) -> FakeCredentials:
        assert kwargs["host"] == "127.0.0.1"
        if self.failure:
            raise RuntimeError("secret-value")
        return FakeCredentials(None)


@pytest.mark.parametrize("failure", [False, True])
def test_sign_in_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: bool) -> None:
    module = importlib.import_module("google_auth_oauthlib.flow")
    monkeypatch.setattr(module, "InstalledAppFlow", FakeFlow)
    monkeypatch.setattr(FakeFlow, "failure", failure)
    secrets = tmp_path / "client.json"
    secrets.write_text(compact_json({"installed": {"client_id": "id", "client_secret": "secret"}}))
    with pytest.raises(HealthError, match=r"Google sign-in failed|no refresh token") as error:
        sign_in(secrets, ["https://scope"], tmp_path / "out.json")
    assert "secret-value" not in str(error.value)
    assert not (tmp_path / "out.json").exists()
