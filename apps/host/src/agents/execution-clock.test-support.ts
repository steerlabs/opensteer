import type { ManualClock } from "@opensteer/shared/test-support/clock";
import type { HostRuntime } from "../runtime/runtime.js";
import type { VerticalStack } from "./vertical-stack.test-support.js";
import type { RunId } from "@opensteer/core";

export async function executionLeaseExpiresAt(
  host: Pick<HostRuntime, "store">,
  runId: RunId,
): Promise<Date> {
  const binding = await host.store.database
    .selectFrom("runs")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .select("providerSessions.leaseExpiresAt")
    .where("runs.id", "=", runId)
    .executeTakeFirstOrThrow();
  if (!binding.leaseExpiresAt) throw new Error("Expected an established execution lease");
  return binding.leaseExpiresAt;
}

export async function executionDisconnected(
  stack: Pick<VerticalStack, "api" | "environmentId">,
): Promise<boolean> {
  const read = await stack.api["bootstrap.get"]({});
  return (
    read.ok &&
    read.data.environments.some(
      (environment) => environment.id === stack.environmentId && !environment.connected,
    )
  );
}

/** Advance a bounded interval, waiting for each async sweep before its next tick. */
export async function advanceExecutionClock(
  clock: ManualClock,
  host: Pick<HostRuntime, "settleExecutionLeases">,
  milliseconds: number,
): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new Error("Execution time must advance by a finite nonnegative integer");
  for (let remaining = milliseconds; remaining > 0;) {
    await host.settleExecutionLeases();
    const step = Math.min(1_000, remaining);
    clock.advanceBy(step);
    await host.settleExecutionLeases();
    remaining -= step;
  }
}
