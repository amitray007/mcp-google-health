import { parseArgs } from "node:util";
import { z } from "zod";
import { credentialsPath } from "./credentials.ts";
import { spec } from "./spec.ts";

type Command =
  | { kind: "serve" | "help" | "version" }
  | {
      kind: "auth";
      clientSecrets: string;
      scopes: string[];
      port: number;
      credentials: string;
    };

export function parseCommand(argv: string[]): Command {
  const [command, ...args] = argv;
  if (command === undefined) return { kind: "serve" };
  if (command === "--help" || command === "-h") return { kind: "help" };
  if (command === "--version") return { kind: "version" };
  if (command !== "auth")
    throw new Error(`Unknown command ${command}. Run mcp-google-health --help.`);
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "client-secrets": { type: "string" },
      write: { type: "boolean", default: false },
      scope: { type: "string", multiple: true, default: [] },
      port: { type: "string" },
      credentials: { type: "string" },
    },
  });
  if (!values["client-secrets"]) throw new Error("Give --client-secrets <file>.");
  const parsedPort = z.coerce
    .number()
    .int()
    .min(0)
    .max(65535)
    .safeParse(values.port ?? "0");
  if (!parsedPort.success) throw new Error("Give --port as an integer from 0 to 65535.");
  const port = parsedPort.data;
  const shortScopes = [
    ...spec.scopes.read,
    ...(values.write ? spec.scopes.write : []),
    ...values.scope,
  ];
  const scopes = [
    ...new Set(
      shortScopes.map((scope) =>
        scope.startsWith("https://") ? scope : spec.scopes.prefix + scope,
      ),
    ),
  ];
  return {
    kind: "auth",
    clientSecrets: values["client-secrets"],
    scopes,
    port,
    credentials: values.credentials ?? credentialsPath(),
  };
}

export function help(version: string): string {
  return `mcp-google-health ${version}

Usage:
  mcp-google-health                 Run the MCP server on stdio.
  mcp-google-health auth [options]  Sign in to Google and save credentials.
  mcp-google-health --help          Show help.
  mcp-google-health --version       Show version.

Auth options:
  --client-secrets <file>  Desktop app OAuth client JSON from Google Cloud. Required.
  --write                Also request write scopes.
  --scope <scope>        Request an extra scope. Repeatable.
  --port <port>          Loopback port. Default: a free port.
  --credentials <file>   Save credentials to this path.

Credentials path: $GOOGLE_HEALTH_CREDENTIALS, else $GOOGLE_APPLICATION_CREDENTIALS,
else ~/.config/mcp-google-health/credentials.json.`;
}
