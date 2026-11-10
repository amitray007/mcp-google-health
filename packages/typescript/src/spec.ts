import { readFileSync } from "node:fs";
import { z } from "zod";

const json = z.json();
export type Json = z.infer<typeof json>;
const record = z.record(z.string(), json);
const argument = z.strictObject({
  arg: z.string(),
  format: z.enum(["sourceFamily", "civilDateTime", "dataPointNames"]).optional(),
});
type Expression = string | number | boolean | { [key: string]: Expression | undefined };
const expression: z.ZodType<Expression> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    argument,
    z.record(z.string(), expression).refine((value) => !Object.hasOwn(value, "arg")),
  ]),
);
const requestSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PATCH"]),
  path: z.string(),
  versioned: z.boolean().optional(),
  query: z.record(z.string(), expression).optional(),
  body: expression.optional(),
});
const toolSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    description: z.string().min(1),
    annotations: z.strictObject({
      readOnlyHint: z.boolean(),
      openWorldHint: z.boolean(),
      destructiveHint: z.boolean().optional(),
    }),
    inputSchema: z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string(), z.record(z.string(), z.unknown())),
        required: z.array(z.string()),
        additionalProperties: z.literal(false),
      })
      .catchall(json),
    local: z.enum(["listDataTypes", "describeSchema"]).optional(),
    request: requestSchema.optional(),
    response: z.strictObject({ saveField: z.string(), pathArg: z.string() }).optional(),
  })
  .refine((tool) => (tool.local === undefined) !== (tool.request === undefined));

export const toolsSchema = z.object({
  server: z.strictObject({ name: z.string(), instructions: z.string() }),
  tools: z.array(toolSchema).min(1),
});
const catalogSchema = z.object({
  dataTypes: z.array(
    z.strictObject({
      slug: z.string(),
      kind: z.enum(["Interval", "Sample", "Daily", "Session", "Food"]),
      scope: z.string(),
      operations: z
        .array(
          z.enum([
            "list",
            "get",
            "reconcile",
            "rollUp",
            "dailyRollUp",
            "create",
            "patch",
            "batchDelete",
          ]),
        )
        .optional(),
      beta: z.literal(true).optional(),
    }),
  ),
});
const discoverySchema = z.object({
  revision: z.string(),
  schemas: z.record(z.string(), record),
  v4DataPointFields: z.array(z.string()),
});
const scopesSchema = z.object({
  prefix: z.string(),
  read: z.array(z.string()),
  write: z.array(z.string()),
});

function load<T>(name: string, schema: z.ZodType<T>): T {
  const value: unknown = JSON.parse(
    readFileSync(new URL(`../spec/${name}.json`, import.meta.url), "utf8"),
  );
  return schema.parse(value);
}

export const spec = {
  ...load("tools", toolsSchema),
  ...load("data-types", catalogSchema),
  discovery: load("discovery", discoverySchema),
  scopes: load("scopes", scopesSchema),
};
export type Tool = z.infer<typeof toolSchema>;
export type RequestSpec = z.infer<typeof requestSchema>;
export type Spec = typeof spec;
export type { Expression };
