/* oxlint-disable vitest/no-conditional-expect, vitest/valid-title -- Shared fixtures select assertions and supply test names. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHealthApi } from "./api.ts";
import { createTokenProvider } from "./credentials.ts";
import { createServer } from "./server.ts";
import { spec } from "./spec.ts";

const response = z.object({
  status: z.number(),
  body: z.unknown().optional(),
  text: z.string().optional(),
});
const caseSchema = z.object({
  name: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  apiResponse: z.unknown().optional(),
  api: response.optional(),
  token: response.optional(),
  credentials: z.enum(["missing", "malformed"]).optional(),
  expect: z
    .object({
      request: z
        .object({
          method: z.string(),
          path: z.string(),
          query: z.record(z.string(), z.string()),
          body: z.unknown().optional(),
        })
        .optional(),
      result: z.unknown().optional(),
      resultSubset: z.unknown().optional(),
      text: z.string().optional(),
      file: z.object({ path: z.string(), content: z.string() }).optional(),
    })
    .default({}),
});

function assertSubset(actual: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    const values = z.array(z.unknown()).parse(actual);
    expect(values.length).toBeGreaterThanOrEqual(expected.length);
    expected.forEach((value, index) => assertSubset(values[index], value));
  } else if (expected !== null && typeof expected === "object") {
    const values = z.record(z.string(), z.unknown()).parse(actual);
    for (const [key, value] of Object.entries(expected)) {
      expect(Object.hasOwn(values, key)).toBe(true);
      assertSubset(values[key], value);
    }
  } else expect(actual).toEqual(expected);
}

function substitute(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === "string")
    return value.replace(/\{(?:tmpdir|credentialsPath)\}/g, (key) => replacements[key] ?? key);
  if (Array.isArray(value)) return value.map((child) => substitute(child, replacements));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, substitute(child, replacements)]),
    );
  return value;
}

for (const kind of ["requests", "errors", "validation"]) {
  const fixture: unknown = JSON.parse(
    await readFile(new URL(`../../../spec/conformance/${kind}.json`, import.meta.url), "utf8"),
  );
  const { cases } = z.object({ cases: z.array(caseSchema) }).parse(fixture);
  describe(`shared conformance: ${kind}`, () => {
    for (const original of cases) {
      it(original.name, async () => {
        const directory = await mkdtemp(join(tmpdir(), "google-health-conformance-"));
        const path = join(directory, "credentials.json");
        const test = caseSchema.parse(
          substitute(original, { "{tmpdir}": directory, "{credentialsPath}": path }),
        );
        const requests: unknown[] = [];
        let tokenRequests = 0;
        const fakeFetch: typeof fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.hostname === "oauth2.googleapis.com") {
            tokenRequests++;
            const form = new URLSearchParams(z.string().parse(init?.body));
            expect(form.get("grant_type")).toBe("refresh_token");
            expect(form.get("refresh_token")).toBe("refresh-secret");
            expect(new Headers(init?.headers).get("content-type")).toBe(
              "application/x-www-form-urlencoded",
            );
            return test.token
              ? Response.json(test.token.body, { status: test.token.status })
              : Response.json({ access_token: "access-secret", expires_in: 3600 });
          }
          requests.push({
            method: init?.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            ...(init?.body === undefined ? {} : { body: JSON.parse(z.string().parse(init.body)) }),
          });
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-secret");
          if (init?.body !== undefined)
            expect(new Headers(init.headers).get("content-type")).toBe("application/json");
          if (test.api?.text !== undefined)
            return new Response(test.api.text, { status: test.api.status });
          return Response.json(test.api ? test.api.body : (test.apiResponse ?? {}), {
            status: test.api?.status ?? 200,
          });
        };
        const server = createServer(
          createHealthApi(createTokenProvider({ path, fetch: fakeFetch }), fakeFetch),
          "0.0.0",
        );
        const client = new Client({ name: "conformance", version: "0" });
        try {
          if (test.credentials !== "missing")
            await writeFile(
              path,
              test.credentials === "malformed"
                ? "{broken secret"
                : JSON.stringify({
                    type: "authorized_user",
                    client_id: "client-id",
                    client_secret: "client-secret",
                    refresh_token: "refresh-secret",
                  }),
            );
          const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
          await server.connect(serverSide);
          await client.connect(clientSide);
          const result = await client.callTool({ name: test.tool, arguments: test.arguments });
          const content = z
            .array(z.object({ type: z.literal("text"), text: z.string() }))
            .parse(result.content);
          expect(content).toHaveLength(1);
          const text = z.string().parse(content[0]?.text);
          if (kind === "validation") {
            expect(result.isError).toBe(true);
            expect(requests).toEqual([]);
            expect(tokenRequests).toBe(0);
          } else if (kind === "errors") {
            expect(result.isError).toBe(true);
            expect(text).toBe(test.expect.text);
            for (const secret of ["access-secret", "refresh-secret", "client-secret"])
              expect(text).not.toContain(secret);
          } else {
            expect(result.isError).not.toBe(true);
            const data: unknown = JSON.parse(text);
            if (test.expect.request) expect(requests).toEqual([test.expect.request]);
            else expect(requests).toEqual([]);
            if (Object.hasOwn(test.expect, "result")) expect(data).toEqual(test.expect.result);
            else if (!Object.hasOwn(test.expect, "resultSubset"))
              expect(data).toEqual(test.apiResponse ?? {});
            if (Object.hasOwn(test.expect, "resultSubset"))
              assertSubset(data, test.expect.resultSubset);
            if (test.expect.file)
              expect(await readFile(test.expect.file.path, "utf8")).toBe(test.expect.file.content);
          }
        } finally {
          await client.close();
          await server.close();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });
}

it("publishes every spec tool with its description, validator, and annotations before credentials exist", async () => {
  const server = createServer(async () => {
    throw new Error("API must stay lazy");
  }, "0.0.0");
  const client = new Client({ name: "catalog", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(19);
    for (const tool of spec.tools)
      expect(tools.find((entry) => entry.name === tool.name)).toMatchObject({
        name: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: {
          type: "object",
          ...(tool.inputSchema.required.length ? { required: tool.inputSchema.required } : {}),
          additionalProperties: false,
        },
      });
    expect(client.getServerVersion()).toEqual({ name: spec.server.name, version: "0.0.0" });
    expect(client.getInstructions()).toBe(spec.server.instructions);
  } finally {
    await client.close();
    await server.close();
  }
});
