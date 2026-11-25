import { createId } from "@opensteer/core";
import { isConnectedAgentTask } from "@opensteer/client/host";
import {
  AgentConnectionStore,
  beginAgentSession,
  endAgentSessions,
  republishThreads,
} from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { createPersonalRunFixturePort } from "@opensteer/database/test-support/personal-run";
import type { PersonalResumeCursor, ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { describe, expect, it } from "vitest";
import type { HostServerDependencies } from "../server.js";
import {
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../runtime/private-machine-host.test-support.js";
import { createPersonalReads } from "./personal-reads.js";
import type { PersonalResources } from "./personal-resources.js";

type Reads = ReturnType<typeof createPersonalReads>;
type Session = Parameters<Reads["readCut"]>[0];

async function fixture(database: { url: string }) {
  const host = await startPrivateMachineHost(database.url, { logger: false });
  const shell = await host.api["personal.shell.get"]({});
  if (!shell.ok) throw new Error(shell.error.message);
  const { session } = shell.data;
  const owner = { id: session.sessionId, user: session.user } as Session;
  const other = { ...owner, id: createId("authSession") } as Session;
  const resources = { initial: async () => [] } as unknown as PersonalResources;
  const reads = createPersonalReads({ store: host.store } as HostServerDependencies, resources);
  const state = () =>
    host.store.database.selectFrom("clientSyncState").selectAll().executeTakeFirstOrThrow();
  return { host, owner, other, reads, state, surface: session.sessionSurface };
}

it("carries connection lineage on the owner's task views", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const { ownerId, store } = host;
    const tasks = createPersonalRunFixturePort(store);
    const { thread: ownerTask } = await tasks.createTask({ ownerId, suffix: "origin-owner" });
    const { id: environmentId, runnerId } = (await store.getEnvironment(ownerTask.environmentId))!;
    if (!runnerId) throw new Error("Fixture task needs a hosting computer");
    const connections = new AgentConnectionStore(store.database);
    const connection = await connections.create({
      userId: ownerId,
      clientName: "Fixture agent",
      label: "Fixture agent",
      accessMode: "full-access",
      grant: { scope: "everything" },
      resource: "https://fixture.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await connections.activate(connection.id, crypto.randomUUID())).toBe(true);
    const create = (
      title: string,
      authority?: Parameters<typeof store.createThread>[0]["authority"],
    ) =>
      store.createThread({
        ...(authority ? { authority } : {}),
        createdBy: ownerId,
        environmentId,
        harnessInstanceId: ownerTask.harnessInstanceId,
        modelSelection: ownerTask.modelSelection,
        idempotencyKey: `origin:${title}`,
        title,
      });
    const { thread: delegated } = await create("Connection task", {
      kind: "connection",
      connectionId: connection.id,
      userId: ownerId,
      accessMode: "full-access",
    });
    const createFromRun = async (threadId: typeof ownerTask.id, title: string) => {
      const started = await tasks.startTask(threadId, title);
      return create(title, {
        kind: "run",
        userId: ownerId,
        accessMode: "full-access",
        scope: {
          bindingGeneration: started.bindingGeneration,
          runnerBootId: started.runnerBootId,
          runId: started.runId,
          runnerId,
          environmentId,
          threadId,
          requestedBy: ownerId,
        },
      });
    };
    const { thread: withinLineage } = await createFromRun(delegated.id, "Run with lineage");
    const { thread: ordinary } = await createFromRun(ownerTask.id, "Run without lineage");
    const { session: direct } = await beginAgentSession(store.database, {
      userId: ownerId,
      agentConnectionId: connection.id,
    });
    expect(delegated).not.toHaveProperty("originConnectionId");
    expect(withinLineage).not.toHaveProperty("originConnectionId");

    const shell = await host.api["personal.shell.get"]({});
    if (!shell.ok) throw new Error(shell.error.message);
    const row = (id: string) => shell.data.tasks.find((task) => task.id === id)!;
    for (const task of [delegated, withinLineage])
      expect(row(task.id)).toHaveProperty("originConnectionId", connection.id);
    for (const task of [ownerTask, ordinary]) {
      expect(row(task.id)).toBeDefined();
      expect(row(task.id)).not.toHaveProperty("originConnectionId");
    }
    expect(row(direct.threadId)).toMatchObject({ externalWork: { sessionId: direct.id } });
    expect(row(direct.threadId)).not.toHaveProperty("originConnectionId");

    const page = await host.api["tasks.page"]({});
    if (!page.ok) throw new Error(page.error.message);
    const paged = page.data.tasks.find(({ thread }) => thread.id === withinLineage.id)!;
    expect(paged).toHaveProperty("originConnectionId", connection.id);
    expect(paged.thread).not.toHaveProperty("originConnectionId");
    const ordinaryEntry = page.data.tasks.find(({ thread }) => thread.id === ordinary.id)!;
    expect(ordinaryEntry).toBeDefined();
    expect(ordinaryEntry).not.toHaveProperty("originConnectionId");
    expect(shell.data.activeTaskIds).toContain(direct.threadId);
    const active = await host.api["tasks.page"]({ active: true });
    if (!active.ok) throw new Error(active.error.message);
    const directEntry = active.data.tasks.find(({ thread }) => thread.id === direct.threadId);
    expect(directEntry).toBeDefined();
    expect(directEntry).not.toHaveProperty("originConnectionId");

    const detail = await host.api["thread.snapshot.get"]({ threadId: delegated.id });
    if (!detail.ok) throw new Error(detail.error.message);
    expect(detail.data.thread).toHaveProperty("originConnectionId", connection.id);
    expect(detail.data.thread.thread).not.toHaveProperty("originConnectionId");

    await endAgentSessions(store.database, {
      userId: ownerId,
      sessionIds: [direct.id],
      reason: "stopped",
    });
    // A quiet move puts this task outside the open shell window.
    await store.database
      .updateTable("threads")
      .set({ doneAt: new Date(), doneReason: "quiet", status: "idle" })
      .where("id", "=", direct.threadId)
      .execute();
    const after = await host.api["personal.shell.get"]({});
    if (!after.ok) throw new Error(after.error.message);
    expect(after.data.tasks.some(({ id }) => id === direct.threadId)).toBe(false);
    const done = await host.api["tasks.page"]({ done: true });
    if (!done.ok) throw new Error(done.error.message);
    expect(done.data.tasks.some(({ thread }) => thread.id === direct.threadId)).toBe(false);
    const quiet = await host.api["thread.snapshot.get"]({ threadId: direct.threadId });
    if (!quiet.ok) throw new Error(quiet.error.message);
    expect(quiet.data.thread).toMatchObject({
      thread: { doneReason: "quiet" },
      externalWork: { sessionId: direct.id, status: "ended", connection: { id: connection.id } },
    });
    expect(isConnectedAgentTask(quiet.data.thread)).toBe(true);
  } finally {
    await host?.close();
    await database.drop();
  }
});

describe("owner task window totals", () => {
  it.each([false, true])(
    "counts and pages the person's tasks (connected agent: %s)",
    async (withAgent) => {
      const database = await cloneTestDatabase("host");
      let host: PrivateMachineHost | undefined;
      try {
        host = await startPrivateMachineHost(database.url, { logger: false });
        const { ownerId, store, api } = host;
        const tasks = createPersonalRunFixturePort(store);
        const ownerTasks = [];
        for (let index = 0; index < 30; index++) {
          const { threadId } = await tasks.createTask({ ownerId, suffix: `window-owner-${index}` });
          ownerTasks.push(threadId);
        }
        const doneTasks = withAgent ? ownerTasks.slice(0, 3) : ownerTasks;
        const agentTasks = [];
        if (withAgent) {
          const connections = new AgentConnectionStore(store.database);
          const connection = await connections.create({
            userId: ownerId,
            clientName: "Fixture agent",
            label: "Fixture agent",
            accessMode: "full-access",
            grant: { scope: "everything" },
            resource: "https://fixture.test/mcp",
            expiresAt: new Date(Date.now() + 600_000),
          });
          expect(await connections.activate(connection.id, crypto.randomUUID())).toBe(true);
          for (let index = 0; index < 30; index++) {
            const { session } = await beginAgentSession(store.database, {
              userId: ownerId,
              agentConnectionId: connection.id,
            });
            agentTasks.push(session.threadId);
            await endAgentSessions(store.database, {
              userId: ownerId,
              sessionIds: [session.id],
              reason: "narrowed",
            });
          }
        }
        await store.database
          .updateTable("threads")
          .set({ doneAt: new Date(), doneReason: "quiet", status: "idle" })
          .where("id", "in", [...doneTasks, ...agentTasks])
          .execute();
        const done = await api["tasks.page"]({ done: true });
        if (!done.ok) throw new Error(done.error.message);
        expect.soft(done.data.window, "first Done page").toMatchObject({
          totalItems: doneTasks.length,
          itemCount: Math.min(25, doneTasks.length),
          hasMore: !withAgent,
        });
        expect
          .soft(done.data.tasks.every(({ thread }) => doneTasks.includes(thread.id)))
          .toBe(true);

        if (!withAgent) return;
        await store.database
          .updateTable("threads")
          .set({ doneAt: null, doneReason: null })
          .where("id", "in", [...doneTasks, ...agentTasks])
          .execute();
        const first = await api["tasks.page"]({});
        if (!first.ok) throw new Error(first.error.message);
        expect.soft(first.data.window, "first settled Tasks page").toMatchObject({
          totalItems: ownerTasks.length,
          itemCount: 25,
          hasMore: true,
        });
        const shell = await api["personal.shell.get"]({});
        if (!shell.ok) throw new Error(shell.error.message);
        expect(shell.data.recentTaskIds).toEqual(first.data.tasks.map(({ thread }) => thread.id));
        const before = shell.data.nextBefore;
        if (!before) throw new Error("Expected a Show more cursor");
        const more = await api["tasks.page"]({ before });
        if (!more.ok) throw new Error(more.error.message);
        expect.soft(more.data.window, "Show more").toMatchObject({ itemCount: 5, hasMore: false });
        expect(
          new Set([...shell.data.recentTaskIds, ...more.data.tasks.map(({ thread }) => thread.id)]),
        ).toEqual(new Set(ownerTasks));
      } finally {
        await host?.close();
        await database.drop();
      }
    },
  );
});

it("replays a waiting message's queue row once, with this cut's lease for each session", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    const f = await fixture(database);
    host = f.host;
    const { store } = host;
    const tasks = createPersonalRunFixturePort(store);
    const { threadId } = await tasks.createTask({ ownerId: host.ownerId, suffix: "lease-replay" });
    await tasks.startTask(threadId, "Working");
    const waiting = await store.enqueueThreadInput({
      requestedBy: host.ownerId,
      threadId,
      content: [{ type: "text", text: "Next" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "lease-replay-waiting",
    });
    const before = await f.state();
    const identity = {
      threadId,
      messageId: waiting.message.id,
      requestedBy: host.ownerId,
      sessionId: f.owner.id,
      deviceLabel: "Phone",
    };
    await store.takeThreadInputLease({ ...identity, leaseId: "first", takeOver: false });
    await store.releaseThreadInputLease({ ...identity, leaseId: "first" });
    await store.takeThreadInputLease({ ...identity, leaseId: "second", takeOver: false });
    const cursor: PersonalResumeCursor = {
      deploymentId: before.deploymentId,
      epoch: before.epoch,
      viewerId: host.ownerId,
      scopeKey: `thread:${threadId}`,
      afterSequence: before.sequence,
    };
    const rows = async (session: Session) => {
      const cut = await f.reads.readCut(session, f.surface, { kind: "thread", threadId }, cursor);
      return cut.frames.flatMap((frame) =>
        frame.type === "host.changes"
          ? frame.changes
              .filter((change) => change.entityKind === "queue-entry")
              .map((change) => ({ through: frame.throughSequence, change }))
          : [],
      );
    };
    const owned = await rows(f.owner);
    const head = (await f.state()).sequence;
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({
      through: head,
      change: { operation: "upsert", value: { lease: { ownedBySession: true } } },
    });
    expect(await rows(f.other)).toMatchObject([
      { through: head, change: { value: { lease: { ownedBySession: false } } } },
    ]);
  } finally {
    await host?.close();
    await database.drop();
  }
});

it("does not share one viewer's shell repair across different selected tasks", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    const f = await fixture(database);
    host = f.host;
    const tasks = createPersonalRunFixturePort(host.store);
    const selected = [];
    for (const suffix of ["first-selected", "second-selected"]) {
      const { threadId } = await tasks.createTask({ ownerId: host.ownerId, suffix });
      await host.store.database
        .updateTable("threads")
        .set({ doneAt: new Date("2020-01-01") })
        .where("id", "=", threadId)
        .execute();
      selected.push(threadId);
    }
    const state = await f.state();
    await host.store.database
      .updateTable("clientSyncState")
      .set((eb) => ({ prunedThroughSequence: eb.ref("sequence") }))
      .execute();
    const cursor: PersonalResumeCursor = {
      deploymentId: state.deploymentId,
      epoch: state.epoch,
      viewerId: host.ownerId,
      scopeKey: "shell",
      afterSequence: (BigInt(state.sequence) - 1n).toString(),
    };
    const cuts = await Promise.all(
      selected.map((threadId) =>
        f.reads.readCut(f.owner, f.surface, { kind: "shell" }, cursor, undefined, threadId, {
          reader: {},
          atLeast: state.sequence,
        }),
      ),
    );
    for (const [index, cut] of cuts.entries()) {
      const snapshot = cut.frames.find(
        (frame): frame is Extract<ScopedHostMessage, { type: "host.snapshot" }> =>
          frame.type === "host.snapshot",
      );
      if (!snapshot || !("tasks" in snapshot.snapshot)) throw new Error("Expected a shell repair");
      expect(snapshot.snapshot.tasks.map(({ id }) => id)).toContain(selected[index]);
      expect(snapshot.snapshot.tasks.map(({ id }) => id)).not.toContain(selected[1 - index]);
    }
  } finally {
    await host?.close();
    await database.drop();
  }
});

