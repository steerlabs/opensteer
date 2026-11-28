import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createId, type RunnerId } from "@opensteer/core";
import { RunnerBootIdSchema, type MachineAccessPolicy } from "@opensteer/protocol";
import {
  createStoreFixture,
  testRunnerDescriptor,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import {
  DeviceAccessRefusal,
  requireDeviceAccess,
  requireRunnerDeviceAccess,
  type DeviceCapability,
} from "./device-access.js";

let fixture: StoreFixture;
beforeEach(async () => {
  fixture = await createStoreFixture();
});
afterEach(async () => {
  await fixture?.close();
});

const allEnabledPolicy: MachineAccessPolicy = {
  browser: true,
  apps: true,
  reach: "owner",
  commands: false,
  forwarding: false,
  shares: [],
};

async function enrollSelfRunner(name = "Work Mac", accessPolicy?: MachineAccessPolicy) {
  const owner = await fixture.startRunFixture("device-access-sql");
  await fixture.database
    .insertInto("personalRemoteAccess")
    .values({
      singletonKey: "personal",
      mode: "private",
      generation: 1,
      routeOrigin: "https://device-access-sql.invalid",
    })
    .onConflict((conflict) =>
      conflict
        .column("singletonKey")
        .doUpdateSet({ mode: "private", routeOrigin: "https://device-access-sql.invalid" }),
    )
    .execute();
  const runnerId = createId("runner");
  const token = randomUUID();
  await fixture.store.createRunnerEnrollment({
    allowedModules: ["browser", "integrations"],
    createdBy: owner.userId,
    expiresAt: new Date(Date.now() + 60_000),
    id: token,
    idempotencyKey: token,
    name,
    requestFingerprint: token,
    runnerKind: "local",
    tokenHash: token,
  });
  await fixture.store.enrollRunnerConnection({
    descriptor: {
      ...testRunnerDescriptor({
        runnerId,
        runnerKind: "local",
        name,
        environmentId: createId("environment"),
        modules: { integrations: { platform: "darwin" } },
      }),
      device: { platform: "macos", form: "desktop", app: "opensteer" },
    },
    enrollmentTokenHash: token,
    publicKeyPem: `test-key-${token}`,
    publicKeyFingerprint: `test-fingerprint-${token}`,
  });
  const deviceId = await fixture.store.requireSelfDeviceId(runnerId);
  if (accessPolicy) {
    await fixture.database
      .updateTable("devices")
      .set({ accessPolicy })
      .where("id", "=", deviceId)
      .execute();
  }
  return { owner, runnerId, deviceId };
}

async function outcome(fn: () => Promise<void>) {
  try {
    await fn();
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      isDeviceRefusal: error instanceof DeviceAccessRefusal,
      code: (error as { code?: string }).code,
      reason: (error as { reason?: string }).reason,
      message: error instanceof Error ? error.message : String(error),
      details: (error as { details?: unknown }).details,
    };
  }
}

async function compareWithTwoQueries(
  runnerId: RunnerId,
  capability: DeviceCapability,
  online: boolean,
  options: { readonly asleep?: boolean; readonly stopped?: boolean } = {},
) {
  const single = await outcome(() =>
    requireRunnerDeviceAccess(fixture.database, runnerId, capability, online, options),
  );
  const legacy = await outcome(async () => {
    const deviceId = await fixture.store.requireSelfDeviceId(runnerId);
    await requireDeviceAccess(fixture.database, deviceId, capability, online, options);
  });
  expect(single).toEqual(legacy);
  return single;
}

