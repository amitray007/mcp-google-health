import { z } from "zod";

type ApiVersion = "v4" | "v4beta";

export type ApiRequest = {
  method: "GET" | "POST" | "PATCH";
  /** Path below the version, such as `users/me/profile`. */
  path: string;
  version?: ApiVersion;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export type HealthApi = (request: ApiRequest) => Promise<unknown>;

/** Returns the Authorization header for the next request, refreshing the token when needed. */
export type Authorize = () => Promise<Headers>;

class HealthApiError extends Error {
  override name = "HealthApiError";
}

const baseUrl = "https://health.googleapis.com";

/** Calls the Google Health API with headers from `authorize`. */
export function createHealthApi(authorize: Authorize, fetchImpl: typeof fetch = fetch): HealthApi {
  return async ({ method, path, version = "v4", query = {}, body }) => {
    const url = new URL(`${baseUrl}/${version}/${path}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let headers: Headers;
    try {
      headers = await authorize();
    } catch (error) {
      throw new HealthApiError(describeSignInFailure(error));
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) throw new HealthApiError(describeApiFailure(response.status, data));
    return data;
  };
}

const apiErrorSchema = z.object({
  error: z.object({ status: z.string().optional(), message: z.string() }),
});

function describeApiFailure(status: number, data: unknown): string {
  const parsed = apiErrorSchema.safeParse(data);
  return parsed.success
    ? `Google Health API ${parsed.data.error.status ?? status}: ${parsed.data.error.message}`
    : `Google Health API returned HTTP ${status}.`;
}

const signInErrorSchema = z.object({
  response: z.object({ data: z.object({ error: z.string() }) }),
});

/** Names the OAuth error, such as invalid_grant, without the request that carried the token. */
function describeSignInFailure(error: unknown): string {
  const parsed = signInErrorSchema.safeParse(error);
  return parsed.success
    ? `Google sign-in failed: ${parsed.data.response.data.error}. Run the auth command again.`
    : "Google sign-in failed. Run the auth command again.";
}
