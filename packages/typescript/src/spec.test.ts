import { describe, expect, it } from "vitest";
import { spec, toolsSchema } from "./spec.ts";

describe("spec bundle", () => {
  it("contains complete inlined validators and server metadata", () => {
    expect(spec.tools).toHaveLength(19);
    expect(spec.scopes.read).toHaveLength(9);
    expect(spec.dataTypes).toHaveLength(47);
    expect(spec.discovery.schemas["DataPoint"]).toBeDefined();
    for (const tool of spec.tools) expect(JSON.stringify(tool.inputSchema)).not.toContain('"$ref"');
  });
  it("preserves top-level JSON Schema constraints", () => {
    const tool = spec.tools[0];
    expect(tool).toBeDefined();
    if (!tool) throw new Error("Missing fixture tool");
    expect(
      toolsSchema.parse({
        ...spec,
        tools: [{ ...tool, inputSchema: { ...tool.inputSchema, maxProperties: 0 } }],
      }).tools[0]?.inputSchema["maxProperties"],
    ).toBe(0);
  });
  it.each([
    { local: "listDataTypes", request: { method: "GET", path: "users/me/test" } },
    { local: undefined, request: undefined },
    { local: undefined, request: { method: "DELETE", path: "users/me/test" } },
    {
      local: undefined,
      request: { method: "POST", path: "users/me/test", body: { arg: "x", format: "invalid" } },
    },
    { local: undefined, request: { method: "POST", path: "users/me/test", body: null } },
  ])("rejects an invalid tool handler %#", (overrides) => {
    expect(
      toolsSchema.safeParse({ ...spec, tools: [{ ...spec.tools[0], ...overrides }] }).success,
    ).toBe(false);
  });
});
