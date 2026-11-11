import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import { prepareProjectAdmission, projectWatchWorkSource } from "./project-work.test-support.js";
import { finalizeProjectRunTransaction } from "./run-finalization.js";
import { ProjectBindingStore, ProjectControlDeliveryStore } from "./project-execution-store.js";
import { readProjectRunBinding, assertActiveProjectBinding } from "./execution-authority.js";

describeStore("Project Run terminalization", (it) => {
  it("ends only the captured Run and preserves newer global-root work while queuing its original interrupt", async ({
    storeFixture,
  }) => {
    const { database, project, prepared, origin, store } = await prepareProjectAdmission(
      storeFixture,
      true,
    );
    const grant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", prepared.run.id)
      .executeTakeFirstOrThrow();
    const original = await readProjectRunBinding(database, {
      runId: prepared.run.id,
      grantId: grant.id,
    });
    if (!original) throw new Error("Original Project binding is missing");
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", project.userId)
      .execute();
    const next = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin: { ...origin, initiatorGeneration: 2 },
      source: { kind: "human" },
      content: [{ type: "text", text: "A new incarnation" }],
      policy: "queue",
      idempotencyKey: "new-incarnation",
    });
    if (!next.runId) throw new Error("New incarnation did not queue its Run");
    const events = await database
      .transaction()
      .execute((transaction) =>
        finalizeProjectRunTransaction(transaction, {
          runId: prepared.run.id,
          source: "host",
          status: "failed",
          failure: {
            code: "workspace_access_revoked",
            message: "The original root lost authority",
            retryable: false,
            status: "failed",
          },
          stopReason: "authority-revoked",
          completedAt: new Date(),
        }),
      );
    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
    expect(
      await database
        .selectFrom("runs")
        .select(["status", "initiatorGeneration"])
        .where("id", "=", prepared.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed", initiatorGeneration: "1" });
    expect(
      await database
        .selectFrom("runs")
        .select(["status", "initiatorGeneration"])
        .where("id", "=", next.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "queued", initiatorGeneration: "2" });
    expect(
      (
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", next.input.messageId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("pending");
    await expect(
      assertActiveProjectBinding(database, original.binding, { runnerIsAttached: () => true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const control = await database
      .selectFrom("commands")
      .selectAll()
      .where("runId", "=", prepared.run.id)
      .where("type", "=", "run.control.project")
      .executeTakeFirstOrThrow();
    expect(control).toMatchObject({
      status: "pending",
      originatingGrantId: original.binding.grantId,
      initiatorGeneration: "1",
    });
    const delivery = new ProjectControlDeliveryStore(database, {
      currentRunnerBootId: () => original.binding.runnerBootId,
      currentPeerIsProjectCapable: () => true,
      async canContinue() {
        return false;
      },
    });
    expect(await delivery.claim(control.id, "terminal-delivery")).toMatchObject({
      state: "ready",
      binding: original.binding,
      control: { kind: "run.interrupt" },
    });
    expect(
      await database
        .transaction()
        .execute((transaction) =>
          finalizeProjectRunTransaction(transaction, {
            runId: prepared.run.id,
            source: "host",
            status: "interrupted",
            completedAt: new Date(),
          }),
        ),
    ).toEqual([]);
  });

  it("uses the planned managerless decision without reading the old member state and rolls terminal work back atomically", async ({
    storeFixture,
  }) => {
    const context = await prepareProjectAdmission(storeFixture);
    const { database, project, prepared, store } = context;
    const { source } = await projectWatchWorkSource(context, "managerless");
    const admitted = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin: null,
      source,
      content: [{ type: "text", text: "Unattended work" }],
      policy: "queue",
      idempotencyKey: "managerless",
    });
    if (!admitted.runId || !admitted.commandId)
      throw new Error("Unattended fixture was not admitted");
    const boot = `rbt_${randomUUID()}`;
    const bound = await new ProjectBindingStore(database, { runnerIsAttached: () => true }).acquire(
      {
        commandId: admitted.commandId,
        runnerId: project.runnerId,
        runnerBootId: boot,
        dispatcherId: "managerless",
        leaseTokenHash: "managerless-lease",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    );
    await database
      .updateTable("runs")
      .set({ status: "waiting" })
      .where("id", "=", admitted.runId)
      .execute();
    const stop = {
      runId: admitted.runId,
      source: "host" as const,
      status: "failed" as const,
      failure: {
        code: "no_eligible_manager",
        message: "The planned final graph has no eligible manager",
        retryable: false,
        status: "failed" as const,
      },
      stopReason: "no-eligible-manager" as const,
      completedAt: new Date(),
    };
    const abort = new Error("Authority mutation aborted");
    await expect(
      database.transaction().execute(async (transaction) => {
        await finalizeProjectRunTransaction(transaction, stop);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(
      (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", admitted.runId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("waiting");
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("type", "=", "run.control.project")
        .execute(),
    ).toEqual([]);
    const events = await database
      .transaction()
      .execute((transaction) => finalizeProjectRunTransaction(transaction, stop));
    expect(events.some((event) => event.type === "run.failed")).toBe(true);
    expect(
      (
        await database
          .selectFrom("users")
          .select("memberState")
          .where("id", "=", project.userId)
          .executeTakeFirstOrThrow()
      ).memberState,
    ).toBe("active");
    expect(
      await database
        .selectFrom("workspaceMemberships")
        .select(["state", "role"])
        .where("workspaceId", "=", project.workspace.id)
        .where("userId", "=", project.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "active", role: "owner" });
    expect(
      await database
        .selectFrom("runs")
        .select(["status", "requestedBy", "initiatorGeneration"])
        .where("id", "=", admitted.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed", requestedBy: null, initiatorGeneration: null });
    expect(
      await database
        .selectFrom("commands")
        .select(["payload", "requestedBy"])
        .where("type", "=", "run.control.project")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      requestedBy: null,
      payload: { binding: bound.binding, control: { kind: "run.interrupt" } },
    });
  });
});
