import {
  createIntegrationId,
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
} from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { jsonValue } from "./store-primitives.js";
import { machineAccessPolicyDefault } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { createId, DeviceIdSchema } from "@opensteer/core";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "./connection.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";
import { seedPrivatePublisher } from "./private-publisher.test-support.js";
import { testRunnerDescriptor } from "./runner-fixture.test-support.js";
import { OpensteerStore } from "./store.js";

let clone: TestDatabase;
let db: ReturnType<typeof createDatabase>;
let store: OpensteerStore;
let fixture: Awaited<ReturnType<typeof seedPrivatePublisher>>;
let sessionId: ReturnType<typeof createId<"authSession">>;
beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  db = createDatabase({ connectionString: clone.url });
  fixture = await seedPrivatePublisher(db);
  store = new OpensteerStore(db);
  await db
    .insertInto("personalRemoteAccess")
    .values({
      singletonKey: "personal",
      mode: "private",
      generation: 1,
      routeOrigin: "https://driver.invalid",
    })
    .onConflict((c) =>
      c
        .column("singletonKey")
        .doUpdateSet({ mode: "private", routeOrigin: "https://driver.invalid" }),
    )
    .execute();
  sessionId = createId("authSession");
  await db
    .insertInto("authSessions")
    .values({
      id: sessionId,
      userId: fixture.userId,
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
});
afterEach(async () => {
  try {
    await db?.destroy();
  } finally {
    await clone?.drop();
  }
});
async function mac() {
  const runnerId = createId("runner");
  const token = randomUUID();
  await store.createRunnerEnrollment({
    allowedModules: ["browser", "integrations"],
    createdBy: fixture.userId,
    expiresAt: new Date(Date.now() + 60000),
    id: token,
    idempotencyKey: token,
    name: "Mac",
    requestFingerprint: token,
    runnerKind: "local",
    tokenHash: token,
  });
  const descriptor = {
    ...testRunnerDescriptor({
      runnerId,
      runnerKind: "local",
      name: "Mac",
      environmentId: createId("environment"),
      modules: { integrations: { platform: "darwin", screenDrivers: 1 } },
    }),
    device: { platform: "macos" as const, form: "desktop" as const, app: "opensteer" as const },
  };
  const connection = await store.enrollRunnerConnection({
    descriptor,
    enrollmentTokenHash: token,
    publicKeyPem: `test-key-${token}`,
    publicKeyFingerprint: `test-fingerprint-${token}`,
  });
  return { runnerId, generation: connection.connectionGeneration };
}
it("attaches without approval, replays exactly and fences detach/re-attach generations", async () => {
  const driver = await mac();
  const input = {
    sessionId,
    userId: fixture.userId,
    driverRunnerId: driver.runnerId,
    driverConnectionGeneration: driver.generation,
    negotiatedScreenDrivers: 1 as const,
    idempotencyKey: randomUUID(),
    target: { kind: "new" as const, name: "iPhone" },
  };
  const attached = await store.attachIphoneScreen(input);
  expect(await store.attachIphoneScreen(input)).toEqual(attached);
  expect((await store.getDevice(attached.deviceId))?.kind).toBe("phone");
  expect((await store.getDevice(attached.deviceId))?.accessPolicy.apps).toBe(false);
  expect(
    await db
      .selectFrom("integrationConnections")
      .select("id")
      .where("deviceId", "=", attached.deviceId)
      .execute(),
  ).toEqual([]);
  const detach = {
    sessionId,
    userId: fixture.userId,
    idempotencyKey: randomUUID(),
    deviceId: attached.deviceId,
    expectedGeneration: 1,
  };
  expect(await store.detachIphoneScreen(detach)).toEqual({
    deviceId: attached.deviceId,
    generation: 2,
  });
  expect(await store.detachIphoneScreen(detach)).toEqual({
    deviceId: attached.deviceId,
    generation: 2,
  });
  await expect(
    store.attachIphoneScreen({
      ...input,
      idempotencyKey: randomUUID(),
      target: { kind: "existing", deviceId: attached.deviceId, expectedGeneration: 1 },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    await store.attachIphoneScreen({
      ...input,
      idempotencyKey: randomUUID(),
      target: { kind: "existing", deviceId: attached.deviceId, expectedGeneration: 2 },
    }),
  ).toEqual({ deviceId: attached.deviceId, generation: 3 });
});
it("Runner revoke removes self but retains and detaches its screen targets; Device remove leaves Mac live", async () => {
  const driver = await mac();
  const attach = () =>
    store.attachIphoneScreen({
      sessionId,
      userId: fixture.userId,
      driverRunnerId: driver.runnerId,
      driverConnectionGeneration: driver.generation,
      negotiatedScreenDrivers: 1,
      idempotencyKey: randomUUID(),
      target: { kind: "new", name: "iPhone" },
    });
  const first = await attach();
  const second = await attach();
  const platform = new IntegrationPlatformStore(db);
  const definition = IntegrationDefinitionSchema.parse({
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This phone" }],
    id: "iphone-screen",
    name: "iPhone screen",
    provider: "iphone-screen",
    description: "Phone screen",
    config: {
      kind: "display",
      platforms: ["ios"],
      accessLabels: { read: "Read", readWrite: "Control" },
      accessSummaries: { read: "See", readWrite: "Control" },
      operations: [
        {
          name: "observe",
          title: "Observe",
          description: "Observe",
          effect: "read",
          inputSchema: { type: "object" },
          outputSchema: null,
        },
      ],
    },
  });
  const installationId = createIntegrationId("installation"),
    serverId = createIntegrationId("server");
  await platform.install({
    actorUserId: fixture.userId,
    adapterSnapshot: null,
    requestId: randomUUID(),
    installation: {
      id: installationId,
      name: definition.id,
      title: definition.name,
      description: definition.description,
      manifest: { definition: integrationDefinitionSummary(definition) },
      provenance: { definitionId: definition.id, maintainedBy: "opensteer" },
      sourceKind: "built-in",
      trust: "built-in",
      status: "active",
      version: "test",
    },
    servers: [
      {
        id: serverId,
        name: "default",
        status: "active",
        statusDetail: null,
        connectionRequirement: { kind: "computer", definitionId: definition.id },
        transport: { type: "computer", definitionId: definition.id },
        catalog: { definitions: {}, tools: [] },
      },
    ],
  });
  const connectionIds = [];
  for (const phone of [first, second]) {
    const result = await platform.setDeviceComputerConnection({
      deviceId: phone.deviceId,
      actorUserId: fixture.userId,
      access: "read",
      app: null,
      definitionId: definition.id,
      definitionDigest: integrationDefinitionDigest(definition),
      createIfMissing: true,
      requestId: randomUUID(),
      tools: () => [],
    });
    connectionIds.push(result.connection.id);
    await platform.createGrant({
      access: "read",
      alias: "Phone",
      connectionId: result.connection.id,
      createdBy: fixture.userId,
      ownerUserId: fixture.userId,
      installationId,
      isDefault: false,
      providerAuthorizations: {},
    });
    await store.updateDeviceAccessPolicy({
      deviceId: phone.deviceId,
      ownerId: fixture.userId,
      allowDeployment: false,
      expectedRevision: 1,
      policy: { ...machineAccessPolicyDefault, browser: false, apps: true },
    });
    await store.recordComputerUseStop({ deviceId: phone.deviceId, runId: fixture.runId });
  }
  const tabId = createId("tab");
  await db
    .insertInto("personalTabs")
    .values({
      id: tabId,
      ownerId: fixture.userId,
      kind: "phone",
      computerId: second.deviceId,
      title: "Phone",
      openedBy: jsonValue("person"),
    })
    .execute();
  await db
    .updateTable("authSessions")
    .set({ deviceId: await store.requireSelfDeviceId(driver.runnerId) })
    .where("id", "=", sessionId)
    .execute();

  const rename = {
    administration: {
      requestedBy: fixture.userId,
      idempotencyKey: randomUUID(),
      type: "machine.rename",
      request: { deviceId: first.deviceId, name: "Renamed iPhone" },
      authoritySource: { kind: "user-session", userId: fixture.userId },
    },
  };
  await store.renameDevice(first.deviceId, fixture.userId, "Renamed iPhone", rename);
  await store.renameDevice(first.deviceId, fixture.userId, "Renamed iPhone", rename);
  expect((await store.getDevice(first.deviceId))?.name).toBe("Renamed iPhone");
  const removal = {
    administration: {
      ...rename.administration,
      type: "machine.revoke",
      idempotencyKey: randomUUID(),
      request: { deviceId: first.deviceId },
    },
  };
  const removed = await store.removeDevice(first.deviceId, fixture.userId, removal);
  expect(await store.removeDevice(first.deviceId, fixture.userId, removal)).toEqual(removed);
  expect(removed.removedDeviceIds).toEqual([first.deviceId]);
  expect(await store.runnerForAuthentication(driver.runnerId)).toMatchObject({ revokedAt: null });
  expect(
    (
      await db
        .selectFrom("authSessions")
        .select("deviceId")
        .where("id", "=", sessionId)
        .executeTakeFirst()
    )?.deviceId,
  ).toBe(await store.requireSelfDeviceId(driver.runnerId));
  expect(
    (
      await db
        .selectFrom("integrationGrants")
        .select("status")
        .where("connectionId", "=", connectionIds[0]!)
        .executeTakeFirst()
    )?.status,
  ).toBe("revoked");
  const effects = await store.revokeRunner(driver.runnerId, fixture.userId);
  expect(effects.removedDeviceIds).toEqual([DeviceIdSchema.parse(driver.runnerId)]);
  expect(effects.detachedDeviceBindings).toEqual([
    { deviceId: second.deviceId, role: "screen", runnerId: driver.runnerId, generation: 2 },
  ]);
  expect((await store.getDevice(second.deviceId))?.removedAt).toBeNull();
  expect(await store.getSelfDeviceId(driver.runnerId)).toBeNull();
  expect(await store.activeComputerUseStops()).toEqual([
    { runId: fixture.runId, deviceId: second.deviceId },
  ]);
  expect(
    (
      await db
        .selectFrom("integrationConnections")
        .select("status")
        .where("id", "=", connectionIds[1]!)
        .executeTakeFirst()
    )?.status,
  ).toBe("connected");
  expect(
    (
      await db
        .selectFrom("integrationGrants")
        .select("status")
        .where("connectionId", "=", connectionIds[1]!)
        .executeTakeFirst()
    )?.status,
  ).toBe("active");
  expect((await store.getDevice(second.deviceId))?.accessPolicy.apps).toBe(true);
  expect(
    (
      await db
        .selectFrom("personalTabs")
        .select("closedAt")
        .where("id", "=", tabId)
        .executeTakeFirst()
    )?.closedAt,
  ).toBeNull();
});
it("requires a live owner session, current Mac generation and a supported self Device", async () => {
  const driver = await mac();
  const input = {
    sessionId,
    userId: fixture.userId,
    driverRunnerId: driver.runnerId,
    driverConnectionGeneration: driver.generation,
    negotiatedScreenDrivers: 1 as const,
    idempotencyKey: randomUUID(),
    target: { kind: "new" as const, name: "iPhone" },
  };
  await expect(
    store.attachIphoneScreen({ ...input, driverConnectionGeneration: driver.generation + 1 }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    store.attachIphoneScreen({
      ...input,
      target: {
        kind: "existing",
        deviceId: DeviceIdSchema.parse(driver.runnerId),
        expectedGeneration: 1,
      },
    }),
  ).rejects.toMatchObject({ code: "forbidden" });

  const foreign = await store.createUser("Other owner");
  await db
    .updateTable("runners")
    .set({ ownerUserId: foreign })
    .where("id", "=", driver.runnerId)
    .execute();
  await expect(store.attachIphoneScreen(input)).rejects.toMatchObject({ code: "forbidden" });
  await db
    .updateTable("runners")
    .set({
      ownerUserId: fixture.userId,
      moduleDescriptors: jsonValue({ integrations: { platform: "darwin" } }),
    })
    .where("id", "=", driver.runnerId)
    .execute();
  await expect(store.attachIphoneScreen(input)).rejects.toMatchObject({ code: "forbidden" });
  await db.deleteFrom("authSessions").where("id", "=", sessionId).execute();
  await expect(store.attachIphoneScreen(input)).rejects.toMatchObject({ code: "forbidden" });
});

it("rolls back an in-flight attach when its person session is revoked", async () => {
  const driver = await mac();
  const idempotencyKey = randomUUID();
  let attempt: Promise<unknown> | undefined;
  await db.transaction().execute(async (transaction) => {
    await transaction
      .selectFrom("runners")
      .select("id")
      .where("id", "=", driver.runnerId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    attempt = store
      .attachIphoneScreen({
        sessionId,
        userId: fixture.userId,
        driverRunnerId: driver.runnerId,
        driverConnectionGeneration: driver.generation,
        negotiatedScreenDrivers: 1,
        idempotencyKey,
        target: { kind: "new", name: "Revoked attach" },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await vi.waitFor(
      async () => {
        const waiting = await sql<{
          count: string;
        }>`select count(*)::text from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from "runners"%'`.execute(
          db,
        );
        expect(
          Number(waiting.rows[0]!.count),
          "Attach never waited on its Runner fence",
        ).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    await db.deleteFrom("authSessions").where("id", "=", sessionId).execute();
  });
  expect(await attempt).toMatchObject({ code: "unauthorized" });
  expect(
    await db.selectFrom("devices").select("id").where("name", "=", "Revoked attach").execute(),
  ).toEqual([]);
  expect(
    await db
      .selectFrom("commands")
      .select("id")
      .where("idempotencyKey", "=", idempotencyKey)
      .execute(),
  ).toEqual([]);
});

it("revokes Runner-bound sessions even when the Runner has no Device", async () => {
  const driver = await mac();
  await db.deleteFrom("deviceDrivers").where("runnerId", "=", driver.runnerId).execute();
  await db.deleteFrom("devices").where("id", "=", DeviceIdSchema.parse(driver.runnerId)).execute();
  await db
    .updateTable("authSessions")
    .set({ deviceId: DeviceIdSchema.parse(driver.runnerId) })
    .where("id", "=", sessionId)
    .execute();
  const effects = await store.revokeRunner(driver.runnerId, fixture.userId);
  expect(effects.removedDeviceIds).toEqual([]);
  expect(effects.endedSessionIds).toEqual([sessionId]);
  expect(
    await db.selectFrom("authSessions").select("id").where("id", "=", sessionId).execute(),
  ).toEqual([]);
});
