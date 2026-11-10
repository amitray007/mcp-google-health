#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createHealthApi } from "./api.ts";
import { openBrowser, signIn } from "./auth-flow.ts";
import { help, parseCommand } from "./cli-options.ts";
import { createTokenProvider, loadClientSecrets, saveCredentials } from "./credentials.ts";
import { createServer } from "./server.ts";

async function main(): Promise<void> {
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
  const command = parseCommand(process.argv.slice(2));
  switch (command.kind) {
    case "help":
      console.log(help(version));
      return;
    case "version":
      console.log(version);
      return;
    case "serve":
      await createServer(createHealthApi(createTokenProvider()), version).connect(
        new StdioServerTransport(),
      );
      return;
    case "auth": {
      const credentials = await signIn({
        client: await loadClientSecrets(command.clientSecrets),
        scopes: command.scopes,
        port: command.port,
        announce: (url) => {
          console.error(`Open this URL to sign in to Google Health:\n\n${url}\n`);
          openBrowser(url);
        },
      });
      await saveCredentials(command.credentials, credentials);
      console.error(`Saved Google Health credentials to ${command.credentials}.`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
});
