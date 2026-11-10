from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import httpx

from mcp_google_health import __version__
from mcp_google_health.api import HealthApi
from mcp_google_health.auth_flow import requested_scopes, sign_in
from mcp_google_health.credentials import TokenProvider, credentials_path
from mcp_google_health.errors import HealthError
from mcp_google_health.server import create_server, serve_stdio
from mcp_google_health.spec import load_bundle


class Options(argparse.Namespace):
    command: str | None = None
    client_secrets: Path
    write: bool
    scope: list[str]
    port: int
    credentials: Path | None


def valid_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Port must be an integer from 0 to 65535.") from None
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("Port must be an integer from 0 to 65535.")
    return port


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="mcp-google-health", description="Run Google Health tools on MCP stdio."
    )
    result.add_argument("--version", action="version", version=__version__)
    commands = result.add_subparsers(dest="command")
    auth = commands.add_parser("auth", help="Sign in and save Google Health credentials.")
    auth.add_argument("--client-secrets", type=Path, required=True)
    auth.add_argument("--write", action="store_true")
    auth.add_argument("--scope", action="append", default=[])
    auth.add_argument("--port", type=valid_port, default=0)
    auth.add_argument("--credentials", type=Path)
    return result


async def serve() -> None:
    async with httpx.AsyncClient() as client:
        api = HealthApi(client, TokenProvider(client))
        await serve_stdio(create_server(api))


def main(argv: list[str] | None = None) -> None:
    options = parser().parse_args(argv, namespace=Options())
    try:
        if options.command == "auth":
            path = options.credentials if options.credentials is not None else credentials_path()
            scopes = requested_scopes(load_bundle().scopes, options.write, options.scope)
            sign_in(options.client_secrets, scopes, path, options.port)
            print(f"Saved Google Health credentials to {path}.", file=sys.stderr)
        else:
            asyncio.run(serve())
    except (HealthError, OSError) as error:
        message = (
            str(error) if isinstance(error, HealthError) else "Could not access the requested file."
        )
        print(message, file=sys.stderr)
        raise SystemExit(1) from None
