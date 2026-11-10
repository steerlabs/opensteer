import { ProjectRunBindingSchema, createId } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import {
  createProjectIdentityFixture,
  insertProjectRunFixture,
} from "./project-work.test-support.js";
import { ProjectExecutionStore } from "./project-execution-store.js";

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
    await expect(
      database
        .updateTable("commands")
        .set({ payload: {} })
        .where("id", "=", stored[0]?.id ?? createId("command"))
        .execute(),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
