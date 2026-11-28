/**
 * The bench-only agent entry: the production daemon plus a crash at a named step, for the
 * real-host test of an agent restart in the middle of a transition. Root writes a checkpoint
 * name to the file below; the next agent reads and deletes it, and kills itself with SIGKILL
 * at that point. Built to dist/bench-agent.mjs and never installed by setup-host.sh.
 */
import { readFile, rm } from "node:fs/promises";
import { log, runDaemon } from "../src/daemon.js";

async function crashPoint(): Promise<string | undefined> {
  const file = "/run/opensteer-pool/test-crash-at";
  const point = await readFile(file, "utf8").catch(() => undefined);
  if (point === undefined) return undefined;
  await rm(file, { force: true });
  return point.trim() || undefined;
}

const crashAt = await crashPoint();
runDaemon(
  crashAt
    ? {
        checkpoint: (point: string) => {
          if (point !== crashAt) return;
          log({ event: "agent.test-crash", point });
          process.kill(process.pid, "SIGKILL");
        },
      }
    : {},
).catch((error: unknown) => {
  log({ event: "agent.failed", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
