import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createTokenProvider,
  credentialsPath,
  loadClientSecrets,
  loadCredentials,
  saveCredentials,
} from "./credentials.ts";

const credentials = {
  type: "authorized_user",
  client_id: "client-id",
  client_secret: "client-secret",
  refresh_token: "refresh-secret",
} as const;
let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(homedir(), ".google-health-test-"));
  path = join(directory, "credentials.json");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("credentials files", () => {
  it("resolves path precedence, including unset and empty values", () => {
    expect(
      credentialsPath({
        GOOGLE_HEALTH_CREDENTIALS: "health",
        GOOGLE_APPLICATION_CREDENTIALS: "google",
      }),
    ).toBe("health");
    expect(credentialsPath({ GOOGLE_APPLICATION_CREDENTIALS: "google" })).toBe("google");
    expect(
      credentialsPath({ GOOGLE_HEALTH_CREDENTIALS: "", GOOGLE_APPLICATION_CREDENTIALS: "google" }),
    ).toBe("google");
    expect(credentialsPath({})).toBe(join(homedir(), ".config/mcp-google-health/credentials.json"));
    vi.stubEnv("GOOGLE_HEALTH_CREDENTIALS", "process-path");
    expect(credentialsPath()).toBe("process-path");
  });
  it("reports missing and unreadable paths without exposing file errors", async () => {
    for (const missing of [path, directory])
      await expect(loadCredentials(missing)).rejects.toThrow(
        `No Google Health credentials at ${missing}. Run "mcp-google-health auth" first.`,
      );
  });
  it.each([
    "not-json-client-secret",
    "null",
    "[]",
    "{}",
    '{"type":"service_account","private_key":"client-secret"}',
    JSON.stringify({ ...credentials, refresh_token: "" }),
    JSON.stringify({ ...credentials, client_secret: 123 }),
  ])("rejects malformed credentials %s", async (text) => {
    await writeFile(path, text);
    await expect(loadCredentials(path)).rejects.toThrow(
      `${path} is not a Google authorized_user credentials file.`,
    );
  });
  it("accepts authorized_user files and strips extra fields", async () => {
    await writeFile(path, JSON.stringify({ ...credentials, extra: "ignored" }));
    expect(await loadCredentials(path)).toEqual(credentials);
  });
  it("saves and overwrites a 0600 file in a 0700 directory", async () => {
    const nested = join(directory, "oauth", "credentials.json");
    await saveCredentials(nested, credentials);
    expect((await stat(join(directory, "oauth"))).mode & 0o777).toBe(0o700);
    expect((await stat(nested)).mode & 0o777).toBe(0o600);
    await chmod(join(directory, "oauth"), 0o755);
    await chmod(nested, 0o644);
    await saveCredentials(nested, { ...credentials, refresh_token: "replacement" });
    expect((await stat(join(directory, "oauth"))).mode & 0o777).toBe(0o700);
    expect((await stat(nested)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(nested, "utf8"))).toEqual({
      ...credentials,
      refresh_token: "replacement",
    });
  });
  it.each(["installed", "web"])("reads %s client secrets", async (kind) => {
    await writeFile(path, JSON.stringify({ [kind]: credentials }));
    expect(await loadClientSecrets(path)).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
    });
  });
  it.each(["client-secret malformed", '{"installed":{"client_secret":"client-secret"}}'])(
    "sanitizes invalid client secrets %s",
    async (text) => {
      await writeFile(path, text);
      await expect(loadClientSecrets(path)).rejects.toThrow(
        `${path} is not a Google OAuth client secrets file.`,
      );
    },
  );
  it("sanitizes missing client secrets", async () => {
    await expect(loadClientSecrets(path)).rejects.toThrow(
      `${path} is not a Google OAuth client secrets file.`,
    );
  });
});

describe("refresh tokens", () => {
  beforeEach(async () => {
    await writeFile(path, JSON.stringify(credentials));
  });
  it("loads lazily, sends a form to the configured endpoint, shares concurrent refresh, and expires at 60 seconds", async () => {
    vi.stubEnv("GOOGLE_HEALTH_TOKEN_URL", "http://127.0.0.1:5678/token");
    let now = 1_000_000;
    let issued = 0;
    const fake = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe("http://127.0.0.1:5678/token");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(Object.fromEntries(new URLSearchParams(z.string().parse(init?.body)))).toMatchObject({
        grant_type: "refresh_token",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-secret",
      });
      return Response.json({ access_token: `access-${++issued}`, expires_in: 3600 });
    });
    const provider = createTokenProvider({ path, fetch: fake, now: () => now });
    expect(fake).not.toHaveBeenCalled();
    expect(await Promise.all([provider(), provider()])).toEqual(["access-1", "access-1"]);
    now += 3_539_999;
    expect(await provider()).toBe("access-1");
    expect(fake).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await provider()).toBe("access-2");
    expect(fake).toHaveBeenCalledTimes(2);
  });
  it("uses the default token endpoint, dynamic credentials path, and wall clock", async () => {
    vi.stubEnv("GOOGLE_HEALTH_CREDENTIALS", path);
    const fake = vi.fn<typeof fetch>(async (input) => {
      expect(input).toBe("https://oauth2.googleapis.com/token");
      return Response.json({ access_token: "access", expires_in: 3600 });
    });
    const provider = createTokenProvider({ fetch: fake });
    expect(await provider()).toBe("access");
    expect(await provider()).toBe("access");
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("retries a failed credential load on the next call", async () => {
    await rm(path);
    const fake = vi.fn<typeof fetch>(async () => Response.json({ access_token: "access" }));
    const provider = createTokenProvider({ path, fetch: fake });
    await expect(provider()).rejects.toThrow("No Google Health credentials");
    expect(fake).not.toHaveBeenCalled();
    await writeFile(path, JSON.stringify(credentials));
    expect(await provider()).toBe("access");
  });
  it("retries rejected refreshes and never caches tokens without expiry", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }))
      .mockImplementation(async () => Response.json({ access_token: "access" }));
    const provider = createTokenProvider({ path, fetch: fake });
    await expect(provider()).rejects.toThrow(
      "Google sign-in failed: invalid_grant. Run the auth command again.",
    );
    expect(await provider()).toBe("access");
    expect(await provider()).toBe("access");
    expect(fake).toHaveBeenCalledTimes(3);
  });
  it.each([
    [
      () => Response.json({ error: "invalid_client" }, { status: 401 }),
      "Google sign-in failed: invalid_client. Run the auth command again.",
    ],
    [
      () => Response.json({ message: "client-secret refresh-secret" }, { status: 500 }),
      "Google sign-in failed. Run the auth command again.",
    ],
    [
      () => new Response("client-secret", { status: 500 }),
      "Google sign-in failed. Run the auth command again.",
    ],
    [
      () => {
        throw new Error("client-secret Authorization: Bearer refresh-secret");
      },
      "Google sign-in failed. Run the auth command again.",
    ],
    [
      () => Response.json({ access_token: 12 }),
      "Google sign-in failed. Run the auth command again.",
    ],
    [() => Response.json({}), "Google sign-in failed. Run the auth command again."],
    [
      () => Response.json({ error: "client-secret refresh-secret" }, { status: 400 }),
      "Google sign-in failed: [redacted] [redacted]. Run the auth command again.",
    ],
  ])("uses a safe refresh failure message %#", async (respond, expected) => {
    const provider = createTokenProvider({ path, fetch: async () => respond() });
    await expect(provider()).rejects.toThrow(expected);
  });
});
