import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A process owns its pending files; only same-directory rename publishes them. */
export function createCaptureRecordWriter(directory) {
  const identity = randomUUID();
  let order = 0;
  return (message, runId = null) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ordinal = order++;
    const path = join(directory, `${identity}-${String(ordinal).padStart(8, "0")}`);
    writeFileSync(
      `${path}.pending`,
      JSON.stringify({
        ...message,
        captureProcessId: process.pid,
        captureProcessIdentity: identity,
        captureRunId: runId,
        captureOrder: ordinal,
        captureTime: performance.timeOrigin + performance.now(),
      }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(`${path}.pending`, `${path}.json`);
  };
}
