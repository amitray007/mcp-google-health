# mcp-google-health

Read and write Google Health data from Fitbit and Pixel Watch through an MCP client.

Run the server with [uv](https://docs.astral.sh/uv/):

```sh
uvx mcp-google-health
```

Create a Google OAuth Desktop client and download its client secrets file. Enable the Google
Health API in your Google Cloud project. Sign in before you call an API tool:

```sh
uvx mcp-google-health auth --client-secrets client_secrets.json
```

The command opens your browser and saves credentials in
`~/.config/mcp-google-health/credentials.json`. Add `--write` to request write access. Repeat
`--scope` to add scopes, use `--port` to choose a loopback port, or use `--credentials` to choose
the output file. The browser can be selected with `$BROWSER`.

Add this server to your MCP client's configuration:

```json
{
  "mcpServers": {
    "google-health": {
      "command": "uvx",
      "args": ["mcp-google-health"]
    }
  }
}
```

Set `GOOGLE_HEALTH_CREDENTIALS` to read another credentials file. The server also accepts
`GOOGLE_APPLICATION_CREDENTIALS`. It loads credentials on the first API call, so you can list
its 19 tools before signing in. Start with `list_data_types`. Use `describe_schema` before a
write.

`GOOGLE_HEALTH_API_BASE_URL` and `GOOGLE_HEALTH_TOKEN_URL` override the API origin and token
endpoint for proxies and tests. Both packages in this repository interpret the shared contract
in [`spec/`](https://github.com/amitray007/mcp-google-health/tree/main/spec).
