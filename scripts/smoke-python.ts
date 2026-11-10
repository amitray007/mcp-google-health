// Builds the wheel, installs it in a fresh virtual environment, and runs it over stdio.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, specToolNames } from "./lib/spec.ts";
import { assertTools, listToolsOverStdio } from "./lib/stdio-probe.ts";

const work = await mkdtemp(join(tmpdir(), "mcp-google-health-py-"));
const project = fileURLToPath(new URL("packages/python/", repoRoot));
execFileSync("uv", ["build", "--wheel", "--out-dir", work, project], { stdio: "inherit" });
const wheel = (await readdir(work)).find((file) => file.endsWith(".whl"));
if (!wheel) throw new Error("uv build produced no wheel.");

const venv = join(work, ".venv");
execFileSync("uv", ["venv", venv], { stdio: "inherit" });
execFileSync("uv", ["pip", "install", "--python", venv, join(work, wheel)], { stdio: "inherit" });
const bin = join(venv, process.platform === "win32" ? "Scripts" : "bin", "mcp-google-health");
console.log(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim());
assertTools("Python wheel", await listToolsOverStdio(bin, []), await specToolNames());
