import { spec, type Json, type Spec } from "./spec.ts";

type Schemas = Spec["discovery"]["schemas"];
function object(value: Json | undefined): Record<string, Json> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function getSchema(schemas: Schemas, name: string) {
  return Object.hasOwn(schemas, name) ? schemas[name] : undefined;
}
function inline(value: Json, schemas: Schemas, depth: number, seen: Set<string>): Json {
  if (Array.isArray(value)) return value.map((child) => inline(child, schemas, depth, seen));
  const schema = object(value);
  if (!schema) return value;
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const target = getSchema(schemas, ref);
    if (!target || depth === 0 || seen.has(ref)) return schema;
    const { $ref: _ref, ...rest } = schema;
    return { ...rest, ...object(inline(target, schemas, depth - 1, new Set([...seen, ref]))) };
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, child]) => [key, inline(child, schemas, depth, seen)]),
  );
}

export function describeSchema(name: string, schemas: Schemas = spec.discovery.schemas): Json {
  let schema = getSchema(schemas, name);
  let rootName = name;
  if (!schema) {
    const field = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    for (const container of ["DataPoint", "RollupDataPoint", "DailyRollupDataPoint"]) {
      const ref = object(object(getSchema(schemas, container)?.["properties"])?.[field])?.["$ref"];
      if (typeof ref === "string") {
        schema = getSchema(schemas, ref);
        rootName = ref;
        break;
      }
    }
  }
  if (!schema) throw new Error(`No schema named ${name}. Use a data type slug or schema name.`);
  return inline(schema, schemas, 4, new Set([rootName]));
}

export function listDataTypes(bundle: Spec = spec) {
  return { discoveryRevision: bundle.discovery.revision, dataTypes: bundle.dataTypes };
}
