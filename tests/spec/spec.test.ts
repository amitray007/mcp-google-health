import { readdir, readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { bundleTools, inlineRefs } from "../../scripts/sync-spec.ts";

const root = new URL("../../", import.meta.url);
const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(new URL(path, root), "utf8")) as T;

type Value =
  | { arg?: string; format?: string }
  | Record<string, unknown>
  | string
  | number
  | boolean;
type Tool = {
  name: string;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  inputSchema: { properties: Record<string, unknown>; required: string[] };
  local?: string;
  request?: {
    method: string;
    path: string;
    versioned?: boolean;
    query?: Record<string, Value>;
    body?: Value;
  };
  response?: { saveField: string; pathArg: string };
};
type Case = { name: string; tool: string; arguments: Record<string, unknown> };
type Discovery = {
  revision: string;
  v4DataPointFields: string[];
  scopes: string[];
  schemas: Record<string, { properties?: Record<string, unknown> }>;
};

const tools = (await bundleTools()) as unknown as { tools: Tool[] };
const discovery = await readJson<Discovery>("spec/discovery.json");
const catalog = await readJson<{ dataTypes: { slug: string; scope: string; beta?: boolean }[] }>(
  "spec/data-types.json",
);
const scopes = await readJson<{ read: string[]; write: string[]; discoveryOnly: string[] }>(
  "spec/scopes.json",
);
const conformanceFiles = (await readdir(new URL("spec/conformance/", root))).filter((file) =>
  file.endsWith(".json"),
);
const conformance = Object.fromEntries(
  await Promise.all(
    conformanceFiles.map(async (file) => [
      file,
      (await readJson<{ cases: Case[] }>(`spec/conformance/${file}`)).cases,
    ]),
  ),
) as Record<string, Case[]>;
const camel = (slug: string) => slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function argsIn(value: Value | undefined): { arg: string; format?: string }[] {
  if (value === undefined || typeof value !== "object") return [];
  if (typeof value.arg === "string") return [value as { arg: string; format?: string }];
  return Object.values(value).flatMap((child) => argsIn(child as Value));
}

describe("spec files", () => {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    allowUnionTypes: true,
  });
  it.each([
    ["spec/tools.json", "tools.schema.json"],
    ["spec/data-types.json", "data-types.schema.json"],
    ["spec/scopes.json", "scopes.schema.json"],
    ...conformanceFiles.map((file) => [`spec/conformance/${file}`, "conformance.schema.json"]),
  ])("%s matches %s", async (file, schema) => {
    const validate = ajv.compile(await readJson<object>(`spec/schema/${schema}`));
    const valid = validate(await readJson(file));
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each([
    [
      "both local and request",
      { local: "listDataTypes", request: { method: "GET", path: "users/me/x" } },
    ],
    ["neither local nor request", {}],
    ["a path outside users/me", { request: { method: "GET", path: "projects/x" } }],
    [
      "an unknown value format",
      {
        request: { method: "GET", path: "users/me/x", query: { a: { arg: "a", format: "upper" } } },
      },
    ],
    [
      "an input schema that allows extra arguments",
      {
        local: "listDataTypes",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
      },
    ],
  ])("rejects a tool with %s", async (_label, change) => {
    const spec = await readJson<{ tools: Record<string, unknown>[] }>("spec/tools.json");
    const { local: _local, request: _request, ...base } = spec.tools[0]!;
    spec.tools = [{ ...base, ...change }];
    const validate = ajv.compile(await readJson<object>("spec/schema/tools.schema.json"));
    expect(validate(spec)).toBe(false);
  });

  it("compiles every tool input schema as JSON Schema 2020-12", () => {
    for (const tool of tools.tools) expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
  });
});

