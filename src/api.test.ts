import { describe, expect, it } from "vitest";
import { createHealthApi } from "./api.ts";

const authorized = async () => new Headers({ authorization: "Bearer test-token" });

function respond(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return async (input, init) => {
    seen.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status });
  };
}

describe("createHealthApi", () => {
  it("drops undefined query values and sends JSON bodies with auth", async () => {
    const seen: Request[] = [];
    const api = createHealthApi(authorized, respond(200, { ok: true }, seen));
    const result = await api({
      method: "POST",
      path: "users/me/dataTypes/steps/dataPoints:rollUp",
      query: { a: 1, b: undefined },
      body: { windowSize: "3600s" },
    });
    expect(result).toEqual({ ok: true });
    expect(seen[0]?.url).toBe(
      "https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints:rollUp?a=1",
    );
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer test-token");
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(await seen[0]?.json()).toEqual({ windowSize: "3600s" });
  });

  it("reports Google's status and message", async () => {
    const api = createHealthApi(
      authorized,
      respond(403, { error: { status: "PERMISSION_DENIED", message: "Missing scope." } }),
    );
    await expect(api({ method: "GET", path: "users/me/settings" })).rejects.toThrow(
      "Google Health API PERMISSION_DENIED: Missing scope.",
    );
  });

  it("asks for a new sign-in when the refresh token is rejected", async () => {
    const api = createHealthApi(
      async () => {
        throw Object.assign(new Error("Bearer ya29.secret"), {
          response: { status: 400, data: { error: "invalid_grant" } },
        });
      },
      respond(200, {}),
    );
    const failure = api({ method: "GET", path: "users/me/settings" });
    await expect(failure).rejects.toThrow(
      "Google sign-in failed: invalid_grant. Run the auth command again.",
    );
    await expect(failure).rejects.not.toThrow("ya29");
  });
});
