import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { findConflictingApplicationLockCycles } from "../packages/database/src/lock-order-checker.test-support.js";
const mode = z.enum(["KEY SHARE", "SHARE", "NO KEY UPDATE", "UPDATE"]);
const edge = z.object({
  type: z.literal("edge"),
  database: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  heldMode: mode,
  requestedMode: mode,
  heldKey: z.string(),
  requestedKey: z.string(),
  statement: z.string(),
  previous: z.string(),
  stack: z.string(),
  previousStack: z.string(),
});
const graph = z.object({
  mode: z.literal("enforce"),
  errors: z.array(z.string()).length(0),
  violations: z.literal(0),
  edges: z.array(edge),
});
/** Consume only completed enforcing summaries from the existing collector. */
export function mergeLockGraphs(files: readonly string[]) {
  if (!files.length || new Set(files).size !== files.length)
    throw new Error("Missing or duplicate lock graphs");
  const edges = files.flatMap((file) => graph.parse(JSON.parse(readFileSync(file, "utf8"))).edges);
  const cycles = findConflictingApplicationLockCycles(edges);
  if (cycles.length) throw new Error(`Combined lock graph: ${cycles.length} conflicting cycles`);
  return { edges, cycles };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const merged = mergeLockGraphs(process.argv.slice(2));
  writeFileSync("combined-lock-graph.json", JSON.stringify(merged, null, 2) + "\n");
}
