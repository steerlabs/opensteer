import { createId } from "@opensteer/core";
import {
  defaultWorkPolicy,
  OrganizationIdSchema,
  WorkAssignmentIdSchema,
} from "@opensteer/control-plane-protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { deviceEnrollmentPreviewPath } from "@opensteer/protocol";
import { ScopedHostMessageSchema } from "@opensteer/protocol/personal-sync";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { OpensteerStore, republishThreads, WorkHomeStore } from "@opensteer/database";
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

it("does not read work policy or emit policy data on the personal shell stream", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    const f = await fixture(database);
    host = f.host;
    const queries: string[] = [];
    const observed = new OpensteerStore(
      host.store.database.withPlugin({
        transformQuery({ node }) {
          queries.push(JSON.stringify(node));
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      }),
    );
    const reads = createPersonalReads(
      { store: observed } as HostServerDependencies,
      {} as PersonalResources,
    );
    const scope = { kind: "shell" } as const;
    const first = await reads.readCut(f.owner, f.surface, scope, null);
    expect(first.frames[0]).toMatchObject({ type: "host.snapshot", scope });
    expect(JSON.stringify(first)).not.toContain("effectiveWorkPolicy");
    if (!first.cursor) throw new Error("The personal shell did not give a cursor");
    const replay = await reads.readCut(f.owner, f.surface, scope, first.cursor);
    expect(replay.frames).toEqual([]);
    expect(replay.shellProgress).not.toHaveProperty("effectiveWorkPolicy");
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.join(" ")).not.toMatch(/work(HomePolicy|Audit)|work_(home_policy|audit)/u);
  } finally {
    await host?.close();
    await database.drop();
  }
});

it("publishes accepted work policy to a connected shell and discloses only enrollment facts to a valid code", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  let socket: WebSocket | undefined;
  try {
    const f = await fixture(database);
    host = f.host;
    const mint = async (key: string) => {
      const response = await f.host.api["commands.dispatch"]({
        type: "runner.enrollment.createLocal",
        name: "Joining Mac",
        allowedModules: ["browser"],
        idempotencyKey: key,
      });
      if (!response.ok || response.data.type !== "runner.enrollment.createLocal")
        throw new Error("Expected an owner-issued device setup code");
      return response.data;
    };
    const preview = (enrollmentToken: string) =>
      f.host.runtime.app.inject({
        method: "POST",
        url: deviceEnrollmentPreviewPath,
        payload: { enrollmentToken },
      });
    const personal = await mint("personal-preview");
    const personalView = await preview(personal.token);
    expect(personalView.statusCode, personalView.body).toBe(200);
    expect(personalView.json()).toEqual({});

    const home = new WorkHomeStore(host.store.database);
    const { deploymentId } = await f.state();
    const marker = {
      organizationId: OrganizationIdSchema.parse(`org_${randomUUID()}`),
      organizationName: "Workshop",
      assignmentId: WorkAssignmentIdSchema.parse(`was_${randomUUID()}`),
    };
    await home.initialize(marker, deploymentId);
    const policy = (revision: number, devices: "assignee-may-enroll" | "cloud-computer-only") =>
      home.apply({
        assignmentId: marker.assignmentId,
        deploymentId,
        state: "active",
        revision,
        policy: { ...defaultWorkPolicy, devices },
      });
    await policy(1, "assignee-may-enroll");
    const active = await mint("work-preview");
    const expired = await mint("expired-preview");
    const consumed = await mint("used-preview");
    await host.store.database
      .updateTable("runnerEnrollments")
      .set({ expiresAt: new Date(0) })
      .where("id", "=", expired.enrollmentId)
      .execute();
    await host.store.database
      .updateTable("runnerEnrollments")
      .set({ consumedAt: new Date() })
      .where("id", "=", consumed.enrollmentId)
      .execute();
    const view = await preview(active.token);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.headers["cache-control"]).toBe("no-store");
    expect(view.headers["set-cookie"]).toBeUndefined();
    expect(view.json()).toEqual({ organizationName: "Workshop", devices: "assignee-may-enroll" });
    for (const refusedToken of ["x".repeat(48), expired.token, consumed.token]) {
      const refused = await preview(refusedToken);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.body).not.toMatch(/Workshop|assignee-may-enroll|cloud-computer-only/u);
    }

    const address = new URL("/v1/realtime", host.origin);
    address.protocol = "ws:";
    const peer = (socket = new WebSocket(address, { headers: host.ownerHeaders }));
    const synced = Promise.withResolvers<void>();
    const policyChanged =
      Promise.withResolvers<Extract<ScopedHostMessage, { type: "host.snapshot" }>>();
    const shells: Extract<ScopedHostMessage, { type: "host.snapshot" }>[] = [];
    peer.on("message", (raw) => {
      const parsed = ScopedHostMessageSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) return;
      const frame = parsed.data;
      if (!("scope" in frame) || frame.scope.kind !== "shell") return;
      if (frame.type === "host.synchronized") synced.resolve();
      if (frame.type === "host.snapshot") {
        shells.push(frame);
        if ("tasks" in frame.snapshot && frame.snapshot.effectiveWorkPolicy?.appliedRevision === 2)
          policyChanged.resolve(frame);
      }
    });
    await once(peer, "open");
    peer.send(
      JSON.stringify({
        type: "client.attach",
        apiVersion: hostApiVersion,
        generation: 1,
        interests: [],
        installed: {},
      }),
    );
    await withTimeout(synced.promise, 5_000, {
      timeoutError: () => new Error("Shell did not attach"),
    });
    expect(shells[0]?.snapshot).toMatchObject({
      effectiveWorkPolicy: {
        organizationName: "Workshop",
        appliedRevision: 1,
        devices: "assignee-may-enroll",
      },
    });
    const rpc = await host.api["personal.shell.get"]({});
    if (!rpc.ok || !shells[0] || !("tasks" in shells[0].snapshot))
      throw new Error("Expected both shell reads");
    expect(rpc.data.effectiveWorkPolicy).toEqual(shells[0].snapshot.effectiveWorkPolicy);
    await policy(2, "cloud-computer-only");
    const updated = await withTimeout(policyChanged.promise, 5_000, {
      timeoutError: () => new Error("The connected shell missed the work policy"),
    });
    expect(updated.generation).toBe(shells[0].generation);
    expect(BigInt(updated.throughSequence)).toBeGreaterThan(BigInt(shells[0].throughSequence));
    expect(updated.snapshot).toMatchObject({
      effectiveWorkPolicy: {
        organizationName: "Workshop",
        appliedRevision: 2,
        devices: "cloud-computer-only",
      },
    });
    const blocked = await preview(active.token);
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(blocked.json()).toEqual({
      organizationName: "Workshop",
      devices: "cloud-computer-only",
    });
    expect(
      await host.store.database
        .selectFrom("runnerEnrollments")
        .select(["consumedAt", "runnerId"])
        .where("id", "=", active.enrollmentId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ consumedAt: null, runnerId: null });
  } finally {
    socket?.terminate();
    await host?.close();
    await database.drop();
  }
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
