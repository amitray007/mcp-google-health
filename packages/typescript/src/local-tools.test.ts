import { describe, expect, it } from "vitest";
import { describeSchema, listDataTypes } from "./local-tools.ts";
import { spec } from "./spec.ts";

describe("discovery references", () => {
  it("inlines four references and leaves the fifth as a reference", () => {
    expect(
      describeSchema("A", {
        A: { properties: { value: { $ref: "B" } } },
        B: { next: { $ref: "C" } },
        C: { next: { $ref: "D" } },
        D: { next: { $ref: "E" } },
        E: { next: { $ref: "F" } },
        F: { type: "string" },
      }),
    ).toEqual({ properties: { value: { next: { next: { next: { next: { $ref: "F" } } } } } } });
  });
  it("stops cycles on the current path but expands sibling references", () => {
    expect(
      describeSchema("A", {
        A: { one: { $ref: "B" }, two: { $ref: "B" } },
        B: { parent: { $ref: "A" } },
      }),
    ).toEqual({
      one: { parent: { $ref: "A" } },
      two: { parent: { $ref: "A" } },
    });
  });
  it("retains unknown references, handles arrays and literals, and lets targets override siblings", () => {
    expect(
      describeSchema("A", {
        A: {
          anyOf: [{ $ref: "B", description: "sibling", extra: true }, { $ref: "Unknown" }, null, 0],
        },
        B: { type: "string", description: "target" },
      }),
    ).toEqual({
      anyOf: [{ type: "string", description: "target", extra: true }, { $ref: "Unknown" }, null, 0],
    });
  });
  it("uses the first container field with a reference and converts kebab case", () => {
    expect(
      describeSchema("heart-rate", {
        DataPoint: { properties: { heartRate: { $ref: "First" } } },
        RollupDataPoint: { properties: { heartRate: { $ref: "Second" } } },
        First: { id: "First" },
        Second: { id: "Second" },
      }),
    ).toEqual({ id: "First" });
  });
  it("falls back to the daily container", () => {
    expect(
      describeSchema("daily-type", {
        DailyRollupDataPoint: { properties: { dailyType: { $ref: "Daily" } } },
        Daily: { type: "string" },
      }),
    ).toEqual({ type: "string" });
  });
  it.each(["unknown", "__proto__", "toString"])(
    "rejects missing or inherited schema %s",
    (name) => {
      expect(() => describeSchema(name, {})).toThrow(
        `No schema named ${name}. Use a data type slug or schema name.`,
      );
    },
  );
  it("returns the bundle catalog and revision", () => {
    expect(listDataTypes()).toEqual({
      discoveryRevision: spec.discovery.revision,
      dataTypes: spec.dataTypes,
    });
  });
});
