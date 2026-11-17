import { commitPersonalMutation } from "./personal-mutation.js";

import { finalizeRunTransaction } from "./run-finalization.js";

import { createId, ModelSelectionSchema } from "@opensteer/core";
import { expect } from "vitest";
import { readPersonalDetailSnapshot, readPersonalShellSnapshot } from "./snapshot-store.js";
import { readTranscriptPage } from "./personal-sync-store.js";
import { readPersonalTaskPage } from "./personal-task-store.js";
import { ScopedHostMessageSchema } from "@opensteer/protocol/personal-sync";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  testRunnerDescriptor,
} from "./store.integration.test-support.js";
describeStore("Deployment snapshot history", (it) => {
  it("remembers a human hand-off returned to the queue at finalization", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("waited-returned-steer");
    await database
      .updateTable("runners")
      .set({
        moduleDescriptors: testRunnerDescriptor({
          environmentId: f.environmentId,
          runnerId: f.runnerId,
          runnerKind: "main",
          name: "Hosting computer",
        }).modules,
      })
      .where("id", "=", f.runnerId)
      .execute();
    await database
      .updateTable("threads")
      .set({
        purpose: "voice",
        inputQueuePaused: true,
        inputQueuePausedBy: f.userId,
      })
      .where("id", "=", f.thread.id)
      .execute();
    await database
      .updateTable("messages")
      .set({
        author: {
          kind: "watch",
          displayName: "Watcher",
          activationId: createId("triggerWatchActivation"),
          revisionId: createId("triggerRevision"),
          triggerId: createId("trigger"),
        },
      })
      .where("id", "=", f.run.seedInputId)
      .execute();
    await database
      .updateTable("runs")
      .set({
        personWaited: false,
      })
      .where("id", "=", f.run.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Please help",
        },
      ],
      idempotencyKey: "waited-return",
      policy: "queue",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: f.thread.id,
    });
    await database
      .updateTable("threads")
      .set({
        inputQueuePaused: false,
        inputQueuePausedBy: null,
      })
      .where("id", "=", f.thread.id)
      .execute();
    const steered = await store.steerThreadInput({
      threadId: f.thread.id,
      expectedRunId: f.run.id,
      messageId: queued.message.id,
      requestedBy: f.userId,
      idempotencyKey: "waited-steer",
    });
    expect(steered.command).not.toBeNull();
    await database
      .updateTable("threads")
      .set({
        inputQueuePaused: true,
        inputQueuePausedBy: f.userId,
      })
      .where("id", "=", f.thread.id)
      .execute();
    await commitPersonalMutation(database, (tx) =>
      finalizeRunTransaction(tx, {
        completedAt: new Date(),
        links: {
          threadUrl: (id) => `https://example.test/thread/${id}`,
        },
        queuedInputCancellation: "seed-input",
        runId: f.run.id,
        source: "runner",
        status: "completed",
      }),
    );
    expect(
      await database
        .selectFrom("messages")
        .select("runId")
        .where("id", "=", queued.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      runId: null,
    });
    expect(
      await database
        .selectFrom("runs")
        .select(["personWaited"])
        .where("id", "=", f.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      personWaited: true,
    });
  });

  it("keeps a human-seeded Run stopped before claim", async ({ storeFixture }) => {
    const { database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const f = await createRunFixture("human-stop-before-claim");
    const admitted = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Please help",
        },
      ],
      requestedBy: f.userId,
      idempotencyKey: "human-stop",
      threadId: f.thread.id,
    });
    await commitPersonalMutation(database, (tx) =>
      finalizeRunTransaction(tx, {
        completedAt: new Date(),
        links: {
          threadUrl: (id) => `https://example.test/thread/${id}`,
        },
        queuedInputCancellation: "seed-input",
        runId: admitted.run.id,
        source: "host",
        status: "interrupted",
      }),
    );
    expect(
      await database
        .selectFrom("runs")
        .select(["personWaited"])
        .where("id", "=", admitted.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      personWaited: true,
    });
    expect(
      await readTranscriptPage(database, {
        viewerId: f.userId,
        scope: { kind: "thread", threadId: f.thread.id },
        maxTurns: 10,
      }),
    ).not.toBeNull();
  });
  it("does not count report updates or automatic steers as new turns", async ({ storeFixture }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("automatic-page-boundaries");
    await database
      .updateTable("threads")
      .set({
        purpose: "voice",
      })
      .where("id", "=", f.thread.id)
      .execute();
    const seed = await database
      .selectFrom("transcriptItems")
      .selectAll()
      .where("messageId", "=", f.run.seedInputId)
      .executeTakeFirstOrThrow();
    for (const [index, policy] of (["report", "steer"] as const).entries()) {
      const report = await store.enqueueThreadInput({
        threadId: f.thread.id,
        requestedBy: f.userId,
        policy,
        content: [{ type: "text", text: "Automatic update" }],
        source: { kind: "agent", runId: f.run.id },
        idempotencyKey: `automatic-update-${index}`,
      });
      const item = await database
        .selectFrom("transcriptItems")
        .select("isTurnStart")
        .where("messageId", "=", report.message.id)
        .executeTakeFirst();
      expect(item?.isTurnStart ?? false).toBe(false);
    }
    const page = await readTranscriptPage(database, {
      viewerId: f.userId,
      scope: { kind: "thread", threadId: f.thread.id },
      maxTurns: 1,
    });
    expect(page).toMatchObject({
      kind: "page",
      items: expect.arrayContaining([expect.objectContaining({ id: seed.id })]),
    });
    if (page.kind !== "page") throw new Error("The transcript must be available");
    expect(page.items.filter(({ isTurnStart }) => isTurnStart).map(({ id }) => id)).toEqual([
      seed.id,
    ]);
  });
  it("moves tasks only for admitted human work, including steering a running turn", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("task-asked");
    await database
      .updateTable("runners")
      .set({
        moduleDescriptors: testRunnerDescriptor({
          environmentId: f.environmentId,
          runnerId: f.runnerId,
          runnerKind: "main",
          name: "Hosting computer",
        }).modules,
      })
      .where("id", "=", f.runnerId)
      .execute();
    const other = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "task-asked-other",
      modelSelection: testModelSelection,
      title: "Other",
    });
    expect(other.thread.askedAt).toBe(other.thread.createdAt);
    await database
      .updateTable("threads")
      .set({
        askedAt: new Date("2020-01-01"),
      })
      .where("id", "=", f.thread.id)
      .execute();
    await database
      .updateTable("threads")
      .set({
        askedAt: new Date("2021-01-01"),
      })
      .where("id", "=", other.thread.id)
      .execute();
    const page = () =>
      readPersonalTaskPage(database, {
        viewerId: f.userId,
        window: "recent",
      });
    expect((await page()).tasks.map(({ id }) => id)).toEqual([other.thread.id, f.thread.id]);
    const steer = await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Please change direction",
        },
      ],
      idempotencyKey: "task-asked-steer",
      policy: "steer",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: f.thread.id,
    });
    expect(steer.disposition).toBe("steering");
    const asked = (await page()).tasks[0]!;
    expect(asked.id).toBe(f.thread.id);
    expect(asked.askedAt.getTime()).toBeGreaterThan(Date.parse("2021-01-01"));
    const unchanged = async () =>
      expect((await page()).tasks.find(({ id }) => id === f.thread.id)!.askedAt).toEqual(
        asked.askedAt,
      );
    await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Agent context",
        },
      ],
      idempotencyKey: "task-asked-agent",
      policy: "queue",
      requestedBy: f.userId,
      source: {
        kind: "agent",
        runId: f.run.id,
      },
      threadId: f.thread.id,
    });
    await unchanged();
    const child = await store.delegateThread({
      accessMode: "auto",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "task-asked-child",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: f.run.id,
        parentThreadId: f.thread.id,
      },
      task: [
        {
          type: "text",
          text: "Check something",
        },
      ],
      title: "Child",
    });
    await database
      .updateTable("runs")
      .set({
        status: "completed",
      })
      .where("id", "=", child.run.id)
      .execute();
    await database
      .updateTable("delegations")
      .set({
        status: "completed",
        resultRunId: child.run.id,
        resultText: "Checked",
        finishedAt: new Date(),
      })
      .where("id", "=", child.assignment.id)
      .execute();
    expect(
      (await store.drainAssignmentReturn(child.assignment.id)).some(
        ({ type }) => type === "message.created",
      ),
    ).toBe(true);
    await unchanged();
    await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Human report",
        },
      ],
      idempotencyKey: "task-asked-report",
      policy: "report",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: f.thread.id,
    });
    await unchanged();
    await database
      .updateTable("threads")
      .set({
        titleSource: "provisional",
        iconSource: "provisional",
      })
      .where("id", "=", f.thread.id)
      .execute();
    expect(
      await store.applyGeneratedThreadName({
        threadId: f.thread.id,
        title: "Generated",
        icon: "code",
      }),
    ).not.toBeNull();
    await unchanged();
    await store.renameThread({
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "task-asked-rename",
      title: "Renamed",
    });
    await unchanged();
    await database
      .updateTable("runs")
      .set({
        status: "completed",
      })
      .where("threadId", "=", f.thread.id)
      .execute();
    await store.updateThreadExecutionSelection({
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "task-asked-model",
      harnessInstanceId: f.harnessInstance.id,
      continuationIdentity: testContinuationIdentity,
      modelSelection: ModelSelectionSchema.parse({
        ...testModelSelection,
        modelId: "another-model",
      }),
    });
    await unchanged();
    await database
      .updateTable("threads")
      .set({
        askedAt: new Date("2020-01-01"),
      })
      .where("id", "=", other.thread.id)
      .execute();
    await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Start other",
        },
      ],
      idempotencyKey: "task-asked-human",
      policy: "queue",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: other.thread.id,
    });
    expect((await page()).tasks[0]!.id).toBe(other.thread.id);
  });
  it("builds addressed shell and detail cuts within their budgets without reading message bodies", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture, openLiveRequest } = storeFixture;
    const f = await startRunFixture("bounded-scoped-snapshots");
    const requestId = createId("request");
    await openLiveRequest(f, requestId);
    let messageQueries = 0;
    const observed = database.withPlugin({
      transformQuery({ node }) {
        if (JSON.stringify(node).includes('"name":"messages"')) messageQueries += 1;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const shell = await readPersonalShellSnapshot(observed, {
      viewerId: f.userId,
      selectedThreadId: f.thread.id,
    });
    const scope = { kind: "thread" as const, threadId: f.thread.id };
    const detail = await readPersonalDetailSnapshot(observed, { viewerId: f.userId, scope });
    expect(shell.kind).toBe("snapshot");
    expect(detail.kind).toBe("snapshot");
    if (shell.kind !== "snapshot" || detail.kind !== "snapshot")
      throw new Error("Expected both cuts");
    expect(shell.snapshot.tasks).toContainEqual(expect.objectContaining({ id: f.thread.id }));
    expect(detail.snapshot.queue?.runs).toContainEqual(expect.objectContaining({ id: f.run.id }));
    expect(detail.snapshot.pendingRequests).toContainEqual(
      expect.objectContaining({ id: requestId }),
    );
    expect(detail.snapshot.items).toContainEqual(
      expect.objectContaining({ id: f.run.seedInputId }),
    );
    for (const [cut, frameScope, subscriptionId] of [
      [shell, { kind: "shell" }, "shell"],
      [detail, scope, "detail:0"],
    ] as const) {
      expect(
        ScopedHostMessageSchema.safeParse({
          type: "host.snapshot",
          scope: frameScope,
          subscriptionId,
          generation: 1,
          throughSequence: cut.state.sequence,
          snapshot: cut.snapshot,
        }).success,
      ).toBe(true);
    }
    expect(messageQueries).toBe(0);
    expect(shell.state.sequence).toBe(detail.state.sequence);
  });
});
