import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import {
  installLockOrderChecker,
  lockOrderRecordOnly,
  recordedLockOrderEdges,
  recordedLockOrderViolations,
  takeTransactionConflicts,
} from "./lock-order-checker.test-support.js";
const file = expect.getState().testPath;
const worker = process.env.VITEST_WORKER_ID!;
const directory = process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY!;
const trace = join(directory, `worker-${process.env.VITEST_POOL_ID}-${worker}.jsonl`);
process.env.OPENSTEER_LOCK_ORDER_TRACE = trace;
writeFileSync(trace, JSON.stringify({ type: "file-start", file, worker }) + "\n", { flag: "wx" });
installLockOrderChecker();

afterEach(({ task }) => {
  const violations = recordedLockOrderViolations.splice(0);
  const conflicts = takeTransactionConflicts();
  recordedLockOrderEdges.splice(0);
  // These cases deliberately assert rejected SQL; no application path is exempt.
  if (task.file.filepath.endsWith("/lock-order-checker.integration.test.ts")) return;
  // Opt-in diagnostic sweeps record all edges without claiming an enforcing pass.
  if (lockOrderRecordOnly()) return;
  expect(violations, "Lock-order violations, including errors caught by application code").toEqual(
    [],
  );
  // A deadlock the retry absorbed still happened; only tests that cause one claim it.
  expect(conflicts, "Deadlocks or serialization failures, including retried ones").toEqual([]);
});
