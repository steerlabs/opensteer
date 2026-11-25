import { z } from "zod";
import { commandRow, commandTable, type CommandRow, type CommandType } from "./command-table.js";
import { hostApi } from "./host-api.js";

/**
 * A command's arguments as the door reads them from an agent: by the type's own schema, with each
 * value only the person types left out when it is absent (the agent is told to leave it out). The
 * door reads a proposal this way, and the Home reads a stored proposal (whose secret values were
 * never kept) the same way, so an ask that waits for a value only the person types is still the
 * command it was asked as.
 */

/** Each command type's own schemas (a type may have more than one variant). */
const variants = (() => {
  const byType = new Map<string, z.ZodObject[]>();
  for (const option of (
    hostApi["commands.dispatch"].payload as unknown as z.ZodUnion<z.ZodObject[]>
  ).options) {
    const type = (option.shape.type as z.ZodLiteral<string>).value;
    byType.set(type, [...(byType.get(type) ?? []), option]);
  }
  return byType;
})();

export function commandSchemaVariants(type: string): readonly z.ZodObject[] {
  return variants.get(type) ?? [];
}

/** The schema with the secret value at `path` (dotted) left out, where the schema has it. */
function without(schema: z.ZodObject, path: readonly string[]): z.ZodObject {
  const [key, ...rest] = path;
  if (!key || !Object.hasOwn(schema.shape, key)) return schema;
  if (!rest.length) return schema.omit({ [key]: true } as never);
  let inner = schema.shape[key] as z.ZodType;
  const optional = inner instanceof z.ZodOptional;
  if (optional) inner = (inner as z.ZodOptional<z.ZodType>).unwrap() as z.ZodType;
  if (!(inner instanceof z.ZodObject)) return schema;
  const narrowed = without(inner, rest);
  return schema.extend({ [key]: optional ? narrowed.optional() : narrowed });
}

function absentAt(value: unknown, path: readonly string[]): boolean {
  let at: unknown = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return true;
    at = (at as Record<string, unknown>)[key];
  }
  return at === undefined;
}

/**
 * Reads a command with its own schema (or the variants given), leaving out each secret field the
 * table names that it does not carry. The first variant that reads it wins.
 */
export function parseCommandArguments(
  command: { readonly type: string } & Readonly<Record<string, unknown>>,
  options: { readonly variants?: readonly z.ZodObject[] } = {},
): ReturnType<z.ZodObject["safeParse"]> {
  const row = Object.hasOwn(commandTable, command.type)
    ? (commandRow(command.type as CommandType) as CommandRow)
    : undefined;
  const absent = (row?.secretFields ?? [])
    .map((path) => path.split("."))
    .filter((path) => absentAt(command, path));
  let first: ReturnType<z.ZodObject["safeParse"]> | undefined;
  for (const variant of options.variants ?? commandSchemaVariants(command.type)) {
    const schema = absent.reduce(without, variant);
    const result = schema.safeParse(command);
    if (result.success) return result;
    first ??= result;
  }
  return first ?? hostApi["commands.dispatch"].payload.safeParse(command);
}
