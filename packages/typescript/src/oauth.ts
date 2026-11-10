import { z } from "zod";

const failure = "Google sign-in failed. Run the auth command again.";
const errorSchema = z.object({ error: z.string() });
const tokenSchema = z.object({
  // A token must be safe in an HTTP header; anything else is a failed sign-in, not a header error.
  access_token: z
    .string()
    .regex(/^[\x21-\x7E]+$/)
    .optional(),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
});

export async function postToken(form: URLSearchParams, fetchImpl: typeof fetch = fetch) {
  let response: Response;
  let data: unknown;
  try {
    response = await fetchImpl(
      process.env["GOOGLE_HEALTH_TOKEN_URL"] || "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    );
    data = await response.json();
  } catch {
    throw new Error(failure);
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(data);
    let message = parsed.success
      ? `Google sign-in failed: ${parsed.data.error}. Run the auth command again.`
      : failure;
    for (const key of ["client_secret", "refresh_token", "code", "code_verifier"]) {
      const secret = form.get(key);
      if (secret) message = message.replaceAll(secret, "[redacted]");
    }
    throw new Error(message);
  }
  const parsed = tokenSchema.safeParse(data);
  if (!parsed.success) throw new Error(failure);
  return parsed.data;
}
