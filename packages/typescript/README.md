# mcp-google-health

Read and write Google Health data from Fitbit and Pixel Watch through an MCP client.

Install Node.js 22.12 or later. Enable the Google Health API in Google Cloud, configure the
OAuth consent screen, and download a Desktop app OAuth client JSON file.

Sign in:

```sh
npx -y mcp-google-health auth --client-secrets ~/Downloads/client_secret.json
```

Add `--write` to request write scopes. The command saves credentials to
`~/.config/mcp-google-health/credentials.json`.

Add the server to Claude Code:

```sh
claude mcp add google-health -- npx -y mcp-google-health
```

Other MCP clients run `npx -y mcp-google-health` over stdio. Set `GOOGLE_HEALTH_CREDENTIALS`
to use another credentials file.
