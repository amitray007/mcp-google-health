// Refreshes spec/discovery.json from Google's discovery documents.
// Run: node scripts/update-discovery.ts
import { writeFile } from "node:fs/promises";
import { z } from "zod";

const discoverySchema = z.object({
  revision: z.string(),
  auth: z.object({ oauth2: z.object({ scopes: z.record(z.string(), z.unknown()) }) }),
  schemas: z.record(
    z.string(),
    z.looseObject({ properties: z.record(z.string(), z.unknown()).optional() }),
  ),
});
type Discovery = z.infer<typeof discoverySchema>;

async function fetchDiscovery(version: string): Promise<Discovery> {
  const response = await fetch(`https://health.googleapis.com/$discovery/rest?version=${version}`);
  if (!response.ok) throw new Error(`Discovery ${version} returned ${response.status}.`);
  return discoverySchema.parse(await response.json());
}

const [stable, beta] = await Promise.all([fetchDiscovery("v4"), fetchDiscovery("v4beta")]);
const fields = (doc: Discovery) => Object.keys(doc.schemas["DataPoint"]?.properties ?? {});
const snapshot = {
  revision: beta.revision,
  v4DataPointFields: fields(stable),
  scopes: Object.keys(stable.auth.oauth2.scopes),
  schemas: beta.schemas,
};
await writeFile(
  new URL("../spec/discovery.json", import.meta.url),
  `${JSON.stringify(snapshot, null, 2)}\n`,
);
console.log(`Saved discovery revision ${snapshot.revision}.`);
