import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UserRefreshClient } from "google-auth-library";
import { z } from "zod";

const authorizedUserSchema = z.object({
  type: z.literal("authorized_user"),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
});

export type AuthorizedUser = z.infer<typeof authorizedUserSchema>;

const clientSecretsSchema = z
  .object({
    installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }),
  })
  .or(
    z.object({
      web: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }),
    }),
  );

export type OAuthClientId = { clientId: string; clientSecret: string };

/** Where the server reads, and `auth` writes, the Google authorized-user credentials. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["GOOGLE_HEALTH_CREDENTIALS"] ||
    env["GOOGLE_APPLICATION_CREDENTIALS"] ||
    join(homedir(), ".config", "googlehealth-mcp", "credentials.json")
  );
}

export async function loadCredentials(path: string): Promise<AuthorizedUser> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`No Google Health credentials at ${path}. Run "googlehealth-mcp auth" first.`);
  }
  const parsed = authorizedUserSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is not a Google authorized_user credentials file.`);
  return parsed.data;
}

export function clientFor(credentials: AuthorizedUser): UserRefreshClient {
  return new UserRefreshClient({
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    refreshToken: credentials.refresh_token,
  });
}

export async function saveCredentials(path: string, credentials: AuthorizedUser): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Reads a client secrets file downloaded from Google Cloud (Desktop or Web client). */
export async function loadClientSecrets(path: string): Promise<OAuthClientId> {
  const parsed = clientSecretsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const client = "installed" in parsed ? parsed.installed : parsed.web;
  return { clientId: client.client_id, clientSecret: client.client_secret };
}
