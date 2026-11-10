// Fails unless version.txt, the npm package, the Python package, and uv.lock all match the tag.
// Run: node scripts/check-versions.ts v1.2.3
import { readFile } from "node:fs/promises";
import { repoRoot } from "./lib/spec.ts";

const read = (path: string) => readFile(new URL(path, repoRoot), "utf8");
const tag = process.argv[2]?.replace(/^v/, "");
const versions = {
  "version.txt": (await read("version.txt")).trim(),
  "packages/typescript/package.json": (
    JSON.parse(await read("packages/typescript/package.json")) as { version: string }
  ).version,
  "packages/python/pyproject.toml": /^version\s*=\s*"([^"]+)"/m.exec(
    await read("packages/python/pyproject.toml"),
  )?.[1],
  "packages/python/uv.lock": /name = "mcp-google-health"\nversion = "([^"]+)"/.exec(
    await read("packages/python/uv.lock"),
  )?.[1],
};
const expected = tag ?? versions["version.txt"];
const wrong = Object.entries(versions).filter(([, version]) => version !== expected);
if (wrong.length > 0) {
  for (const [file, version] of wrong)
    console.error(`${file}: ${version ?? "missing"}, expected ${expected}`);
  process.exit(1);
}
console.log(`All versions are ${expected}.`);
