import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRequest } from "./request.ts";
import type { RequestSpec } from "./spec.ts";

afterEach(() => vi.unstubAllEnvs());
describe("request expressions", () => {
  it("passes literals, false, zero, empty strings, null arguments, and nested data through", () => {
    const result = buildRequest(
      {
        method: "POST",
        path: "users/me/test",
        body: {
          string: "literal",
          number: 1.5,
          boolean: false,
          zero: 0,
          empty: { arg: "empty" },
          data: { arg: "data" },
          nil: { arg: "nil" },
          nested: { missing: { arg: "missing" }, present: true },
          absent: { arg: "missing" },
        },
      },
      { empty: "", data: { a: [false, null] }, nil: null },
    );
    expect(result.body).toEqual({
      string: "literal",
      number: 1.5,
      boolean: false,
      zero: 0,
      empty: "",
      data: { a: [false, null] },
      nil: null,
      nested: { present: true },
    });
  });
  it("formats dates, families and names, pruning absent formatted values", () => {
    const result = buildRequest(
      {
        method: "POST",
        path: "users/me/test",
        body: {
          date: { arg: "date", format: "civilDateTime" },
          family: { arg: "family", format: "sourceFamily" },
          names: { arg: "ids", format: "dataPointNames" },
          missing: { arg: "unknown", format: "sourceFamily" },
        },
      },
      { date: "2026-01-02", family: "self-sources", ids: ["a", "b"], dataType: "weight" },
    );
    expect(result.body).toEqual({
      date: { date: { year: 2026, month: 1, day: 2 } },
      family: "users/me/dataSourceFamilies/self-sources",
      names: ["users/me/dataTypes/weight/dataPoints/a", "users/me/dataTypes/weight/dataPoints/b"],
    });
  });
  it("encodes path segments and query values exactly once", () => {
    const { url } = buildRequest(
      {
        method: "GET",
        path: "users/me/{id}",
        query: {
          text: { arg: "text" },
          no: false,
          yes: true,
          n: 10.5,
          absent: { arg: "missing" },
        },
      },
      { id: "a/b ?#%é", text: "a+b &c" },
    );
    expect(url.pathname).toBe("/v4/users/me/a%2Fb%20%3F%23%25%C3%A9");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      text: "a+b &c",
      no: "false",
      yes: "true",
      n: "10.5",
    });
  });
  it("omits an absent body and ignores inherited arguments", () => {
    expect(
      buildRequest({ method: "POST", path: "users/me/test", body: { arg: "toString" } }, {}),
    ).not.toHaveProperty("body");
  });
  it.each([
    [undefined, "skin-temperature-sensors", "v4beta", "v4"],
    [false, "skin-temperature-sensors", "v4beta", "v4"],
    [true, "skin-temperature-sensors", undefined, "v4beta"],
    [true, "skin-temperature-sensors", "v4", "v4"],
    [true, "steps", "v4beta", "v4beta"],
    [true, "steps", undefined, "v4"],
    [true, "future", undefined, "v4"],
  ])(
    "versioned=%s type=%s override=%s routes to %s",
    (versioned, dataType, apiVersion, expected) => {
      const request: RequestSpec = {
        method: "GET",
        path: "users/me/test",
        ...(versioned === undefined ? {} : { versioned }),
      };
      expect(buildRequest(request, { dataType, apiVersion }).url.pathname).toBe(
        `/${expected}/users/me/test`,
      );
    },
  );
  it("honors a configured base URL and trims its trailing slash", () => {
    vi.stubEnv("GOOGLE_HEALTH_API_BASE_URL", "http://127.0.0.1:1234/");
    expect(buildRequest({ method: "GET", path: "users/me/test" }, {}).url.href).toBe(
      "http://127.0.0.1:1234/v4/users/me/test",
    );
  });
});