it("matches the two-query check on real PostgreSQL for active, disabled, offline, asleep, stopped, removed, detached, revoked, and rebooted runners", async () => {
  const { owner, runnerId, deviceId } = await enrollSelfRunner("Work Mac", allEnabledPolicy);

  // Active enabled device passes.
  expect(await compareWithTwoQueries(runnerId, "browser", true)).toEqual({ ok: true });

  // Stopped, asleep, and offline refusals match the two old queries identically.
  expect(await compareWithTwoQueries(runnerId, "browser", true, { stopped: true })).toMatchObject({
    ok: false,
    isDeviceRefusal: true,
    reason: "device-stopped",
    details: { machineId: deviceId, capability: "browser", machineName: "Work Mac" },
  });
  expect(await compareWithTwoQueries(runnerId, "browser", false, { asleep: true })).toMatchObject({
    ok: false,
    isDeviceRefusal: true,
    reason: "device-asleep",
    details: { machineId: deviceId, capability: "browser", machineName: "Work Mac" },
  });
  expect(await compareWithTwoQueries(runnerId, "browser", false)).toMatchObject({
    ok: false,
    isDeviceRefusal: true,
    reason: "device-offline",
    details: { machineId: deviceId, capability: "browser", machineName: "Work Mac" },
  });

  // Capability switched off (disabled for browser while apps remains on).
  await fixture.database
    .updateTable("devices")
    .set({ accessPolicy: { ...allEnabledPolicy, browser: false, apps: true } })
    .where("id", "=", deviceId)
    .execute();
  expect(await compareWithTwoQueries(runnerId, "browser", true)).toMatchObject({
    ok: false,
    isDeviceRefusal: true,
    code: "forbidden",
    reason: "device-access-off",
    details: { machineId: deviceId, capability: "browser" },
  });
  expect(await compareWithTwoQueries(runnerId, "apps", true)).toEqual({ ok: true });

  // Re-enable browser, then reconnect the Runner under a new boot ID (generation bumps):
  // both queries keep resolving the same active self device.
  await fixture.database
    .updateTable("devices")
    .set({ accessPolicy: allEnabledPolicy })
    .where("id", "=", deviceId)
    .execute();
  await fixture.store.authenticateRunnerConnection({
    ...testRunnerDescriptor({
      runnerId,
      runnerKind: "local",
      name: "Work Mac",
      environmentId: createId("environment"),
      modules: { integrations: { platform: "darwin" } },
    }),
    bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
    device: { platform: "macos", form: "desktop", app: "opensteer" },
  });
  expect(await compareWithTwoQueries(runnerId, "browser", true)).toEqual({ ok: true });

  // Another person's runner/device with capability disabled is refused with its own deviceId
  // and never leaks or matches the first runner's device row.
  const otherUserId = createId("user");
  await fixture.database
    .insertInto("users")
    .values({
      id: otherUserId,
      email: `other-${randomUUID()}@example.test`,
      emailVerified: true,
      displayName: "Other Person",
      image: null,
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute();
  const otherRunnerId = createId("runner");
  const otherToken = randomUUID();
  await fixture.store.createRunnerEnrollment({
    allowedModules: ["browser", "integrations"],
    createdBy: owner.userId,
    expiresAt: new Date(Date.now() + 60_000),
    id: otherToken,
    idempotencyKey: otherToken,
    name: "Other Mac",
    requestFingerprint: otherToken,
    runnerKind: "local",
    tokenHash: otherToken,
  });
  await fixture.store.enrollRunnerConnection({
    descriptor: {
      ...testRunnerDescriptor({
        runnerId: otherRunnerId,
        runnerKind: "local",
        name: "Other Mac",
        environmentId: createId("environment"),
        modules: { integrations: { platform: "darwin" } },
      }),
      device: { platform: "macos", form: "desktop", app: "opensteer" },
    },
    enrollmentTokenHash: otherToken,
    publicKeyPem: `test-key-${otherToken}`,
    publicKeyFingerprint: `test-fingerprint-${otherToken}`,
  });
  const otherDeviceId = await fixture.store.requireSelfDeviceId(otherRunnerId);
  await fixture.database
    .updateTable("devices")
    .set({
      ownerUserId: otherUserId,
      accessPolicy: { ...allEnabledPolicy, browser: false, apps: false, reach: "nobody" },
    })
    .where("id", "=", otherDeviceId)
    .execute();
  await fixture.database
    .updateTable("runners")
    .set({ ownerUserId: otherUserId })
    .where("id", "=", otherRunnerId)
    .execute();
  expect(await compareWithTwoQueries(otherRunnerId, "browser", true)).toMatchObject({
    ok: false,
    isDeviceRefusal: true,
    reason: "device-access-off",
    details: { machineId: otherDeviceId, capability: "browser" },
  });
  expect(await compareWithTwoQueries(runnerId, "browser", true)).toEqual({ ok: true });

  // Detached self driver -> not_found.
  await fixture.database
    .updateTable("deviceDrivers")
    .set({ detachedAt: new Date() })
    .where("runnerId", "=", otherRunnerId)
    .where("role", "=", "self")
    .execute();
  expect(await compareWithTwoQueries(otherRunnerId, "browser", true)).toMatchObject({
    ok: false,
    code: "not_found",
    message: "Active self Device not found",
  });

  // Removed device -> not_found.
  await fixture.database
    .updateTable("devices")
    .set({ removedAt: new Date() })
    .where("id", "=", deviceId)
    .execute();
  expect(await compareWithTwoQueries(runnerId, "browser", true)).toMatchObject({
    ok: false,
    code: "not_found",
    message: "Active self Device not found",
  });

  // Restore device, then revoke runner -> not_found.
  await fixture.database
    .updateTable("devices")
    .set({ removedAt: null })
    .where("id", "=", deviceId)
    .execute();
  await fixture.database
    .updateTable("runners")
    .set({ revokedAt: new Date() })
    .where("id", "=", runnerId)
    .execute();
  expect(await compareWithTwoQueries(runnerId, "browser", true)).toMatchObject({
    ok: false,
    code: "not_found",
    message: "Active self Device not found",
  });
});
