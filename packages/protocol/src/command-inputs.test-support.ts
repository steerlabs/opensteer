import { z } from "zod";
import { hostApi } from "./host-api.js";

type Schema = Record<string, unknown>;

/**
 * Every input path of every command that can decide what the command does: an enum, a boolean, a
 * literal (a discriminator), a URL, or an optional field (what leaving it out does). Read from the
 * command schemas themselves, so a new field cannot slip past the table without a verdict.
 */
export function decidingInputPaths(): readonly string[] {
  const out = new Set<string>();
  const walk = (
    type: string,
    node: unknown,
    path: readonly string[],
    root: Schema,
    optional: boolean,
    seen: ReadonlySet<string>,
  ): void => {
    if (!node || typeof node !== "object") return;
    const schema = node as Schema;
    if (typeof schema.$ref === "string") {
      if (seen.has(schema.$ref)) return;
      const target = schema.$ref
        .replace(/^#\//u, "")
        .split("/")
        .reduce<unknown>((at, key) => (at as Schema | undefined)?.[key], root);
      walk(type, target, path, root, optional, new Set([...seen, schema.$ref]));
      return;
    }
    const key = `${type} ${path.join(".") || "(root)"}`;
    if (
      (optional && path.length > 0) ||
      (schema.const !== undefined && path.at(-1) !== "type") ||
      Array.isArray(schema.enum) ||
      schema.type === "boolean" ||
      schema.format === "uri" ||
      schema.format === "url"
    )
      out.add(key);
    for (const union of ["anyOf", "oneOf", "allOf"] as const)
      if (Array.isArray(schema[union]))
        for (const option of schema[union] as unknown[])
          walk(type, option, path, root, false, seen);
    if (schema.type === "object" && schema.properties) {
      const required = new Set((schema.required ?? []) as string[]);
      for (const [name, property] of Object.entries(schema.properties as Schema))
        walk(type, property, [...path, name], root, !required.has(name), seen);
    }
    if (schema.type === "array" && schema.items)
      walk(type, schema.items, [...path, "[]"], root, false, seen);
  };
  for (const option of (
    hostApi["commands.dispatch"].payload as unknown as z.ZodUnion<z.ZodObject[]>
  ).options) {
    const type = (option.shape.type as z.ZodLiteral<string>).value;
    const json = z.toJSONSchema(option, { unrepresentable: "any", io: "input" }) as Schema;
    walk(type, json, [], json, false, new Set());
  }
  return [...out].sort();
}
