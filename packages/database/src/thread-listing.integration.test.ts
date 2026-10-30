import { createId, type MessageAuthor, type ThreadId } from "@opensteer/core";
import { expect } from "vitest";
import { jsonValue } from "./store-primitives.js";
import { describeStore, testModelSelection } from "./store.integration.test-support.js";

describeStore("person-asked Thread listing", (it) => {
  it("lists only human-seeded Chat delegations and promotes on re-task", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const f = await startRunFixture("listing");
    await database
      .updateTable("threads")
      .set({ role: "conversation" })
      .where("id", "=", f.thread.id)
      .execute();
    const human = (
      await database
        .selectFrom("messages")
        .select("author")
        .where("id", "=", f.run.seedInputId)
        .executeTakeFirstOrThrow()
    ).author;
    const delegate = (key: string, threadId?: ThreadId) =>
      store.delegateThread({
        accessMode: "auto",
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey: key,
        modelSelection: testModelSelection,
        origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
        task: [{ type: "text", text: key }],
        title: key,
        workspaceId: f.workspace.id,
        ...(threadId ? { threadId } : {}),
      });
    const asked = await delegate("asked");
    expect(asked.thread.listed).toBe(true);
    expect(asked.events.filter((event) => event.type === "thread.created")).toMatchObject([
      { data: { thread: { listed: true } } },
    ]);
    expect(asked.events.some((event) => event.type === "thread.listed")).toBe(false);
    const authors: MessageAuthor[] = [
      { kind: "platform", cause: "assignment-result" },
      {
        kind: "agent",
        displayName: "Worker",
        runId: f.run.id,
        threadId: f.thread.id,
        workspaceId: f.workspace.id,
        workspaceName: "Main",
      },
      {
        kind: "trigger",
        displayName: "Schedule",
        occurrenceId: createId("triggerOccurrence"),
        source: "schedule",
        triggerId: createId("trigger"),
      },
      {
        kind: "watch",
        displayName: "Watch",
        activationId: createId("triggerWatchActivation"),
        revisionId: createId("triggerRevision"),
        triggerId: createId("trigger"),
      },
    ];
    for (const author of authors) {
      await database
        .updateTable("messages")
        .set({
          author: jsonValue(author),
          kind: author.kind === "platform" ? "continuation" : "input",
        })
        .where("id", "=", f.run.seedInputId)
        .execute();
      expect((await delegate(`seed-${author.kind}`)).thread.listed).toBe(false);
    }
    await database
      .updateTable("messages")
      .set({ author: jsonValue(human), kind: "input" })
      .where("id", "=", f.run.seedInputId)
      .execute();
    await database
      .updateTable("threads")
      .set({ role: "work" })
      .where("id", "=", f.thread.id)
      .execute();
    const helper = await delegate("helper");
    expect(helper.thread.listed).toBe(false);
    // Complete the worker's current task before handing it another one.
    await store.cancelAssignment({
      assignmentId: helper.assignment.id,
      requestedBy: f.userId,
      idempotencyKey: "cancel-helper",
    });
    await database
      .updateTable("threads")
      .set({ role: "conversation" })
      .where("id", "=", f.thread.id)
      .execute();
    const promoted = await delegate("promote", helper.thread.id);
    expect(promoted.thread.listed).toBe(true);
    expect(promoted.events.filter((event) => event.type === "thread.listed")).toMatchObject([
      { data: { thread: { listed: true } } },
    ]);
  });

  it("keeps a person's child inside a task, and lists one they make in Chat", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database, store } = storeFixture;
    const f = await createRunFixture("person-child");
    const create = (key: string) =>
      store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey: key,
        modelSelection: testModelSelection,
        parentThreadId: f.thread.id,
        title: key,
        workspaceId: f.workspace.id,
      });
    expect((await create("inside-task")).thread.listed).toBe(false);
    await database
      .updateTable("threads")
      .set({ role: "conversation" })
      .where("id", "=", f.thread.id)
      .execute();
    expect((await create("from-chat")).thread.listed).toBe(true);
  });

  for (const kind of ["trigger", "watch"] as const) {
    it(`never lists ${kind} work on Chat, including a re-tasked helper`, async ({
      storeFixture,
    }) => {
      const { startRunFixture, startTriggerOccurrence, store, database, triggers } = storeFixture;
      const f = await startRunFixture(`automation-${kind}`);
      const base = {
        accessMode: "auto" as const,
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        modelSelection: testModelSelection,
        task: [{ type: "text" as const, text: "Work" }],
        title: "Worker",
        workspaceId: f.workspace.id,
      };
      const helper = await store.delegateThread({
        ...base,
        idempotencyKey: "helper",
        origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
      });
      expect(helper.thread.listed).toBe(false);
      await store.cancelAssignment({
        assignmentId: helper.assignment.id,
        requestedBy: f.userId,
        idempotencyKey: "stop-helper",
      });
      await database
        .updateTable("threads")
        .set({ role: "conversation" })
        .where("id", "=", f.thread.id)
        .execute();
      const occurrence = await startTriggerOccurrence(f, kind);
      const watch =
        kind === "watch"
          ? await triggers.create({
              actorThreadId: null,
              anchorThreadId: f.thread.id,
              createdBy: f.userId,
              idempotencyKey: "watch",
              name: "Watch",
              program: {
                toolContractVersion: 2,
                language: "javascript",
                source: "export default async () => null",
              },
              source: { kind: "watch" },
            })
          : null;
      const watches = watch
        ? await triggers.reconcileWatchesForRunner({
            environmentId: f.environmentId,
            leaseExpiresAt: new Date(Date.now() + 60000),
            runnerBootId: "watch-listing",
            runnerConnectionGeneration: 1,
            runnerId: f.runnerId,
          })
        : null;
      const activation = watches?.activations[0]?.activation;
      if (kind === "watch") expect(activation).toBeDefined();
      const origin =
        watch && activation
          ? {
              kind: "watch" as const,
              activationId: activation.id,
              observationId: "listing",
              revisionId: watch.revision.id,
              triggerId: watch.trigger.id,
              parentThreadId: f.thread.id,
            }
          : { kind: "trigger" as const, occurrenceId: occurrence.id, parentThreadId: f.thread.id };
      for (const threadId of [undefined, helper.thread.id]) {
        const result = await store.delegateThread({
          ...base,
          idempotencyKey: `automation-${threadId ?? "new"}`,
          origin,
          ...(threadId ? { threadId } : {}),
        });
        expect(result.thread.listed).toBe(false);
        expect(result.events.some((event) => event.type === "thread.listed")).toBe(false);
      }
    });
  }
});
