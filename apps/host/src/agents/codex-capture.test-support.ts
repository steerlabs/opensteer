import { readFile } from "node:fs/promises";
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

/** Read captures made with --capture-process-id, excluding task-naming app servers. */
export async function readCodexRunCaptures(path: string) {
  const captures = (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => captureSchema.parse(JSON.parse(line)));
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
