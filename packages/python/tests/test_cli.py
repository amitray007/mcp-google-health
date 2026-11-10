from __future__ import annotations

import sys
from pathlib import Path

import pytest
from mcp import Client, StdioServerParameters
from mcp.server.lowlevel import Server

from mcp_google_health import __version__, cli
from mcp_google_health.errors import HealthError
from mcp_google_health.spec import load_bundle


def test_parser() -> None:
    options = cli.parser().parse_args(
        [
            "auth",
            "--client-secrets",
            "client.json",
            "--write",
            "--scope",
            "one",
            "--scope",
            "two",
            "--port",
            "1234",
            "--credentials",
            "user.json",
        ]
    )
    assert options.command == "auth"
    assert options.client_secrets == Path("client.json")
    assert options.write
    assert options.scope == ["one", "two"]
    assert options.port == 1234
    assert options.credentials == Path("user.json")
    assert cli.parser().parse_args([]).command is None


@pytest.mark.parametrize(
    "arguments",
    [
        ["auth"],
        ["unknown"],
        ["--extra"],
        ["auth", "--client-secrets", "x", "--port", "-1"],
        ["auth", "--client-secrets", "x", "--port", "65536"],
        ["auth", "--client-secrets", "x", "--port", "abc"],
    ],
)
def test_bad_arguments(arguments: list[str]) -> None:
    with pytest.raises(SystemExit) as error:
        cli.main(arguments)
    assert error.value.code == 2


@pytest.mark.parametrize(("argument", "text"), [("--help", "stdio"), ("--version", __version__)])
def test_help_version(argument: str, text: str, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as error:
        cli.main([argument])
    assert error.value.code == 0
    assert text in capsys.readouterr().out


def test_auth_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    output = tmp_path / "credentials.json"
    monkeypatch.setenv("GOOGLE_HEALTH_CREDENTIALS", str(output))
    called: list[tuple[Path, list[str], Path, int]] = []

    def fake_sign_in(client_secrets: Path, scopes: list[str], output_path: Path, port: int) -> None:
        called.append((client_secrets, scopes, output_path, port))

    monkeypatch.setattr(cli, "sign_in", fake_sign_in)
    cli.main(["auth", "--client-secrets", "client.json"])
    assert called == [
        (
            Path("client.json"),
            [load_bundle().scopes.prefix + scope for scope in load_bundle().scopes.read],
            output,
            0,
        )
    ]
    assert f"Saved Google Health credentials to {output}." in capsys.readouterr().err
    cli.main(["auth", "--client-secrets", "client.json", "--credentials", "other.json"])
    assert called[1][2] == Path("other.json")


@pytest.mark.parametrize("error", [HealthError("Safe failure."), OSError("secret-value")])
def test_main_errors(
    monkeypatch: pytest.MonkeyPatch, error: Exception, capsys: pytest.CaptureFixture[str]
) -> None:
    def fake_sign_in(*args: object) -> None:
        raise error

    monkeypatch.setattr(cli, "sign_in", fake_sign_in)
    with pytest.raises(SystemExit) as exited:
        cli.main(["auth", "--client-secrets", "client.json"])
    assert exited.value.code == 1
    assert "secret-value" not in capsys.readouterr().err


def test_default_runs_stdio(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[Server[None]] = []

    async def fake_serve(server: Server[None]) -> None:
        called.append(server)

    monkeypatch.setattr(cli, "serve_stdio", fake_serve)
    cli.main([])
    assert len(called) == 1
    assert called[0].name == "mcp-google-health"


@pytest.mark.anyio
async def test_module_stdio_subprocess(tmp_path: Path) -> None:
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "mcp_google_health"],
        env={"GOOGLE_HEALTH_CREDENTIALS": str(tmp_path / "missing")},
    )
    async with Client(parameters, mode="legacy", read_timeout_seconds=10) as client:
        tools = await client.list_tools()
    assert len(tools.tools) == 19
    assert {tool.name for tool in tools.tools} == set(load_bundle().by_name)
