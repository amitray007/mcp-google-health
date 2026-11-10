import { writeFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HealthApi } from "./api.ts";
import { apiVersionFor, dataTypes, discoveryRevision } from "./data-types.ts";
import { describeSchema } from "./schemas.ts";

const segment = z
  .string()
  .regex(/^[A-Za-z0-9._~-]+$/, "Use an ID without slashes.")
  .describe("A resource ID without slashes.");
const dataType = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .describe("Data type in kebab case, such as steps, sleep, or heart-rate. See list_data_types.");
const apiVersion = z
  .enum(["v4", "v4beta"])
  .optional()
  .describe("API version. Defaults to v4, or v4beta for beta-only data types.");
const sourceFamily = z
  .enum(["all-sources", "google-wearables", "google-sources", "self-sources"])
  .optional()
  .describe(
    "Data sources: all-sources (default), google-wearables (Fitbit and Pixel devices only), google-sources (Google devices, manual logs, Health Connect), or self-sources (data this client wrote).",
  );
const pageSize = z.number().int().min(1).max(10000).optional();
const pageToken = z.string().optional().describe("nextPageToken from the previous response.");
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Civil date in the user's time zone, YYYY-MM-DD.");
const timestamp = z.string().datetime({ offset: true }).describe("RFC 3339 timestamp.");
const dataPointBody = z
  .record(z.string(), z.unknown())
  .describe(
    'DataPoint body. Put the payload under the camelCase data type field, such as {"weight": {...}}. Call describe_schema with the data type for its fields.',
  );

const tcxResponse = z.object({ tcxData: z.string().default("") });

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown): CallToolResult {
  const text = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text }] };
}

function family(value: string | undefined): string | undefined {
  return value && `users/me/dataSourceFamilies/${value}`;
}

function civil(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return { date: { year, month, day } };
}

const points = (type: string) => `users/me/dataTypes/${type}/dataPoints`;

