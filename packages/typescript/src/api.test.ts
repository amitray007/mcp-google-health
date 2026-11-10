import { describe, expect, it, vi } from "vitest";
import { createHealthApi } from "./api.ts";

const request = {
  method: "GET",
  url: new URL("https://example.test/v4/users/me/profile"),
} as const;
describe("API transport", () => {
  it("sets bearer authorization and sends JSON only when there is a body", async () => {
    const fake = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const api = createHealthApi(async () => "access-secret", fake);
    expect(await api(request)).toEqual({ ok: true });
    expect(fake.mock.calls[0]?.[0]).toEqual(request.url);
    const init = fake.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-secret");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
    expect(init).not.toHaveProperty("body");
    await api({ ...request, method: "POST", body: { enabled: false } });
    expect(fake.mock.calls[1]?.[1]?.body).toBe('{"enabled":false}');
    expect(new Headers(fake.mock.calls[1]?.[1]?.headers).get("content-type")).toBe(
      "application/json",
    );
  });
  it("returns empty successful responses as empty objects", async () => {
    expect(
      await createHealthApi(
        async () => "access",
        async () => new Response(null, { status: 204 }),
      )(request),
    ).toEqual({});
  });
  it.each([
    [
      () =>
        Response.json({ error: { status: "DENIED", message: "Missing scope." } }, { status: 403 }),
      "Google Health API DENIED: Missing scope.",
    ],
    [
      () => Response.json({ error: { message: "Not found." } }, { status: 404 }),
      "Google Health API 404: Not found.",
    ],
    [
      () => Response.json({ error: { status: "DENIED" } }, { status: 403 }),
      "Google Health API returned HTTP 403.",
    ],
    [
      () => new Response("<html>secret</html>", { status: 502 }),
      "Google Health API returned HTTP 502.",
    ],
    [() => new Response(null, { status: 503 }), "Google Health API returned HTTP 503."],
    [() => Response.json(null, { status: 500 }), "Google Health API returned HTTP 500."],
    [
      () => new Response("bad JSON access-secret"),
      "Google Health API returned an invalid JSON response.",
    ],
    [
      () => {
        throw new Error("Authorization: Bearer access-secret");
      },
      "Google Health API request failed.",
    ],
    [
      () => Response.json({ error: { message: "token access-secret" } }, { status: 401 }),
      "Google Health API 401: token [redacted]",
    ],
  ])("formats and sanitizes failures %#", async (respond, expected) => {
    await expect(
      createHealthApi(
        async () => "access-secret",
        async () => respond(),
      )(request),
    ).rejects.toThrow(expected);
  });
  it("sanitizes failures while reading the response body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("access-secret"));
      },
    });
    await expect(
      createHealthApi(
        async () => "access-secret",
        async () => new Response(stream),
      )(request),
    ).rejects.toThrow("Google Health API request failed.");
  });
  it("does not call the API after token-provider failure", async () => {
    const fake = vi.fn<typeof fetch>();
    const api = createHealthApi(async () => {
      throw new Error("Google sign-in failed. Run the auth command again.");
    }, fake);
    await expect(api(request)).rejects.toThrow(
      "Google sign-in failed. Run the auth command again.",
    );
    expect(fake).not.toHaveBeenCalled();
  });
});
