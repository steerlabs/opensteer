import { z } from "zod";

export type JsonSchema = { readonly [key: string]: unknown };
export type Direction = "input" | "output";
/**
 * `input`: requests a Host parses strictly, so only an older sender matters.
 * `output`: what a Host sends, read by peers older than it. `frames`: read in
 * both directions by readers that skip frame types they do not know.
 */
export type Surface = "input" | "output" | "frames";
export type Wire = Readonly<Record<Surface, Readonly<Record<string, JsonSchema>>>>;

export function json(schema: z.core.$ZodType): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  return rest;
}

const record = (value: unknown): JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonSchema) : {};
export const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Names a union member by its literal discriminator, or by its JSON type. */
function memberKey(member: JsonSchema): string {
  const literals = Object.entries(record(member.properties))
    .filter(([, value]) => "const" in record(value))
    .map(([name, value]) => `${name}=${String(record(value).const)}`);
  return literals.length ? literals.join(",") : String(member.type ?? JSON.stringify(member));
}

/**
 * Where a newer reader stops accepting what an older peer sends (`input`) or
 * a newer writer starts sending what an older reader rejects (`output`). New
 * fields must be optional either way; an output may only gain them where its
 * readers ignore unknown fields, and only an input may gain union members or
 * enum values, except the frame types readers skip.
 */
export function breakingChanges(
  before: unknown,
  after: unknown,
  direction: Direction,
  path = "",
  skipsUnknownMembers = false,
): string[] {
  if (same(before, after)) return [];
  const old = record(before),
    next = record(after);
  if (
    direction === "input" &&
    Array.isArray(next.anyOf) &&
    Object.keys(next).every((key) => ["anyOf", "description", "title", "default"].includes(key)) &&
    next.anyOf.some((member) => breakingChanges(old, member, direction).length === 0)
  )
    return [];
  const breaks: string[] = [];
  const keys = new Set([...Object.keys(old), ...Object.keys(next)]);
  for (const key of keys) {
    const at = `${path}/${key}`;
    if (["description", "title", "default"].includes(key) || same(old[key], next[key])) continue;
    if (key === "properties") {
      const oldProperties = record(old.properties),
        nextProperties = record(next.properties);
      const required = new Set((next.required as string[] | undefined) ?? []);
      for (const name of Object.keys(oldProperties)) {
        if (!(name in nextProperties)) breaks.push(`${at}/${name} was removed`);
        else
          breaks.push(
            ...breakingChanges(
              oldProperties[name],
              nextProperties[name],
              direction,
              `${at}/${name}`,
            ),
          );
      }
      for (const name of Object.keys(nextProperties)) {
        if (name in oldProperties) continue;
        if (required.has(name)) breaks.push(`${at}/${name} was added as required`);
        else if (direction === "output" && old.additionalProperties === false)
          breaks.push(`${at}/${name} was added where readers refuse unknown fields`);
      }
    } else if (key === "required") {
      const oldRequired = new Set((old.required as string[] | undefined) ?? []);
      const nextRequired = new Set((next.required as string[] | undefined) ?? []);
      const narrowed =
        direction === "input"
          ? [...nextRequired].filter(
              (name) => !oldRequired.has(name) && name in record(old.properties),
            )
          : [...oldRequired].filter((name) => !nextRequired.has(name));
      for (const name of narrowed)
        breaks.push(
          `${path}/properties/${name} became ${direction === "input" ? "required" : "optional"}`,
        );
    } else if (key === "anyOf" || key === "oneOf") {
      const members = (value: unknown) =>
        new Map(
          (Array.isArray(value) ? value : []).map((member) => [
            memberKey(record(member)),
            member as unknown,
          ]),
        );
      const oldMembers = members(old[key]),
        nextMembers = members(next[key]);
      for (const [name, member] of oldMembers) {
        if (!nextMembers.has(name)) breaks.push(`${at}[${name}] was removed`);
        else
          breaks.push(
            ...breakingChanges(member, nextMembers.get(name), direction, `${at}[${name}]`),
          );
      }
      if (direction === "output" && !skipsUnknownMembers)
        for (const name of nextMembers.keys())
          if (!oldMembers.has(name)) breaks.push(`${at}[${name}] was added`);
    } else if (key === "enum") {
      const nextValues = (next.enum as unknown[] | undefined) ?? [];
      const oldValues = (old.enum as unknown[] | undefined) ?? [];
      const widened =
        direction === "input" && oldValues.every((value) => nextValues.includes(value));
      if (!widened) breaks.push(`${at} changed`);
    } else if (key === "items" || key === "additionalProperties") {
      if (key === "additionalProperties" && old[key] === false && !(key in next)) continue;
      if (typeof old[key] === "object" && typeof next[key] === "object")
        breaks.push(...breakingChanges(old[key], next[key], direction, at));
      else breaks.push(`${at} changed`);
    } else breaks.push(`${at} changed`);
  }
  return breaks;
}

export function surfaceBreaks(
  before: unknown,
  after: unknown,
  surface: Surface,
  path = "",
): string[] {
  before = inlineReferences(before);
  after = inlineReferences(after);
  const breaks = breakingChanges(before, after, "input", path);
  if (surface !== "input")
    breaks.push(...breakingChanges(before, after, "output", path, surface === "frames"));
  return [...new Set(breaks)];
}

export function wireBreaks(before: Wire, after: Wire): string[] {
  return (["input", "output", "frames"] as const).flatMap((surface) =>
    Object.entries(before[surface]).flatMap(([name, schema]) =>
      name in after[surface]
        ? surfaceBreaks(schema, after[surface][name], surface, `${surface} ${name}`)
        : [`${surface} ${name} was removed`],
    ),
  );
}

function inlineReferences(value: unknown): unknown {
  const root = record(value);
  const walk = (node: unknown, active: ReadonlySet<string> = new Set()): unknown => {
    if (Array.isArray(node)) return node.map((entry) => walk(entry, active));
    if (!node || typeof node !== "object") return node;
    const schema = record(node);
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/")) {
      const definition = record(root.$defs)[schema.$ref.slice("#/$defs/".length)];
      if (active.has(schema.$ref)) return { $ref: "#recursive" };
      if (definition) return walk(definition, new Set([...active, schema.$ref]));
    }
    return Object.fromEntries(
      Object.entries(schema)
        .filter(([key]) => key !== "$defs")
        .map(([key, entry]) => [key, walk(entry, active)]),
    );
  };
  return walk(value);
}

export function wireUnionMembers(schema: z.ZodType): z.ZodType[] {
  return schema instanceof z.ZodUnion
    ? schema.options.flatMap((option) => wireUnionMembers(option as z.ZodType))
    : [schema];
}
