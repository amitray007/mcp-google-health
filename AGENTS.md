# googlehealth-mcp agent instructions

A stdio MCP server for the Google Health API v4, published to npm as `googlehealth-mcp`.

- Check: `pnpm check` (format, lint, typecheck, tests, Knip). Run it before each commit.
- Tools pin Node and pnpm through mise. Run commands with `mise exec --` when the shell is not
  activated.
- `src/discovery.json` is a snapshot of Google's discovery documents. Refresh it with
  `pnpm update-discovery`. The catalog test fails when Google adds a data type; add it to
  `src/data-types.ts` with its operations from https://developers.google.com/health/data-types.
- Never log or return tokens, client secrets, or request headers. Errors carry Google's status and
  message only.
- Validate every tool input with Zod. IDs are single path segments.
