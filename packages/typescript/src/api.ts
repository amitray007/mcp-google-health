import { z } from "zod";
import type { ApiRequest } from "./request.ts";

export type HealthApi = (request: ApiRequest) => Promise<unknown>;
const errorSchema = z.object({
  error: z.object({ status: z.string().optional(), message: z.string() }),
});

export function createHealthApi(
  tokenProvider: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): HealthApi {
  return async ({ method, url, body }) => {
    const token = await tokenProvider();
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch {
      throw new Error("Google Health API request failed.");
    }
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        response.ok
          ? "Google Health API returned an invalid JSON response."
          : `Google Health API returned HTTP ${response.status}.`,
      );
    }
    if (!response.ok) {
      const parsed = errorSchema.safeParse(data);
      const message = parsed.success
        ? `Google Health API ${parsed.data.error.status ?? response.status}: ${parsed.data.error.message}`
        : `Google Health API returned HTTP ${response.status}.`;
      throw new Error(message.replaceAll(token, "[redacted]"));
    }
    return data;
  };
}
