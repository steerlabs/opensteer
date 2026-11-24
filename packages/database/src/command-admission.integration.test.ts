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
import {
  commandResourceKey,
  commandTable,
  type CommandResource,
} from "@opensteer/protocol/command-table";
import {
  describeStore,
  testModelSelection,
  type StoreFixture,
} from "./store.integration.test-support.js";

/** The types an agent sends today through the administration service, which admits at commit. */
const otherConnection = (type: CommandType) => commandTable[type].scope === "other-connection";
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

/** A real profile of the fixture's person, made in each test's setup. */
let profileId = createId("browserProfile");

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
    const home = await storeFixture.enrollBrowserRunner(
      f.userId,
      `Home ${randomUUID().slice(0, 4)}`,
    );
    profileId = (
      await storeFixture.store.createBrowserProfile({
        name: `Setup ${randomUUID().slice(0, 4)}`,
        ownerId: f.userId,
        homeRunnerId: home,
        idempotencyKey: randomUUID(),
      })
    ).id;
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
      // A chat account is another connection: not there for any connected agent (X13).
      expect([type, await answer(`connection:${everything.id}`, type)]).toEqual([
        type,
        otherConnection(type) ? "not_found" : allowedBefore(type) ? "now" : "ask",
      ]);
      expect([type, await answer(`connection:${supervised.id}`, type)]).not.toContainEqual("now");
      expect([type, await answer(`connection:${selected.id}`, type)]).not.toContainEqual("now");
    }
    await workFor(everything.id);
    for (const type of administrationTypes)
      expect([type, await answer(run, type)]).toEqual([
        type,
        otherConnection(type) ? "not_found" : allowedBefore(type) ? "now" : "ask",
      ]);
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
      const on = (id: string) =>
        ({ ...sample(type), triggerId: id, input: { name: "Renamed" } }) as Command;
      expect(await admit(self, on(triggerId)), type).toBe("not_found");
      expect(await admit(self, on(createId("trigger"))), type).toBe("not_found");
      expect(await admit(`run:${f.run.id}`, on(triggerId))).not.toBe("not_found");
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

  /** A tab of the person's, or one a task opened, in a profile; and a browser using it. */
  async function browserFixtures(
    storeFixture: StoreFixture,
    f: Awaited<ReturnType<StoreFixture["startRunFixture"]>>,
  ) {
    const { database } = storeFixture;
    const browserRunner = await storeFixture.enrollBrowserRunner(
      f.userId,
      `Browser ${randomUUID().slice(0, 4)}`,
    );
    const newProfile = (name: string) =>
      storeFixture.store.createBrowserProfile({
        name,
        ownerId: f.userId,
        homeRunnerId: browserRunner,
        idempotencyKey: randomUUID(),
      });
    const profile = await newProfile(`Profile ${randomUUID().slice(0, 4)}`);
    const deviceId = await storeFixture.store.requireSelfDeviceId(f.runnerId);
    const tab = async (openedBy: "person" | { taskId: string }, profileId = profile.id) => {
      const id = createId("tab");
      await database
        .insertInto("personalTabs")
        .values({
          id,
          ownerId: f.userId,
          kind: "page",
          computerId: deviceId,
          title: "Bank",
          url: "https://bank.example",
          profileId,
          profileName: "Profile",
          openedBy: JSON.stringify(openedBy) as never,
        } as never)
        .execute();
      return id;
    };
    const browserSession = async (threadId: string | null) => {
      const id = `bsn_${randomUUID()}`;
      await database
        .insertInto("browserSessions")
        .values({
          id,
          tabGroupId: id,
          origin: "agent",
          profileId: profile.id,
          placementKey: id,
          runnerId: f.runnerId,
          runtimeId: "runtime",
          state: "ready",
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never)
        .execute();
      if (threadId)
        await database
          .insertInto("browserSessionUses")
          .values({
            id: randomUUID(),
            sessionId: id,
            threadId,
            runId: null,
            tabId: null,
            firstUsedAt: new Date(),
            lastUsedAt: new Date(),
          } as never)
          .execute();
      return id;
    };
    const setup = async (threadId: string | null) => {
      const deployment = await database
        .selectFrom("deployments")
        .select("id")
        .where("singletonKey", "=", "primary")
        .executeTakeFirstOrThrow();
      const id = randomUUID();
      await database
        .insertInto("computerAppSetupRequests")
        .values({
          id,
          kind: "app",
          policyAppApproval: null,
          reason: null,
          server: null,
          threadId,
          threadTitle: null,
          access: "read",
          app: null,
          appKey: null,
          createdAt: new Date(),
          definitionDigest: "digest",
          definitionId: "phone-screen",
          deploymentId: deployment.id,
          expiresAt: new Date(Date.now() + 60 * 60_000),
          ownerUserId: f.userId,
          runnerId: deviceId,
        } as never)
        .execute();
      return id;
    };
    return { profile, newProfile, tab, browserSession, setup };
  }

  it("reaches a tab group only when every tab in it is reached: tab.group.close (K)", async ({
    storeFixture,
  }) => {
    const { f, database, connect } = await setup(storeFixture);
    const { profile, newProfile, tab } = await browserFixtures(storeFixture, f);
    const other = await newProfile(`Other ${randomUUID().slice(0, 4)}`);
    const inProfile = await tab("person");
    const alsoInProfile = await tab("person");
    const elsewhere = await tab("person", other.id);
    const group = (groupId: string, tabIds: readonly string[]) => ({
      kind: "group",
      group: { groupId, name: groupId, color: "blue", collapsed: false, tabIds },
    });
    const held = `tgr_${randomUUID()}`;
    const mixed = `tgr_${randomUUID()}`;
    const none = `tgr_${randomUUID()}`;
    await database
      .insertInto("tabLayouts")
      .values({
        ownerId: f.userId,
        items: JSON.stringify([
          group(held, [inProfile, alsoInProfile]),
          group(mixed, [inProfile, elsewhere]),
          group(none, [elsewhere]),
        ]) as never,
      })
      .onConflict((conflict) =>
        conflict.column("ownerId").doUpdateSet((eb) => ({ items: eb.ref("excluded.items") })),
      )
      .execute();
    const close = (groupId: string) => ({ type: "tab.group.close", groupId });
    const admit = async (subject: Parameters<typeof admitCommand>[1]["subject"], groupId: string) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject,
          command: { idempotencyKey: randomUUID(), ...close(groupId) } as never,
        })
      ).answer;
    // The person: admitted, as every command of theirs.
    expect(await admit({ kind: "person" }, held)).toBe("now");
    // A connected agent holding the profile every tab of the group is in: admitted (the person's
    // handler still answers it, so the door asks them).
    const holder = await connect({
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: profile.id }],
    });
    expect(await admit(commandSubject(`connection:${holder.id}`), held)).not.toBe("not_found");
    // Holding only some of its tabs, or none: like a group that does not exist (rule 5).
    expect(await admit(commandSubject(`connection:${holder.id}`), mixed)).toBe("not_found");
    expect(await admit(commandSubject(`connection:${holder.id}`), none)).toBe("not_found");
    expect(await admit(commandSubject(`connection:${holder.id}`), `tgr_${randomUUID()}`)).toBe(
      "not_found",
    );
  });

  it("lets an Auto connection close a tab its own direct session opened, and asks about the person's (G2d)", async ({
    storeFixture,
  }) => {
    const { f, database, connect } = await setup(storeFixture);
    const { profile, tab } = await browserFixtures(storeFixture, f);
    const auto = await connect(
      {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: profile.id }],
      },
      "auto",
    );
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: auto.id,
    });
    await database
      .updateTable("threads")
      .set({ accessMode: "auto" })
      .where("id", "=", session.threadId)
      .execute();
    const admit = async (tabIds: readonly string[]) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: { kind: "binding", bindingId: `session:${session.id}` },
          command: { idempotencyKey: randomUUID(), type: "tab.close", tabIds } as never,
        })
      ).answer;
    expect(await admit([await tab({ taskId: session.threadId })])).toBe("now");
    expect(await admit([await tab("person")])).toBe("ask");
  });

  it("asks a Supervised agent about tabs, browsers and setups it did not open (D3, D4)", async ({
    storeFixture,
  }) => {
    const { f, database, setMode, connect } = await setup(storeFixture);
    const {
      profile,
      tab,
      browserSession,
      setup: deviceSetup,
    } = await browserFixtures(storeFixture, f);
    const admit = async (callerKey: string, command: Record<string, unknown>) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(callerKey),
          command: { idempotencyKey: randomUUID(), ...command } as never,
        })
      ).answer;
    // A Supervised connected agent holding only that profile, no Tasks.
    const supervised = await connect(
      {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: profile.id }],
      },
      "approval-required",
    );
    const key = `connection:${supervised.id}`;
    const persons = await tab("person");
    const session = await browserSession(null);
    expect(
      await admit(key, {
        type: "tab.open",
        target: { kind: "page", url: "https://bank.example", profileId: profile.id },
      }),
    ).toBe("ask");
    expect(await admit(key, { type: "tab.close", tabIds: [persons] })).toBe("ask");
    expect(
      await admit(key, { type: "tab.organize", tabIds: [persons], group: { kind: "none" } }),
    ).toBe("ask");
    expect(await admit(key, { type: "browser.session.close", sessionId: session })).toBe("ask");
    // Your own agent, Supervised: a full-access task's tab is not its own work; a missing group
    // and a missing setup are not there at all; a full-access task's setup is not its own work.
    await setMode("approval-required");
    const other = await storeFixture.createTaskForOwner(f.userId, `full-${randomUUID()}`);
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", other.id)
      .execute();
    const run = `run:${f.run.id}`;
    expect(await admit(run, { type: "tab.close", tabIds: [await tab({ taskId: other.id })] })).toBe(
      "ask",
    );
    expect(
      await admit(run, { type: "tab.close", tabIds: [await tab({ taskId: f.threadId })] }),
    ).toBe("now");
    expect(
      await admit(run, { type: "tab.group.update", groupId: "tgr_missing", name: "Bank" }),
    ).toBe("not_found");
    expect(
      await admit(run, {
        type: "integration.computer.setup.respond",
        setupRequestId: randomUUID(),
        decision: "deny",
      }),
    ).toBe("not_found");
    expect(
      await admit(run, {
        type: "integration.computer.setup.respond",
        setupRequestId: await deviceSetup(other.id),
        decision: "deny",
      }),
    ).toBe("ask");
    // D4: cancelling a setup reaches it where it is stored, under the same key as answering it.
    await setMode("full-access");
    const setupId = await deviceSetup(f.threadId);
    expect(
      await admit(run, { type: "integration.computer.setup.cancel", requestId: setupId }),
    ).toBe("ask");
    expect(
      await admit(run, { type: "integration.computer.setup.cancel", requestId: randomUUID() }),
    ).toBe("not_found");
    const key_ = (type: CommandType, input: Record<string, unknown>) =>
      commandResourceKey(
        (commandTable[type].governs as (c: unknown) => CommandResource)({ type, ...input }),
      );
    expect(key_("integration.computer.setup.cancel", { requestId: setupId })).toBe(
      key_("integration.computer.setup.respond", { setupRequestId: setupId }),
    );
  });

  it("reads an existing thing out of reach exactly like a missing one", async ({
    storeFixture,
  }) => {
    const { f, database, connect } = await setup(storeFixture);
    const { profile, tab, browserSession } = await browserFixtures(storeFixture, f);
    const selected = await connect({ scope: "selected", tasks: true, resources: [] });
    const key = `connection:${selected.id}`;
    const answer = async (command: Record<string, unknown>) => {
      const {
        answer: a,
        reason,
        face,
      } = await admitCommand(database, {
        ownerUserId: f.userId,
        subject: commandSubject(key),
        command: { idempotencyKey: randomUUID(), ...command } as never,
      });
      return JSON.stringify({ a, reason, face });
    };
    const question = await ownQuestion(storeFixture, f);
    for (const [existing, missing] of [
      [
        { type: "tab.close", tabIds: [await tab("person")] },
        { type: "tab.close", tabIds: ["tab_missing"] },
      ],
      [
        { type: "browser.session.close", sessionId: await browserSession(f.threadId) },
        { type: "browser.session.close", sessionId: `bsn_${randomUUID()}` },
      ],
      [
        { type: "request.respond", requestId: question, response: { kind: "external" } },
        { type: "request.respond", requestId: createId("request"), response: { kind: "external" } },
      ],
      [
        {
          type: "tab.open",
          target: { kind: "page", url: "https://a.example", profileId: profile.id },
        },
        {
          type: "tab.open",
          target: { kind: "page", url: "https://a.example", profileId: createId("browserProfile") },
        },
      ],
      [
        { type: "browser.session.start", input: { threadId: f.threadId, profileId: profile.id } },
        {
          type: "browser.session.start",
          input: { threadId: f.threadId, profileId: createId("browserProfile") },
        },
      ],
    ] as const)
      expect(await answer(existing), existing.type).toBe(await answer(missing));
    expect(JSON.parse(await answer({ type: "tab.close", tabIds: ["tab_missing"] })).a).toBe(
      "not_found",
    );
  });

  it("asks a Supervised agent before it starts work above its mode, and reaches its own session's Requests (D9)", async ({
    storeFixture,
  }) => {
    const { f, database, setMode, connect } = await setup(storeFixture);
    await setMode("approval-required");
    const create = await admitCommand(database, {
      ownerUserId: f.userId,
      subject: commandSubject(`run:${f.run.id}`),
      command: {
        type: "thread.create",
        idempotencyKey: randomUUID(),
        accessMode: "full-access",
        input: {},
      } as never,
    });
    expect(create.answer).toBe("ask");
    // A direct-work connection (no Tasks switch) answers the Requests of its own session's task.
    const direct = await connect({ scope: "selected", tasks: false, resources: [] });
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: direct.id,
    });
    const created = await storeFixture.store.requests.create({
      callId: `session-${randomUUID()}`,
      kind: "person.question",
      mode: "durable",
      originatingAgentSessionId: session.id,
      originatingThreadId: session.threadId,
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Which one?",
        fields: [{ id: "a", prompt: "Which?", custom: true, multiSelect: false, secret: false }],
      },
      requestedBy: f.userId,
      requiredActor: "requester",
    } as never);
    expect(
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(`session:${session.id}`),
          command: {
            type: "request.respond",
            idempotencyKey: randomUUID(),
            requestId: created.request.id,
            response: { kind: "external", value: { decision: "declined" } },
          } as never,
        })
      ).answer,
    ).not.toBe("not_found");
  });

  it("holds an agent's default-mode change to what the store sees, and a plugin to the grant", async ({
    storeFixture,
  }) => {
    const { f, database, connect } = await setup(storeFixture);
    const callerKey = `run:${f.run.id}`;
    const remember = (accessMode: ThreadAccessMode) => {
      const command = {
        type: "execution.preferences.remember",
        idempotencyKey: randomUUID(),
        accessMode,
      } as unknown as Command & { readonly idempotencyKey: string };
      return storeFixture.store.rememberExecutionChoice(
        f.userId,
        { accessMode },
        {
          requestedBy: f.userId,
          idempotencyKey: command.idempotencyKey,
          type: command.type,
          request: { accessMode },
          authoritySource: { kind: "mcp", callerKey },
          ...commandAdmission({ ownerUserId: f.userId, callerKey, command }),
        },
      );
    };
    // The person sets new tasks to start in Auto; an agent raising that is theirs to approve.
    await storeFixture.store.rememberExecutionChoice(f.userId, { accessMode: "auto" });
    await expect(remember("full-access")).rejects.toMatchObject({
      code: "forbidden",
      reason: "authority-changed",
    });
    expect(await remember("approval-required")).toMatchObject({ accessMode: "approval-required" });
    // A new version of a plugin: a selected grant without it reads nothing, with it asks.
    const without = await connect({ scope: "selected", tasks: true, resources: [] });
    const withIt = await connect({
      scope: "selected",
      tasks: true,
      resources: [
        { kind: "plugin", target: { kind: "installed", pluginId: "github" }, access: "read-write" },
      ],
    });
    const activate = async (key: string) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(key),
          command: {
            type: "plugins.version.activate",
            idempotencyKey: randomUUID(),
            pluginId: "github",
            versionId: "v2",
          } as never,
        })
      ).answer;
    expect(await activate(`connection:${without.id}`)).toBe("not_found");
    expect(await activate(`connection:${withIt.id}`)).toBe("ask");
  });

  it("refuses at commit when the governed task's mode rises or a tab moves out of the grant", async ({
    storeFixture,
  }) => {
    const { f, database, setMode, connect } = await setup(storeFixture);
    const { profile, tab, newProfile } = await browserFixtures(storeFixture, f);
    // (b) The governed task's mode rises between admission and commit.
    await setMode("auto");
    const target = await storeFixture.createTaskForOwner(f.userId, `target-${randomUUID()}`);
    await database
      .updateTable("threads")
      .set({ accessMode: "auto" })
      .where("id", "=", target.id)
      .execute();
    const rename = {
      type: "thread.rename",
      idempotencyKey: randomUUID(),
      threadId: target.id,
      title: "New",
    } as unknown as Command & { readonly idempotencyKey: string };
    const runKey = `run:${f.run.id}`;
    expect(
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(runKey),
          command: rename,
        })
      ).answer,
    ).toBe("now");
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", target.id)
      .execute();
    await expect(
      database
        .transaction()
        .execute((tx) =>
          commandAdmission({ ownerUserId: f.userId, callerKey: runKey, command: rename }).admit!(
            tx,
          ),
        ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "authority-changed" });
    // (c) A tab moves to a profile the grant does not name.
    await setMode("full-access");
    const holder = await connect({
      scope: "selected",
      tasks: true,
      resources: [{ kind: "browser-profile", profileId: profile.id }],
    });
    const tabId = await tab("person");
    const close = {
      type: "tab.close",
      idempotencyKey: randomUUID(),
      tabIds: [tabId],
    } as unknown as Command & { readonly idempotencyKey: string };
    const key = `connection:${holder.id}`;
    expect(
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(key),
          command: close,
        })
      ).answer,
    ).not.toBe("not_found");
    const elsewhere = await newProfile("Elsewhere");
    await database
      .updateTable("personalTabs")
      .set({ profileId: elsewhere.id })
      .where("id", "=", tabId)
      .execute();
    await expect(
      database
        .transaction()
        .execute((tx) =>
          commandAdmission({ ownerUserId: f.userId, callerKey: key, command: close }).admit!(tx),
        ),
    ).rejects.toMatchObject({ code: "not_found", message: "That item is unavailable." });
  });

  it("fires nothing from a connection's webhook once the connection is Disconnected (D1)", async ({
    storeFixture,
  }) => {
    const { f, database, connect, connections } = await setup(storeFixture);
    const connection = await connect({ scope: "everything" });
    const routeKey = `wh_${randomUUID().replaceAll("-", "")}`;
    const created = await storeFixture.triggers.create({
      actorThreadId: null,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: randomUUID(),
      name: "Provider",
      script: {
        interpreter: null,

        text: "console.log('ok')",
      },
      source: { kind: "webhook" },
      webhookRouteKey: routeKey,
    });
    // It is the connection's automation: its lineage is the connection's.
    await database
      .updateTable("triggers")
      .set({ originConnectionId: connection.id })
      .where("id", "=", created.trigger.id)
      .execute();
    await database
      .updateTable("threads")
      .set({ originConnectionId: connection.id })
      .where("id", "=", f.threadId)
      .execute();
    const deliver = () =>
      storeFixture.triggers.enqueueWebhook({
        headers: {},
        method: "POST",
        payload: { ok: true },
        routeKey,
      });
    await connections.revoke(f.userId, connection.id);
    await expect(deliver()).rejects.toBeDefined();
    expect(
      await database
        .selectFrom("triggerOccurrences")
        .select("id")
        .where("triggerId", "=", created.trigger.id)
        .execute(),
    ).toEqual([]);
  });

  it("asks a connection before it runs, or changes what runs in, an automation not its own (X11)", async ({
    storeFixture,
  }) => {
    const { f, database, connect } = await setup(storeFixture);
    const connection = await connect({ scope: "everything" });
    const make = async (originConnectionId: string | null) => {
      const created = await storeFixture.triggers.create({
        actorThreadId: null,
        anchorThreadId: f.threadId,
        createdBy: f.userId,
        idempotencyKey: randomUUID(),
        name: "Daily",
        script: {
          interpreter: null,

          text: "console.log('ok')",
        },
        source: {
          kind: "schedule",
          schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
        },
      });
      await database
        .updateTable("triggers")
        .set({ originConnectionId })
        .where("id", "=", created.trigger.id)
        .execute();
      return created.trigger.id;
    };
    const admit = async (command: Record<string, unknown>) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(`connection:${connection.id}`),
          command: { idempotencyKey: randomUUID(), ...command } as Command,
        })
      ).answer;
    const script = { interpreter: null, text: "console.log('ok')" } as const;
    const commands = (triggerId: string) => ({
      run: { type: "trigger.run", triggerId },
      program: { type: "trigger.update", triggerId, input: { script } },
      rename: { type: "trigger.update", triggerId, input: { name: "Renamed" } },
      pause: { type: "trigger.status.set", triggerId, status: "paused" },
    });
    // The person's daily automation: what it starts is the person's, outside this Disconnect.
    const persons = commands(await make(null));
    expect(await admit(persons.run)).toBe("ask");
    expect(await admit(persons.program)).toBe("ask");
    expect(await admit(persons.rename)).toBe("now");
    expect(await admit(persons.pause)).toBe("now");
    // Its own automation: what it starts is in its own Disconnect set.
    const own = commands(await make(connection.id));
    for (const command of Object.values(own))
      expect(await admit(command), command.type).toBe("now");
  });

  it("reads an automation of a chat without personal context as nothing, for a memory pass's work (T3)", async ({
    storeFixture,
  }) => {
    const { f, database } = await setup(storeFixture);
    const script = {
      interpreter: null,
      text: "console.log('ok')",
    };
    const make = async () =>
      (
        await storeFixture.triggers.create({
          actorThreadId: null,
          anchorThreadId: f.threadId,
          createdBy: f.userId,
          idempotencyKey: randomUUID(),
          name: "Daily",
          script,
          source: {
            kind: "schedule",
            schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
          },
        })
      ).trigger.id;
    // A chat anyone may speak in, and an automation in its lineage.
    const chat = await storeFixture.createBridgeFixture("memory-reader", {
      senders: "anyone",
      conversation: { id: "C-memory-reader", name: "Open room" },
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const chats = await make();
    await database
      .updateTable("triggers")
      .set({ originConnectionId: chat.bridge.id } as never)
      .where("id", "=", chats)
      .execute();
    const persons = await make();
    const admit = async (command: Record<string, unknown>) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(`run:${f.run.id}`),
          command: { idempotencyKey: randomUUID(), ...command } as Command,
        })
      ).answer;
    const pause = (triggerId: string) => ({
      type: "trigger.status.set",
      triggerId,
      status: "paused",
    });
    // An ordinary Run of the person's task: both are the person's to pause.
    expect(await admit(pause(chats))).toBe("now");
    // The same Run as a memory pass's own work: its task is a memory automation's anchor.
    await database
      .updateTable("triggers")
      .set({ systemRole: "memory-light" } as never)
      .where("id", "=", persons)
      .execute();
    expect(await admit(pause(chats))).toBe("not_found");
    expect(await admit({ type: "trigger.run", triggerId: chats })).toBe("not_found");
    expect(await admit(pause(persons))).toBe("now");
  });

  it("asks one of the person's own agents before it runs, or puts a program in, another lineage's automation (T1)", async ({
    storeFixture,
  }) => {
    const { f, database, connect } = await setup(storeFixture);
    const connection = await connect({ scope: "everything" });
    // A task the connected agent started: its lineage, not the person's.
    const { thread: theirs } = await storeFixture.store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: randomUUID(),
      modelSelection: testModelSelection,
      title: "The agent's task",
    } as never);
    await database
      .updateTable("threads")
      .set({ originConnectionId: connection.id, accessMode: "full-access" })
      .where("id", "=", theirs.id)
      .execute();
    const make = async (anchorThreadId: string, originConnectionId: string | null) => {
      const created = await storeFixture.triggers.create({
        actorThreadId: null,
        anchorThreadId: f.threadId,
        createdBy: f.userId,
        idempotencyKey: randomUUID(),
        name: "Daily",
        script: {
          interpreter: null,
          text: "console.log('ok')",
        },
        source: {
          kind: "schedule",
          schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
        },
      });
      await database
        .updateTable("triggers")
        .set({ anchorThreadId, originConnectionId } as never)
        .where("id", "=", created.trigger.id)
        .execute();
      return created.trigger.id;
    };
    // The person's own agent: a Full Run in the person's own task, with no connection.
    const admit = async (command: Record<string, unknown>) =>
      (
        await admitCommand(database, {
          ownerUserId: f.userId,
          subject: commandSubject(`run:${f.run.id}`),
          command: { idempotencyKey: randomUUID(), ...command } as Command,
        })
      ).answer;
    const script = {
      interpreter: null,
      text: "console.log(1)",
    };
    const source = {
      kind: "schedule",
      schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
    };
    const create = (anchorThreadId: string) => ({
      type: "trigger.create",
      input: { anchorThreadId, name: "New", script, source },
    });
    // The connected agent's automation: a script run unattended as its task is more than the
    // person's own agent holds there; the person is asked.
    const others = await make(theirs.id, connection.id);
    expect(await admit({ type: "trigger.run", triggerId: others })).toBe("ask");
    expect(await admit({ type: "trigger.update", triggerId: others, input: { script } })).toBe(
      "ask",
    );
    expect(await admit(create(theirs.id))).toBe("ask");
    // The person's own: its own work, at Full access, now.
    const persons = await make(f.threadId, null);
    expect(await admit({ type: "trigger.run", triggerId: persons })).toBe("now");
    expect(await admit({ type: "trigger.update", triggerId: persons, input: { script } })).toBe(
      "now",
    );
    expect(await admit(create(f.threadId))).toBe("now");
  });

  it("settles what a command answers in the effect's own transaction, or not at all", async ({
    storeFixture,
  }) => {
    const { f, database } = await setup(storeFixture);
    const settled: unknown[] = [];
    const identity = (settle: (result: unknown) => Promise<void>): CommandIdentity => ({
      requestedBy: f.userId,
      idempotencyKey: randomUUID(),
      type: "probe.settle",
      request: { probe: true },
      authoritySource: { kind: "person" },
      settle: async (_transaction, result) => settle(result),
    });
    const rename = (name: string, settle: (result: unknown) => Promise<void>) =>
      withAdministrationTransaction(database, identity(settle), async (transaction) => {
        await transaction
          .updateTable("runners")
          .set({ name })
          .where("id", "=", f.runnerId)
          .execute();
        return { renamed: name };
      });
    const name = async () =>
      (
        await database
          .selectFrom("runners")
          .select("name")
          .where("id", "=", f.runnerId)
          .executeTakeFirstOrThrow()
      ).name;
    await rename("Settled", async (result) => void settled.push(result));
    expect(settled).toEqual([{ renamed: "Settled" }]);
    expect(await name()).toBe("Settled");
    // A settlement that cannot be made takes the effect with it.
    await expect(
      rename("Unsettled", async () => {
        throw new Error("The Request moved on");
      }),
    ).rejects.toThrow("The Request moved on");
    expect(await name()).toBe("Settled");
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
        // Another connection's thing is never admitted for a connection in the first place.
        if ((change === "disconnected" || change === "narrowed") && otherConnection(type)) continue;
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
    // A default mode above approval-required: only the stored default says whether it rises.
    const command = {
      type: "execution.preferences.remember",
      idempotencyKey: randomUUID(),
      accessMode: "auto",
    } as unknown as Command;
    // Admitted before the store has looked: some face of it could be now, so it may go on, and
    // only the Request (the store's view) says what the answer does.
    const admission = commandAdmission({ ownerUserId: f.userId, callerKey, command });
    await database.transaction().execute(async (transaction) => {
      await admission.admit(transaction);
      await admission.face(transaction, { face: "preference" });
      // The stored default is lower: this raises it, which lifts a gate the person set.
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
    // A default mode above approval-required: only the stored default says whether it rises.
    const command = {
      type: "execution.preferences.remember",
      idempotencyKey: randomUUID(),
      accessMode: "auto",
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
        if (report) await admitted.face!(transaction, { face: "preference" });
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
