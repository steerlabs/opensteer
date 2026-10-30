import type { ChildProcess } from "node:child_process";
import { withTimeout } from "@opensteer/shared/withTimeout";

/** Call immediately after spawn, before waiting for readiness or sending work. */
export function ownChild(child: ChildProcess) {
  let failure: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      failure = error;
      // A failed spawn has no exit event. An error on a live child still needs joining.
      if (child.pid === undefined) resolve();
    });
    child.once("close", () => resolve());
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
  let closing: Promise<void> | undefined;
  return {
    exited,
    close: (request: () => void, graceMs = 1_000) =>
      (closing ??= (async () => {
        const failures: unknown[] = [];
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try {
            request();
          } catch (error) {
            failures.push(error);
          }
          let expired = false;
          await withTimeout(exited, graceMs, {
            timeoutError: () => new Error("Owned child ignored graceful stop"),
          }).catch(() => {
            expired = true;
          });
          if (expired) child.kill("SIGKILL");
        }
        await withTimeout(exited, 5_000, {
          timeoutError: () => new Error("Owned child exit was not observed"),
        });
        if (failure) failures.push(failure);
        if (failures.length) throw new AggregateError(failures, "Owned child cleanup failed");
      })()),
  };
}
