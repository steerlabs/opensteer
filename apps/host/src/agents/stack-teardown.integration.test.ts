import { expect, it, vi } from "vitest";
import { HarnessRegistry, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

it("joins engines and a held final save before closing Host and its database", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const harnesses = new HarnessRegistry();
  const engineClosed = vi.spyOn(harnesses, "close");
  let stack: VerticalStack | undefined;
  // No engine account is needed: cancellation during catalog startup also owns the save.
  const starting = startVerticalStack({
    databaseUrl: process.env.OPENSTEER_TEST_DATABASE_URL!,
    harnesses,
    harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
    harnessInstance: {
      config: {},
      driverKind: "missing",
      sourceId: "missing",
      stateKind: "ambient",
    },
    catalogTimeoutMs: 100,
    runTimeoutMs: 1_000,
    beforeHostClose: async (host) => {
      expect(engineClosed).toHaveBeenCalled();
      entered.resolve();
      await release.promise;
      expect(await host.store.firstUser()).not.toBeNull();
    },
  });
  // The missing driver cancels startup. Its cleanup must still join the held save.
  const finished = starting.then(
    (value) => {
      stack = value;
    },
    () => undefined,
  );
  let completed = false;
  void finished.then(() => {
    completed = true;
  });
  try {
    await withTimeout(entered.promise, 5_000, {
      timeoutError: () => new Error("Final save was not entered during startup cancellation"),
    });
    expect(completed).toBe(false);
  } finally {
    release.resolve();
    await finished;
    await stack?.close();
  }
});
