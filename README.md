# mcp-google-health

An MCP server for the [Google Health API](https://developers.google.com/health). It gives an AI
agent your Fitbit, Fitbit Air, and Pixel Watch data, plus anything else that syncs to Google
Health.

The same server ships to npm and PyPI, so it runs with `npx` or `uvx`. It covers the whole
user-facing API: all 47 data types, including the v4beta skin temperature
type and the daily personal ranges. It also reads paired devices, exports exercise TCX with GPS,
reads and updates the profile and settings, and writes, edits, and deletes data points. Responses
are the API's raw JSON. The server does not summarize or redact them.

This project is not affiliated with Google or Fitbit. It is not a medical device.

## Set up Google Cloud

1. In a Google Cloud project, [enable the Google Health API](https://console.cloud.google.com/apis/library/health.googleapis.com).
2. Configure the OAuth consent screen. Add the Google Health scopes you plan to use. Add your
   account as a test user, or publish the app. A Testing app's refresh tokens expire after 7 days.
3. Create an OAuth client of type **Desktop app** and download its JSON file.

## Sign in

```sh
npx -y mcp-google-health auth --client-secrets ~/Downloads/client_secret.json
# or
uvx mcp-google-health auth --client-secrets ~/Downloads/client_secret.json
```

The command opens Google's consent page and listens for the reply on a `127.0.0.1` port. It
saves a refresh token to `~/.config/mcp-google-health/credentials.json` with mode `0600`.

- `--write` also requests every write scope.
- `--scope <scope>` adds a scope, such as `mindfulness.readonly`. You can repeat it.
- `--port <port>` fixes the loopback port.
- `--credentials <file>` saves the credentials to another path.

By default the command requests the nine read scopes: activity and fitness, ECG, health metrics,
irregular rhythm notifications, exercise location, nutrition, profile, settings, and sleep.

## Add it to an MCP client

```sh
claude mcp add google-health -- npx -y mcp-google-health
# or
claude mcp add google-health -- uvx mcp-google-health
```

Other clients run either command as a stdio server. The server loads credentials on the first
API call, so it lists its tools before you sign in.

| Variable                                                | Use                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_HEALTH_CREDENTIALS`                             | Path of the credentials file.                                                                                      |
| `GOOGLE_APPLICATION_CREDENTIALS`                        | Used when `GOOGLE_HEALTH_CREDENTIALS` is unset. Any Google `authorized_user` file with Google Health scopes works. |
| `GOOGLE_HEALTH_API_BASE_URL`, `GOOGLE_HEALTH_TOKEN_URL` | Override the API origin and token endpoint, for proxies and tests.                                                 |

## Tools

| Tool                                                             | API method                                         |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `list_data_types`                                                | Local catalog: kind, scope, operations, v4beta     |
| `describe_schema`                                                | Local discovery schema for a data type or resource |
| `get_identity`, `get_profile`, `get_settings`, `get_irn_profile` | `users.get*`                                       |
| `update_profile`, `update_settings`                              | `users.update*`                                    |
| `list_paired_devices`, `get_paired_device`                       | `users.pairedDevices`                              |
| `list_data_points`, `get_data_point`                             | `dataPoints.list`, `dataPoints.get`                |
| `reconcile_data_points`                                          | `dataPoints.reconcile`                             |
| `roll_up_data_points`, `daily_roll_up_data_points`               | `dataPoints.rollUp`, `dataPoints.dailyRollUp`      |
| `export_exercise_tcx`                                            | `dataPoints.exportExerciseTcx`                     |
| `create_data_point`, `update_data_point`, `delete_data_points`   | `dataPoints.create`, `patch`, `batchDelete`        |

Each tool carries read-only or destructive hints, so a client can ask before it writes.

The server leaves out two parts of the API. Webhook subscribers need a public HTTPS endpoint and
project-level credentials. SMART Health Links serve shared records, not your account.

## How the repository works

```text
spec/                  the contract both packages interpret
  tools.json           19 tools: input schemas, annotations, and the HTTP request each one sends
  data-types.json      47 data types with kinds, scopes, and operations
  scopes.json          OAuth scopes for auth
  discovery.json       snapshot of Google's discovery schemas
  conformance/         shared test cases every package must pass
packages/typescript/   npm package
packages/python/       PyPI package
tests/spec/            checks the spec files and their cross-references
tests/e2e/             runs both built packages over stdio against a fake Google API
```

A change to a tool starts in `spec/`, with a conformance case. Both packages run every case in
their own unit tests. The end-to-end test then runs the built npm package and the built wheel
side by side and checks that they list the same tools, send the same requests, and return the
same results and errors. See [spec/README.md](spec/README.md).

## Development

```sh
mise install
pnpm install
mise run check          # spec, TypeScript, Python, build, end-to-end parity
pnpm update-discovery   # refresh spec/discovery.json from Google
```

CI runs the checks on Node 22 and 24 and on Python 3.10 to 3.14, on Linux and macOS. It also
installs the packed npm tarball and the built wheel and runs them.

## Releases

Release Please keeps a release PR open with the next version and changelog. Every release bumps
the patch version. To release a minor or major version, put `Release-As: X.Y.Z` in a commit
body. Merging the release PR tags the version and publishes both packages through
Trusted Publishing (GitHub OIDC), with no stored tokens.
