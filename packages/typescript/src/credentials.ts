import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { postToken } from "./oauth.ts";

const authorizedUserSchema = z.object({
  type: z.literal("authorized_user"),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
});
export type AuthorizedUser = z.infer<typeof authorizedUserSchema>;
const clientSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) });
const clientSecretsSchema = z.union([
  z.object({ installed: clientSchema }),
  z.object({ web: clientSchema }),
]);
export type OAuthClientId = { clientId: string; clientSecret: string };

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["GOOGLE_HEALTH_CREDENTIALS"] ||
    env["GOOGLE_APPLICATION_CREDENTIALS"] ||
    join(homedir(), ".config", "mcp-google-health", "credentials.json")
  );
}

export async function loadCredentials(path: string): Promise<AuthorizedUser> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`No Google Health credentials at ${path}. Run "mcp-google-health auth" first.`);
  }
  try {
    return authorizedUserSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(`${path} is not a Google authorized_user credentials file.`);
  }
}

export function createTokenProvider(
  options: {
    path?: string;
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
): () => Promise<string> {
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  const now = options.now ?? Date.now;
  async function refresh(): Promise<string> {
    const credentials = await loadCredentials(options.path ?? credentialsPath());
    const issuedAt = now();
    const token = await postToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
      }),
      options.fetch,
    );
    if (!token.access_token) throw new Error("Google sign-in failed. Run the auth command again.");
    cached = { token: token.access_token, expires: issuedAt + (token.expires_in ?? 0) * 1000 };
    return cached.token;
  }
  return async () => {
    if (cached && now() < cached.expires - 60_000) return cached.token;
    pending ??= refresh().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

export async function saveCredentials(path: string, credentials: AuthorizedUser): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadClientSecrets(path: string): Promise<OAuthClientId> {
  try {
    const parsed = clientSecretsSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const client = "installed" in parsed ? parsed.installed : parsed.web;
    return { clientId: client.client_id, clientSecret: client.client_secret };
  } catch {
    throw new Error(`${path} is not a Google OAuth client secrets file.`);
  }
}
