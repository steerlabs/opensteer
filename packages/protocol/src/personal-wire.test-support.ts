import { readFileSync } from "node:fs";
import { z } from "zod";

const baseline = JSON.parse(
  readFileSync(new URL("./device-wire-v60.fixture.json", import.meta.url), "utf8"),
) as Record<"input" | "output", Record<string, z.core.JSONSchema.JSONSchema>>;

/** Reconstitutes the frozen v60 reader, including strict objects and ID patterns. */
export function frozenPersonalReader(
  name: string,
  path: readonly (string | number)[] = [],
  surface: "input" | "output" = "output",
) {
  const root = baseline[surface][name];
  if (!root) throw new Error(`No frozen personal wire surface: ${name}`);
  let schema: unknown = root;
  for (const key of path) {
    if (typeof schema !== "object" || schema === null)
      throw new Error(`Invalid frozen reader path: ${name}`);
    schema = Reflect.get(schema, key);
  }
  if (typeof schema !== "object" || schema === null)
    throw new Error(`Missing frozen reader path: ${name}`);
  return z.fromJSONSchema({
    ...(schema as z.core.JSONSchema.JSONSchema),
    ...(root.$defs ? { $defs: root.$defs } : {}),
  });
}
