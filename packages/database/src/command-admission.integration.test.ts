import { randomUUID } from "node:crypto";
import { createId, type AgentGrant, type ThreadAccessMode } from "@opensteer/core";
import type { Command, CommandType } from "@opensteer/protocol/command-table";
import { expect } from "vitest";
import {
  commandAdmission,
  replayAdministrationCommand,
  withAdministrationTransaction,
  type CommandIdentity,
} from "./administration-command.js";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { admitCommand, commandSubject } from "./resource-access.js";
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
        ).rejects.toMatchObject({ code: "forbidden" });
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
      requestId: createId("request"),
      response: { kind: "choice", optionId: "allow" },
    } as unknown as Command;
    // Admitted as an answer to its own question; only the Request says what the answer does.
    const admission = commandAdmission({ ownerUserId: f.userId, callerKey, command, face: 0 });
    await database.transaction().execute(async (transaction) => {
      await admission.admit(transaction);
      await admission.face(transaction, { face: "widen-self" });
      // The stored Request is a permission: allowing it lifts a gate the person set.
      await expect(admission.face(transaction, { face: "approve" })).rejects.toMatchObject({
        code: "forbidden",
        reason: "access-changed",
      });
    });
    // With no face claimed and none reported, it is held to the strictest one.
    await expect(
      database
        .transaction()
        .execute((transaction) =>
          commandAdmission({ ownerUserId: f.userId, callerKey, command }).admit(transaction),
        ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
