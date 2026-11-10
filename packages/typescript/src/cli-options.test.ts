import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { help, parseCommand } from "./cli-options.ts";
import { spec } from "./spec.ts";

const exec = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());
describe("CLI arguments", () => {
  it.each([
    [[], "serve"],
    [["--help"], "help"],
    [["-h"], "help"],
    [["--version"], "version"],
  ])("parses %j", (args, kind) => {
    expect(parseCommand(args)).toEqual({ kind });
  });
  it("explains commands, flags, and credential precedence", () => {
    const text = help("0.0.0");
    for (const expected of [
      "mcp-google-health 0.0.0",
      "auth",
      "--client-secrets",
      "--write",
      "--scope",
      "--port",
      "--credentials",
      "GOOGLE_HEALTH_CREDENTIALS",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ])
      expect(text).toContain(expected);
  });
  it("uses the spec's default read scopes and credential location", () => {
    vi.stubEnv("GOOGLE_HEALTH_CREDENTIALS", "/test/default.json");
    expect(parseCommand(["auth", "--client-secrets", "client.json"])).toEqual({
      kind: "auth",
      clientSecrets: "client.json",
      port: 0,
      credentials: "/test/default.json",
      scopes: spec.scopes.read.map((scope) => spec.scopes.prefix + scope),
    });
  });
  it("adds write and repeated extra scopes, expands short scopes, and removes duplicates", () => {
    const command = parseCommand([
      "auth",
      "--client-secrets",
      "client.json",
      "--write",
      "--scope",
      "mindfulness.readonly",
      "--scope",
      "https://example.test/custom",
      "--scope",
      "sleep.readonly",
      "--port",
      "4567",
      "--credentials",
      "/test/alternate.json",
    ]);
    expect(command).toMatchObject({
      kind: "auth",
      clientSecrets: "client.json",
      port: 4567,
      credentials: "/test/alternate.json",
    });
    if (command.kind !== "auth") throw new Error("Expected auth");
    expect(command.scopes).toEqual(
      [...spec.scopes.read, ...spec.scopes.write, "mindfulness.readonly"]
        .map((scope) => spec.scopes.prefix + scope)
        .concat("https://example.test/custom"),
    );
  });
  it.each([
    ["unknown"],
    ["--unknown"],
    ["auth"],
    ["auth", "--client-secrets"],
    ["auth", "--client-secrets", "x", "--unknown"],
    ["auth", "--client-secrets", "x", "positional"],
    ["auth", "--client-secrets", "x", "--port", "NaN"],
    ["auth", "--client-secrets", "x", "--port", "65536"],
    ["auth", "--client-secrets", "x", "--port", "-1"],
    ["auth", "--client-secrets", "x", "--port", "1.5"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => parseCommand(args)).toThrow(/Unknown|Give|Option|Unexpected|Invalid/);
  });
  it.each(["--help", "--version"])("runs the CLI entry for %s", async (flag) => {
    const result = await exec(process.execPath, [
      new URL("cli.ts", import.meta.url).pathname,
      flag,
    ]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("0.0.0");
  });
  it("exits with a useful error for an unknown command", async () => {
    await expect(
      exec(process.execPath, [new URL("cli.ts", import.meta.url).pathname, "unknown"]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Unknown command unknown."),
    });
  });
});
