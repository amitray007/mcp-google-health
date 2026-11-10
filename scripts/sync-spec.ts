// Copies spec/ into each package as a self-contained bundle. tools.json gets its $refs inlined,
// so neither implementation needs a JSON Schema reference resolver.
// Run: node scripts/sync-spec.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const targets = ["packages/typescript/spec/", "packages/python/src/mcp_google_health/spec/"];
const copied = ["data-types.json", "scopes.json", "discovery.json"];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Replaces each `{"$ref": "#/$defs/name"}` with the definition, keeping sibling keys. */
export function inlineRefs(value: Json, defs: Record<string, Json>): Json {
  if (Array.isArray(value)) return value.map((item) => inlineRefs(item, defs));
  if (value === null || typeof value !== "object") return value;
  const { $ref, ...rest } = value;
  const resolved: Record<string, Json> = {};
  if (typeof $ref === "string") {
    const name = $ref.replace(/^#\/\$defs\//, "");
    const target = defs[name];
    if (target === undefined || name === $ref) throw new Error(`Unknown $ref ${$ref}.`);
    Object.assign(resolved, inlineRefs(target, defs));
  }
  for (const [key, child] of Object.entries(rest)) resolved[key] = inlineRefs(child, defs);
  return resolved;
}

export async function bundleTools(): Promise<Json> {
  const spec = JSON.parse(await readFile(new URL("spec/tools.json", root), "utf8")) as {
    $defs: Record<string, Json>;
    server: Json;
    tools: Json;
  };
  return { server: spec.server, tools: inlineRefs(spec.tools, spec.$defs) };
}

async function sync(): Promise<void> {
  const tools = `${JSON.stringify(await bundleTools(), null, 2)}\n`;
  for (const target of targets) {
    const directory = new URL(target, root);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL("tools.json", directory), tools);
    for (const file of copied)
      await writeFile(new URL(file, directory), await readFile(new URL(`spec/${file}`, root)));
  }
  console.log(`Synced spec into ${targets.join(", ")}.`);
}

if (import.meta.main) await sync();
