import { randomUUID } from "node:crypto";
import {
  createId,
  type AgentGrant,
  type RequestId,
  type RunId,
  type ThreadAccessMode,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { Command, CommandType } from "@opensteer/protocol/command-table";
import { expect } from "vitest";
import {
  commandAdmission,
  replayAdministrationCommand,
  withAdministrationTransaction,
  type CommandIdentity,
} from "./administration-command.js";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { beginAgentSession } from "./agent-session-store.js";
import { admitCommand, commandSubject } from "./resource-access.js";
import { commandTable } from "@opensteer/protocol/command-table";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";

/** The types an agent sends today through the administration service, which admits at commit. */
const administrationTypes = [
  "viewer.timeZone.update",
  "viewer.quietTasks.update",
  "viewer.name.update",
  "settings.idleCompaction.set",
  "execution.preferences.remember",
  "harness.model.configure",
  "harness.rename",
  "harness.enabled.set",
  "harness.default.set",
  "machine.revoke",
  "machine.rename",
  "iphone.screen.attach",
  "iphone.screen.detach",
  "machine.access.session.stop",
  "browser.profile.rename",
  "browser.profile.delete",
  "browser.history.remove",
  "browser.history.clear",
  "browser.site.remove",
  "channel.connection.status.set",
  "integration.disconnect",
  "integration.grant.revoke",
  "plugin.remove",
] as const satisfies readonly CommandType[];
/** What the administration service refused every agent before the table existed. */
const refusedToEveryAgent = new Set<CommandType>([
  "viewer.name.update",
  "settings.idleCompaction.set",
  "iphone.screen.attach",
  "iphone.screen.detach",
]);

const profileId = createId("browserProfile");

/** Every row whose governed thing is a task named by the input (`threadId`, an anchor). */
function taskScopedRows(): CommandType[] {
  const probe = createId("thread");
  return (Object.keys(commandTable) as CommandType[]).filter((type) => {
    const row = commandTable[type] as unknown as {
      scope: string;
      governs: (c: unknown) => { kind: string; id: string | null };
    };
    if (row.scope !== "task") return false;
    const governed = row.governs({
      ...sample(type),
      threadId: probe,
      input: { anchorThreadId: probe },
    });
    return governed.kind === "task" && governed.id === probe;
  });
}
/** A question the Run's own task asked: a Request in the Run's reach. */
async function ownQuestion(
  storeFixture: StoreFixture,
  f: { readonly run: { readonly id: RunId }; readonly threadId: ThreadId; readonly userId: UserId },
): Promise<RequestId> {
  const created = await storeFixture.store.requests.create({
    callId: `command-face-${randomUUID()}`,
    kind: "person.question",
    mode: "durable",
    originatingRunId: f.run.id,
    originatingThreadId: f.threadId,
    payload: { kind: "person.question" },
    presentation: {
      kind: "form",
      title: "Which one?",
      fields: [
        {
          id: "answer",
          prompt: "Which one?",
          choices: [{ label: "This", value: "this" }],
          custom: false,
          multiSelect: false,
          secret: false,
        },
      ],
    },
    requestedBy: f.userId,
    requiredActor: "requester",
  } as never);
  return created.request.id;
}
function personViewOnly(type: CommandType): boolean {
  return commandTable[type].faces.every((face) => face.class === "person-view");
}
/** Every field a row reads to tell its face or what it governs. */
function sample(type: CommandType): Command & { readonly idempotencyKey: string } {
  return {
    type,
    idempotencyKey: randomUUID(),
    profileId,
    machineId: createId("device"),
    deviceId: createId("device"),
    harnessInstanceId: createId("harnessInstance"),
    connectionId: `ic_${randomUUID()}`,
    grantId: `ig_${randomUUID()}`,
    pluginId: "plugin",
    sessionId: "session",
    target: { kind: "new", name: "iPhone" },
    status: "paused",
    enabled: false,
  } as unknown as Command & { readonly idempotencyKey: string };
}

/**
 * What the commit says once the change has landed: an ended lineage is refused as before, a mode
 * that no longer reaches asks (`authority-changed`, which the agent tools map), and a grant that
 * no longer names the Home's settings reads as not found, the fixed reply.
 */
const refusalAfter = {
  ended: { code: "forbidden", message: "Task authority is no longer available" },
  disconnected: { code: "forbidden" },
  lowered: { code: "forbidden", reason: "authority-changed" },
  narrowed: { code: "not_found", message: "That item is unavailable." },
} as const;

describeStore("one admission for Home commands", (it) => {
  async function setup(storeFixture: StoreFixture) {
    const f = await storeFixture.startRunFixture(`command-${randomUUID().slice(0, 8)}`);
    const { database } = storeFixture;
    const connections = new AgentConnectionStore(database);
    const setMode = async (mode: ThreadAccessMode) => {
      await database
        .updateTable("threads")
        .set({ accessMode: mode })
        .where("id", "=", f.threadId)
        .execute();
      await database
        .updateTable("runs")
        .set({ accessMode: mode })
        .where("id", "=", f.run.id)
        .execute();
    };
    const connect = async (grant: AgentGrant, accessMode: ThreadAccessMode = "full-access") => {
      const connection = await connections.create({
        userId: f.userId,
        label: "Agent",
        clientName: "Agent",
        accessMode,
        resource: "http://localhost/mcp",
        expiresAt: new Date(Date.now() + 60_000),
        grant,
      });
      await connections.activate(connection.id, `hash-${randomUUID()}`);
      return connection;
    };
    const workFor = (connectionId: string | null) =>
      database.updateTable("runs").set({ connectionId }).where("id", "=", f.run.id).execute();
    await setMode("full-access");
    return { f, database, connections, setMode, connect, workFor };
  }

  it("lets each agent change exactly what the administration service let it change", async ({
    storeFixture,
  }) => {
    const { f, database, setMode, connect, workFor } = await setup(storeFixture);
    const everything = await connect({ scope: "everything" });
    const supervised = await connect({ scope: "everything" }, "approval-required");
    const selected = await connect({
      scope: "selected",
      tasks: true,
      resources: [{ kind: "browser-profile", profileId }],
    });
    const answer = async (callerKey: string, type: CommandType) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(callerKey),
          command: sample(type),
        })
      ).answer;
    const run = `run:${f.run.id}`;
    // Before: Full access, and for a connection's work `everything`; minus four per-type refusals.
    const allowedBefore = (type: CommandType) => !refusedToEveryAgent.has(type);
    for (const type of administrationTypes) {
      expect([type, await answer(run, type)]).toEqual([type, allowedBefore(type) ? "now" : "ask"]);
      expect([type, await answer(`connection:${everything.id}`, type)]).toEqual([
        type,
        allowedBefore(type) ? "now" : "ask",
      ]);
      expect([type, await answer(`connection:${supervised.id}`, type)]).not.toContainEqual("now");
      expect([type, await answer(`connection:${selected.id}`, type)]).not.toContainEqual("now");
    }
    await workFor(everything.id);
    for (const type of administrationTypes)
      expect([type, await answer(run, type)]).toEqual([type, allowedBefore(type) ? "now" : "ask"]);
    await workFor(selected.id);
    for (const type of administrationTypes) expect(await answer(run, type)).not.toBe("now");
    await workFor(null);
    await setMode("auto");
    for (const type of administrationTypes) expect(await answer(run, type)).not.toBe("now");
  });

  it("reads a selected grant's outside, and other connections, exactly like nothing", async ({
    storeFixture,
  }) => {
    const { f, database, connect } = await setup(storeFixture);
    const selected = await connect({
      scope: "selected",
      tasks: true,
      resources: [{ kind: "browser-profile", profileId }],
    });
    const other = await connect({ scope: "everything" });
    const admit = (callerKey: string, command: Command) =>
      admitCommand(database, {
        ownerUserId: f.userId,
        subject: commandSubject(callerKey),
        command,
      });
    const self = `connection:${selected.id}`;
    // Its own profile: it may ask (a rename waits for its family's handler).
    expect(await admit(self, sample("browser.profile.rename"))).toMatchObject({ answer: "ask" });
    // Another profile, the Home's engines, another connection: not there at all.
    for (const command of [
      { ...sample("browser.profile.rename"), profileId: createId("browserProfile") },
      sample("harness.rename"),
      { ...sample("connection.revoke"), connectionId: other.id },
      { ...sample("connection.revoke"), connectionId: "unknown" },
    ] as Command[])
      expect([command.type, (await admit(self, command)).answer]).toEqual([
        command.type,
        "not_found",
      ]);
    // `everything` sees no other connection either; its own it may end (once its handler takes it).
    const wide = `connection:${other.id}`;
    expect(
      (await admit(wide, { ...sample("connection.revoke"), connectionId: selected.id } as Command))
        .answer,
    ).toBe("not_found");
    expect(
      (await admit(wide, { ...sample("connection.revoke"), connectionId: other.id } as Command))
        .answer,
    ).toBe("ask");
  });

  it("decides a task row's reach before it answers: inside, outside and missing", async ({
    storeFixture,
  }) => {
    const { f, database, setMode, connect, workFor } = await setup(storeFixture);
    const selected = await connect({ scope: "selected", tasks: true, resources: [] });
    const noTasks = await connect({
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId }],
    });
    const everything = await connect({ scope: "everything" });
    const other = await connect({ scope: "everything" });
    const ownersTask = f.threadId;
    const lineageTask = (await storeFixture.createTaskForOwner(f.userId, `lineage-${randomUUID()}`))
      .id;
    const othersTask = (await storeFixture.createTaskForOwner(f.userId, `others-${randomUUID()}`))
      .id;
    await database
      .updateTable("threads")
      .set({ originConnectionId: selected.id })
      .where("id", "=", lineageTask)
      .execute();
    await database
      .updateTable("threads")
      .set({ originConnectionId: other.id })
      .where("id", "=", othersTask)
      .execute();
    const missing = createId("thread");
    const admission = async (callerKey: string, command: Command) => {
      const { answer, reason, face } = await admitCommand(database, {
        ownerUserId: f.userId,
        subject: commandSubject(callerKey),
        command,
      });
      return { answer, reason, face };
    };
    const taskRows = taskScopedRows();
    const onTask = (type: CommandType, threadId: string) =>
      ({
        ...sample(type),
        threadId,
        input: { anchorThreadId: threadId },
      }) as unknown as Command;
    expect(taskRows.length).toBeGreaterThan(10);
    const nf = expect.objectContaining({ answer: "not_found", reason: undefined });
    for (const type of taskRows) {
      // A connection: its own lineage is in reach; the person's task (selected), another
      // connection's work (even with everything) and nothing at all read exactly alike.
      for (const [connection, inside, outside] of [
        [selected, lineageTask, ownersTask],
        [everything, ownersTask, othersTask],
      ] as const) {
        const key = `connection:${connection.id}`;
        const inReach = await admission(key, onTask(type, inside));
        const outOfReach = await admission(key, onTask(type, outside));
        const absent = await admission(key, onTask(type, missing));
        if (personViewOnly(type)) expect(inReach.answer, type).toBe("not_found");
        else expect(inReach.answer, `${type} inside`).not.toBe("not_found");
        expect(outOfReach, `${type} outside`).toEqual(nf);
        expect(JSON.stringify(outOfReach), `${type} outside = missing`).toBe(
          JSON.stringify(absent),
        );
      }
      // A grant without tasks reaches no task at all.
      expect(
        (await admission(`connection:${noTasks.id}`, onTask(type, lineageTask))).answer,
        type,
      ).toBe("not_found");
    }
    // Your own agent below Full access: the person's task at a higher mode is not its own work.
    await setMode("auto");
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", othersTask)
      .execute();
    await workFor(null);
    const run = `run:${f.run.id}`;
    for (const type of taskRows) {
      if (personViewOnly(type)) continue;
      expect([type, (await admission(run, onTask(type, othersTask))).answer]).toEqual([
        type,
        "ask",
      ]);
      expect([type, (await admission(run, onTask(type, missing))).answer]).toEqual([
        type,
        "not_found",
      ]);
    }
  });

  it("reaches a Request, an automation, a tab and a direct session through what they belong to", async ({
    storeFixture,
  }) => {
    const { f, database, connect } = await setup(storeFixture);
    const selected = await connect({ scope: "selected", tasks: true, resources: [] });
    const other = await connect({ scope: "everything" });
    const admit = async (callerKey: string, command: Command) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(callerKey),
          command,
        })
      ).answer;
    const self = `connection:${selected.id}`;
    // The person's own automation is outside a selected grant; a made-up one is not there.
    const occurrence = await storeFixture.startTriggerOccurrence(f, `reach-${randomUUID()}`);
    const triggerId = occurrence.triggerId;
    for (const type of ["trigger.update", "trigger.cancel", "trigger.status.set"] as const) {
      expect(await admit(self, { ...sample(type), triggerId } as Command), type).toBe("not_found");
      expect(
        await admit(self, { ...sample(type), triggerId: createId("trigger") } as Command),
        type,
      ).toBe("not_found");
      expect(await admit(`run:${f.run.id}`, { ...sample(type), triggerId } as Command)).not.toBe(
        "not_found",
      );
    }
    // Tabs, browsers, delegations and setups no selected grant names: not there.
    for (const command of [
      { ...sample("tab.close"), tabIds: ["tab_missing"] },
      { ...sample("tab.group.update"), groupId: "group_missing" },
      { ...sample("browser.session.close"), sessionId: `bsn_${randomUUID()}` },
      { ...sample("assignment.cancel"), assignmentId: `asg_${randomUUID()}` },
      { ...sample("integration.computer.setup.respond"), setupRequestId: randomUUID() },
      { ...sample("request.respond"), requestId: createId("request") },
    ] as Command[])
      expect([command.type, await admit(self, command)]).toEqual([command.type, "not_found"]);
    // A direct session: its own it may stop; another connection's is not there.
    const own = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: selected.id,
    });
    const theirs = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: other.id,
    });
    const stop = (session: typeof own.session) =>
      ({
        type: "agent.session.stop",
        idempotencyKey: randomUUID(),
        threadId: session.threadId,
        agentSessionId: session.id,
      }) as unknown as Command;
    // Its own session is in reach; its handler is the person's in this step, so it asks.
    expect(await admit(self, stop(own.session))).toBe("ask");
    expect(await admit(self, stop(theirs.session))).toBe("not_found");
  });

  it("admits a program, and refuses an expired connection, as the administration service did", async ({
    storeFixture,
  }) => {
    const { f, database, connect, connections } = await setup(storeFixture);
    const occurrence = await storeFixture.startTriggerOccurrence(f, `program-${randomUUID()}`);
    const program = `trigger:${occurrence.event.id}`;
    for (const type of administrationTypes)
      expect([
        type,
        (
          await admitCommand(database, {
            ownerUserId: f.userId,
            subject: commandSubject(program),
            command: sample(type),
          })
        ).answer,
      ]).toEqual([type, refusedToEveryAgent.has(type) ? "ask" : "now"]);
    const expired = await connect({ scope: "everything" });
    await database
      .updateTable("agentConnections")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", expired.id)
      .execute();
    await expect(
      admitCommand(database, {
        ownerUserId: f.userId,
        subject: commandSubject(`connection:${expired.id}`),
        command: sample("harness.rename"),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    void connections;
    // Resuming a chat account lets its senders reach the Home again: never now for an agent.
    expect(
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(`run:${f.run.id}`),
          command: { ...sample("channel.connection.status.set"), status: "connected" } as Command,
        })
      ).answer,
    ).toBe("ask");
  });

  it("refuses the work of a paused chat until the chat is back", async ({ storeFixture }) => {
    const { bridge, channels, configured, fixture } = await storeFixture.createBridgeFixture(
      `paused-${randomUUID().slice(0, 8)}`,
    );
    const admit = () =>
      admitCommand(storeFixture.database, {
        ownerUserId: fixture.userId,
        subject: commandSubject(`connection:${bridge.id}`),
        command: sample("thread.rename"),
      });
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    await expect(admit()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("admits the person without reading anything", async ({ storeFixture }) => {
    const { f } = await setup(storeFixture);
    const unread = new Proxy({} as never, {
      get: () => {
        throw new Error("The person's admission read the database");
      },
    });
    for (const type of administrationTypes)
      expect(
        await admitCommand(unread, {
          ownerUserId: f.userId,
          subject: { kind: "person" },
          command: sample(type),
        }),
      ).toEqual({ answer: "now", face: expect.anything(), execution: null });
  });

  for (const [change, label] of [
    ["ended", "the Run ended"],
    ["lowered", "the person lowered its mode"],
    ["disconnected", "its connection was Disconnected"],
    ["narrowed", "the person narrowed its grant"],
  ] as const)
    it(`refuses at commit, for every administration type, when ${label} after admission`, async ({
      storeFixture,
    }) => {
      const { f, database, connections, setMode, connect } = await setup(storeFixture);
      const before = await database
        .selectFrom("runners")
        .select("name")
        .where("id", "=", f.runnerId)
        .executeTakeFirstOrThrow();
      for (const type of administrationTypes) {
        if (refusedToEveryAgent.has(type)) continue;
        // A fresh caller each time: a live Run at Full access, or a live `everything` connection.
        await setMode("full-access");
        await database
          .updateTable("runs")
          .set({ status: "running", completedAt: null })
          .where("id", "=", f.run.id)
          .execute();
        const connection =
          change === "disconnected" || change === "narrowed"
            ? await connect({ scope: "everything" })
            : null;
        const callerKey = connection ? `connection:${connection.id}` : `run:${f.run.id}`;
        const command = sample(type);
        const identity: CommandIdentity = {
          requestedBy: f.userId,
          idempotencyKey: command.idempotencyKey,
          type,
          request: { probe: type },
          authoritySource: { kind: "mcp", callerKey },
          ...commandAdmission({ ownerUserId: f.userId, callerKey, command }),
        };
        // Admitted when it was sent.
        expect([
          type,
          (
            await admitCommand(database, {
              ownerUserId: f.userId,
              subject: commandSubject(callerKey),
              command,
            })
          ).answer,
        ]).toEqual([type, "now"]);
        // The change lands between admission and commit.
        if (change === "ended")
          await database
            .updateTable("runs")
            .set({ status: "completed", completedAt: new Date() })
            .where("id", "=", f.run.id)
            .execute();
        if (change === "lowered") await setMode("approval-required");
        if (connection && change === "disconnected")
          await connections.revoke(f.userId, connection.id);
        if (connection && change === "narrowed")
          await connections.update(f.userId, {
            connectionId: connection.id,
            expectedRevision: 1,
            grant: { scope: "selected", tasks: true, resources: [] },
          });
        await expect(
          withAdministrationTransaction(database, identity, (transaction) =>
            transaction
              .updateTable("runners")
              .set({ name: `changed by ${type}` })
              .where("id", "=", f.runnerId)
              .execute(),
          ),
          `${type} after ${label}`,
        ).rejects.toMatchObject(refusalAfter[change]);
        expect(
          await database
            .selectFrom("commands")
            .select("id")
            .where("idempotencyKey", "=", command.idempotencyKey)
            .execute(),
        ).toEqual([]);
      }
      expect(
        await database
          .selectFrom("runners")
          .select("name")
          .where("id", "=", f.runnerId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
    });

  it("replays the same command once, refuses another under its key, and rechecks before replaying", async ({
    storeFixture,
  }) => {
    const { f, database, setMode } = await setup(storeFixture);
    const callerKey = `run:${f.run.id}`;
    const command = sample("machine.rename");
    const identity = (request: Record<string, unknown>): CommandIdentity => ({
      requestedBy: f.userId,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
      request,
      authoritySource: { kind: "mcp", callerKind: "run", callerKey },
      ...commandAdmission({ ownerUserId: f.userId, callerKey, command }),
    });
    let writes = 0;
    const rename = (request: Record<string, unknown>) =>
      withAdministrationTransaction(database, identity(request), async (transaction) => {
        writes += 1;
        await transaction
          .updateTable("runners")
          .set({ name: "Renamed" })
          .where("id", "=", f.runnerId)
          .execute();
        return { renamed: true };
      });
    expect(await rename({ name: "Renamed" })).toEqual({ renamed: true });
    expect(await rename({ name: "Renamed" })).toEqual({ renamed: true });
    expect(writes).toBe(1);
    await expect(rename({ name: "Other" })).rejects.toMatchObject({ code: "conflict" });
    const ledger = await database
      .selectFrom("commands")
      .select(["type", "authoritySource"])
      .where("idempotencyKey", "=", command.idempotencyKey)
      .execute();
    // The record of who sent it.
    expect(ledger).toEqual([
      { type: "machine.rename", authoritySource: { kind: "mcp", callerKind: "run", callerKey } },
    ]);
    await setMode("approval-required");
    await expect(
      replayAdministrationCommand(database, identity({ name: "Renamed" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("decides a two-faced command's face at commit, from what the store sees", async ({
    storeFixture,
  }) => {
    const { f, database } = await setup(storeFixture);
    const callerKey = `run:${f.run.id}`;
    const command = {
      type: "request.respond",
      idempotencyKey: randomUUID(),
      // A Request of its own task: in reach, so only the face is in question.
      requestId: await ownQuestion(storeFixture, f),
      response: { kind: "choice", optionId: "allow" },
    } as unknown as Command;
    // Admitted before the store has looked: some face of it could be now, so it may go on, and
    // only the Request (the store's view) says what the answer does.
    const admission = commandAdmission({ ownerUserId: f.userId, callerKey, command });
    await database.transaction().execute(async (transaction) => {
      await admission.admit(transaction);
      await admission.face(transaction, { face: "widen-self" });
      // The stored Request is a permission: allowing it lifts a gate the person set.
      await expect(admission.face(transaction, { face: "approve" })).rejects.toMatchObject({
        code: "forbidden",
        reason: "authority-changed",
      });
    });
    // A caller cannot say which face it is: a face passed in is not the store's.
    expect(
      Object.keys(
        commandAdmission({
          ownerUserId: f.userId,
          callerKey,
          command,
          face: 0,
        } as Parameters<typeof commandAdmission>[0]),
      ).sort(),
    ).toEqual(["admit", "face", "faced"]);
  });

  it("fails closed when a command only the store can tell commits without the store's view", async ({
    storeFixture,
  }) => {
    const { f, database } = await setup(storeFixture);
    const callerKey = `run:${f.run.id}`;
    const command = {
      type: "request.respond",
      idempotencyKey: randomUUID(),
      // A Request of its own task: in reach, so only the face is in question.
      requestId: await ownQuestion(storeFixture, f),
      response: { kind: "choice", optionId: "allow" },
    } as unknown as Command & { readonly idempotencyKey: string };
    const identity = (): CommandIdentity => ({
      requestedBy: f.userId,
      idempotencyKey: command.idempotencyKey,
      // The ledger's label only: a real `request.respond` row belongs to a thread's commands.
      type: "probe.face",
      request: { requestId: "probe" },
      authoritySource: { kind: "mcp", callerKey },
      // Nothing claimed: only the store's report decides the face.
      ...commandAdmission({ ownerUserId: f.userId, callerKey, command }),
    });
    const rename = (name: string, report: boolean) => {
      const admitted = identity();
      return withAdministrationTransaction(database, admitted, async (transaction) => {
        if (report) await admitted.face!(transaction, { face: "widen-self" });
        await transaction
          .updateTable("runners")
          .set({ name })
          .where("id", "=", f.runnerId)
          .execute();
      });
    };
    const before = await database
      .selectFrom("runners")
      .select("name")
      .where("id", "=", f.runnerId)
      .executeTakeFirstOrThrow();
    // The store wrote but never said what the command does against what it stores.
    await expect(rename("Unchecked", false)).rejects.toMatchObject({
      code: "forbidden",
      reason: "authority-changed",
    });
    expect(
      await database
        .selectFrom("runners")
        .select("name")
        .where("id", "=", f.runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("idempotencyKey", "=", command.idempotencyKey)
        .execute(),
    ).toEqual([]);
    // Once it reports the face it is admitted on, the same command commits.
    await rename("Checked", true);
    expect(
      await database
        .selectFrom("runners")
        .select("name")
        .where("id", "=", f.runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ name: "Checked" });
  });
});
