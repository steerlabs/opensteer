import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import { prepareProjectAdmission } from "./project-work.test-support.js";
import { ProjectBindingStore } from "./project-execution-store.js";
import { ProjectRunRecoveryStore } from "./project-run-recovery.js";
import { assertActiveProjectBinding } from "./execution-authority.js";
import { loadProjectRunDispatchContext } from "./execution-store.js";
import type { AgentEvent } from "@opensteer/core";

describeStore("Project bound Run recovery", (it) => {
  it("retains the native session, exact root and admitted settings while giving a restarted Runner a new binding", async ({
    storeFixture,
  }) => {
    const { database, project, prepared, store, origin } =
      await prepareProjectAdmission(storeFixture);
    const admitted = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" },
      content: [{ type: "text", text: "Continue this work" }],
      policy: "queue",
      idempotencyKey: "recoverable",
    });
    if (!admitted.commandId || !admitted.runId)
      throw new Error("Project recovery fixture was not admitted");
    const bindings = new ProjectBindingStore(database, { runnerIsAttached: () => true });
    const first = await bindings.acquire({
      commandId: admitted.commandId,
      runnerId: project.runnerId,
      runnerBootId: `rbt_${randomUUID()}`,
      dispatcherId: "first-host",
      leaseTokenHash: "first-lease",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const providerSessionId = (
      await database
        .selectFrom("runs")
        .select("providerSessionId")
        .where("id", "=", admitted.runId)
        .executeTakeFirstOrThrow()
    ).providerSessionId;
    if (!providerSessionId) throw new Error("Project fixture has no native session");
    await bindings.sessionBound({
      binding: first.binding,
      providerSessionId,
      harnessInstanceId: prepared.harnessInstance.id,
      providerSessionReference: "project-native-session",
    });
    await database
      .updateTable("runs")
      .set({ status: "running", startedAt: new Date(), nextRunnerOrdinal: 2 })
      .where("id", "=", admitted.runId)
      .execute();
    let boot = first.binding.runnerBootId;
    const events: AgentEvent[] = [];
    const recovery = new ProjectRunRecoveryStore(database, {
      currentRunner: () => ({ runnerId: project.runnerId, runnerBootId: boot }),
      publish: (batch) => events.push(...batch),
    });
    expect(
      await recovery.recover({
        runId: admitted.runId,
        expectedBindingGeneration: first.binding.bindingGeneration,
      }),
    ).toEqual({ state: "unavailable" });
    boot = `rbt_${randomUUID()}`;
    expect(
      await recovery.recover({
        runId: admitted.runId,
        expectedBindingGeneration: first.binding.bindingGeneration,
      }),
    ).toEqual({ state: "recovered" });
    expect(events.some((event) => event.type === "run.restarted")).toBe(true);
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", admitted.runId)
      .where("type", "=", "run.execute.project")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    const next = await bindings.acquire({
      commandId: command.id,
      runnerId: project.runnerId,
      runnerBootId: boot,
      dispatcherId: "restarted-host",
      leaseTokenHash: "new-lease",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(next.binding.authority).toEqual(first.binding.authority);
    expect(next.snapshot).toEqual(first.snapshot);
    expect(next.binding.grantId).not.toBe(first.binding.grantId);
    expect(next.binding.bindingGeneration).toBeGreaterThan(first.binding.bindingGeneration);
    const context = await loadProjectRunDispatchContext(
      database,
      command.id,
      next.binding,
      () => true,
    );
    expect(context.firstOrdinal).toBe(2);
    expect(context.executionBinding?.providerSessionReference).toBe("project-native-session");
    expect(context.inputs[0]?.author).toMatchObject({ kind: "platform", cause: "run-recovery" });
    await expect(
      assertActiveProjectBinding(database, first.binding, { runnerIsAttached: () => true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await recovery.recover({
        runId: admitted.runId,
        expectedBindingGeneration: first.binding.bindingGeneration,
      }),
    ).toEqual({ state: "unavailable" });
    await database
      .updateTable("users")
      .set({ authorityGeneration: "3" })
      .where("id", "=", origin.userId)
      .execute();
    expect(
      await recovery.recover({
        runId: admitted.runId,
        expectedBindingGeneration: next.binding.bindingGeneration,
      }),
    ).toEqual({ state: "cancelled" });
    expect(
      (
        await database
          .selectFrom("runs")
          .select("requestedBy")
          .where("id", "=", admitted.runId)
          .executeTakeFirstOrThrow()
      ).requestedBy,
    ).toBe(origin.userId);
  });
});
