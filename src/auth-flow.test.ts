import { describe, expect, it } from "vitest";
import { signIn } from "./auth-flow.ts";

describe("signIn", () => {
  it("requests offline access with PKCE and rejects a reply with the wrong state", async () => {
    let consent = "";
    const pending = signIn({
      client: { clientId: "id.apps.googleusercontent.com", clientSecret: "secret" },
      scopes: ["https://www.googleapis.com/auth/googlehealth.sleep.readonly"],
      timeoutMs: 5000,
      announce: (url) => {
        consent = url;
      },
    });
    const outcome = pending.catch((error: unknown) => error);
    await expect.poll(() => consent).not.toBe("");
    const url = new URL(consent);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("googlehealth.sleep.readonly");
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    expect(redirect.hostname).toBe("127.0.0.1");
    const reply = await fetch(`${redirect.origin}/?code=abc&state=wrong`);
    expect(reply.status).toBe(400);
    expect(await outcome).toHaveProperty(
      "message",
      "The sign-in reply did not match this request.",
    );
  });
});
