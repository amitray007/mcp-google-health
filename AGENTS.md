# mcp-google-health agent instructions

An MCP server for the Google Health API, published twice from one repository: to npm from
`packages/typescript` and to PyPI from `packages/python`. Both packages interpret the shared,
language-neutral contract in `spec/`. Read [spec/README.md](spec/README.md) before any change.

## Layout

| Path                   | Owns                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `spec/`                | Tool contract, data type catalog, scopes, discovery snapshot, conformance cases, and their JSON Schemas. The single source of truth. |
| `packages/typescript/` | npm package `mcp-google-health`.                                                                                                     |
| `packages/python/`     | PyPI package `mcp-google-health`.                                                                                                    |
| `tests/spec/`          | Validates the spec files and their cross-references.                                                                                 |
| `tests/e2e/`           | Runs both built packages over stdio against a fake Google API and checks parity.                                                     |
| `scripts/`             | Spec sync, discovery refresh, version check, and package smoke tests.                                                                |

## Rules

- Change behavior in `spec/` first, add a conformance case, then make both packages pass it. A
  tool, scope, or data type that exists in only one package is a bug.
- Never hand-edit `packages/typescript/spec/` or `packages/python/src/mcp_google_health/spec/`.
  `mise run sync-spec` generates them, and Git ignores them.
- Never log or return tokens, client secrets, or request headers. Errors carry only the messages
  in spec/README.md.
- Both packages validate every tool input against the spec's JSON Schema before any request.

## Commands

mise pins Node, pnpm, Python, and uv. Run commands in a mise-activated shell or prefix them with
`mise exec --`.

- `mise run check`: everything CI runs (spec, TypeScript, Python, build, end-to-end parity). Run it
  before each commit.
- `mise run check:spec`, `mise run check:ts`, `mise run check:py`, `mise run test:e2e`: one part.
- `pnpm format` and `uv run --project packages/python ruff format`: apply formatting.
- `pnpm update-discovery`: refresh `spec/discovery.json`. The spec tests then name any new data
  type or scope to add.

## Releases

Release Please owns versions, the changelog, and tags. Use Conventional Commits. Every release
bumps the patch version (`0.0.x`); put `Release-As: X.Y.Z` in a commit body to release a minor or
major version. Merging the release PR publishes both packages from the Release workflow.
