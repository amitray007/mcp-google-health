#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import packageJson from "../package.json" with { type: "json" };
import { createHealthApi, type HealthApi } from "./api.ts";
import { openBrowser, signIn } from "./auth-flow.ts";
import {
  clientFor,
  credentialsPath,
  loadClientSecrets,
  loadCredentials,
  saveCredentials,
} from "./credentials.ts";
import { readScopes, scopeUrl, writeScopes } from "./scopes.ts";
import { createServer } from "./tools.ts";

const help = `mcp-google-health ${packageJson.version}

Usage:
  mcp-google-health                 Run the MCP server on stdio.
  mcp-google-health auth [options]  Sign in to Google and save credentials.

Auth options:
  --client-secrets <file>  OAuth client JSON from Google Cloud (Desktop app). Required.
  --write                  Also request every write scope.
  --scope <scope>          Request an extra scope, such as mindfulness.readonly. Repeatable.
  --port <port>            Loopback port for the Google redirect. Default: a free port.
  --credentials <file>     Where to save credentials. Default: the credentials path below.

Credentials path: $GOOGLE_HEALTH_CREDENTIALS, else $GOOGLE_APPLICATION_CREDENTIALS,
else ~/.config/mcp-google-health/credentials.json.`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") return console.log(help);
  if (command === "--version") return console.log(packageJson.version);
  if (command === "auth") return auth(rest);
  if (command !== undefined) throw new Error(`Unknown command ${command}.\n\n${help}`);
  await serve();
}

async function serve(): Promise<void> {
  const path = credentialsPath();
  let api: HealthApi | undefined;
  const lazyApi: HealthApi = async (request) => {
    if (!api) {
      const client = clientFor(await loadCredentials(path));
      api = createHealthApi(async () => new Headers(await client.getRequestHeaders()));
    }
    return api(request);
  };
  await createServer(lazyApi, packageJson.version).connect(new StdioServerTransport());
}

async function auth(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "client-secrets": { type: "string" },
      write: { type: "boolean", default: false },
      scope: { type: "string", multiple: true, default: [] },
      port: { type: "string" },
      credentials: { type: "string" },
    },
    strict: true,
  });
  if (!values["client-secrets"]) throw new Error("Give --client-secrets <file>.\n\n" + help);
  const scopes = [
    ...readScopes,
    ...(values.write ? writeScopes : []),
    ...values.scope.map(scopeUrl),
  ];
  const credentials = await signIn({
    client: await loadClientSecrets(values["client-secrets"]),
    scopes: [...new Set(scopes)],
    ...(values.port ? { port: Number(values.port) } : {}),
    announce: (url) => {
      console.error(`Open this URL to sign in to Google Health:\n\n${url}\n`);
      openBrowser(url);
    },
  });
  const path = values.credentials ?? credentialsPath();
  await saveCredentials(path, credentials);
  console.error(`Saved Google Health credentials to ${path}.`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
