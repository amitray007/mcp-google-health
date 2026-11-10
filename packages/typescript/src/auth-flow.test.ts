import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openBrowser, signIn } from "./auth-flow.ts";
import { saveCredentials } from "./credentials.ts";

vi.mock("node:child_process", () => ({
  spawn: vi.fn<() => { on: (event: string, handler: () => void) => void; unref: () => void }>(
    () => ({
      on: vi.fn<(event: string, handler: () => void) => void>((_event, handler) => handler()),
      unref: vi.fn<() => void>(),
    }),
  ),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const client = { clientId: "client-id", clientSecret: "client-secret" };
const scopes = [
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
];
function callback(consent: string, parameters: Record<string, string>): URL {
  const url = new URL(consent);
  const redirect = new URL(z.string().parse(url.searchParams.get("redirect_uri")));
  redirect.search = new URLSearchParams(parameters).toString();
  return redirect;
}

describe("loopback OAuth", () => {
  it("uses S256 PKCE, loopback redirect, offline consent and requested scopes, then exchanges and saves private credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "health-auth-test-"));
    let received = new URLSearchParams();
    const tokenServer = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        received = new URLSearchParams(body);
        expect(request.method).toBe("POST");
        expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ refresh_token: "new-refresh-secret" }));
      });
    });
    try {
      await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
      const address = z.object({ port: z.number() }).parse(tokenServer.address());
      vi.stubEnv("GOOGLE_HEALTH_TOKEN_URL", `http://127.0.0.1:${address.port}/token`);
      const announced = Promise.withResolvers<string>();
      const flow = signIn({ client, scopes, announce: announced.resolve });
      const consent = new URL(await announced.promise);
      expect(consent.origin + consent.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      expect(consent.searchParams.get("response_type")).toBe("code");
      expect(consent.searchParams.get("client_id")).toBe("client-id");
      expect(consent.searchParams.get("access_type")).toBe("offline");
      expect(consent.searchParams.get("prompt")).toBe("consent");
      expect(consent.searchParams.get("scope")).toBe(scopes.join(" "));
      expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
      const redirect = new URL(z.string().parse(consent.searchParams.get("redirect_uri")));
      expect(redirect.hostname).toBe("127.0.0.1");
      expect(redirect.protocol).toBe("http:");
      expect(redirect.pathname).toBe("/");
      const wrongPath = new URL("/favicon.ico", redirect);
      expect((await fetch(wrongPath)).status).toBe(404);
      const state = z.string().parse(consent.searchParams.get("state"));
      expect(state.length).toBeGreaterThanOrEqual(32);
      const reply = await fetch(callback(consent.href, { code: "authorization-code", state }));
      expect(reply.status).toBe(200);
      const credentials = await flow;
      expect(Object.fromEntries(received)).toMatchObject({
        grant_type: "authorization_code",
        client_id: "client-id",
        client_secret: "client-secret",
        code: "authorization-code",
        redirect_uri: redirect.href,
      });
      const verifier = z.string().parse(received.get("code_verifier"));
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(consent.searchParams.get("code_challenge")).toBe(
        createHash("sha256").update(verifier).digest("base64url"),
      );
      expect(credentials).toEqual({
        type: "authorized_user",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "new-refresh-secret",
      });
      const path = join(directory, "private", "credentials.json");
      await saveCredentials(path, credentials);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(credentials);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
    } finally {
      tokenServer.close();
      tokenServer.closeAllConnections();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["wrong state", "missing code", "oauth error"])(
    "rejects %s without calling the token endpoint",
    async (kind) => {
      const announced = Promise.withResolvers<string>();
      const fake = vi.fn<typeof fetch>();
      const flow = signIn({ client, scopes, announce: announced.resolve, fetch: fake });
      const outcome = flow.catch((error: unknown) => error);
      const consent = await announced.promise;
      const state = z.string().parse(new URL(consent).searchParams.get("state"));
      const parameters =
        kind === "wrong state"
          ? { code: "code", state: "wrong" }
          : kind === "missing code"
            ? { state }
            : { state, error: "access_denied client-secret" };
      const reply = await fetch(callback(consent, parameters));
      expect(reply.status).toBe(400);
      expect(await outcome).toEqual(new Error("The sign-in reply did not match this request."));
      expect(fake).not.toHaveBeenCalled();
    },
  );
  it("times out and closes its listener", async () => {
    const announced = Promise.withResolvers<string>();
    const flow = signIn({ client, scopes, announce: announced.resolve, timeoutMs: 20 });
    const outcome = flow.catch((error: unknown) => error);
    const consent = await announced.promise;
    expect(await outcome).toEqual(new Error("Sign-in timed out. Run the command again."));
    await expect(fetch(callback(consent, {}))).rejects.toThrow("fetch failed");
  });
  it.each([
    [
      () => Response.json({ access_token: "only-access" }),
      "Google returned no refresh token. Remove the app's access and sign in again.",
    ],
    [
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      "Google sign-in failed: invalid_grant. Run the auth command again.",
    ],
    [
      () => {
        throw new Error("client-secret authorization-code");
      },
      "Google sign-in failed. Run the auth command again.",
    ],
    [
      () => Response.json({ error: "client-secret authorization-code" }, { status: 400 }),
      "Google sign-in failed: [redacted] [redacted]. Run the auth command again.",
    ],
  ])("sanitizes exchange failure %#", async (respond, expected) => {
    const announced = Promise.withResolvers<string>();
    const flow = signIn({
      client,
      scopes,
      announce: announced.resolve,
      fetch: async () => respond(),
    });
    const outcome = flow.catch((error: unknown) => error);
    const consent = await announced.promise;
    await fetch(
      callback(consent, {
        state: z.string().parse(new URL(consent).searchParams.get("state")),
        code: "authorization-code",
      }),
    );
    expect(await outcome).toEqual(new Error(expected));
  });
  it("reports a busy loopback port", async () => {
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = z.object({ port: z.number() }).parse(busy.address());
      await expect(signIn({ client, scopes, port, announce: () => {} })).rejects.toThrow(
        "EADDRINUSE",
      );
    } finally {
      busy.close();
    }
  });
  it("opens BROWSER as an executable with one URL argument, and handles an unavailable opener", () => {
    openBrowser("https://example.test/?x=$secret", { BROWSER: "/path/to/browser" });
    expect(spawn).toHaveBeenCalledWith("/path/to/browser", ["https://example.test/?x=$secret"], {
      stdio: "ignore",
      detached: true,
    });
  });
  it.each(["darwin", "linux", "win32"])("selects the %s platform opener", (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    openBrowser("https://example.test/", {});
    expect(spawn).toHaveBeenCalledWith(
      platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open",
      ["https://example.test/"],
      expect.any(Object),
    );
  });
  it("keeps the printed URL usable when the opener throws", () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("Cannot spawn");
    });
    expect(() => openBrowser("https://example.test/", {})).not.toThrow();
  });
  it("uses BROWSER from the process environment", () => {
    vi.stubEnv("BROWSER", "browser-command");
    openBrowser("https://example.test/");
    expect(spawn).toHaveBeenCalledWith(
      "browser-command",
      ["https://example.test/"],
      expect.any(Object),
    );
  });
});
