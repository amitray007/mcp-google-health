import { writeFile } from "node:fs/promises";
import { fromJsonSchema, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HealthApi } from "./api.ts";
import { describeSchema, listDataTypes } from "./local-tools.ts";
import { buildRequest } from "./request.ts";
import { spec, type Spec, type Tool } from "./spec.ts";

async function execute(
  tool: Tool,
  args: Record<string, unknown>,
  api: HealthApi,
  bundle: Spec,
): Promise<unknown> {
  if (tool.local === "listDataTypes") return listDataTypes(bundle);
  if (tool.local === "describeSchema")
    return describeSchema(z.string().parse(args["name"]), bundle.discovery.schemas);
  if (!tool.request) throw new Error("Tool has no handler.");
  const result = await api(buildRequest(tool.request, args, undefined, bundle.dataTypes));
  if (tool.response && args[tool.response.pathArg] !== undefined) {
    const path = z.string().parse(args[tool.response.pathArg]);
    const data = z.record(z.string(), z.unknown()).parse(result);
    const value = data[tool.response.saveField];
    const text = z.string().parse(value === undefined ? "" : value);
    await writeFile(path, text, "utf8");
    return { outputPath: path, bytes: Buffer.byteLength(text, "utf8") };
  }
  return result;
}

export function createServer(api: HealthApi, version: string, bundle: Spec = spec): McpServer {
  const server = new McpServer(
    { name: bundle.server.name, version },
    { instructions: bundle.server.instructions },
  );
  for (const tool of bundle.tools) {
    // Advertises the spec schema verbatim, as the Python package does, and validates against it.
    const inputSchema = fromJsonSchema<Record<string, unknown>>(tool.inputSchema);
    server.registerTool(
      tool.name,
      { description: tool.description, annotations: tool.annotations, inputSchema },
      async (input): Promise<CallToolResult> => {
        try {
          const args = z.record(z.string(), z.unknown()).parse(input);
          return {
            content: [
              { type: "text", text: JSON.stringify(await execute(tool, args, api, bundle)) },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              { type: "text", text: error instanceof Error ? error.message : "Tool failed." },
            ],
          };
        }
      },
    );
  }
  return server;
}
