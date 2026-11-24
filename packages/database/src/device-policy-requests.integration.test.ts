import { buildPersonalDetailSnapshot } from "./personal-snapshot-store.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";
import { DeviceIdSchema } from "@opensteer/core";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createId, type RunnerId } from "@opensteer/core";
import { RunnerBootIdSchema, machineAccessPolicyDefault } from "@opensteer/protocol";
import { expect } from "vitest";
import { NotificationStore } from "./notification-store.js";
import { needsYouPage } from "./needs-you-store.js";
import {
  describeStore,
  enrollTestRunner,
  pendingEvent,
  type StoreFixture,
} from "./store.integration.test-support.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { personalReachableGrant, phoneRunnerGrant } from "./runner-store.js";

type Started = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;
async function device(f: StoreFixture, run: Started, phone: "ios" | "android" | false = false) {
  const runnerId = createId("runner");
  await f.database
    .insertInto("personalRemoteAccess")
    .values({
      singletonKey: "personal",
      mode: "private",
      generation: 1,
      routeOrigin: "https://devices.invalid",
      updatedAt: new Date(),
    })
    .onConflict((c) => c.column("singletonKey").doUpdateSet({ mode: "private" }))
    .execute();
  if (phone) {
    const key = generateKeyPairSync("ed25519");
    const tokenHash = `sha256:${randomUUID()}`;
    await f.store.createRunnerEnrollment({
      allowedModules: phoneRunnerGrant,
      createdBy: run.userId,
      ...(phone === "ios" ? { deviceProfile: "iphone" as const } : {}),
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: runnerId,
      name: "Phone",
      requestFingerprint: runnerId,
      runnerKind: "local",
      tokenHash,
    });
    await f.store.enrollRunnerConnection({
      descriptor: {
        runnerId,
        runnerKind: "local",
        name: "Phone",
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        runtimeVersion: "test",
        capabilities: [],
        device: { form: "phone", platform: phone, app: "opensteer" },
        modules: {
          browser: { runtimeId: runnerId, wireVersion: 2 },
          ...(phone === "ios"
            ? { integrations: { platform: "ios" as const, protocolVersion: 2 } }
            : {}),
        },
      },
      enrollmentTokenHash: tokenHash,
      publicKeyPem: key.publicKey.export({ format: "pem", type: "spki" }).toString(),
      publicKeyFingerprint: `sha256:${runnerId}`,
    });
  } else
    await enrollTestRunner(f.store, {
      runnerId,
      runnerKind: "local",
      createdBy: run.userId,
      name: "Laptop",
      environmentId: createId("environment"),
      allowedModules: personalReachableGrant,
      modules: {
        integrations: { platform: "darwin" },
        browser: { runtimeId: runnerId, wireVersion: 2 },
      },
      tokenSuffix: runnerId,
    });
  await f.store.updateMachineAccessPolicy({
    runnerId,
    ownerId: run.userId,
    allowDeployment: true,
    expectedRevision: 1,
    policy: { ...machineAccessPolicyDefault, browser: false, apps: false },
  });
  return runnerId;
}
function ask(
  f: StoreFixture,
  run: Started,
  machineId: RunnerId,
  callId = "ask",
  access: "browser" | "apps" | "files" = "browser",
  online = true,
) {
  return f.store.requests.createDeviceAccessRequest(
    {
      callId,
      machineId: DeviceIdSchema.parse(machineId),
      access,
      reason: "Read the task's files",
      originatingRunId: run.run.id,
      originatingThreadId: run.thread.id,
      requestedBy: run.userId,
    },
    () => online,
  );
}
const decline = { kind: "external", value: { decision: "declined" } } as const;
describeStore("device access Requests", (it) => {
  it("lists a device Request on every read of pending Requests", async ({ storeFixture: f }) => {
    const run = await f.startRunFixture("device-every-read");
    const target = await device(f, run);
    const ordinary = await f.store.requests.create({
      callId: "every-read-browser",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: run.run.id,
      originatingThreadId: run.thread.id,
      requestedBy: run.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Read a source",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Choose a profile",
        subject: { kind: "task", id: run.thread.id },
      },
    });
    const opened = await ask(f, run, target);
    const both = [ordinary.request.id, opened.request.id].toSorted();
    const notifications = new NotificationStore(f.database);
    const [notification] = await notifications.decide({
      type: "requestChanged",
      kind: "device.access",
      status: "pending",
      opened: true,
      requestId: opened.request.id,
      runId: run.run.id,
      threadId: run.thread.id,
    });
    expect(
      await notifications.publicationSkipReason({
        ...notification!.view,
        userId: run.userId,
        eventId: createId("event"),
        sequence: notification!.sequence,
        connectionId: notification!.connectionId,
        occurredAt: new Date(opened.request.createdAt),
        expiresAt: new Date(Date.parse(opened.request.createdAt) + 60_000),
      }),
    ).toBeNull();

    const needsYou = await needsYouPage(f.database, { userId: run.userId });
    expect(needsYou.count).toBe(2);
    expect(
      needsYou.entries.flatMap((entry) => (entry.kind === "request" ? [entry.request.id] : [])),
    ).toEqual(expect.arrayContaining(both));
    expect(await f.store.notificationState.attention(run.userId)).toMatchObject({ needsYou: 2 });
    const waiting = await f.store.requests.waitingOnUserPage({ userId: run.userId, limit: 100 });
    expect(waiting.requests.map(({ request }) => request.id).toSorted()).toEqual(both);
    expect(waiting.window.totalItems).toBe(2);
    const threadRequests = await f.store.requests.originatingPendingPage({
      threadId: run.thread.id,
      limit: 100,
    });
    expect(threadRequests.requests.map(({ id }) => id).toSorted()).toEqual(both);
    expect(threadRequests.window.totalItems).toBe(2);
    expect(
      await f.database
        .selectFrom("clientSyncState")
        .select(["pendingRequestCount", "needsYouCount"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ pendingRequestCount: 2, needsYouCount: 2 });
    const detail = await withPersonalSyncRead(f.database, async (tx) =>
      buildPersonalDetailSnapshot(tx, await authorizedSyncState(tx, run.userId), run.userId, {
        kind: "thread",
        threadId: run.thread.id,
      }),
    );
    expect(detail.thread.pendingRequestCount).toBe(2);
    expect(detail.pendingRequests.map(({ id }) => id).toSorted()).toEqual(both);
    expect(await f.store.requests.get(opened.request.id)).toMatchObject({ status: "pending" });
  });

  it("deduplicates an owned off phone and never adds it to reachable shell routes", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("device-access");
    const target = await device(f, run, "ios");
    const [a, b] = await Promise.all([ask(f, run, target), ask(f, run, target, "again")]);
    expect(a.request.id).toBe(b.request.id);
    expect(a.request).toMatchObject({
      kind: "device.access",
      mode: "durable",
      requiredActor: "owner",
      payload: { machineId: target, machineName: "Phone", access: "browser" },
    });
    expect(await f.store.listReachableMachines(run.userId, run.runnerId)).toEqual([]);
    await expect(ask(f, run, run.runnerId, "home-files", "files")).rejects.toMatchObject({
      reason: "device-access-on",
    });
    const android = await device(f, run, "android");
    await expect(ask(f, run, android, "unsupported-apps", "apps")).rejects.toMatchObject({
      reason: "device-access-unsupported",
    });
  });
  it("rechecks online state, ownership and the effective switch before creating", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("device-recheck");
    const target = await device(f, run);
    await expect(ask(f, run, target, "offline", "browser", false)).rejects.toMatchObject({
      reason: "device-offline",
      details: { machineId: target, capability: "browser" },
    });
    await f.store.updateMachineAccessPolicy({
      runnerId: target,
      ownerId: run.userId,
      allowDeployment: true,
      expectedRevision: 2,
      policy: { ...machineAccessPolicyDefault, browser: true },
    });
    await expect(ask(f, run, target, "already-on")).rejects.toMatchObject({
      reason: "device-access-on",
    });
    await f.database
      .updateTable("devices")
      .set({ ownerKind: "deployment", ownerUserId: null })
      .where("id", "=", DeviceIdSchema.parse(target))
      .execute();
    await expect(ask(f, run, target, "not-owned", "apps")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(
      await f.database
        .selectFrom("requests")
        .select("id")
        .where("kind", "=", "device.access")
        .execute(),
    ).toEqual([]);
  });
  it("fulfills and queues its continuation in the access transaction, with rollback and replay", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("device-fulfil");
    const target = await device(f, run);
    const opened = await ask(f, run, target);
    const update = {
      runnerId: target,
      ownerId: run.userId,
      allowDeployment: true,
      expectedRevision: 2,
      policy: { ...machineAccessPolicyDefault, browser: true },
      idempotency: { key: "enable", requestedBy: run.userId },
    };
    await expect(
      commitPersonalMutation(f.database, async (tx) => {
        const { updateMachineAccessPolicy } = await import("./machine-store.js");
        await updateMachineAccessPolicy(tx, update);
        expect(await tx.selectFrom("requestContinuations").selectAll().execute()).toHaveLength(1);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await f.store.requests.get(opened.request.id))?.status).toBe("pending");
    expect(await f.database.selectFrom("requestContinuations").selectAll().execute()).toEqual([]);
    expect(
      await f.store.updateMachineAccessPolicy({
        ...update,
        expectedRevision: 1,
        idempotency: { key: "stale-enable", requestedBy: run.userId },
      }),
    ).toMatchObject({ outcome: "conflict" });
    expect((await f.store.requests.get(opened.request.id))?.status).toBe("pending");
    const updated = await f.store.updateMachineAccessPolicy(update);
    expect(updated).toMatchObject({
      outcome: "updated",
    });
    expect((await f.store.requests.get(opened.request.id))?.status).toBe("fulfilled");
    expect(await f.store.updateMachineAccessPolicy(update)).toMatchObject({
      replayed: true,
    });
    expect(await f.database.selectFrom("requestContinuations").selectAll().execute()).toHaveLength(
      1,
    );
  });
  it("keeps Not now for the task and checks real machine-management authority", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("device-decline");
    const target = await device(f, run);
    const opened = await ask(f, run, target);
    await expect(
      f.store.requests.declineDeviceAccessRequest({
        requestId: opened.request.id,
        expectedRevision: (await f.store.requests.revision(opened.request.id))!,
        resolvedBy: createId("user"),
        response: decline,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.store.requests.declineDeviceAccessRequest({
      requestId: opened.request.id,
      expectedRevision: (await f.store.requests.revision(opened.request.id))!,
      resolvedBy: run.userId,
      response: decline,
    });
    const ordinal = await f.database
      .selectFrom("runs")
      .select("nextRunnerOrdinal")
      .where("id", "=", run.run.id)
      .executeTakeFirstOrThrow();
    await f.store.commitRunnerEvent({
      environmentId: run.environmentId,
      runnerId: run.runnerId,
      runnerBootId: run.runnerBootId,
      event: pendingEvent({
        type: "run.completed",
        data: { status: "completed" },
        environmentId: run.environmentId,
        runId: run.run.id,
        threadId: run.thread.id,
        bindingGeneration: run.bindingGeneration,
        ordinal: ordinal.nextRunnerOrdinal,
      }),
    });
    const turn = await f.enqueueHumanTrigger({
      threadId: run.thread.id,
      requestedBy: run.userId,
      content: [{ type: "text", text: "Continue the task" }],
      idempotencyKey: "later-task-turn",
    });
    const later = { ...run, ...(await startPersonalQueuedRunFixture(f.store, turn.run.id)) };
    const again = await ask(f, later, target, "new-call");
    expect(again).toMatchObject({
      replayed: true,
      request: { id: opened.request.id, status: "declined" },
    });
    const another = await f.startRunFixture("different-task");
    expect((await ask(f, another, target)).request.id).not.toBe(opened.request.id);
  });
  it("cancels on device removal and on loss of the origin's authority", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("device-cancel");
    const target = await device(f, run);
    const opened = await ask(f, run, target);
    const removed = await f.store.revokeRunner(target, run.userId);
    expect(removed.cancelledRequestIds).toContain(opened.request.id);
    expect(await f.store.requests.get(opened.request.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "resource-deleted",
    });
    await expect(ask(f, run, target, "removed")).rejects.toMatchObject({ code: "forbidden" });
    const nextTarget = await device(f, run);
    const next = await ask(f, run, nextTarget, "authority");
    await f.database
      .updateTable("devices")
      .set({ ownerKind: "deployment", ownerUserId: null })
      .where("id", "=", DeviceIdSchema.parse(nextTarget))
      .execute();
    const { fulfillDeviceAccessRequestsInTransaction } = await import("./request-store.js");
    await commitPersonalMutation(f.database, (tx) =>
      fulfillDeviceAccessRequestsInTransaction(tx, DeviceIdSchema.parse(nextTarget), {
        ...machineAccessPolicyDefault,
        browser: true,
      }),
    );
    expect(await f.store.requests.get(next.request.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
  });
});
