import { agentTools } from "@opensteer/agent-tools";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { opaqueToolFields, projectedAwayFields } from "./tool-output.js";

type Def = {
  readonly type: string;
  readonly shape?: Record<string, z.ZodType>;
  readonly element?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly left?: z.ZodType;
  readonly right?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly out?: z.ZodType;
  readonly items?: readonly z.ZodType[];
};

/** Every object key a schema accepts, outside fields whose values the projection leaves alone. */
function projectedKeys(
  schema: z.ZodType,
  path: string,
  found: string[],
  seen = new Set<z.ZodType>(),
) {
  if (seen.has(schema)) return found;
  seen.add(schema);
  const def = (schema as unknown as { readonly _zod: { readonly def: Def } })._zod.def;
  const children: [string, z.ZodType | undefined][] = [];
  if (def.type === "object")
    for (const [key, child] of Object.entries(def.shape ?? {})) {
      found.push(`${path}.${key}`);
      if (!opaqueToolFields.has(key)) children.push([`${path}.${key}`, child]);
    }
  if (def.type === "array") children.push([`${path}[]`, def.element]);
  if (def.type === "record") children.push([`${path}{}`, def.valueType]);
  if (def.type === "intersection") children.push([path, def.left], [path, def.right]);
  if (def.type === "pipe") children.push([path, def.in], [path, def.out]);
  for (const option of [...(def.options ?? []), ...(def.items ?? [])])
    children.push([path, option]);
  if (def.innerType) children.push([path, def.innerType]);
  for (const [childPath, child] of children)
    if (child) projectedKeys(child, childPath, found, seen);
  return found;
}

describe("tool output projection", () => {
  it("never leaves an output schema expecting a field the projection renames or drops", () => {
    const stale = agentTools.flatMap((tool) =>
      projectedKeys(tool.output, tool.name, []).filter((path) =>
        projectedAwayFields.has(path.slice(path.lastIndexOf(".") + 1)),
      ),
    );
    expect(stale).toEqual([]);
  });
});
