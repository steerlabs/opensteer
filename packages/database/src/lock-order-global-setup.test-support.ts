import {
  appendFileSync,
  createReadStream,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { TestProject } from "vitest/node";
import { lockOrderMode } from "@opensteer/shared/lockOrderMode";
import { z } from "zod";
import {
  findConflictingApplicationLockCycles,
  isLockOrderFixture,
  type LockOrderEdge,
} from "./lock-order-checker.test-support.js";

const mode = z.enum(["KEY SHARE", "SHARE", "NO KEY UPDATE", "UPDATE"]);
const fileRecord = { file: z.string().min(1), worker: z.string().min(1) };
const recordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file-start"), ...fileRecord }),
  z.object({ type: z.literal("file-end"), ...fileRecord }),
  z.object({ type: z.literal("violation"), message: z.string() }).passthrough(),
  z.object({
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
  }),
]);

/** Physical database isolation must preserve the whole suite's logical lock graph. */
export default function setup(project?: TestProject) {
  const requested = process.env.OPENSTEER_LOCK_ORDER_TRACE;
  const scratch = requested ? null : mkdtempSync(join(tmpdir(), "opensteer-lock-order-"));
  const trace = requested ?? join(scratch!, "trace.jsonl");
  const directory = mkdtempSync(join(dirname(trace), basename(trace) + ".workers-"));
  process.env.OPENSTEER_LOCK_ORDER_TRACE = trace;
  process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY = directory;
  const expectedFiles = project?.vitest.state.getPaths();
  const mode = lockOrderMode();
  const recordOnly = mode === "record";
  const teardown = async () => {
    const edges = new Map<string, LockOrderEdge>();
    const files = new Set<string>();
    const errors: string[] = [];
    let acquisitions = 0;
    let violations = 0;
    writeFileSync(trace, "");
    const traces = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    if (!traces.length) errors.push("Missing lock traces");
    for (const name of traces) {
      let file: { file: string; worker: string } | undefined;
      let completed = false;
      try {
        const lines = createInterface({
          input: createReadStream(join(directory, name)),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          const value = recordSchema.parse(JSON.parse(line));
          appendFileSync(trace, line + "\n");
          if (completed) throw new Error("Record after file-end");
          if (value.type === "file-start") {
            if (file || files.has(value.file)) throw new Error("Duplicate file-start");
            file = value;
            files.add(value.file);
            continue;
          }
          if (!file) throw new Error("Missing file-start");
          if (value.type === "file-end") {
            if (value.file !== file.file || value.worker !== file.worker)
              throw new Error("Mismatched file-end");
            completed = true;
            continue;
          }
          // Only the dedicated negative fixtures are excluded, never an application path.
          if (isLockOrderFixture(value)) continue;
          if (value.type === "violation") {
            violations++;
            continue;
          }
          acquisitions++;
          const signature = JSON.stringify([
            value.database,
            value.from,
            value.to,
            value.heldMode,
            value.requestedMode,
          ]);
          if (!edges.has(signature)) edges.set(signature, value);
        }
        if (!completed) throw new Error("Missing file-end");
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const file of expectedFiles ?? []) {
      if (!files.has(file)) errors.push(`Missing lock trace for ${file}`);
    }
    const cycles = findConflictingApplicationLockCycles([...edges.values()]);
    const summary = {
      mode,
      acquisitions,
      signatures: edges.size,
      violations,
      cycles,
      files: [...files].sort(),
      traces: traces.length,
      errors,
      edges: [...edges.values()],
    };
    writeFileSync(trace + ".graph.json", JSON.stringify(summary, null, 2) + "\n");
    console.info(`Database lock graph: ${trace}.graph.json`);
    if (errors.length || (!recordOnly && (violations > 0 || cycles.length > 0))) {
      throw new Error(
        `Database lock graph: ${violations} rank/order violations; ${cycles.length} conflicting cycle witnesses; ${errors.length} trace errors. See ${trace}.graph.json\n${errors.join("\n")}`,
      );
    }
    if (scratch && !recordOnly) {
      for (const name of traces) rmSync(join(directory, name));
      rmSync(trace);
    }
  };
  return async () => {
    try {
      await teardown();
    } catch (error) {
      // Vitest reports a teardown error but still exits 0 unless told otherwise.
      process.exitCode = 1;
      throw error;
    }
  };
}
