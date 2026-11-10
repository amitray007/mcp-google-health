import discovery from "./discovery.json" with { type: "json" };
import { dataPointField } from "./data-types.ts";

type Schema = { $ref?: string; properties?: Record<string, Schema>; items?: Schema } & Record<
  string,
  unknown
>;

const schemas: Record<string, Schema> = discovery.schemas;

/** Returns a discovery schema with its references inlined, so one call shows the full shape. */
export function describeSchema(name: string, depth = 4): Schema | undefined {
  const schema = schemas[name] ?? schemaForDataType(name);
  return schema && inline(schema, depth, new Set([String(schema["id"])]));
}

/** A data type's payload schema, or its roll-up value schema for roll-up-only types. */
function schemaForDataType(slug: string): Schema | undefined {
  const field = dataPointField(slug);
  const ref = ["DataPoint", "RollupDataPoint", "DailyRollupDataPoint"]
    .map((container) => schemas[container]?.properties?.[field]?.$ref)
    .find(Boolean);
  return ref ? schemas[ref] : undefined;
}

function inline(schema: Schema, depth: number, seen: Set<string>): Schema {
  if (schema.$ref) {
    const target = schemas[schema.$ref];
    if (!target || depth === 0 || seen.has(schema.$ref)) return schema;
    const { $ref: _ref, ...rest } = schema;
    return { ...rest, ...inline(target, depth - 1, new Set([...seen, schema.$ref])) };
  }
  const result: Schema = { ...schema };
  if (schema.properties)
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, inline(value, depth, seen)]),
    );
  if (schema.items) result.items = inline(schema.items, depth, seen);
  return result;
}
