from pathlib import Path

import pytest

from mcp_google_health.credentials import AuthorizedUser, save_credentials


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def credentials_file(tmp_path: Path) -> Path:
    path = tmp_path / "credentials" / "user.json"
    save_credentials(
        path,
        AuthorizedUser(
            client_id="client-id", client_secret="secret-value", refresh_token="refresh-value"
        ),
    )
    return path
