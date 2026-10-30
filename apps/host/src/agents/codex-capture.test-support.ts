import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const captureSchema = z
  .object({
    captureProcessId: z.number().optional(),
    method: z.string().optional(),
    params: z
      .object({ ephemeral: z.boolean().optional(), threadId: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const publishedSchema = captureSchema.extend({
  captureProcessId: z.number().int(),
  captureProcessIdentity: z.string(),
  // The engine thread is the fixture's Run identity; initialize precedes it.
  captureRunId: z.string().nullable(),
  captureOrder: z.number().int().nonnegative(),
  captureTime: z.number(),
});

/** Only .json names are published; a writer may still be filling its .pending file. */
export async function readCodexCaptures(path: string) {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: z.infer<typeof publishedSchema>[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    let text: string;
    try {
      text = await readFile(join(path, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      records.push(publishedSchema.parse(JSON.parse(text)));
    } catch {
      // JSON and schema errors may include credential payloads. Never attach a cause.
      throw new Error("Malformed published Codex capture");
    }
  }
  return records.sort((a, b) =>
    a.captureProcessIdentity === b.captureProcessIdentity
      ? a.captureOrder - b.captureOrder
      : a.captureTime - b.captureTime ||
        a.captureProcessIdentity.localeCompare(b.captureProcessIdentity),
  );
}

/** Read captures made with --capture-records, excluding task-naming app servers. */
export async function readCodexRunCaptures(path: string) {
  const captures = await readCodexCaptures(path);
  const naming = (entry: z.infer<typeof captureSchema>) =>
    (entry.method === "thread/start" && entry.params?.ephemeral === true) ||
    entry.params?.threadId?.startsWith("codex-title-") === true;
  const namingProcesses = new Set<number>();
  const runProcesses = new Set<number>();
  for (const entry of captures) {
    if (entry.captureProcessId === undefined) continue;
    if (naming(entry)) namingProcesses.add(entry.captureProcessId);
    else if (["thread/start", "thread/resume"].includes(entry.method ?? ""))
      runProcesses.add(entry.captureProcessId);
  }
  return captures.filter((entry) => {
    if (
      naming(entry) ||
      (entry.captureProcessId !== undefined && namingProcesses.has(entry.captureProcessId))
    )
      return false;
    // Naming initializes before it declares its ephemeral thread. Credentials
    // can only be selected once their process has opened a real Run's thread.
    return (
      !entry.fakeOpensteerTokens ||
      (entry.captureProcessId !== undefined && runProcesses.has(entry.captureProcessId))
    );
  });
}
