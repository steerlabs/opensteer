import { expect, test } from "vitest";
import { z } from "zod";
import { DeviceCapabilityReasonSchema } from "./devices.js";
import {
  MachineInventoryEntrySchema,
  machineInventoryEntryMaxBytes,
  personalMachineLimit,
} from "./machines.js";
import { personalInventoryBound } from "./resources.js";

type Json = Record<string, any>;

/**
 * The most bytes a value of `schema` can serialize to, from its declared limits alone: every
 * string at its maximum length in three-byte characters, every array full. Any field without a
 * limit is reported, so the bound cannot hide one. Ids are fixed by pattern; a capability reason
 * is normalized into `DeviceCapabilityReasonSchema`, priced as that.
 */
function worstBytes(schema: z.ZodType) {
  const unbounded: string[] = [];
  const reason = z.toJSONSchema(DeviceCapabilityReasonSchema, { io: "input" }) as Json;
  const visit = (node: Json, defs: Json, path: string): number => {
    if (node.$ref) return visit(defs[node.$ref.split("/").pop()], defs, path);
    for (const key of ["anyOf", "oneOf", "allOf"])
      if (node[key]) return Math.max(...node[key].map((each: Json) => visit(each, defs, path)));
    if (node.const !== undefined) return JSON.stringify(node.const).length;
    if (node.enum) return Math.max(...node.enum.map((v: unknown) => JSON.stringify(v).length));
    const type = Array.isArray(node.type) ? node.type.find((t: string) => t !== "null") : node.type;
    if (type === "string") {
      if (node.maxLength !== undefined) return node.maxLength * 3 + 2;
      if (node.pattern) return 128;
      unbounded.push(path);
      return 0;
    }
    if (node.type === "null") return 4;
    if (type === "number" || type === "integer") return 24;
    if (type === "boolean") return 5;
    if (type === "array") {
      if (node.maxItems === undefined) unbounded.push(`${path}[]`);
      return (
        2 + (node.maxItems ?? 0) * ((node.items ? visit(node.items, defs, `${path}[]`) : 0) + 1)
      );
    }
    if (type === "object" || node.properties) {
      if (node.additionalProperties && typeof node.additionalProperties === "object")
        unbounded.push(`${path}{*}`);
      return Object.entries(node.properties ?? {}).reduce(
        (sum, [key, value]) => sum + key.length + 4 + visit(value as Json, defs, `${path}.${key}`),
        2,
      );
    }
    if (path.endsWith(".reason")) return visit(reason, reason.$defs ?? {}, path);
    unbounded.push(`${path}<any>`);
    return 0;
  };
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as Json;
  const bytes = visit(json, json.$defs ?? {}, "entry");
  return { bytes, unbounded };
}

test("a machine inventory entry is bounded by its declared limits, and every computer fits", () => {
  const { bytes, unbounded } = worstBytes(MachineInventoryEntrySchema);
  expect(unbounded).toEqual([]);
  expect(bytes).toBeLessThanOrEqual(machineInventoryEntryMaxBytes);
  // Every computer a Deployment may hold, each at its worst, in under two thirds of the bound.
  expect(personalMachineLimit * machineInventoryEntryMaxBytes).toBeLessThanOrEqual(
    (personalInventoryBound("machine") * 2) / 3,
  );
});
