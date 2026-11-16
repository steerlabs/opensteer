import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createId, TabIdSchema } from "@opensteer/core";
import { TabStore } from "@opensteer/database";
import {
  createStoreFixture,
  testRunnerDescriptor,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import { DeviceDriverService, type DeviceDriverManagementPort } from "./device-driver-service.js";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "./administration-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";

let fixture: StoreFixture;
beforeEach(async () => {
  fixture = await createStoreFixture();
});
afterEach(async () => {
  await fixture?.close();
});

async function setup() {
  const owner = await fixture.startRunFixture("screen-management");
  const store = fixture.store;
  const sessionId = createId("authSession");
  await fixture.database
    .insertInto("authSessions")
    .values({
      id: sessionId,
      userId: owner.userId,
      token: randomUUID(),
      deviceLabel: "Test",
      userAgent: null,
      ipAddress: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      absoluteExpiresAt: new Date(Date.now() + 120000),
    })
    .execute();
  await fixture.database
    .insertInto("personalRemoteAccess")
    .values({
      singletonKey: "personal",
      mode: "private",
      generation: 1,
      routeOrigin: "https://screen-management.invalid",
    })
    .onConflict((conflict) =>
      conflict
        .column("singletonKey")
        .doUpdateSet({ mode: "private", routeOrigin: "https://screen-management.invalid" }),
    )
    .execute();
  const runnerId = createId("runner"),
    token = randomUUID();
  await store.createRunnerEnrollment({
    allowedModules: ["browser", "integrations"],
    createdBy: owner.userId,
    expiresAt: new Date(Date.now() + 60000),
    id: token,
    idempotencyKey: token,
    name: "Work Mac",
    requestFingerprint: token,
    runnerKind: "local",
    tokenHash: token,
  });
  const connection = await store.enrollRunnerConnection({
    descriptor: {
      ...testRunnerDescriptor({
        runnerId,
        runnerKind: "local",
        name: "Work Mac",
        environmentId: createId("environment"),
        modules: { integrations: { platform: "darwin", screenDrivers: 1 } },
      }),
      device: { platform: "macos", form: "desktop", app: "opensteer" },
    },
    enrollmentTokenHash: token,
    publicKeyPem: `test-key-${token}`,
    publicKeyFingerprint: `test-fingerprint-${token}`,
  });
  let negotiated = true;
  const port: DeviceDriverManagementPort = {
    screenDriver: () =>
      negotiated
        ? { connectionGeneration: connection.connectionGeneration, screenDrivers: 1 }
        : null,
    withAdmission: async (_id, action) => action(),
    bindingsChanged: async () => {},
    removed: async () => {},
    disableAgentAccess: async () => {},
  };
  const service = new DeviceDriverService(store, port);
  const actor = { userId: owner.userId, sessionId };
  const command = {
    type: "iphone.screen.attach" as const,
    idempotencyKey: randomUUID(),
    driverRunnerId: runnerId,
    target: { kind: "new" as const, name: "Travel iPhone" },
  };
  return {
    owner,
    store,
    runnerId,
    port,
    service,
    actor,
    command,
    unnegotiate: () => {
      negotiated = false;
    },
  };
}

it("attaches with no grants, replays once, and detaches without removing its phone tab or Mac", async () => {
  const f = await setup();
  const attached = await f.service.execute(f.actor, f.command);
  expect(await f.service.execute(f.actor, f.command)).toEqual(attached);
  expect(await f.store.getDevice(attached.deviceId)).toMatchObject({
    name: "Travel iPhone",
    kind: "phone",
    platform: "ios",
    accessPolicy: { apps: false, browser: false, reach: "nobody" },
  });
  expect(
    await fixture.database
      .selectFrom("integrationConnections")
      .select("id")
      .where("deviceId", "=", attached.deviceId)
      .execute(),
  ).toEqual([]);
  const tabs = new TabStore(fixture.database),
    tabId = TabIdSchema.parse("screen-management-tab");
  await tabs.open(
    {
      id: tabId,
      ownerId: f.actor.userId,
      kind: "phone",
      computerId: attached.deviceId,
      title: "Travel iPhone",
      openedBy: "person",
    },
    randomUUID(),
  );
  await f.store.recordComputerUseStop({ deviceId: attached.deviceId, runId: f.owner.runId });
  const detached = await f.service.execute(f.actor, {
    type: "iphone.screen.detach",
    idempotencyKey: randomUUID(),
    deviceId: attached.deviceId,
    expectedGeneration: attached.generation,
  });
  expect(detached.generation).toBe(attached.generation + 1);
  expect(await f.store.activeComputerUseStops()).toContainEqual({
    deviceId: attached.deviceId,
    runId: f.owner.runId,
  });
  expect(
    await fixture.database
      .selectFrom("personalTabs")
      .select("computerId")
      .where("id", "=", tabId)
      .executeTakeFirst(),
  ).toMatchObject({ computerId: attached.deviceId });
  expect(await f.store.getDevice(attached.deviceId)).toMatchObject({ removedAt: null });
  expect(
    await fixture.database
      .selectFrom("runners")
      .select("revokedAt")
      .where("id", "=", f.runnerId)
      .executeTakeFirst(),
  ).toMatchObject({ revokedAt: null });
  await expect(
    f.service.execute(f.actor, {
      ...f.command,
      idempotencyKey: randomUUID(),
      target: {
        kind: "existing",
        deviceId: attached.deviceId,
        expectedGeneration: attached.generation,
      },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});

it("requires confirmed negotiation and an owner person session, then removes only the screen Device", async () => {
  const f = await setup();
  const admin = new AdministrationService(
    {
      store: f.store,
      deviceDrivers: f.port,
      realtime: { broadcast: () => {} },
    } as unknown as AdministrationDependencies,
    () => {},
  );
  await expect(
    admin.authorize({ kind: "run", userId: f.actor.userId } as AgentCaller, f.command),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    admin.execute({ kind: "person", userId: f.actor.userId }, f.command),
  ).rejects.toMatchObject({ code: "forbidden" });
  const attached = await f.service.execute(f.actor, f.command);
  await admin.execute(
    { kind: "person", userId: f.actor.userId },
    {
      type: "machine.rename",
      machineId: attached.deviceId,
      name: "Renamed iPhone",
      idempotencyKey: randomUUID(),
    },
  );
  await admin.execute(
    { kind: "person", userId: f.actor.userId },
    { type: "machine.revoke", machineId: attached.deviceId, idempotencyKey: randomUUID() },
  );
  expect(await f.store.getDevice(attached.deviceId)).toMatchObject({
    name: "Renamed iPhone",
    removedAt: expect.any(Date),
  });
  expect(
    await fixture.database
      .selectFrom("runners")
      .select("revokedAt")
      .where("id", "=", f.runnerId)
      .executeTakeFirst(),
  ).toMatchObject({ revokedAt: null });
  f.unnegotiate();
  await expect(
    f.service.execute(f.actor, { ...f.command, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: "conflict" });
});
