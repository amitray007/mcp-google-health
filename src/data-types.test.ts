import { describe, expect, it } from "vitest";
import discovery from "./discovery.json" with { type: "json" };
import { dataPointField, dataTypes } from "./data-types.ts";

const notDataTypes = new Set([
  "name",
  "dataSource",
  "startTime",
  "endTime",
  "civilStartTime",
  "civilEndTime",
]);
const containers = ["DataPoint", "RollupDataPoint", "DailyRollupDataPoint"] as const;

describe("data type catalog", () => {
  it("covers every data type in the discovery snapshot", () => {
    const fields = new Set(
      containers.flatMap((name) => Object.keys(discovery.schemas[name].properties)),
    );
    const expected = [...fields].filter((field) => !notDataTypes.has(field)).toSorted();
    expect(dataTypes.map((type) => dataPointField(type.slug)).toSorted()).toEqual(expected);
  });

  it("marks exactly the data point types missing from v4 as beta", () => {
    const beta = new Set(Object.keys(discovery.schemas.DataPoint.properties));
    for (const field of discovery.v4DataPointFields) beta.delete(field);
    expect(dataTypes.filter((type) => type.beta).map((type) => dataPointField(type.slug))).toEqual([
      ...beta,
    ]);
  });
});