it("gives a resumed detail the current thread value after a return-hint input changed, and republishes to node viewers", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    const f = await fixture(database);
    host = f.host;
    const { threadId } = await createPersonalRunFixturePort(host.store).createTask({
      ownerId: host.ownerId,
      suffix: "hint-resume",
    });
    const before = await f.state();
    const cursor: PersonalResumeCursor = {
      deploymentId: before.deploymentId,
      epoch: before.epoch,
      viewerId: host.ownerId,
      scopeKey: `thread:${threadId}`,
      afterSequence: before.sequence,
    };
    const resumed = () => f.reads.readCut(f.owner, f.surface, { kind: "thread", threadId }, cursor);
    const threadRows = (cut: Awaited<ReturnType<typeof resumed>>) =>
      cut.frames.flatMap((frame) =>
        frame.type === "host.changes"
          ? frame.changes.filter((change) => change.entityKind === "thread")
          : [],
      );
    await host.store.notificationState.setIdleCompactionPolicy({
      policy: { mode: "off" },
      userId: host.ownerId,
    });
    // The settings commit wrote no row to this scope; the resume still carries the value.
    const head = (await f.state()).sequence;
    const resumedRows = threadRows(await resumed());
    expect(resumedRows).toMatchObject([
      { entityId: threadId, operation: "upsert", value: { thread: { id: threadId } } },
    ]);
    // The task row is unchanged: only a value stamped past what the reader holds is taken.
    const row = resumedRows[0];
    if (row?.operation !== "upsert" || row.entityKind !== "thread")
      throw new Error("Expected a thread value");
    expect(row.value.revision).toBe(head);
    expect(BigInt(row.value.revision)).toBeGreaterThan(BigInt(before.sequence));

    const nodeId = createId("executionNode");
    await republishThreads(host.store.database, [{ kind: "node", threadId, nodeId }]);
    expect(
      await host.store.database
        .selectFrom("clientChanges")
        .select(["entityKind", "entityId"])
        .where("scopeKey", "=", `node:${nodeId}`)
        .execute(),
    ).toEqual([{ entityKind: "thread", entityId: threadId }]);
  } finally {
    await host?.close();
    await database.drop();
  }
});
