# Shared spec

Both implementations, `packages/typescript` (npm) and `packages/python` (PyPI), serve the same MCP
tools from these files. They differ only in language. A change to a tool, scope, or data type
starts here.

| File                   | Content                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `tools.json`           | Tool contract: name, description, annotations, input JSON Schema, and the HTTP request or local handler each tool runs. |
| `data-types.json`      | Data type catalog: slug, kind, scope family, documented operations, v4beta flag.                                        |
| `scopes.json`          | OAuth scopes. `auth` requests `read` by default, and `read` + `write` with `--write`.                                   |
| `discovery.json`       | Snapshot of Google's v4beta discovery schemas plus the v4 DataPoint field list. Refresh with `pnpm update-discovery`.   |
| `schema/*.schema.json` | JSON Schemas that validate the files above.                                                                             |
| `conformance/*.json`   | Cases that both implementations must pass.                                                                              |

`mise run sync-spec` copies the spec into `packages/typescript/spec/` and
`packages/python/src/mcp_google_health/spec/`. It inlines every `$ref` in `tools.json`, so each
tool's `inputSchema` is self-contained. The copies are generated and Git ignores them.

## Tool contract

Each tool has exactly one of `local` or `request`.

### Local tools

- `listDataTypes`: returns `{"discoveryRevision": <discovery.revision>, "dataTypes": <data-types.json dataTypes>}`.
- `describeSchema`: looks up `name` as a schema in `discovery.schemas`. When there is none, it
  converts `name` from kebab case to camel case (`heart-rate` becomes `heartRate`). It then takes
  the `$ref` of that field from the first of `DataPoint`, `RollupDataPoint`, and
  `DailyRollupDataPoint` that has the field. It returns the schema with references inlined:
  each `{"$ref": X, ...rest}` becomes `{...rest, ...inline(schemas[X])}`, to a depth of 4. It
  does not expand a schema that is already on the current path. When nothing matches, it fails
  with `No schema named <name>. Use a data type slug or schema name.`

### Request tools

`request` fields:

- `method`: `GET`, `POST`, or `PATCH`.
- `path`: below the API version. `{argName}` placeholders take the argument value,
  percent-encoded as a URI component.
- `versioned`: when true, the version is the `apiVersion` argument if given. Otherwise it is
  `v4beta` when the `dataType` argument names a catalog entry with `"beta": true`, and `v4` in
  all other cases. When `versioned` is absent, the version is `v4`.
- `query`: map of query parameter to value expression. A parameter whose value resolves to
  "absent" is left out. Values are sent as strings: numbers in decimal, booleans as `true` or
  `false`.
- `body`: a value expression, sent as JSON with `content-type: application/json`. With no
  `body`, the request has no body.

Value expressions:

- `{"arg": "name"}`: the argument's value, or absent when the caller did not give it.
- `{"arg": "name", "format": "sourceFamily"}`: `users/me/dataSourceFamilies/<value>`.
- `{"arg": "name", "format": "civilDateTime"}`: `"YYYY-MM-DD"` becomes
  `{"date": {"year": Y, "month": M, "day": D}}` with integer fields.
- `{"arg": "name", "format": "dataPointNames"}`: each ID becomes
  `users/me/dataTypes/<dataType argument>/dataPoints/<id>`.
- Any other object: an object with each key evaluated. Keys whose values are absent are left out.
- A string, number, or boolean: that literal.

`response` (only `export_exercise_tcx`): when the `pathArg` argument is given, write the string
in the response's `saveField` (empty string when missing) to that path as UTF-8. Return
`{"outputPath": <path>, "bytes": <UTF-8 byte length>}`. Otherwise return the response.

### Input validation

Each implementation validates arguments against the tool's `inputSchema` as JSON Schema 2020-12
before any request. Patterns use ECMA-262 semantics as JSON Schema requires: `$` matches only at
the end of the string, and the spec writes digits as `[0-9]`, not `\d`. Python therefore
translates `$` to `\Z`. Integral numbers such as `1.0` are sent as `1`, as JavaScript does. Every
integer input has bounds within ±(2^53 - 1), so both languages hold the value exactly.

