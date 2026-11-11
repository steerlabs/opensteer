import { setProjectRuntimeSettings } from "./project-runtime-settings-store.js";
import { ProjectBindingStore } from "./project-execution-store.js";
import { testModelSelection } from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";
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
  it("keeps a source Run's access ceiling after settings become stronger and rejects a snapshotless forged Run", async ({
    storeFixture,
  }) => {
    const { database, project, prepared, store, origin } =
      await prepareProjectAdmission(storeFixture);
    const configure = (accessMode: "approval-required" | "full-access", revision: number) =>
      setProjectRuntimeSettings(
        database,
        { userId: origin.userId, authorityGeneration: 1 },
        {
          workspaceId: project.workspace.id,
          expectedAccessRevision: 1,
          expectedSettingsRevision: revision,
          commandIdentity: createId("command"),
          harnessInstanceId: prepared.harnessInstance.id,
          modelSelection: testModelSelection,
          accessMode,
          instructions: "Project only",
          timeZone: "UTC",
        },
      );
    await configure("approval-required", 1);
    const admitted = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" },
      content: [{ type: "text", text: "Ask before acting" }],
      policy: "queue",
      idempotencyKey: "restricted-source",
    });
    if (!admitted.runId || !admitted.commandId) throw new Error("Restricted source Run is missing");
    const bound = await new ProjectBindingStore(database, { runnerIsAttached: () => true }).acquire(
      {
        commandId: admitted.commandId,
        runnerId: project.runnerId,
        runnerBootId: `rbt_${randomUUID()}`,
        dispatcherId: "restricted-source",
        leaseTokenHash: "restricted-source",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    );
    await configure("full-access", 2);
    await expect(
      store.delegateProjectWork({
        binding: bound.binding,
        title: "Stronger child",
        content: [{ type: "text", text: "Act without asking" }],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: "project-access-ceiling-exceeded" });
    await expect(
      store.admitProjectWork({
        threadId: prepared.thread.id,
        origin,
        source: { kind: "agent", runId: admitted.runId },
        content: [{ type: "text", text: "Start stronger work" }],
        policy: "report",
        idempotencyKey: "stronger-message",
      }),
    ).rejects.toMatchObject({ reason: "project-access-ceiling-exceeded" });
    const parent = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", admitted.runId)
      .executeTakeFirstOrThrow();
    const seed = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", parent.seedInputId)
      .executeTakeFirstOrThrow();
    const thread = await database
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", parent.threadId)
      .executeTakeFirstOrThrow();
    const { projectRuntime: _runtime, ...identity } = parent.authoritySource;
    const source = { ...identity, parentRunId: parent.id };
    const messageId = createId("message");
    let seedInserted = false;
    await expect(
      database.transaction().execute(async (tx) => {
        await tx
          .insertInto("messages")
          .values({
            id: messageId,
            threadId: thread.id,
            runId: null,
            sequence: thread.nextMessageSequence,
            actorPrincipalId: parent.actorPrincipalId,
            kind: "input",
            author: jsonValue({
              kind: "agent",
              runId: parent.id,
              threadId: thread.id,
              workspaceId: thread.workspaceId,
              workspaceName: project.workspace.name,
              displayName: "Restricted source",
            }),
            content: jsonValue([{ type: "text", text: "Forged stronger work" }]),
          })
          .execute();
        await tx
          .insertInto("threadInputs")
          .values({
            ...seed,
            authoritySource: jsonValue(source),
            messageId,
            runId: null,
            state: "pending",
            policy: "queue",
            queueRank: thread.nextMessageSequence,
            idempotencyKey: "snapshotless-forgery",
          })
          .execute();
        seedInserted = true;
        await tx
          .insertInto("runs")
          .values({
            threadId: parent.threadId,
            environmentId: parent.environmentId,
            harnessInstanceId: parent.harnessInstanceId,
            providerSessionId: parent.providerSessionId,
            actorPrincipalId: parent.actorPrincipalId,
            requestedBy: parent.requestedBy,
            membershipGeneration: parent.membershipGeneration,
            initiatorGeneration: parent.initiatorGeneration,
            originConnectionId: parent.originConnectionId,
            causalChainId: parent.causalChainId,
            replyTarget: null,
            createdAt: new Date(),
            startedAt: null,
            completedAt: null,
            id: createId("run"),
            status: "queued",
            bindingGeneration: null,
            accessMode: "full-access",
            authoritySource: jsonValue(source),
            modelSelection: jsonValue(parent.modelSelection),
            activationInputId: messageId,
            seedInputId: messageId,
            runOrdinal: thread.nextRunOrdinal,
            reportContext: null,
            initialContext: null,
            nextRunnerOrdinal: 0,
          })
          .execute();
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(seedInserted).toBe(true);
    expect(
      await database
        .selectFrom("messages")
        .select("id")
        .where("id", "=", messageId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await database
        .selectFrom("delegations")
        .select("id")
        .where("parentRunId", "=", parent.id)
        .execute(),
    ).toEqual([]);
  });
});