export function createServer(api: HealthApi, version: string): McpServer {
  const server = new McpServer(
    { name: "mcp-google-health", version },
    {
      instructions:
        "Reads and writes Google Health (Fitbit, Pixel Watch) data through the Google Health API v4. Start with list_data_types, then list_data_points, reconcile_data_points, or the roll-up tools. Use describe_schema before a write.",
    },
  );

  function tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    annotations: typeof readOnly | typeof write | typeof destructive,
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      { description, inputSchema: z.object(shape), annotations },
      async (args: z.infer<z.ZodObject<Shape>>) => {
        try {
          return json(await run(args));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  tool(
    "list_data_types",
    "List every Google Health data type with its kind, scope family, supported operations, and whether it needs v4beta.",
    {},
    readOnly,
    async () => ({ discoveryRevision, dataTypes }),
  );

  tool(
    "describe_schema",
    "Show the JSON schema of a data type payload (such as weight or sleep) or an API schema (such as Profile, Settings, PairedDevice, DataPoint).",
    { name: z.string().min(1).describe("Data type slug or schema name.") },
    readOnly,
    async ({ name }) => {
      const schema = describeSchema(name);
      if (!schema) throw new Error(`No schema named ${name}. Use a data type slug or schema name.`);
      return schema;
    },
  );

  tool(
    "get_identity",
    "Get the user's Google Health identity and numeric health user ID.",
    {},
    readOnly,
    () => api({ method: "GET", path: "users/me/identity" }),
  );
  tool(
    "get_profile",
    "Get the user's health profile: age, stride lengths, membership start.",
    {},
    readOnly,
    () => api({ method: "GET", path: "users/me/profile" }),
  );
  tool("get_settings", "Get the user's settings, such as units and time zone.", {}, readOnly, () =>
    api({ method: "GET", path: "users/me/settings" }),
  );
  tool(
    "get_irn_profile",
    "Get the user's irregular rhythm notification (IRN) enrollment profile.",
    {},
    readOnly,
    () => api({ method: "GET", path: "users/me/irnProfile" }),
  );

  tool(
    "update_profile",
    "Update profile fields. Name each changed field in updateMask.",
    {
      profile: z
        .record(z.string(), z.unknown())
        .describe("Profile fields. See describe_schema Profile."),
      updateMask: z.string().min(1).describe("Comma-separated field paths to change."),
    },
    write,
    ({ profile, updateMask }) =>
      api({ method: "PATCH", path: "users/me/profile", query: { updateMask }, body: profile }),
  );
  tool(
    "update_settings",
    "Update settings fields. Name each changed field in updateMask.",
    {
      settings: z
        .record(z.string(), z.unknown())
        .describe("Settings fields. See describe_schema Settings."),
      updateMask: z.string().min(1).describe("Comma-separated field paths to change."),
    },
    write,
    ({ settings, updateMask }) =>
      api({ method: "PATCH", path: "users/me/settings", query: { updateMask }, body: settings }),
  );

  tool(
    "list_paired_devices",
    "List the user's paired devices with battery level, battery status, firmware version, features, and last sync time.",
    { pageSize: pageSize, pageToken },
    readOnly,
    (args) =>
      api({
        method: "GET",
        path: "users/me/pairedDevices",
        query: { pageSize: args.pageSize, pageToken: args.pageToken },
      }),
  );
  tool(
    "get_paired_device",
    "Get one paired device.",
    { deviceId: segment },
    readOnly,
    ({ deviceId }) => api({ method: "GET", path: `users/me/pairedDevices/${deviceId}` }),
  );

  tool(
    "list_data_points",
    'List raw data points of one data type, newest first. Filter with AIP-160 on the type\'s time field, for example steps.interval.civil_start_time >= "2026-11-01", weight.sample_time.physical_time >= "2026-11-01T00:00:00Z", daily_resting_heart_rate.date >= "2026-11-01", or sleep.interval.civil_end_time >= "2026-11-01". Use snake case in filters.',
    {
      dataType,
      filter: z.string().optional().describe("AIP-160 filter on the data type's time field."),
      dataSourceFamily: sourceFamily,
      pageSize,
      pageToken,
      apiVersion,
    },
    readOnly,
    (args) =>
      api({
        method: "GET",
        path: points(args.dataType),
        version: apiVersionFor(args.dataType, args.apiVersion),
        query: {
          filter: args.filter,
          dataSourceFamily: family(args.dataSourceFamily),
          pageSize: args.pageSize,
          pageToken: args.pageToken,
        },
      }),
  );
  tool(
    "get_data_point",
    "Get one identifiable data point, such as an exercise, sleep session, weight, or log entry.",
    { dataType, dataPointId: segment, apiVersion },
    readOnly,
    (args) =>
      api({
        method: "GET",
        path: `${points(args.dataType)}/${args.dataPointId}`,
        version: apiVersionFor(args.dataType, args.apiVersion),
      }),
  );
  tool(
    "reconcile_data_points",
    "List data points merged across sources into one de-duplicated stream, as the Google Health app shows them. Takes the same filters as list_data_points. Use this for sleep across sources.",
    {
      dataType,
      filter: z.string().optional().describe("AIP-160 filter on the data type's time field."),
      dataSourceFamily: sourceFamily,
      pageSize,
      pageToken,
      apiVersion,
    },
    readOnly,
    (args) =>
      api({
        method: "GET",
        path: `${points(args.dataType)}:reconcile`,
        version: apiVersionFor(args.dataType, args.apiVersion),
        query: {
          filter: args.filter,
          dataSourceFamily: family(args.dataSourceFamily),
          pageSize: args.pageSize,
          pageToken: args.pageToken,
        },
      }),
  );
  tool(
    "roll_up_data_points",
    "Aggregate a data type into fixed physical-time windows, such as hourly steps or 5-minute heart rate. Range is closed-open; at most 14 days for heart-rate, active-minutes, total-calories, and calories-in-heart-rate-zone, 90 days otherwise.",
    {
      dataType,
      startTime: timestamp,
      endTime: timestamp,
      windowSize: z
        .string()
        .regex(/^\d+(\.\d+)?s$/)
        .describe("Window length in seconds with an s suffix, such as 3600s."),
      dataSourceFamily: sourceFamily,
      pageSize,
      pageToken,
      apiVersion,
    },
    readOnly,
    (args) =>
      api({
        method: "POST",
        path: `${points(args.dataType)}:rollUp`,
        version: apiVersionFor(args.dataType, args.apiVersion),
        body: {
          range: { startTime: args.startTime, endTime: args.endTime },
          windowSize: args.windowSize,
          dataSourceFamily: family(args.dataSourceFamily),
          pageSize: args.pageSize,
          pageToken: args.pageToken,
        },
      }),
  );
  tool(
    "daily_roll_up_data_points",
    "Aggregate a data type into civil-day windows in the user's time zone, such as daily steps or calories. endDate is exclusive. At most 14 days for heart-rate, active-minutes, total-calories, and calories-in-heart-rate-zone, 90 days otherwise.",
    {
      dataType,
      startDate: civilDate,
      endDate: civilDate.describe("Exclusive end date, YYYY-MM-DD."),
      windowSizeDays: z.number().int().min(1).optional().describe("Days per window. Default 1."),
      dataSourceFamily: sourceFamily,
      pageSize: z.number().int().min(1).max(90).optional(),
      pageToken,
      apiVersion,
    },
    readOnly,
    (args) =>
      api({
        method: "POST",
        path: `${points(args.dataType)}:dailyRollUp`,
        version: apiVersionFor(args.dataType, args.apiVersion),
        body: {
          range: { start: civil(args.startDate), end: civil(args.endDate) },
          windowSizeDays: args.windowSizeDays,
          dataSourceFamily: family(args.dataSourceFamily),
          pageSize: args.pageSize,
          pageToken: args.pageToken,
        },
      }),
  );
  tool(
    "export_exercise_tcx",
    "Export one exercise as TCX with GPS track, heart rate, and laps. Needs the location scope. Give outputPath to save the file instead of returning the TCX text.",
    {
      exerciseId: segment.describe("The exercise data point ID."),
      partialData: z
        .boolean()
        .optional()
        .describe("Include data points when the exercise has no GPS data."),
      outputPath: z.string().min(1).optional().describe("File path for the TCX file."),
    },
    readOnly,
    async ({ exerciseId, partialData, outputPath }) => {
      const result = tcxResponse.parse(
        await api({
          method: "GET",
          path: `${points("exercise")}/${exerciseId}:exportExerciseTcx`,
          query: { partialData },
        }),
      );
      if (!outputPath) return result;
      await writeFile(outputPath, result.tcxData);
      return { outputPath, bytes: Buffer.byteLength(result.tcxData) };
    },
  );

  tool(
    "create_data_point",
    "Write a new data point, such as a weight, body fat, height, sleep, exercise, hydration or nutrition log, mood, symptom, menstrual period, or ovulation test. Needs the matching write scope.",
    { dataType, dataPoint: dataPointBody, apiVersion },
    write,
    (args) =>
      api({
        method: "POST",
        path: points(args.dataType),
        version: apiVersionFor(args.dataType, args.apiVersion),
        body: args.dataPoint,
      }),
  );
  tool(
    "update_data_point",
    "Replace a data point that this client wrote.",
    { dataType, dataPointId: segment, dataPoint: dataPointBody, apiVersion },
    write,
    (args) =>
      api({
        method: "PATCH",
        path: `${points(args.dataType)}/${args.dataPointId}`,
        version: apiVersionFor(args.dataType, args.apiVersion),
        body: args.dataPoint,
      }),
  );
  tool(
    "delete_data_points",
    "Delete up to 10000 data points of one data type that this client wrote.",
    { dataType, dataPointIds: z.array(segment).min(1).max(10000), apiVersion },
    destructive,
    (args) =>
      api({
        method: "POST",
        path: `${points(args.dataType)}:batchDelete`,
        version: apiVersionFor(args.dataType, args.apiVersion),
        body: { names: args.dataPointIds.map((id) => `${points(args.dataType)}/${id}`) },
      }),
  );

  return server;
}
