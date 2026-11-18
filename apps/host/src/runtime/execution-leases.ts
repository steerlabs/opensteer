import type { OpensteerStore } from "@opensteer/database";
import type { Clock } from "@opensteer/shared/clock";
import { DeadlineDrain } from "./deadline-drain.js";

export function executionLeaseDrain(
  store: Pick<
    OpensteerStore,
    | "nextExecutionDeadline"
    | "recoverRunsWithExpiredExecutionBindings"
    | "stopRunsPastBackgroundDeadline"
  >,
  wakeExecution: () => void,
  onError: (error: unknown) => void,
  clock?: Clock,
): DeadlineDrain {
  return new DeadlineDrain({
    ...(clock ? { clock } : {}),
    onError,
    drain: async () => {
      const next = await store.nextExecutionDeadline();
      const now = new Date(clock?.now() ?? Date.now());
      if (!next || next > now) return next;
      await store.recoverRunsWithExpiredExecutionBindings(now);
      await store.stopRunsPastBackgroundDeadline(wakeExecution, now);
      return store.nextExecutionDeadline();
    },
  });
}