### Results and errors

A successful tool returns one text content item: the JSON result with no extra whitespace. Tests
compare it as parsed JSON.

A failed tool returns `isError: true` and one text content item with the message:

| Failure                                                 | Message                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| API error body `{"error": {"status": S, "message": M}}` | `Google Health API S: M`                                                      |
| API error body with a message but no status             | `Google Health API <HTTP code>: M`                                            |
| Any other non-2xx response                              | `Google Health API returned HTTP <code>.`                                     |
| Token refresh rejected with `{"error": E}`              | `Google sign-in failed: E. Run the auth command again.`                       |
| Token refresh failed otherwise                          | `Google sign-in failed. Run the auth command again.`                          |
| Credentials file missing or unreadable                  | `No Google Health credentials at <path>. Run "mcp-google-health auth" first.` |
| Credentials file is not a valid `authorized_user` file  | `<path> is not a Google authorized_user credentials file.`                    |
| Arguments fail the input schema                         | Any message. The server must not call the API.                                |

A token response counts as a failed refresh unless `access_token` is visible ASCII
(`[\x21-\x7E]+`), so a token can never break an HTTP header.

Messages never contain tokens, client secrets, or request headers. Implementations redact the
access token of the failed request, the current token, the client secret, and the refresh token
from any message built from a Google response.

## Runtime configuration

| Variable                         | Default                                        | Use                                       |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `GOOGLE_HEALTH_CREDENTIALS`      |                                                | Credentials path.                         |
| `GOOGLE_APPLICATION_CREDENTIALS` |                                                | Credentials path when the first is unset. |
|                                  | `~/.config/mcp-google-health/credentials.json` | Credentials path when both are unset.     |
| `GOOGLE_HEALTH_API_BASE_URL`     | `https://health.googleapis.com`                | API origin, for tests and proxies.        |
| `GOOGLE_HEALTH_TOKEN_URL`        | `https://oauth2.googleapis.com/token`          | Token endpoint for refresh, for tests.    |

The server reads credentials on the first API call, not at startup, so `tools/list` works before
sign-in. It reads the file again before each token refresh, so a new `auth` takes effect without a
restart.

The credentials file is a Google `authorized_user` JSON:
`{"type": "authorized_user", "client_id", "client_secret", "refresh_token"}`. The server
refreshes the access token with a form POST to the token URL (`grant_type=refresh_token`) and
reuses it until 60 seconds before it expires.

## CLI

Both packages install a `mcp-google-health` command:

- No arguments: run the MCP server on stdio. Server name `mcp-google-health`, version from the
  package, instructions from `tools.json`.
- `--help`, `--version`.
- `auth --client-secrets <file> [--write] [--scope <scope>]... [--port <port>] [--credentials <file>]`:
  Google's loopback OAuth flow with PKCE on `http://127.0.0.1:<port>/`. It prints the consent URL
  to stderr and opens it with `$BROWSER` or the platform opener. It requests offline access with
  `prompt=consent`, then saves the `authorized_user` file with mode `0600` in a directory with mode
  `0700`. A `--scope` value without `https://` gets the `scopes.json` prefix.

## Conformance cases

- `requests.json`: call `tool` with `arguments`. The fake API answers 200 with `apiResponse`
  (default `{}`). `expect.request` is the single request the API must receive: `method`, URL
  `path` (with the version, such as `/v4/users/me/profile`), `query` as a string map, and `body`
  as parsed JSON (absent means no body). `expect.result` must equal the parsed result, and
  `expect.resultSubset` must be a deep subset of it (for arrays, a prefix). Local tools make no
  request. `{tmpdir}` stands for a fresh temporary directory.
- `errors.json`: `api` makes the API answer with `status` and a JSON `body` or raw `text`.
  `token` makes the token endpoint answer that way. `credentials` makes the credentials file
  `missing` or `malformed`. `{credentialsPath}` stands for the credentials path. The tool must
  fail with exactly `expect.text`.
- `validation.json`: each call must fail with `isError: true` and make no API or token request.
