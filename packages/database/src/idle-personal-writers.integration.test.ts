import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect } from "vitest";
import { ChannelStore } from "./channel-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("Idle personal writers", (it) => {
  it.for(["schedules", "channel ingress"] as const)(
    "scans %s without reserving personal event order when there is no work",
    async (kind, { storeFixture }) => {
      const { createRunFixture, database, triggers } = storeFixture;
      await createRunFixture("idle-writers");
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = withPersonalTransaction(database, async () => {
        held.resolve();
        await withTimeout(release.promise, 5_000, {
          timeoutError: () => new Error("Idle scan never released the personal event fence"),
        });
      });
      void blocker.catch(held.reject);
      let scan: Promise<unknown> | undefined;
      try {
        await withTimeout(held.promise, 2_000, {
          timeoutError: () => new Error("Personal event fence was never acquired"),
        });
        scan =
          kind === "schedules"
            ? triggers.claimDueSchedules()
            : new ChannelStore(database).claimIngress("idle-worker");
        await expect(
          withTimeout(scan, 2_000, {
            timeoutError: () => new Error(`Idle ${kind} scan waited for personal event order`),
          }),
        ).resolves.toEqual(kind === "schedules" ? { occurrences: [], changed: false } : null);
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, scan]);
      }
    },
  );
});
