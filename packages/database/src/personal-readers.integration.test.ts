import { personTaskReader } from "./task-reader.js";
import { BrowserHistoryStore } from "./browser-history-store.js";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { readAgentRequest } from "./request-agent-response.js";
import { createId, ModelIdSchema } from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import { expect } from "vitest";
import type { DatabaseSchema } from "./schema.js";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";
import {
  agentThreadPageForOwner,
  getAssignmentForOwner,
  listThreadAssignmentsForOwner,
  ownerThreadPageForOwner,
  readThreadForOwner,
  getThreadInputQueue,
  findThreadCreationByIdempotency,
} from "./thread-store.js";
import { readAgentThreadActivity, readAgentThreadRecent } from "./agent-thread-history.js";
import { readThreadWaitSnapshot } from "./thread-wait.js";
import { RequestStore } from "./request-store.js";
import { assertActiveExecutionBinding, assertActiveGrant } from "./execution-store.js";
import { NotificationStore } from "./notification-store.js";
import { readHarnessCatalogModelPage } from "./harness-store.js";
import { testReadyHarnessCatalog } from "./store.integration.test-support.js";

type Fixture = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;
const readers: Record<string, (tx: Transaction<DatabaseSchema>, f: Fixture) => Promise<unknown>> = {
  "computer policy": (tx, f) =>
    new IntegrationPlatformStore(tx).getComputerUsePolicy({
      runnerId: f.runnerId,
      ownerUserId: f.userId,
    }),
  "agent request": async (tx, f) => {
    await expect(
      readAgentRequest(
        tx,
        {
          kind: "run",
          userId: f.userId,
          accessMode: "full-access",
          scope: { ...f, requestedBy: f.userId, runId: f.run.id, threadId: f.thread.id },
        },
        createId("request"),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  },
  "durable Passwords authority": (tx, f) =>
    new RequestStore(tx).hasDurablePasswordSignInRequestAuthority({
      ownerId: f.userId,
      requestId: createId("request"),
    }),
  "live Passwords authority": async (tx, f) => {
    expect(
      await new RequestStore(tx).hasActiveRunPasswordSignInAuthority({
        requestedBy: f.userId,
        originatingRunId: f.run.id,
        originatingThreadId: f.thread.id,
      }),
    ).toBe(true);
  },
  "owner task page": (tx, f) => ownerThreadPageForOwner(tx, { ownerId: f.userId }),
  "agent task page": (tx, f) =>
    agentThreadPageForOwner(tx, {
      reader: personTaskReader,
      ownerId: f.userId,
      scope: { kind: "personal" },
      scopeId: f.userId,
    }),
  "assignment lookup": (tx, f) =>
    getAssignmentForOwner(tx, {
      ownerId: f.userId,
      assignmentId: createId("delegation"),
      reader: personTaskReader,
    }),
  "assignment page": (tx, f) =>
    listThreadAssignmentsForOwner(tx, { ownerId: f.userId, threadId: f.thread.id }),
  "task messages": (tx, f) => readThreadForOwner(tx, f.thread.id, f.userId),
  "agent recent runs": (tx, f) =>
    readAgentThreadRecent(tx, { ownerId: f.userId, threadId: f.thread.id, runLimit: 5 }),
  "agent activity": (tx, f) =>
    readAgentThreadActivity(tx, { ownerId: f.userId, threadId: f.thread.id, limit: 5 }),
  "wait snapshot": (tx, f) =>
    readThreadWaitSnapshot(tx, { userId: f.userId, threadId: f.thread.id }),
  "waiting requests": (tx, f) =>
    new RequestStore(tx).waitingOnUserPage({ userId: f.userId, limit: 5 }),
  "visible requests": (tx, f) =>
    new RequestStore(tx).visiblePage({ originatingThreadId: f.thread.id, limit: 5 }),
  "input queue": (tx, f) =>
    getThreadInputQueue(tx, { requestedBy: f.userId, threadId: f.thread.id }),
  "create receipt": (tx, f) =>
    findThreadCreationByIdempotency(tx, {
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "not-created",
      title: "Receipt lookup",
      modelSelection: f.thread.modelSelection,
    }),
  "execution binding": (tx, f) =>
    assertActiveExecutionBinding(tx, {
      ...f,
      requestedBy: f.userId,
      runId: f.run.id,
      threadId: f.thread.id,
    }),
  "active grant": (tx, f) =>
    assertActiveGrant(tx, { ...f, requestedBy: f.userId, runId: f.run.id, threadId: f.thread.id }),
  "notification account subjects": (tx, f) => new NotificationStore(tx).accountSubjects(f.userId),
};

describeStore("Personal readers", (it) => {
  it("seeks consecutive model rows within one authorized harness catalog", async ({
    storeFixture,
  }) => {
    const { database, store, createRunFixture } = storeFixture;
    const f = await createRunFixture("catalog-model-page");
    const ready = testReadyHarnessCatalog(f.harnessInstance.id);
    const models = ["zulu", "alpha", "beta"].map((modelId) => ({
      ...ready.models[0]!,
      modelId: ModelIdSchema.parse(modelId),
    }));
    await store.recordHarnessCatalogs({
      environmentId: f.environmentId,
      catalogs: [{ ...ready, models }],
      expectedRevisions: new Map([[f.harnessInstance.id, f.harnessInstance.runtimeRevision]]),
    });
    const first = await readHarnessCatalogModelPage(database, f.userId, { limit: 2 });
    const last = first.at(-1)!;
    expect(first.map(({ ordinal, catalog }) => [ordinal, catalog.models])).toEqual([
      [1, [models[0]]],
      [2, [models[1]]],
    ]);
    const next = await readHarnessCatalogModelPage(database, f.userId, {
      after: [last.environmentId, last.harnessInstanceId, last.ordinal],
      limit: 2,
    });
    expect(next.map(({ ordinal, catalog }) => [ordinal, catalog.models])).toEqual([
      [3, [models[2]]],
    ]);
    expect(await readHarnessCatalogModelPage(database, createId("user"), { limit: 2 })).toEqual([]);
  });
  it("reads profile history and icon bytes in a read-only transaction", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("history-read-only");
    await storeFixture.database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();
    const profile = await storeFixture.store.createBrowserProfile({
      ownerId: f.userId,
      name: "History",
      idempotencyKey: "history-profile",
    });
    const favicon =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=";
    await storeFixture.store.browserHistory.recordVisit({
      profileId: profile.id,
      ownerId: f.userId,
      url: "https://example.com/",
      title: "Example",
      typed: false,
      favicon,
    });
    await storeFixture.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => {
        await sql`set transaction read only`.execute(tx);
        const history = new BrowserHistoryStore(tx);
        const page = await history.list(profile.id, f.userId);
        expect(page.entries).toMatchObject([{ url: "https://example.com/" }]);
        expect(
          await history.icons(
            profile.id,
            f.userId,
            page.icons.map(({ iconRef }) => iconRef),
          ),
        ).toEqual({ icons: [{ iconRef: page.icons[0]!.iconRef, favicon }] });
      });
  });
  it("lists both parent and child assignments newest-first with exact counts across pages", async ({
    storeFixture,
  }) => {
    const { store, startRunFixture } = storeFixture;
    const root = await startRunFixture("assignment-root");
    const middle = await store.delegateThread({
      accessMode: "full-access",
      createdBy: root.userId,
      environmentId: root.environmentId,
      harnessInstanceId: root.harnessInstance.id,
      idempotencyKey: "assignment-middle",
      modelSelection: root.thread.modelSelection,
      origin: { kind: "run", parentRunId: root.run.id, parentThreadId: root.thread.id },
      task: [{ type: "text", text: "Middle task" }],
      title: "Middle",
    });
    await storeFixture.database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", middle.run.id)
      .execute();
    const childOne = await store.delegateThread({
      accessMode: "full-access",
      createdBy: root.userId,
      environmentId: root.environmentId,
      harnessInstanceId: root.harnessInstance.id,
      idempotencyKey: "assignment-child-1",
      modelSelection: root.thread.modelSelection,
      origin: { kind: "run", parentRunId: middle.run.id, parentThreadId: middle.thread.id },
      task: [{ type: "text", text: "Child 1" }],
      title: "Child 1",
    });
    const childTwo = await store.delegateThread({
      accessMode: "full-access",
      createdBy: root.userId,
      environmentId: root.environmentId,
      harnessInstanceId: root.harnessInstance.id,
      idempotencyKey: "assignment-child-2",
      modelSelection: root.thread.modelSelection,
      origin: { kind: "run", parentRunId: middle.run.id, parentThreadId: middle.thread.id },
      task: [{ type: "text", text: "Child 2" }],
      title: "Child 2",
    });
    const all = await store.listThreadAssignmentsForOwner({
      ownerId: root.userId,
      threadId: middle.thread.id,
      maxItems: 10,
    });
    expect(all?.window.hasMore).toBe(false);
    expect(all?.window.totalItems).toBe(3);
    expect(all?.assignments.map(({ id }) => id)).toEqual([
      childTwo.assignment.id,
      childOne.assignment.id,
      middle.assignment.id,
    ]);
    const page1 = await store.listThreadAssignmentsForOwner({
      ownerId: root.userId,
      threadId: middle.thread.id,
      maxItems: 2,
    });
    expect(page1?.window.hasMore).toBe(true);
    expect(page1?.window.totalItems).toBe(3);
    expect(page1?.assignments.map(({ id }) => id)).toEqual([
      childTwo.assignment.id,
      childOne.assignment.id,
    ]);
    const page2 = await store.listThreadAssignmentsForOwner({
      ownerId: root.userId,
      threadId: middle.thread.id,
      maxItems: 2,
      before: page1!.window.nextBefore!,
    });
    expect(page2?.window.hasMore).toBe(false);
    expect(page2?.window.totalItems).toBe(3);
    expect(page2?.assignments.map(({ id }) => id)).toEqual([middle.assignment.id]);
  });
  for (const [name, read] of Object.entries(readers)) {
    it(`reads ${name} without taking a mutation lock`, async ({ storeFixture }) => {
      const f = await storeFixture.startRunFixture("read-only");
      await storeFixture.database
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute(async (tx) => {
          await sql`set transaction read only`.execute(tx);
          await read(tx, f);
          expect(
            (await sql<{ transactionReadOnly: string }>`show transaction_read_only`.execute(tx))
              .rows,
          ).toEqual([{ transactionReadOnly: "on" }]);
        });
    });
  }
});
