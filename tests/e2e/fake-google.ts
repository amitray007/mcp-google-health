import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Reply = { status: number; body?: unknown; text?: string };
type RecordedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  authorization: string | undefined;
};
type Client = { client_id: string; client_secret: string; refresh_token: string };

export type FakeGoogle = {
  url: string;
  apiRequests: RecordedRequest[];
  tokenRequests: number;
  /** Sets the next API and token replies and clears the recorded API requests. */
  reset(api: Reply, token?: Reply): void;
  close(): Promise<void>;
};

const grantedToken: Reply = {
  status: 200,
  body: { access_token: "access-1", expires_in: 3600, token_type: "Bearer" },
};

/** A local stand-in for health.googleapis.com and Google's OAuth token endpoint. */
export async function startFakeGoogle(client: Client): Promise<FakeGoogle> {
  let apiReply: Reply = { status: 200, body: {} };
  let tokenReply: Reply = grantedToken;
  const fake = {
    url: "",
    apiRequests: [] as RecordedRequest[],
    tokenRequests: 0,
    reset(api: Reply, token: Reply = grantedToken) {
      apiReply = api;
      tokenReply = token;
      fake.apiRequests = [];
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, { status: 500, text: String(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const text = await readBody(request);
    if (url.pathname === "/token") {
      fake.tokenRequests++;
      const form = new URLSearchParams(text);
      const valid =
        request.method === "POST" &&
        form.get("grant_type") === "refresh_token" &&
        form.get("refresh_token") === client.refresh_token &&
        form.get("client_id") === client.client_id &&
        form.get("client_secret") === client.client_secret;
      send(response, valid ? tokenReply : { status: 400, body: { error: "invalid_request" } });
      return;
    }
    fake.apiRequests.push({
      method: request.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ...(text ? { body: JSON.parse(text) as unknown } : {}),
      authorization: request.headers.authorization,
    });
    send(response, apiReply);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, reply: Reply): void {
  const json = reply.text === undefined;
  response
    .writeHead(reply.status, { "content-type": json ? "application/json" : "text/html" })
    .end(json ? JSON.stringify(reply.body ?? {}) : reply.text);
}
