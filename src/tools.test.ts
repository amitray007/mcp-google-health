import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { ApiRequest } from "./api.ts";
import { createServer } from "./tools.ts";

async function connect(response: unknown = { ok: true }) {
  const requests: ApiRequest[] = [];
  const server = createServer(async (request) => {
    requests.push(request);
    if (response instanceof Error) throw response;
    return response;
  }, "0.0.0-test");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content;
    const text = first?.type === "text" ? first.text : "";
    return { isError: result.isError === true, text };
  };
  return { client, call, requests };
}

describe("tools", () => {
  it("lists read, write, and destructive tools with matching hints", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        tool.annotations?.readOnlyHint
          ? "read"
          : tool.annotations?.destructiveHint
            ? "destructive"
            : "write",
      ]),
    );
    expect(hints).toMatchObject({
      list_data_points: "read",
      export_exercise_tcx: "read",
      list_paired_devices: "read",
      create_data_point: "write",
      update_settings: "write",
      delete_data_points: "destructive",
    });
    expect(tools).toHaveLength(19);
  });

  it("maps list filters and source families onto the v4 data points path", async () => {
    const { call, requests } = await connect();
    await call("list_data_points", {
      dataType: "steps",
      filter: 'steps.interval.civil_start_time >= "2026-11-01"',
      dataSourceFamily: "google-wearables",
      pageSize: 100,
    });
    expect(requests[0]).toEqual({
      method: "GET",
      path: "users/me/dataTypes/steps/dataPoints",
      version: "v4",
      query: {
        filter: 'steps.interval.civil_start_time >= "2026-11-01"',
        dataSourceFamily: "users/me/dataSourceFamilies/google-wearables",
        pageSize: 100,
        pageToken: undefined,
      },
    });
  });

  it("routes beta-only data types to v4beta", async () => {
    const { call, requests } = await connect();
    await call("list_data_points", { dataType: "skin-temperature-sensors" });
    expect(requests[0]?.version).toBe("v4beta");
  });

  it("builds a civil-day roll-up body", async () => {
    const { call, requests } = await connect();
    await call("daily_roll_up_data_points", {
      dataType: "total-calories",
      startDate: "2026-11-01",
      endDate: "2026-11-08",
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "users/me/dataTypes/total-calories/dataPoints:dailyRollUp",
      body: {
        range: {
          start: { date: { year: 2026, month: 11, day: 1 } },
          end: { date: { year: 2026, month: 11, day: 8 } },
        },
      },
    });
  });

  it("expands batch delete IDs to resource names", async () => {
    const { call, requests } = await connect();
    await call("delete_data_points", { dataType: "weight", dataPointIds: ["a1", "b2"] });
    expect(requests[0]).toMatchObject({
      path: "users/me/dataTypes/weight/dataPoints:batchDelete",
      body: {
        names: [
          "users/me/dataTypes/weight/dataPoints/a1",
          "users/me/dataTypes/weight/dataPoints/b2",
        ],
      },
    });
  });

  it("rejects path traversal in IDs before calling the API", async () => {
    const { call, requests } = await connect();
    const result = await call("get_data_point", { dataType: "exercise", dataPointId: "../../x" });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("returns API failures as tool errors", async () => {
    const { call } = await connect(new Error("Google Health API PERMISSION_DENIED: missing scope"));
    expect(await call("get_settings")).toEqual({
      isError: true,
      text: "Google Health API PERMISSION_DENIED: missing scope",
    });
  });

  it("describes a data type payload with references inlined", async () => {
    const { call } = await connect();
    const schema = JSON.parse((await call("describe_schema", { name: "weight" })).text);
    expect(schema.id).toBe("Weight");
    expect(schema.properties.sampleTime.properties).toHaveProperty("physicalTime");
  });
});
