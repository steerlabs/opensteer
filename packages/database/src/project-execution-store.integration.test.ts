import { randomUUID } from "node:crypto";
import { RunnerConnectionFenceSchema } from "@opensteer/protocol";
import { ProjectRunBindingSchema, createId } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import {
  createProjectIdentityFixture,
  prepareProjectAdmission,
  insertProjectRunFixture,
} from "./project-work.test-support.js";
import { ProjectExecutionStore, ProjectControlDeliveryStore } from "./project-execution-store.js";

describeStore("Project durable controls", (it) => {
  it("retains the original disposition across replays and root loss, refuses identity changes, and rolls back with its caller", async ({
    storeFixture,
  }) => {
    const project = await createProjectIdentityFixture(storeFixture, "controls");
    const prepared = await insertProjectRunFixture(
      storeFixture,
      project,
      "controls",
      project.userId,
      "running",
    );
    const database = storeFixture.database;
    const grant = await database
      .selectFrom("grants")
      .selectAll()
      .where("runId", "=", prepared.run.id)
      .executeTakeFirstOrThrow();
    const binding = ProjectRunBindingSchema.parse({
      authority: {
        version: 1,
        principal: {
          kind: "project",
          principalId: project.principalId,
          workspaceId: project.workspace.id,
        },
        origin: {
          userId: project.userId,
          initiatorGeneration: 1,
          membershipGeneration: 1,
          originConnectionId: null,
        },
      },
      runId: prepared.run.id,
      threadId: prepared.thread.id,
      workspaceId: project.workspace.id,
      environmentId: project.environmentId,
      bindingGeneration: grant.bindingGeneration,
      grantId: grant.id,
      runnerId: grant.runnerId,
      runnerBootId: grant.runnerBootId,
    });
    const store = new ProjectExecutionStore();
    const control = {
      kind: "request.refuse" as const,
      requestId: createId("request"),
      callId: "proposal-one",
      reason: "unsupported-request-kind" as const,
    };
    const input = { binding, idempotencyKey: "proposal-one", control };
    expect(await database.transaction().execute((tx) => store.enqueue(tx, input))).toEqual({
      created: true,
    });
    expect(await database.transaction().execute((tx) => store.enqueue(tx, input))).toEqual({
      created: false,
    });
    await expect(
      database
        .transaction()
        .execute((tx) => store.enqueue(tx, { ...input, control: { kind: "run.interrupt" } })),
    ).rejects.toMatchObject({ reason: "idempotency-conflict" });
    const abort = new Error("caller aborted");
    await expect(
      database.transaction().execute(async (tx) => {
        await store.enqueue(tx, {
          binding,
          idempotencyKey: "aborted",
          control: { kind: "run.interrupt" },
        });
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(
      await database
        .transaction()
        .execute((tx) => store.find(tx, { binding, idempotencyKey: "aborted" })),
    ).toBeNull();
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", project.userId)
      .execute();
    expect(await database.transaction().execute((tx) => store.find(tx, input))).toEqual(control);
    expect(await database.transaction().execute((tx) => store.enqueue(tx, input))).toEqual({
      created: false,
    });
    expect(
      await database.transaction().execute((tx) =>
        store.enqueue(tx, {
          binding,
          idempotencyKey: "revocation",
          control: { kind: "run.interrupt" },
        }),
      ),
    ).toEqual({ created: true });
    await expect(
      database.deleteFrom("grants").where("id", "=", grant.id).execute(),
    ).rejects.toMatchObject({ code: "23001", constraint: "commands_originating_grant_id_fkey" });
    const stored = await database
      .selectFrom("commands")
      .selectAll()
      .where("type", "=", "run.control.project")
      .execute();
    expect(stored).toHaveLength(2);
    expect(
      stored.every((row) => row.status === "pending" && row.originatingGrantId === grant.id),
    ).toBe(true);
    let attached = false;
    const delivery = new ProjectControlDeliveryStore(database, {
      currentPeerIsProjectCapable: () => true,
      currentRunnerBootId: () => (attached ? binding.runnerBootId : null),
      async canContinue() {
        return false;
      },
    });
    const pendingInterrupt = await database
      .selectFrom("commands")
      .select("id")
      .where("type", "=", "run.control.project")
      .where("payload", "@>", JSON.stringify({ control: { kind: "run.interrupt" } }))
      .executeTakeFirstOrThrow();
    expect(await delivery.claim(pendingInterrupt.id, "host-before-restart")).toMatchObject({
      state: "offline",
    });
    attached = true;
    await database
      .updateTable("runs")
      .set({ status: "failed", completedAt: new Date() })
      .where("id", "=", binding.runId)
      .execute();
    const firstDelivery = await delivery.claim(pendingInterrupt.id, "host-before-restart");
    expect(firstDelivery).toMatchObject({
      state: "ready",
      binding,
      control: { kind: "run.interrupt" },
    });
    const afterRestart = new ProjectControlDeliveryStore(database, {
      currentPeerIsProjectCapable: () => true,
      currentRunnerBootId: () => binding.runnerBootId,
      async canContinue() {
        return false;
      },
    });
    expect(await afterRestart.claim(pendingInterrupt.id, "host-after-restart")).toEqual(
      firstDelivery,
    );
    if (firstDelivery.state !== "ready") throw new Error("Control was not ready for delivery");
    const peer = RunnerConnectionFenceSchema.parse({
      runnerId: binding.runnerId,
      bootId: binding.runnerBootId,
      connectionGeneration: 1,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
    });
    const receipt = {
      ...peer,
      type: "runner.project.control-result",
      binding,
      commandId: pendingInterrupt.id,
      correlationId: firstDelivery.correlationId,
      result: { status: "accepted" },
    };
    await expect(
      afterRestart.recordResult(peer, { ...receipt, connectionGeneration: 2 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await afterRestart.recordResult(peer, receipt)).toEqual({
      state: "recorded",
      replayed: false,
    });
    expect(await afterRestart.recordResult(peer, receipt)).toEqual({
      state: "recorded",
      replayed: true,
    });
    await expect(
      afterRestart.recordResult(peer, {
        ...receipt,
        result: { status: "uncertain", message: "Lost result" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await afterRestart.claim(pendingInterrupt.id, "host-after-restart")).toMatchObject({
      state: "settled",
      status: "succeeded",
    });
    const refused = await database
      .selectFrom("commands")
      .select("id")
      .where("type", "=", "run.control.project")
      .where("payload", "@>", JSON.stringify({ control: { kind: "request.refuse" } }))
      .executeTakeFirstOrThrow();
    expect(await afterRestart.claim(refused.id, "host-after-restart")).toMatchObject({
      state: "disposed",
    });
    expect(await database.transaction().execute((tx) => store.find(tx, input))).toEqual(control);
    expect(
      await database
        .selectFrom("commands")
        .select(["id", "status"])
        .where("id", "in", [pendingInterrupt.id, refused.id])
        .orderBy("id")
        .execute(),
    ).toEqual(
      [
        { id: pendingInterrupt.id, status: "succeeded" },
        { id: refused.id, status: "failed" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    await database.transaction().execute((tx) =>
      store.enqueue(tx, {
        binding,
        idempotencyKey: "uncertain-control",
        control: { kind: "run.interrupt" },
      }),
    );
    const uncertainRow = await database
      .selectFrom("commands")
      .select("id")
      .where("type", "=", "run.control.project")
      .where("id", "not in", [pendingInterrupt.id, refused.id])
      .executeTakeFirstOrThrow();
    const uncertainDelivery = await afterRestart.claim(uncertainRow.id, "host-after-restart");
    if (uncertainDelivery.state !== "ready")
      throw new Error("Uncertain control was not queued for delivery");
    const uncertainReceipt = {
      ...receipt,
      commandId: uncertainRow.id,
      correlationId: uncertainDelivery.correlationId,
      result: { status: "uncertain", message: "Engine acceptance could not be proved" },
    };
    expect(await afterRestart.recordResult(peer, uncertainReceipt)).toEqual({
      state: "recorded",
      replayed: false,
    });
    expect(await afterRestart.recordResult(peer, uncertainReceipt)).toEqual({
      state: "recorded",
      replayed: true,
    });
    expect(await afterRestart.claim(uncertainRow.id, "host-restarted-again")).toMatchObject({
      state: "uncertain",
      binding,
    });
    await expect(
      afterRestart.recordResult(peer, { ...uncertainReceipt, result: { status: "accepted" } }),
    ).rejects.toMatchObject({ code: "conflict" });
    await database.transaction().execute((tx) =>
      store.enqueue(tx, {
        binding,
        idempotencyKey: "old-boot-control",
        control: { kind: "run.interrupt" },
      }),
    );
    const oldBootRow = await database
      .selectFrom("commands")
      .select("id")
      .where("type", "=", "run.control.project")
      .where("id", "not in", [pendingInterrupt.id, refused.id, uncertainRow.id])
      .executeTakeFirstOrThrow();
    const newBoot = new ProjectControlDeliveryStore(database, {
      currentRunnerBootId: () => `rbt_${randomUUID()}`,
      currentPeerIsProjectCapable: () => true,
      async canContinue() {
        return false;
      },
    });
    expect(await newBoot.claim(oldBootRow.id, "host-with-new-boot")).toMatchObject({
      state: "disposed",
    });
    expect(
      await database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", oldBootRow.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed" });
    await expect(
      database
        .updateTable("commands")
        .set({ payload: {} })
        .where("id", "=", stored[0]?.id ?? createId("command"))
        .execute(),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("stops a waiting Run after a restart finds an uncertain Request control without losing its disposition", async ({
    storeFixture,
  }) => {
    const { readProjectRunBinding } = await import("./execution-authority.js");
    const { database, project, prepared } = await prepareProjectAdmission(storeFixture, true);
    const grant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", prepared.run.id)
      .executeTakeFirstOrThrow();
    const saved = await readProjectRunBinding(database, {
      runId: prepared.run.id,
      grantId: grant.id,
    });
    if (!saved) throw new Error("Project fixture binding is missing");
    const { binding } = saved;
    const peer = RunnerConnectionFenceSchema.parse({
      runnerId: binding.runnerId,
      bootId: binding.runnerBootId,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      connectionGeneration: 1,
    });
    const makeDelivery = () =>
      new ProjectControlDeliveryStore(database, {
        currentRunnerBootId: () => binding.runnerBootId,
        currentPeerIsProjectCapable: () => true,
        canContinue: async () => false,
      });
    const stored = await database
      .transaction()
      .execute((transaction) =>
        new ProjectExecutionStore().enqueueCommand(transaction, {
          binding,
          idempotencyKey: "uncertain-proposal",
          control: {
            kind: "request.refuse",
            requestId: createId("request"),
            callId: "uncertain-call",
            reason: "unsupported-request-kind",
          },
        }),
      );
    const delivery = await makeDelivery().claim(stored.commandId, "before-crash");
    if (delivery.state !== "ready") throw new Error("Project refusal was not ready");
    await makeDelivery().recordResult(peer, {
      ...peer,
      type: "runner.project.control-result",
      binding,
      commandId: stored.commandId,
      correlationId: delivery.correlationId,
      result: { status: "uncertain", message: "Engine receipt lost" },
    });
    // A new Host worker reads only durable state after the receipt transaction committed.
    const events = await makeDelivery().settleUnavailable(stored.commandId);
    expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
    expect(
      (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", binding.runId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("failed");
    expect(
      await database
        .selectFrom("commands")
        .select(["status", "lastError", "originatingGrantId"])
        .where("id", "=", stored.commandId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "unknown",
      lastError: { projectControlResult: { status: "uncertain", message: "Engine receipt lost" } },
      originatingGrantId: binding.grantId,
    });
    expect(await makeDelivery().settleUnavailable(stored.commandId)).toEqual([]);
    expect(
      (
        await database
          .selectFrom("commands")
          .select("payload")
          .where("runId", "=", binding.runId)
          .where("type", "=", "run.control.project")
          .where("status", "=", "pending")
          .executeTakeFirstOrThrow()
      ).payload,
    ).toMatchObject({ binding, control: { kind: "run.interrupt" } });
    expect(project.workspace.id).toBe(binding.workspaceId);
  });
});
