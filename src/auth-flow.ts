import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import type { AuthorizedUser, OAuthClientId } from "./credentials.ts";

export type SignInOptions = {
  client: OAuthClientId;
  scopes: string[];
  port?: number;
  timeoutMs?: number;
  /** Shows the consent URL to the user. */
  announce: (url: string) => void;
};

/** Runs Google's loopback OAuth flow with PKCE and returns authorized-user credentials. */
export async function signIn(options: SignInOptions): Promise<AuthorizedUser> {
  const state = randomBytes(16).toString("hex");
  const { server, redirectUri, code } = await listenForCode(state, options.port ?? 0);
  try {
    const oauth = new OAuth2Client({
      clientId: options.client.clientId,
      clientSecret: options.client.clientSecret,
      redirectUri,
    });
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: options.scopes,
      state,
      code_challenge: codeChallenge!,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    options.announce(url);
    const authorizationCode = await withTimeout(code, options.timeoutMs ?? 10 * 60_000);
    const { tokens } = await oauth.getToken({
      code: authorizationCode,
      codeVerifier,
      redirect_uri: redirectUri,
    });
    if (!tokens.refresh_token)
      throw new Error(
        "Google returned no refresh token. Remove the app's access and sign in again.",
      );
    return {
      type: "authorized_user",
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      refresh_token: tokens.refresh_token,
    };
  } finally {
    server.close();
  }
}

/** Opens the URL with $BROWSER or the platform opener; the caller still prints it. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): void {
  const opener =
    env["BROWSER"] ||
    (process.platform === "darwin" ? "open" : process.platform === "win32" ? "" : "xdg-open");
  if (!opener) return;
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL still works.
  }
}

async function listenForCode(
  state: string,
  port: number,
): Promise<{ server: Server; redirectUri: string; code: Promise<string> }> {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const value = url.searchParams.get("code");
    const ok = !error && value && url.searchParams.get("state") === state;
    response
      .writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" })
      .end(
        ok
          ? "Signed in to Google Health. You can close this tab."
          : "Sign-in failed. Return to the terminal.",
      );
    if (ok) resolve(value);
    else
      reject(
        new Error(
          error
            ? `Google sign-in failed: ${error}.`
            : "The sign-in reply did not match this request.",
        ),
      );
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", res);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The sign-in listener has no port.");
  return { server, redirectUri: `http://127.0.0.1:${address.port}/`, code };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Sign-in timed out. Run the command again.")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
