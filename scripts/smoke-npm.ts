// Packs the npm package, installs the tarball in an empty project, and runs it over stdio.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, specToolNames } from "./lib/spec.ts";
import { assertTools, listToolsOverStdio } from "./lib/stdio-probe.ts";

const work = await mkdtemp(join(tmpdir(), "mcp-google-health-npm-"));
const pkg = fileURLToPath(new URL("packages/typescript/", repoRoot));
execFileSync("pnpm", ["pack", "--pack-destination", work], { cwd: pkg, stdio: "inherit" });
const tarball = (await readdir(work)).find((file) => file.endsWith(".tgz"));
if (!tarball) throw new Error("pnpm pack produced no tarball.");

const project = join(work, "project");
execFileSync("mkdir", ["-p", project]);
await writeFile(join(project, "package.json"), '{"private":true}\n');
execFileSync("npm", ["install", "--no-audit", "--no-fund", join(work, tarball)], {
  cwd: project,
  stdio: "inherit",
});
const bin = join(project, "node_modules", ".bin", "mcp-google-health");
console.log(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim());
assertTools("npm tarball", await listToolsOverStdio(bin, []), await specToolNames());
