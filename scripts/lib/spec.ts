import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

export const repoRoot = root;

export async function specToolNames(): Promise<string[]> {
  const spec = JSON.parse(await readFile(new URL("spec/tools.json", root), "utf8")) as {
    tools: { name: string }[];
  };
  return spec.tools.map((tool) => tool.name);
}
