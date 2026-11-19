import { createId, type MessageAuthor, type ThreadId } from "@opensteer/core";
import { expect } from "vitest";
import { jsonValue } from "./store-primitives.js";
import { describeStore, testModelSelection } from "./store.integration.test-support.js";
describeStore("person-asked Thread listing", (it) => {
  it("lists only human-seeded Voice delegations and promotes on re-task", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const f = await startRunFixture("listing");
    await database
      .updateTable("threads")
      .set({
        purpose: "voice",
      })
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
        origin: {
          kind: "run",
          parentRunId: f.run.id,
          parentThreadId: f.thread.id,
        },
        task: [
          {
            type: "text",
            text: key,
          },
        ],
        title: key,
        ...(threadId
          ? {
              threadId,
            }
          : {}),
      });
    const asked = await delegate("asked");
    expect(asked.thread.listed).toBe(true);
    const listedChanges = (threadId: ThreadId) =>
      database
        .selectFrom("clientChanges")
        .select("payload")
        .where("scopeKey", "=", "shell")
        .where("entityKind", "=", "task")
        .where("entityId", "=", threadId)
        .where("operation", "=", "upsert")
        .execute();
    expect(await listedChanges(asked.thread.id)).toMatchObject([
      { payload: { id: asked.thread.id, title: asked.thread.title } },
    ]);
    const authors: MessageAuthor[] = [
      {
        kind: "platform",
        cause: "assignment-result",
      },
      {
        kind: "agent",
        displayName: "Worker",
        runId: f.run.id,
        threadId: f.thread.id,
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
      .set({
        author: jsonValue(human),
        kind: "input",
      })
      .where("id", "=", f.run.seedInputId)
      .execute();
    await database
      .updateTable("threads")
      .set({
        purpose: "task",
      })
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
      .set({
        purpose: "voice",
      })
      .where("id", "=", f.thread.id)
      .execute();
    const promoted = await delegate("promote", helper.thread.id);
    expect(promoted.thread.listed).toBe(true);
    expect(await listedChanges(promoted.thread.id)).toMatchObject([
      { payload: { id: helper.thread.id } },
    ]);
  });
  it("keeps a person's child inside its parent, including Voice", async ({ storeFixture }) => {
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
      });
    expect((await create("inside-task")).thread.listed).toBe(false);
    await database
      .updateTable("threads")
      .set({
        purpose: "voice",
      })
      .where("id", "=", f.thread.id)
      .execute();
    expect((await create("from-voice")).thread.listed).toBe(false);
  });
  for (const kind of ["trigger", "watch"] as const) {
    it(`keeps ${kind} work unlisted, including a re-tasked helper`, async ({ storeFixture }) => {
      const { startRunFixture, startTriggerOccurrence, store, triggers, database } = storeFixture;
      const f = await startRunFixture(`automation-${kind}`);
      const base = {
        accessMode: "auto" as const,
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        modelSelection: testModelSelection,
        task: [
          {
            type: "text" as const,
            text: "Work",
          },
        ],
        title: "Worker",
      };
      const helper = await store.delegateThread({
        ...base,
        idempotencyKey: "helper",
        origin: {
          kind: "run",
          parentRunId: f.run.id,
          parentThreadId: f.thread.id,
        },
      });
      expect(helper.thread.listed).toBe(false);
      await store.cancelAssignment({
        assignmentId: helper.assignment.id,
        requestedBy: f.userId,
        idempotencyKey: "stop-helper",
      });
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
                toolContractVersion: 5,
                language: "javascript",
                source: "export default async () => null",
              },
              source: {
                kind: "watch",
              },
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
          : {
              kind: "trigger" as const,
              occurrenceId: occurrence.id,
              parentThreadId: f.thread.id,
            };
      for (const threadId of [undefined, helper.thread.id]) {
        const result = await store.delegateThread({
          ...base,
          idempotencyKey: `automation-${threadId ?? "new"}`,
          origin,
          ...(threadId
            ? {
                threadId,
              }
            : {}),
        });
        expect(result.thread.listed).toBe(false);
        expect(
          await database
            .selectFrom("clientChanges")
            .select("entityId")
            .where("scopeKey", "=", "shell")
            .where("entityKind", "=", "task")
            .where("operation", "=", "upsert")
            .where("entityId", "=", result.thread.id)
            .execute(),
        ).toEqual([]);
      }
    });
  }
});
