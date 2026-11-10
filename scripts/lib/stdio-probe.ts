import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Message = { id?: number; result?: { tools?: { name: string }[] }; error?: unknown };

/** Starts an MCP server over stdio, runs initialize and tools/list, and returns the tool names. */
export async function listToolsOverStdio(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string[]> {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
  const lines = createInterface({ input: child.stdout });
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    });
    for await (const line of lines) {
      const message = JSON.parse(line) as Message;
      if (message.error) throw new Error(`Server error: ${JSON.stringify(message.error)}`);
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      }
      if (message.id === 2) return (message.result?.tools ?? []).map((tool) => tool.name);
    }
    throw new Error("The server closed stdout before answering tools/list.");
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

/** Fails the script when the tool list is not the spec's. */
export function assertTools(label: string, names: string[], expected: string[]): void {
  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length > 0 || names.length !== expected.length)
    throw new Error(`${label}: expected ${expected.length} tools, got ${names.join(", ")}`);
  console.log(`${label}: ${names.length} tools over stdio.`);
}
