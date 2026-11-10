from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import compact_json, object_value, parse_json

TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - public OAuth endpoint


class AuthorizedUser(BaseModel):
    model_config = ConfigDict(strict=True)
    type: Literal["authorized_user"] = "authorized_user"
    client_id: str = Field(min_length=1)
    client_secret: str = Field(min_length=1, repr=False)
    refresh_token: str = Field(min_length=1, repr=False)


def credentials_path(env: Mapping[str, str] | None = None) -> Path:
    environment = os.environ if env is None else env
    return Path(
        environment.get("GOOGLE_HEALTH_CREDENTIALS")
        or environment.get("GOOGLE_APPLICATION_CREDENTIALS")
        or Path.home() / ".config" / "mcp-google-health" / "credentials.json"
    )


def load_credentials(path: Path) -> AuthorizedUser:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise HealthError(
            f'No Google Health credentials at {path}. Run "mcp-google-health auth" first.'
        ) from None
    try:
        data = object_value(parse_json(text))
        if data.get("type") != "authorized_user":
            raise ValueError("Invalid credentials type.")
        return AuthorizedUser.model_validate(data)
    except (ValueError, ValidationError):
        raise HealthError(f"{path} is not a Google authorized_user credentials file.") from None


def save_credentials(path: Path, credentials: AuthorizedUser) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    path.parent.chmod(0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        os.fchmod(file.fileno(), 0o600)
        file.write(compact_json(object_value(parse_json(credentials.model_dump_json()))))
        file.write("\n")


def sign_in_failure(response: httpx.Response) -> HealthError:
    message = "Google sign-in failed. Run the auth command again."
    try:
        error = object_value(parse_json(response.text)).get("error")
        if isinstance(error, str):
            message = f"Google sign-in failed: {error}. Run the auth command again."
    except ValueError:
        pass
    return HealthError(message)


class TokenProvider:
    def __init__(
        self,
        client: httpx.AsyncClient,
        path: Path | None = None,
        token_url: str | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.client = client
        self.path = credentials_path() if path is None else path
        self.token_url = token_url or os.environ.get("GOOGLE_HEALTH_TOKEN_URL") or TOKEN_URL
        self.clock = clock
        self._credentials: AuthorizedUser | None = None
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    async def access_token(self) -> str:
        async with self._lock:
            if self._token is not None and self.clock() < self._expires_at - 60:
                return self._token
            if self._credentials is None:
                self._credentials = load_credentials(self.path)
            return await self._refresh(self._credentials)

    def redact_message(self, message: str) -> str:
        secrets = [self._token] if self._token else []
        if self._credentials is not None:
            secrets.extend([self._credentials.client_secret, self._credentials.refresh_token])
        for secret in sorted(secrets, key=len, reverse=True):
            message = message.replace(secret, "[redacted]")
        return message

    async def _refresh(self, credentials: AuthorizedUser) -> str:
        try:
            response = await self.client.post(
                self.token_url,
                data={
                    "grant_type": "refresh_token",
                    "client_id": credentials.client_id,
                    "client_secret": credentials.client_secret,
                    "refresh_token": credentials.refresh_token,
                },
            )
        except httpx.HTTPError:
            raise HealthError("Google sign-in failed. Run the auth command again.") from None
        if not response.is_success:
            raise HealthError(self.redact_message(str(sign_in_failure(response))))
        try:
            data = object_value(parse_json(response.text))
            token = data["access_token"]
            expires_in = data["expires_in"]
            if not isinstance(token, str) or not token or isinstance(expires_in, bool):
                raise ValueError("Invalid token response.")
            if not isinstance(expires_in, (int, float)) or expires_in <= 0:
                raise ValueError("Invalid token expiry.")
        except (KeyError, ValueError):
            raise HealthError("Google sign-in failed. Run the auth command again.") from None
        self._token = token
        self._expires_at = self.clock() + expires_in
        return token
