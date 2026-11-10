from __future__ import annotations

import importlib
import os
import sys
from collections.abc import Sequence
from contextlib import redirect_stdout
from pathlib import Path
from typing import Protocol, cast

from mcp_google_health.credentials import TOKEN_URL, AuthorizedUser, save_credentials
from mcp_google_health.errors import HealthError
from mcp_google_health.json_types import JsonObject, object_value, parse_json
from mcp_google_health.spec import ScopesSpec


class FlowCredentials(Protocol):
    refresh_token: str | None


class InstalledFlow(Protocol):
    def run_local_server(
        self,
        *,
        host: str,
        port: int,
        open_browser: bool,
        authorization_prompt_message: str,
        success_message: str,
        timeout_seconds: int,
        access_type: str,
        prompt: str,
    ) -> FlowCredentials: ...


class FlowFactory(Protocol):
    def from_client_config(
        self, client_config: JsonObject, scopes: Sequence[str], *, autogenerate_code_verifier: bool
    ) -> InstalledFlow: ...


def requested_scopes(spec: ScopesSpec, write: bool, extra: Sequence[str]) -> list[str]:
    scopes = [spec.prefix + scope for scope in spec.read]
    if write:
        scopes.extend(spec.prefix + scope for scope in spec.write)
    scopes.extend(scope if scope.startswith("https://") else spec.prefix + scope for scope in extra)
    return list(dict.fromkeys(scopes))


def load_client_config(path: Path) -> tuple[JsonObject, str, str]:
    try:
        data = object_value(parse_json(path.read_text(encoding="utf-8")))
        kind = "installed" if "installed" in data else "web"
        client = object_value(data[kind])
        client_id, client_secret = client["client_id"], client["client_secret"]
        if not isinstance(client_id, str) or not client_id:
            raise ValueError("Missing client ID.")
        if not isinstance(client_secret, str) or not client_secret:
            raise ValueError("Missing client secret.")
    except (OSError, ValueError, KeyError):
        raise HealthError(f"{path} is not a Google OAuth client secrets file.") from None
    config: JsonObject = {
        **client,
        "auth_uri": client.get("auth_uri", "https://accounts.google.com/o/oauth2/v2/auth"),
        "token_uri": os.environ.get("GOOGLE_HEALTH_TOKEN_URL") or TOKEN_URL,
    }
    return {kind: config}, client_id, client_secret


def sign_in(client_secrets: Path, scopes: Sequence[str], output_path: Path, port: int = 0) -> None:
    config, client_id, client_secret = load_client_config(client_secrets)
    module = importlib.import_module("google_auth_oauthlib.flow")
    factory = cast(FlowFactory, module.InstalledAppFlow)
    flow = factory.from_client_config(config, scopes, autogenerate_code_verifier=True)
    try:
        with redirect_stdout(sys.stderr):
            credentials = flow.run_local_server(
                host="127.0.0.1",
                port=port,
                open_browser=True,
                authorization_prompt_message="Open this URL to sign in to Google Health:\n{url}",
                success_message="Signed in to Google Health. You can close this tab.",
                timeout_seconds=600,
                access_type="offline",
                prompt="consent",
            )
    except Exception:
        # OAuth exceptions can include the token request, so expose no raw exception text.
        raise HealthError("Google sign-in failed. Run the auth command again.") from None
    if not credentials.refresh_token:
        raise HealthError(
            "Google returned no refresh token. Remove the app's access and sign in again."
        )
    save_credentials(
        output_path,
        AuthorizedUser(
            client_id=client_id,
            client_secret=client_secret,
            refresh_token=credentials.refresh_token,
        ),
    )
