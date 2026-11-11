import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createId } from "@opensteer/core";
import { describeStore } from "./store.integration.test-support.js";
import { prepareProjectAdmission } from "./project-work.test-support.js";
import { readProjectRunBinding } from "./execution-authority.js";

describeStore("Project task reuse and local titles", (it) => {
  it("reuses an idle task without borrowing its creator as authority, preserves its history and refuses another active assignment", async ({
    storeFixture,
  }) => {
    const { database, project, prepared, store, origin } = await prepareProjectAdmission(
      storeFixture,
      true,
    );
    const creator = await storeFixture.store.createUser("Earlier task creator");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", creator)
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: project.workspace.id,
        userId: creator,
        role: "owner",
        state: "active",
        generation: "1",
      })
      .execute();
    const target = (
      await store.createProjectThread({
        workspaceId: project.workspace.id,
        origin: { ...origin, userId: creator },
        title: "Existing task history",
        role: "work",
        home: false,
        idempotencyKey: "existing-task",
      })
    ).thread;
    const earlier = await store.admitProjectWork({
      threadId: target.id,
      origin: { ...origin, userId: creator },
      source: { kind: "human" },
      content: [{ type: "text", text: "An earlier accepted message" }],
      policy: "report",
      idempotencyKey: "earlier-message",
    });
    const grant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", prepared.run.id)
      .executeTakeFirstOrThrow();
    const saved = await readProjectRunBinding(database, {
      runId: prepared.run.id,
      grantId: grant.id,
    });
    if (!saved) throw new Error("Parent binding is missing");
    const request = {
      binding: saved.binding,
      threadId: target.id,
      title: "New assignment",
      content: [{ type: "text" as const, text: "Continue the existing task" }],
      idempotencyKey: randomUUID(),
    };
    const reused = await store.delegateProjectWork(request);
    expect(reused.threadId).toBe(target.id);
    expect(reused.events.filter((event) => event.type === "thread.created")).toEqual([]);
    expect(await store.delegateProjectWork(request)).toMatchObject({
      runId: reused.runId,
      assignmentId: reused.assignmentId,
      wasDuplicate: true,
    });
    expect(
      await database
        .selectFrom("threads")
        .select(["createdBy", "createdByPrincipalId", "title"])
        .where("id", "=", target.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      createdBy: creator,
      createdByPrincipalId: project.principalId,
      title: "Existing task history",
    });
    expect(
      await database
        .selectFrom("runs")
        .select([
          "requestedBy",
          "actorPrincipalId",
          "initiatorGeneration",
          "membershipGeneration",
          "originConnectionId",
        ])
        .where("id", "=", reused.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      requestedBy: origin.userId,
      actorPrincipalId: project.principalId,
      initiatorGeneration: "1",
      membershipGeneration: "1",
      originConnectionId: null,
    });
    expect(
      await database
        .selectFrom("messages")
        .select("id")
        .where("id", "=", earlier.input.messageId)
        .executeTakeFirst(),
    ).toEqual({ id: earlier.input.messageId });
    await expect(
      store.delegateProjectWork({ ...request, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ reason: "task-reuse-busy" });
  });

  it("derives a local title and both Assignment cards from Project work, keeps chosen titles and never consults automatic models", async ({
    storeFixture,
  }) => {
    const { database, project, prepared, store } = await prepareProjectAdmission(
      storeFixture,
      true,
    );
    const grant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", prepared.run.id)
      .executeTakeFirstOrThrow();
    const saved = await readProjectRunBinding(database, {
      runId: prepared.run.id,
      grantId: grant.id,
    });
    if (!saved) throw new Error("Parent binding is missing");
    const child = await store.delegateProjectWork({
      binding: saved.binding,
      title: "Provisional task",
      titleSource: "provisional",
      content: [{ type: "text", text: "  Name from the Project message\nKeep working" }],
      idempotencyKey: randomUUID(),
    });
    expect((await store.projectNamingCandidates(100)).map((row) => row.id)).toContain(
      child.threadId,
    );
    const events = await store.nameProjectThread(child.threadId);
    expect(
      await database
        .selectFrom("threads")
        .select(["title", "titleSource"])
        .where("id", "=", child.threadId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ title: "Name from the Project message", titleSource: "generated" });
    expect(
      events
        .filter((event) => event.type === "assignment.updated")
        .map((event) => event.threadId)
        .sort(),
    ).toEqual([prepared.thread.id, child.threadId].sort());
    expect(await store.nameProjectThread(child.threadId)).toEqual([]);
    expect(await store.nameProjectThread(prepared.thread.id)).toEqual([]);
    expect(project.workspace.id).toBe(saved.binding.workspaceId);
  });
});
