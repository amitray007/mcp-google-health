import { z } from "zod";
import { spec, type Expression, type RequestSpec, type Spec } from "./spec.ts";

export type ApiRequest = { method: RequestSpec["method"]; url: URL; body?: unknown };
const formatSchema = z.object({ arg: z.string(), format: z.string().optional() });

function valueOf(expression: Expression | undefined, args: Record<string, unknown>): unknown {
  if (typeof expression !== "object") return expression;
  if (Object.hasOwn(expression, "arg")) {
    const { arg, format } = formatSchema.parse(expression);
    const value = Object.hasOwn(args, arg) ? args[arg] : undefined;
    if (value === undefined) return undefined;
    switch (format) {
      case "sourceFamily":
        return `users/me/dataSourceFamilies/${z.string().parse(value)}`;
      case "civilDateTime": {
        const [year, month, day] = z.string().parse(value).split("-").map(Number);
        return { date: { year, month, day } };
      }
      case "dataPointNames":
        return z
          .array(z.string())
          .parse(value)
          .map((id) => `users/me/dataTypes/${z.string().parse(args["dataType"])}/dataPoints/${id}`);
      default:
        return value;
    }
  }
  return Object.fromEntries(
    Object.entries(expression)
      .map(([key, child]) => [key, valueOf(child, args)])
      .filter(([, value]) => value !== undefined),
  );
}

export function buildRequest(
  request: RequestSpec,
  args: Record<string, unknown>,
  baseUrl = process.env["GOOGLE_HEALTH_API_BASE_URL"] || "https://health.googleapis.com",
  catalog: Spec["dataTypes"] = spec.dataTypes,
): ApiRequest {
  const version = request.versioned
    ? z
        .enum(["v4", "v4beta"])
        .parse(
          args["apiVersion"] ??
            (catalog.some((type) => type.slug === args["dataType"] && type.beta) ? "v4beta" : "v4"),
        )
    : "v4";
  const path = request.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(z.string().parse(args[name])),
  );
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${version}/${path}`);
  for (const [key, expression] of Object.entries(request.query ?? {})) {
    const value = valueOf(expression, args);
    if (value !== undefined)
      url.searchParams.set(
        key,
        String(z.union([z.string(), z.number(), z.boolean()]).parse(value)),
      );
  }
  const body = request.body === undefined ? undefined : valueOf(request.body, args);
  return { method: request.method, url, ...(body === undefined ? {} : { body }) };
}
