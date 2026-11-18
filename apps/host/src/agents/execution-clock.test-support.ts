import type { ManualClock } from "@opensteer/shared/test-support/clock";
import type { PersonalHostRuntime } from "../runtime/runtime.js";
import type { VerticalStack } from "./vertical-stack.test-support.js";
import type { RunId } from "@opensteer/core";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";

export async function executionLeaseExpiresAt(
  host: Pick<PersonalHostRuntime, "store">,
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

export async function executionConnected(
  stack: Pick<VerticalStack, "api" | "environmentId">,
  connected: boolean,
): Promise<boolean> {
  const response = await stack.api["resources.get"]({ kind: "environment" });
  if (!response.ok) {
    if (response.error.code === "conflict") return false;
    throw new Error(response.error.message);
  }
  return response.data.view.entries.some(
    ({ id, status }) =>
      id === stack.environmentId && status === (connected ? "connected" : "disconnected"),
  );
}
export function executionDisconnected(stack: Pick<VerticalStack, "api" | "environmentId">) {
  return executionConnected(stack, false);
}

/** Advance a bounded interval, waiting for each async sweep before its next tick. */
export async function advanceExecutionClock(
  clock: ManualClock,
  host: Pick<PersonalHostRuntime, "settleExecutionLeases">,
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

/** Tests shorten hours-long background deadlines through the same commit wake as phase changes. */
export async function setBackgroundDeadline(
  host: Pick<PersonalHostRuntime, "store">,
  runIds: readonly RunId[],
  at: Date,
): Promise<void> {
  await commitPersonalMutation(host.store.database, async (tx, mutation) => {
    await tx
      .updateTable("runs")
      .set({ backgroundDeadlineAt: at })
      .where("id", "in", [...runIds])
      .execute();
    mutation.react({ type: "executionDeadlinesChanged" });
  });
}
