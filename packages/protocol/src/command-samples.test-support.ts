import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hostApi, type HostApiCommand } from "./host-api.js";
import type { CommandType } from "./command-table.js";

type Schema = Record<string, unknown>;

/** The variants of the command union, by type. */
function variants(): Map<string, z.ZodObject[]> {
  const members = new Map<string, z.ZodObject[]>();
  for (const option of (
    hostApi["commands.dispatch"].payload as unknown as z.ZodUnion<z.ZodObject[]>
  ).options) {
    const type = (option.shape.type as z.ZodLiteral<string>).value;
    members.set(type, [...(members.get(type) ?? []), option]);
  }
  return members;
}

const uuid = () => randomUUID();
/** A string for a pattern the Home's id and key schemas use. */
function patterned(pattern: string): string | undefined {
  const id = /^\^([a-z]+)_\[0-9a-f(?:-)?\](?:\{8\}-|\{36\})/u.exec(pattern);
  if (id) return `${id[1]}_${uuid()}`;
  const token = /^\^\[A-Za-z0-9_-\]\{(\d+)(?:,\d+)?\}\$$/u.exec(pattern);
  if (token) return "a".repeat(Number(token[1]));
  if (pattern.includes("\\/[a-z0-9")) return "text/plain";
  if (pattern.startsWith("^https?:")) return "https://example.com";
  if (pattern.includes("[0-9a-f]{64}") || pattern.includes("[a-f0-9]{64}")) return "0".repeat(64);
  if (pattern === "^(0|[1-9][0-9]{0,15})$" || pattern.startsWith("^(0|[1-9]")) return "1";
  return undefined;
}

function sampleOf(schema: Schema, root: Schema): unknown {
  if (typeof schema.$ref === "string") {
    const target = schema.$ref
      .replace(/^#\//u, "")
      .split("/")
      .reduce<unknown>((at, key) => (at as Schema | undefined)?.[key], root) as Schema;
    return sampleOf(target, root);
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  for (const key of ["anyOf", "oneOf"] as const)
    if (Array.isArray(schema[key])) {
      const options = schema[key] as Schema[];
      const concrete = options.find((option) => option.type !== "null") ?? options[0]!;
      return sampleOf(concrete, root);
    }
  if (Array.isArray(schema.allOf)) return sampleOf((schema.allOf as Schema[])[0]!, root);
  switch (schema.type) {
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = new Set((schema.required ?? []) as string[]);
      const value: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(properties))
        if (required.has(key)) value[key] = sampleOf(property, root);
      return value;
    }
    case "array": {
      const count = Math.max(1, Number(schema.minItems ?? 0));
      return Array.from({ length: count }, () => sampleOf((schema.items ?? {}) as Schema, root));
    }
    case "integer":
    case "number":
      return Math.max(1, Number(schema.minimum ?? 1));
    case "boolean":
      return false;
    case "string": {
      if (schema.format === "uuid") return uuid();
      if (schema.format === "uri" || schema.format === "url") return "https://example.com/";
      if (schema.format === "date-time") return new Date().toISOString();
      if (typeof schema.pattern === "string") {
        const made = patterned(schema.pattern);
        if (made !== undefined) return made;
      }
      return "a".repeat(Math.max(1, Number(schema.minLength ?? 1)));
    }
    default:
      return {};
  }
}

/** Small fixes where a schema's refinements need more than its JSON Schema says. */
const overrides: Partial<Record<CommandType, Record<string, unknown>>> = {
  "tab.open": { target: { kind: "page", url: "about:blank", guest: true } },
  "browser.session.start": { input: { fresh: true } },
  "execution.preferences.remember": { accessMode: "approval-required" },
  "viewer.timeZone.update": { timeZone: "UTC" },
  "machine.rename": { machineId: `dev_${randomUUID()}` },
  "machine.revoke": { machineId: `dev_${randomUUID()}` },
  "personal.remoteAccess.request": { intent: { action: "rotate" } },
  "tab.group.update": { name: "Group" },
};

/**
 * A command of each type, built from its JSON Schema with only what is required. `valid` says
 * whether its own schema accepts it; where a schema refines more than its JSON Schema says (an
 * account link's sealed challenge, an app's identity) the sample is the shape without the proof.
 */
export function sampleCommand(type: CommandType): {
  readonly command: HostApiCommand;
  readonly valid: boolean;
} {
  const schema = hostApi["commands.dispatch"].payload;
  let fallback: Record<string, unknown> | undefined;
  for (const member of variants().get(type) ?? []) {
    const json = z.toJSONSchema(member, { unrepresentable: "any", io: "input" }) as Schema;
    const value = {
      ...(sampleOf(json, json) as Record<string, unknown>),
      ...overrides[type],
      type,
    };
    fallback ??= value;
    const parsed = schema.safeParse(value);
    if (parsed.success) return { command: parsed.data, valid: true };
  }
  return { command: (fallback ?? { type }) as unknown as HostApiCommand, valid: false };
}