describe("tool contract", () => {
  it("has unique tool names", () => {
    const names = tools.tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(tools.tools.filter((tool) => tool.request).map((tool) => [tool.name, tool]))(
    "%s only references its own arguments",
    (_name, tool) => {
      const { properties, required } = tool.inputSchema;
      const request = tool.request!;
      for (const [, param] of request.path.matchAll(/\{([^}]+)\}/g))
        expect(required).toContain(param);
      const used = [...Object.values(request.query ?? {}).flatMap(argsIn), ...argsIn(request.body)];
      for (const { arg } of used) expect(Object.keys(properties)).toContain(arg);
      if (used.some((value) => value.format === "dataPointNames"))
        expect(required).toContain("dataType");
      if (request.versioned)
        expect(Object.keys(properties)).toEqual(expect.arrayContaining(["dataType", "apiVersion"]));
      if (tool.response) expect(Object.keys(properties)).toContain(tool.response.pathArg);
    },
  );

  it("marks only roll-ups as read-only POSTs and only batch delete as destructive", () => {
    for (const tool of tools.tools) {
      const request = tool.request;
      if (!request) continue;
      if (request.method === "GET") expect(tool.annotations.readOnlyHint).toBe(true);
      if (request.method !== "GET" && tool.annotations.readOnlyHint)
        expect(request.path).toMatch(/:(rollUp|dailyRollUp)$/);
      expect(tool.annotations.destructiveHint === true).toBe(request.path.endsWith(":batchDelete"));
    }
  });

  it("bundles with no references left", () => {
    expect(JSON.stringify(tools)).not.toContain('"$ref"');
  });

  it("inlines references with sibling keys and rejects unknown ones", () => {
    const defs = { id: { type: "string", pattern: "^x$" } };
    expect(inlineRefs({ $ref: "#/$defs/id", description: "An ID." }, defs)).toEqual({
      type: "string",
      pattern: "^x$",
      description: "An ID.",
    });
    expect(() => inlineRefs({ $ref: "#/$defs/missing" }, defs)).toThrow("Unknown $ref");
  });
});

describe("conformance cases", () => {
  const names = new Set(tools.tools.map((tool) => tool.name));
  const all = Object.values(conformance).flat();

  it("only call tools that exist", () => {
    for (const testCase of all) expect(names, testCase.name).toContain(testCase.tool);
  });

  it("call every tool at least once with a successful case", () => {
    const covered = new Set(conformance["requests.json"]?.map((testCase) => testCase.tool));
    expect([...names].filter((name) => !covered.has(name))).toEqual([]);
  });

  it("have unique names within each file", () => {
    for (const cases of Object.values(conformance))
      expect(new Set(cases.map((testCase) => testCase.name)).size).toBe(cases.length);
  });

  it("pass the input schema when they expect success, and fail it in validation.json", () => {
    const ajv = new Ajv2020({ strict: false });
    const schemas = new Map(tools.tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
    for (const testCase of [
      ...(conformance["requests.json"] ?? []),
      ...(conformance["errors.json"] ?? []),
    ])
      expect(schemas.get(testCase.tool)!(testCase.arguments), testCase.name).toBe(true);
    for (const testCase of conformance["validation.json"] ?? [])
      expect(schemas.get(testCase.tool)!(testCase.arguments), testCase.name).toBe(false);
  });
});

describe("data type catalog", () => {
  const notDataTypes = new Set([
    "name",
    "dataSource",
    "startTime",
    "endTime",
    "civilStartTime",
    "civilEndTime",
  ]);
  const containers = ["DataPoint", "RollupDataPoint", "DailyRollupDataPoint"];

  it("covers every data type in the discovery snapshot", () => {
    const fields = new Set(
      containers.flatMap((name) => Object.keys(discovery.schemas[name]?.properties ?? {})),
    );
    const expected = [...fields].filter((field) => !notDataTypes.has(field)).toSorted();
    expect(catalog.dataTypes.map((type) => camel(type.slug)).toSorted()).toEqual(expected);
  });

  it("marks exactly the data point types missing from v4 as beta", () => {
    const beta = Object.keys(discovery.schemas["DataPoint"]?.properties ?? {}).filter(
      (field) => !discovery.v4DataPointFields.includes(field),
    );
    expect(catalog.dataTypes.filter((type) => type.beta).map((type) => camel(type.slug))).toEqual(
      beta,
    );
  });

  it("has a read or write scope for every scope family", () => {
    const families = new Set([...scopes.read, ...scopes.write].map((scope) => scope.split(".")[0]));
    for (const type of catalog.dataTypes) expect(families, type.slug).toContain(type.scope);
  });
});

describe("scopes", () => {
  it("list every Google Health scope in discovery, or name it as discovery-only", async () => {
    const prefix = "https://www.googleapis.com/auth/googlehealth.";
    const known = new Set([...scopes.read, ...scopes.write, ...scopes.discoveryOnly]);
    const fromDiscovery = discovery.scopes
      .filter((scope) => scope.startsWith(prefix))
      .map((scope) => scope.slice(prefix.length));
    expect(fromDiscovery.filter((scope) => !known.has(scope))).toEqual([]);
  });
});
