// Runs the built npm package and the built Python wheel as real stdio servers against a fake
// Google Health API and token endpoint, and checks that both behave as the shared spec says.
// Run after `mise run build`: `mise run test:e2e`.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeGoogle, startFakeGoogle } from "./fake-google.ts";

const root = new URL("../../", import.meta.url);
const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(new URL(path, root), "utf8")) as T;

type Expected = {
  request?: { method: string; path: string; query: Record<string, string>; body?: unknown };
  result?: unknown;
  resultSubset?: unknown;
  text?: string;
  file?: { path: string; content: string };
};
type Case = {
  name: string;
  tool: string;
  arguments: Record<string, unknown>;
  apiResponse?: unknown;
  api?: { status: number; body?: unknown; text?: string };
  token?: { status: number; body: unknown };
  credentials?: "missing" | "malformed";
  expect?: Expected;
};
type Implementation = { name: string; command: string; args: string[] };
type Outcome = { isError: boolean; text: string };

const secrets = {
  client_id: "e2e-client.apps.googleusercontent.com",
  client_secret: "e2e-client-secret",
  refresh_token: "e2e-refresh-token",
};
const requests = (await readJson<{ cases: Case[] }>("spec/conformance/requests.json")).cases;
const errors = (await readJson<{ cases: Case[] }>("spec/conformance/errors.json")).cases;
const validation = (await readJson<{ cases: Case[] }>("spec/conformance/validation.json")).cases;
const spec = await readJson<{ tools: { name: string }[] }>("spec/tools.json");

let google: FakeGoogle;
let work: string;
let implementations: Implementation[];

async function pythonImplementation(): Promise<Implementation> {
  const dist = fileURLToPath(new URL("packages/python/dist/", root));
  const wheel = (await readdir(dist)).find((file) => file.endsWith(".whl"));
  if (!wheel) throw new Error("No wheel in packages/python/dist. Run `mise run build` first.");
  const venv = join(work, "venv");
  execFileSync("uv", ["venv", "--quiet", venv]);
  execFileSync("uv", ["pip", "install", "--quiet", "--python", venv, join(dist, wheel)]);
  return { name: "python", command: join(venv, "bin", "mcp-google-health"), args: [] };
}

async function typescriptImplementation(): Promise<Implementation> {
  const pkg = await readJson<{ bin: Record<string, string> }>("packages/typescript/package.json");
  const bin = pkg.bin["mcp-google-health"];
  if (!bin) throw new Error("packages/typescript/package.json has no mcp-google-health bin.");
  return {
    name: "typescript",
    command: process.execPath,
    args: [fileURLToPath(new URL(`packages/typescript/${bin}`, root))],
  };
}

async function writeCredentials(kind?: "missing" | "malformed"): Promise<string> {
  const directory = await mkdtemp(join(work, "credentials-"));
  const path = join(directory, "credentials.json");
  if (kind === "malformed") await writeFile(path, JSON.stringify({ type: "service_account" }));
  if (!kind) await writeFile(path, JSON.stringify({ type: "authorized_user", ...secrets }));
  return path;
}

async function connect(implementation: Implementation, credentialsPath: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0" });
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: work,
    GOOGLE_HEALTH_API_BASE_URL: google.url,
    GOOGLE_HEALTH_TOKEN_URL: `${google.url}/token`,
    GOOGLE_HEALTH_CREDENTIALS: credentialsPath,
  };
  await client.connect(
    new StdioClientTransport({
      command: implementation.command,
      args: implementation.args,
      env,
      stderr: "ignore",
    }),
  );
  return client;
}

async function call(client: Client, testCase: Case): Promise<Outcome> {
  const result = await client.callTool({
    name: testCase.tool,
    arguments: fill(testCase.arguments),
  });
  const [first] = result.content;
  return { isError: result.isError === true, text: first?.type === "text" ? first.text : "" };
}

function fill<T>(value: T, credentialsPath = ""): T {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll("{tmpdir}", work)
      .replaceAll("{credentialsPath}", credentialsPath),
  ) as T;
}

function expectSubset(actual: unknown, subset: unknown): void {
  if (Array.isArray(subset)) {
    expect(Array.isArray(actual)).toBe(true);
    subset.forEach((item, index) => expectSubset((actual as unknown[])[index], item));
  } else if (subset && typeof subset === "object") {
    for (const [key, value] of Object.entries(subset))
      expectSubset((actual as Record<string, unknown>)[key], value);
  } else expect(actual).toEqual(subset);
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "mcp-google-health-e2e-"));
  google = await startFakeGoogle(secrets);
  implementations = [await typescriptImplementation(), await pythonImplementation()];
}, 120_000);

afterAll(async () => {
  await google?.close();
});

describe("tool listing", () => {
  it("is identical across implementations and matches the spec", async () => {
    const listings = [];
    for (const implementation of implementations) {
      const client = await connect(implementation, await writeCredentials("missing"));
      listings.push((await client.listTools()).tools);
      await client.close();
    }
    const [typescript, python] = listings;
    expect(typescript?.map((tool) => tool.name)).toEqual(spec.tools.map((tool) => tool.name));
    expect(python).toEqual(typescript);
  });
});

describe.each(["typescript", "python"])("%s over stdio", (name) => {
  let client: Client;
  const implementation = () => implementations.find((candidate) => candidate.name === name)!;

  let tokenRequestsBefore = 0;

  beforeAll(async () => {
    tokenRequestsBefore = google.tokenRequests;
    client = await connect(implementation(), await writeCredentials());
  });
  afterAll(async () => {
    await client?.close();
  });

  it.each(requests.map((testCase) => [testCase.name, testCase]))(
    "request: %s",
    async (_name, testCase) => {
      google.reset({ status: 200, body: testCase.apiResponse ?? {} });
      const outcome = await call(client, testCase);
      const expected = fill(testCase.expect ?? {});
      expect(outcome.isError, outcome.text).toBe(false);
      const result: unknown = JSON.parse(outcome.text);
      if (expected.request) {
        expect(google.apiRequests).toEqual([
          { ...expected.request, authorization: "Bearer access-1" },
        ]);
      } else expect(google.apiRequests).toEqual([]);
      if (expected.result !== undefined) expect(result).toEqual(expected.result);
      if (expected.resultSubset !== undefined) expectSubset(result, expected.resultSubset);
      if (expected.file)
        expect(await readFile(expected.file.path, "utf8")).toBe(expected.file.content);
    },
  );

  it("refreshes the access token once and reuses it", () => {
    expect(google.tokenRequests - tokenRequestsBefore).toBe(1);
  });

  it.each(validation.map((testCase) => [testCase.name, testCase]))(
    "rejects: %s",
    async (_name, testCase) => {
      google.reset({ status: 200, body: {} });
      const outcome = await call(client, testCase);
      expect(outcome.isError).toBe(true);
      expect(google.apiRequests).toEqual([]);
    },
  );

  it.each(errors.map((testCase) => [testCase.name, testCase]))(
    "error: %s",
    async (_name, testCase) => {
      const credentialsPath = await writeCredentials(testCase.credentials);
      const fresh = await connect(implementation(), credentialsPath);
      try {
        google.reset(testCase.api ?? { status: 200, body: {} }, testCase.token);
        const outcome = await call(fresh, testCase);
        expect(outcome).toEqual({
          isError: true,
          text: fill(testCase.expect?.text, credentialsPath),
        });
        for (const secret of [...Object.values(secrets), "access-1"])
          expect(outcome.text).not.toContain(secret);
      } finally {
        await fresh.close();
      }
    },
  );
});
