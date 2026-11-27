import { createId, type AgentGrant } from "@opensteer/core";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import {
  admitExecution,
  authorizeTarget,
  bindingAgentConnectionId,
  grantedDeviceApprovals,
  reachesTarget,
} from "./resource-access.js";
import { seedDevice, seedDeviceApproval } from "./device-approvals.test-support.js";
import { describeStore } from "./store.integration.test-support.js";

const refused = { code: "forbidden", message: "Task authority is no longer available" };

describeStore("an execution resolves to a known owner, an agent connection, or nothing", (it) => {
  it("never reads an unknown, ended or inconsistent binding, or an ambiguous task, as the person's", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("known-owner");
    const { database } = storeFixture;
    const connections = new AgentConnectionStore(database);
    const agent = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(agent.id, "known-owner-hash");
    const admit = (bindingId: string) =>
      admitExecution(database, {
        ownerUserId: f.userId,
        subject: { kind: "binding", bindingId },
      });
    const run = `run:${f.run.id}`;
    const thread = `thread:${f.threadId}`;
    const profile = { kind: "browser-profile", profileId: createId("browserProfile") } as const;

    // The person's own Run, proven by its row: everything they own.
    const native = await admit(run);
    expect(native).toMatchObject({ actor: "native", agentConnection: null });
    expect(authorizeTarget(native, profile)).toBe("read-write");
    expect(await bindingAgentConnectionId(database, run)).toBeNull();

    // The same Run working for an `everything` connection on the person's task.
    await database
      .updateTable("runs")
      .set({ connectionId: agent.id })
      .where("id", "=", f.run.id)
      .execute();
    expect(await admit(run)).toMatchObject({
      actor: "agent",
      agentConnection: { agentConnectionId: agent.id },
    });
    // The task binding cannot tell whose work it means: it is refused, not the person's.
    await expect(admit(thread)).rejects.toMatchObject(refused);

    // A Run with no lineage on a task in a lineage: neither side is assumed.
    await database
      .updateTable("threads")
      .set({ originConnectionId: agent.id })
      .where("id", "=", f.threadId)
      .execute();
    await database
      .updateTable("runs")
      .set({ connectionId: null })
      .where("id", "=", f.run.id)
      .execute();
    await expect(admit(run)).rejects.toMatchObject(refused);
    await expect(bindingAgentConnectionId(database, run)).rejects.toMatchObject(refused);

    // Ended work, and work that never existed, have no authority at all.
    await database
      .updateTable("threads")
      .set({ originConnectionId: null })
      .where("id", "=", f.threadId)
      .execute();
    await database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", f.run.id)
      .execute();
    await expect(admit(run)).rejects.toMatchObject(refused);
    for (const unknown of [
      `run:${createId("run")}`,
      `trigger:${createId("triggerOccurrence")}`,
      `watch:${createId("triggerWatchActivation")}`,
      `session:${createId("agentSession")}`,
    ]) {
      await expect(admit(unknown)).rejects.toMatchObject(refused);
      await expect(bindingAgentConnectionId(database, unknown)).rejects.toMatchObject(refused);
    }
    // Nothing resolved is never an owner: a record without a known actor reaches nothing.
    expect(
      authorizeTarget({ actor: "unknown" as never, agentConnection: null }, profile),
    ).toBeNull();
  });

  it("lends no approval on a device someone else owns, though the approval row names the person", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("device-owner");
    const { database } = storeFixture;
    const deviceId = createId("device");
    await seedDevice(database, { id: deviceId, ownerUserId: f.userId, name: "Studio Mac" });
    const approvalId = `con_${crypto.randomUUID()}`;
    await seedDeviceApproval(database, {
      id: approvalId,
      ownerUserId: f.userId,
      deviceId,
      name: "Notes",
      app: { bundleId: "com.apple.notes", displayName: "Notes" },
    });
    const lent = async () =>
      (await grantedDeviceApprovals(database, f.userId, { scope: "everything" })).map(
        ({ id }) => id,
      );
    expect(await lent()).toContain(approvalId);
    // The device now belongs to another person: nothing on it is the person's to lend.
    const other = createId("user");
    await database
      .insertInto("users")
      .values({
        id: other,
        displayName: "Other",
        email: "other-owner@invalid.test",
        emailVerified: true,
      })
      .execute();
    await database
      .updateTable("devices")
      .set({ ownerUserId: other })
      .where("id", "=", deviceId as never)
      .execute();
    expect(await lent()).not.toContain(approvalId);
  });

  it("refuses concrete admission and receipt reachability for an archived browser profile under both selected and everything grants", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("archived-profile-reach");
    const { database } = storeFixture;
    const profile = await database
      .insertInto("browserProfiles")
      .values({
        archivedAt: null,
        id: createId("browserProfile"),
        name: "Work",
        ownerId: f.userId,
        homeRunnerId: f.runnerId,
        purpose: "person",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const target = { kind: "browser-profile", profileId: profile.id } as const;
    const connections = new AgentConnectionStore(database);
    const connect = async (grant: AgentGrant) => {
      const created = await connections.create({
        userId: f.userId,
        label: grant.scope,
        clientName: grant.scope,
        accessMode: "full-access",
        resource: "http://localhost/mcp",
        expiresAt: new Date(Date.now() + 60_000),
        grant,
      });
      await connections.activate(created.id, `hash-${created.id}`);
      return created.id;
    };
    const selectedId = await connect({
      scope: "selected",
      tasks: false,
      resources: [target],
    });
    const everythingId = await connect({ scope: "everything" });

    for (const agentConnectionId of [selectedId, everythingId]) {
      const admitted = await admitExecution(database, {
        ownerUserId: f.userId,
        subject: { kind: "connection", agentConnectionId },
        grantTarget: target,
      });
      expect(authorizeTarget(admitted, target)).toBe("read-write");
      expect(await reachesTarget(database, admitted, target)).toBe(true);
    }

    await database
      .updateTable("browserProfiles")
      .set({ archivedAt: new Date() })
      .where("id", "=", profile.id)
      .execute();

    for (const agentConnectionId of [selectedId, everythingId]) {
      const execution = await admitExecution(database, {
        ownerUserId: f.userId,
        subject: { kind: "connection", agentConnectionId },
      });
      // `authorizeTarget` stays the pure grant-ceiling calculation.
      expect(authorizeTarget(execution, target)).toBe("read-write");
      // Concrete-target admission and receipt reachability both refuse the archived profile.
      await expect(
        admitExecution(database, {
          ownerUserId: f.userId,
          subject: { kind: "connection", agentConnectionId },
          grantTarget: target,
        }),
      ).rejects.toMatchObject({ code: "not_found", message: "That item is unavailable." });
      expect(await reachesTarget(database, execution, target)).toBe(false);
    }
  });
});
