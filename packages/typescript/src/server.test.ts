import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { HealthApi } from "./api.ts";
import { createServer } from "./server.ts";
import { spec, toolsSchema, type Spec } from "./spec.ts";

async function call(
  api: HealthApi,
  name: string,
  args: Record<string, unknown>,
  bundle: Spec = spec,
) {
  const server = createServer(api, "0.0.0", bundle);
  const client = new Client({ name: "server-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("spec-driven execution", () => {
  it("registers a new spec tool, preserving arbitrary bodies and primitive API responses", async () => {
    const bundle = {
      ...spec,
      ...toolsSchema.parse({
        server: spec.server,
        tools: [
          {
            name: "future_tool",
            description: "A tool added by the contract.",
            annotations: { readOnlyHint: false, openWorldHint: true },
            inputSchema: {
              type: "object",
              properties: { payload: { type: "object", additionalProperties: true } },
              required: ["payload"],
              additionalProperties: false,
            },
            request: { method: "POST", path: "users/me/future", body: { arg: "payload" } },
          },
        ],
      }),
    };
    let body: unknown;
    const result = await call(
      async (request) => {
        body = request.body;
        return [null, false, 0];
      },
      "future_tool",
      { payload: { nested: { value: null } } },
      bundle,
    );
    expect(body).toEqual({ nested: { value: null } });
    expect(result.content).toEqual([{ type: "text", text: "[null,false,0]" }]);
  });
  it("returns TCX responses unchanged without a path", async () => {
    const result = await call(async () => ({ other: true }), "export_exercise_tcx", {
      exerciseId: "exercise-1",
    });
    expect(result.content).toEqual([{ type: "text", text: '{"other":true}' }]);
  });
  it("saves an empty TCX file when the response field is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "health-tcx-test-"));
    try {
      const outputPath = join(directory, "exercise.tcx");
      const result = await call(async () => ({}), "export_exercise_tcx", {
        exerciseId: "exercise-1",
        outputPath,
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ outputPath, bytes: 0 }) },
      ]);
      expect(await readFile(outputPath, "utf8")).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("sanitizes non-Error exceptions", async () => {
    const result = await call(
      async () => {
        throw "secret token";
      },
      "get_profile",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Tool failed." }]);
  });
});
