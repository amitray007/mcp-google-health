import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import type { AuthorizedUser, OAuthClientId } from "./credentials.ts";
import { postToken } from "./oauth.ts";

type SignInOptions = {
  client: OAuthClientId;
  scopes: string[];
  port?: number;
  timeoutMs?: number;
  announce: (url: string) => void;
  fetch?: typeof fetch;
};

export async function signIn(options: SignInOptions): Promise<AuthorizedUser> {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = Promise.withResolvers<string>();
  // A callback can arrive while announce() still runs, before the flow awaits the code.
  void code.promise.catch(() => {});
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      response.writeHead(404).end();
      return;
    }
    const value = url.searchParams.get("code");
    const matches = url.searchParams.get("state") === state;
    if (!matches || !value || url.searchParams.has("error")) {
      response.writeHead(400).end("Sign-in failed. Return to the terminal.");
      code.reject(new Error("The sign-in reply did not match this request."));
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Signed in to Google Health. You can close this tab.");
    code.resolve(value);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
    const address = z.object({ port: z.number() }).parse(server.address());
    const redirectUri = `http://127.0.0.1:${address.port}/`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: options.client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: options.scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    timer = setTimeout(
      () => code.reject(new Error("Sign-in timed out. Run the command again.")),
      options.timeoutMs ?? 600_000,
    );
    options.announce(url.href);
    const token = await postToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: options.client.clientId,
        client_secret: options.client.clientSecret,
        redirect_uri: redirectUri,
        code: await code.promise,
        code_verifier: verifier,
      }),
      options.fetch,
    );
    if (!token.refresh_token)
      throw new Error(
        "Google returned no refresh token. Remove the app's access and sign in again.",
      );
    return {
      type: "authorized_user",
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      refresh_token: token.refresh_token,
    };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): void {
  const opener =
    env["BROWSER"] ||
    (process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open");
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The caller prints the consent URL even when the opener cannot launch.
  }
}
