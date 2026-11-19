import type { OpensteerStore } from "@opensteer/database";
import type { Clock } from "@opensteer/shared/clock";
import { DeadlineDrain, retryWithBackoff } from "./deadline-drain.js";

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
      // Progress is what these sweeps themselves settled, never an inference
      // from what is left: a due deadline after a pass that settled something
      // (a Run another transaction held, say) runs again at once.
      // Both sweeps run, in order, even if the first fails; either failure owes a retry.
      const recovered = await store.recoverRunsWithExpiredExecutionBindings(now).then(
        (outcome) => ({ outcome }),
        (error: unknown) => ({ error }),
      );
      const stopped = await store.stopRunsPastBackgroundDeadline(wakeExecution, now);
      if ("error" in recovered) throw recovered.error;
      const settled = recovered.outcome.settled + stopped;
      const after = await store.nextExecutionDeadline();
      if (!after || after > now) return after;
      return settled > 0 ? after : retryWithBackoff;
    },
  });
}
