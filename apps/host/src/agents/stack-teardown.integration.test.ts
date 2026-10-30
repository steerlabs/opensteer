import { describe, expect, it, vi } from "vitest";
import { HarnessRegistry, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// PostgreSQL fixtures are configured only by the integration launcher.
const integration = databaseUrl ? describe : describe.skip;

integration("Vertical stack teardown", () => {
  it("joins engines and a held final save before closing Host and its database", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harnesses = new HarnessRegistry();
    const engineClosed = vi.spyOn(harnesses, "close");
    let stack: VerticalStack | undefined;
    // No engine account is needed: cancellation during catalog startup also owns the save.
    const starting = startVerticalStack({
      databaseUrl: databaseUrl!,
      harnesses,
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      harnessInstance: {
        config: {},
        driverKind: "missing",
        sourceId: "missing",
        stateKind: "ambient",
      },
      // The missing driver's report ends startup; the deadline only bounds a hang and must not
      // race that report on a loaded runner.
      catalogTimeoutMs: 10_000,
      runTimeoutMs: 1_000,
      beforeHostClose: async (host) => {
        expect(engineClosed).toHaveBeenCalled();
        entered.resolve();
        await release.promise;
        expect(await host.store.firstUser()).not.toBeNull();
      },
    });
    // The missing driver cancels startup. Its cleanup must still join the held save.
    const finished = starting.then((value) => {
      stack = value;
    });
    let completed = false;
    const completedStep = () => {
      completed = true;
    };
    void finished.then(completedStep, completedStep);
    let saveEntered = false;
    try {
      await withTimeout(Promise.race([entered.promise, finished]), 5_000, {
        timeoutError: () => new Error("Final save was not entered during startup cancellation"),
      });
      saveEntered = true;
      expect(completed).toBe(false);
    } finally {
      release.resolve();
      if (saveEntered)
        await expect(finished).rejects.toThrow(
          "The account reported unavailable: Harness driver missing is not installed",
        );
      await stack?.close();
    }
  });
});
