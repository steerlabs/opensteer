import { createId } from "@opensteer/core";
import { republishThreads } from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { createPersonalRunFixturePort } from "@opensteer/database/test-support/personal-run";
import type { PersonalResumeCursor, ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { expect, it } from "vitest";
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
