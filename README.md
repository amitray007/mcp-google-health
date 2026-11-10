# mcp-google-health

An MCP server for the [Google Health API](https://developers.google.com/health). It gives an AI
agent your Fitbit, Fitbit Air, and Pixel Watch data, plus anything else that syncs to Google
Health.

It covers the whole user-facing API: all 47 data types, including the v4beta skin temperature
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
```

The command opens Google's consent page and listens for the reply on a `127.0.0.1` port. It
saves a refresh token to `~/.config/mcp-google-health/credentials.json` with mode `0600`.

- `--write` also requests every write scope.
- `--scope <scope>` adds a scope, such as `mindfulness.readonly`. You can repeat it.
- `--port <port>` fixes the loopback port.

By default the command requests the nine read scopes: activity and fitness, ECG, health metrics,
irregular rhythm notifications, exercise location, nutrition, profile, settings, and sleep.

## Add it to an MCP client

```sh
claude mcp add google-health -- npx -y mcp-google-health
```

Other clients run `npx -y mcp-google-health` as a stdio server.

| Variable                         | Use                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_HEALTH_CREDENTIALS`      | Path of the credentials file.                                                                                      |
| `GOOGLE_APPLICATION_CREDENTIALS` | Used when `GOOGLE_HEALTH_CREDENTIALS` is unset. Any Google `authorized_user` file with Google Health scopes works. |

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

## Development

```sh
mise install
pnpm install
pnpm check              # format, lint, types, tests, Knip
pnpm update-discovery   # refresh src/discovery.json from Google
```

Release: set the version in `package.json`, then push a matching tag such as `v0.1.0`. The
Publish workflow runs the checks and publishes to npm with provenance.
