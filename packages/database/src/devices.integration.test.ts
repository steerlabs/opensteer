import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createId, type AuthSessionId, type RunnerId, type UserId } from "@opensteer/core";
import {
  deviceAccess,
  machineAccessPolicyDefault,
  type DeviceInitialAccess,
} from "@opensteer/protocol";
import {
  createDeviceLeaveSignature,
  createDeviceSessionBindingSignature,
} from "@opensteer/runner-auth";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { OpensteerStore } from "./store.js";
import type { DatabaseSchema } from "./schema.js";
import { testRunnerDescriptor } from "./runner-fixture.test-support.js";
import { personalReachableGrant } from "./runner-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";

let clone: TestDatabase;
let db: Kysely<DatabaseSchema>;
let store: OpensteerStore;
let fixture: Awaited<ReturnType<typeof seedPersonalFixture>>;
beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  db = createDatabase({ connectionString: clone.url });
  fixture = await seedPersonalFixture(db, "/tmp/device-test-home");
  store = new OpensteerStore(db);
  await db
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
});
afterEach(async () => {
  try {
    await db?.destroy();
  } finally {
    await clone?.drop();
  }
});

function identity() {
  const keys = generateKeyPairSync("ed25519");
  return {
    runnerId: createId("runner"),
    privateKey: keys.privateKey,
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}
async function enrollment(access?: DeviceInitialAccess, prepared = identity(), pin = true) {
  const id = `ren_${randomUUID()}`;
  const request = {
    allowedModules: personalReachableGrant,
    createdBy: fixture.userId,
    expiresAt: new Date(Date.now() + 600_000),
    id,
    idempotencyKey: id,
    name: "Laptop",
    requestFingerprint: id,
    runnerKind: "local" as const,
    tokenHash: `sha256:${id}`,
    ...(pin
      ? { preparedIdentity: { runnerId: prepared.runnerId, publicKeyPem: prepared.publicKeyPem } }
      : {}),
    ...(access ? { initialAccess: access } : {}),
  };
  await store.createRunnerEnrollment(request);
  const connection = {
    descriptor: testRunnerDescriptor({
      runnerId: prepared.runnerId,
      runnerKind: "local",
      name: "Laptop",
      environmentId: createId("environment"),
      modules: { integrations: { platform: "darwin" } },
    }),
    enrollmentTokenHash: request.tokenHash,
    publicKeyPem: prepared.publicKeyPem,
    publicKeyFingerprint: `sha256:${createHash("sha256").update(prepared.publicKeyPem).digest("base64url")}`,
  };
  return { ...prepared, request, connection };
}
async function device(access?: DeviceInitialAccess) {
  const result = await enrollment(access);
  await store.enrollRunnerConnection(result.connection);
  return result;
}
async function session(userId: UserId = fixture.userId) {
  const id = createId("authSession");
  await db
    .insertInto("authSessions")
    .values({
      id,
      userId,
      token: randomUUID(),
      deviceLabel: "Test",
      userAgent: null,
      ipAddress: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    })
    .execute();
  return id;
}
async function bind(
  target: ReturnType<typeof identity>,
  sessionId: AuthSessionId,
  userId = fixture.userId,
  issuedAt = new Date().toISOString(),
) {
  return store.bindDeviceSession({
    machineId: target.runnerId,
    sessionId,
    userId,
    proof: {
      issuedAt,
      signature: createDeviceSessionBindingSignature(target.privateKey, {
        deploymentId: fixture.deploymentId,
        runnerId: target.runnerId,
        sessionId,
        issuedAt,
      }),
    },
  });
}
function leave(target: ReturnType<typeof identity>) {
  const proof = {
    deploymentId: fixture.deploymentId,
    runnerId: target.runnerId,
    issuedAt: new Date().toISOString(),
  };
  return store.leaveDevice({
    ...proof,
    signature: createDeviceLeaveSignature(target.privateKey, proof),
  });
}
async function policy(runnerId: RunnerId) {
  return db
    .selectFrom("runners")
    .select(["accessPolicy", "accessPolicyRevision", "revokedAt"])
    .where("id", "=", runnerId)
    .executeTakeFirstOrThrow();
}

it("preserves false switches in old-shaped updates and fingerprints stale retry intent", async () => {
  const target = await device({ browser: false, apps: false, files: true });
  const request = {
    allowDeployment: true,
    ownerId: fixture.userId,
    runnerId: target.runnerId,
    expectedRevision: 1,
    idempotency: { key: "folders", requestedBy: fixture.userId },
    policy: { ...machineAccessPolicyDefault, reach: "owner" as const, commands: true },
  };
  const first = await store.updateMachineAccessPolicy(request);
  expect(first).toMatchObject({
    outcome: "updated",
    revision: 2,
    changed: { shell: true, browser: false, apps: false },
  });
  expect(deviceAccess((await policy(target.runnerId)).accessPolicy)).toEqual({
    browser: false,
    apps: false,
    files: true,
  });
  expect(await store.updateMachineAccessPolicy(request)).toMatchObject({
    outcome: "updated",
    revision: 2,
    replayed: true,
    changed: { shell: false, browser: false, apps: false },
  });
  expect(
    await store.updateMachineAccessPolicy({
      ...request,
      idempotency: { ...request.idempotency, key: "stale" },
    }),
  ).toMatchObject({ outcome: "conflict" });
  await expect(
    store.updateMachineAccessPolicy({ ...request, policy: { ...request.policy, apps: true } }),
  ).rejects.toMatchObject({ code: "conflict" });
});

it("applies initial access only on first redemption and conflicts when replayed with different switches", async () => {
  const target = await device({ browser: false, apps: true, files: true });
  expect((await policy(target.runnerId)).accessPolicy).toEqual({
    browser: false,
    apps: true,
    reach: "owner",
    commands: true,
    forwarding: true,
    shares: [],
  });
  await store.updateMachineAccessPolicy({
    allowDeployment: true,
    ownerId: fixture.userId,
    runnerId: target.runnerId,
    expectedRevision: 1,
    policy: { ...machineAccessPolicyDefault, browser: true, apps: false },
  });
  await store.enrollRunnerConnection(target.connection);
  expect(deviceAccess((await policy(target.runnerId)).accessPolicy)).toEqual({
    browser: true,
    apps: false,
    files: false,
  });
  await expect(
    store.createRunnerEnrollment({
      ...target.request,
      initialAccess: { browser: true, apps: true, files: true },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});

it("binds only the effective owner, refuses cross-runner, expired proof/session, and replays harmlessly", async () => {
  const target = await device();
  const other = await device();
  const login = await session();
  await bind(target, login);
  await bind(target, login);
  await expect(bind(other, login)).rejects.toMatchObject({ code: "forbidden" });
  const foreign = createId("user");
  await db
    .insertInto("users")
    .values({ id: foreign, displayName: "Other", email: "other@invalid.test", emailVerified: true })
    .execute();
  await expect(bind(target, await session(foreign), foreign)).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(
    bind(target, await session(), fixture.userId, new Date(Date.now() - 301_000).toISOString()),
  ).rejects.toMatchObject({ code: "forbidden" });
  const expired = await session();
  await db
    .updateTable("authSessions")
    .set({ expiresAt: new Date(0) })
    .where("id", "=", expired)
    .execute();
  await expect(bind(target, expired)).rejects.toMatchObject({ code: "forbidden" });
});

it("tombstones and deletes every bound session atomically; session revoke uses the same operation", async () => {
  const target = await device();
  const one = await session();
  const two = await session();
  const web = await session();
  await bind(target, one);
  await bind(target, two);
  const result = await store.revokeDeviceSession({ sessionId: one, userId: fixture.userId });
  expect([...result.endedSessionIds].sort()).toEqual([one, two].sort());
  expect((await policy(target.runnerId)).revokedAt).not.toBeNull();
  expect((await db.selectFrom("authSessions").select("id").execute()).map((row) => row.id)).toEqual(
    [web],
  );
  await expect(
    store.revokeDeviceSession({ sessionId: one, userId: fixture.userId }),
  ).resolves.toMatchObject({ runnerId: null });
});

it("Home sign-out deletes only its session", async () => {
  const target = identity();
  target.runnerId = fixture.runnerId;
  await db
    .updateTable("runners")
    .set({ publicKeyPem: target.publicKeyPem })
    .where("id", "=", target.runnerId)
    .execute();
  const one = await session();
  const two = await session();
  await bind(target, one);
  await bind(target, two);
  await store.revokeDeviceSession({ sessionId: one, userId: fixture.userId });
  expect((await policy(target.runnerId)).revokedAt).toBeNull();
  expect((await db.selectFrom("authSessions").select("id").execute()).map((row) => row.id)).toEqual(
    [two],
  );
});

it("serializes a binding behind removal and refuses to bind the tombstone", async () => {
  const target = await device();
  const login = await session();
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const removal = withPersonalTransaction(db, async (transaction) => {
    locked.resolve();
    await withTimeout(release.promise, 3000, {
      timeoutError: () => new Error("removal transaction was not released"),
    });
    return new OpensteerStore(transaction).revokeRunner(target.runnerId, fixture.userId);
  });
  await withTimeout(locked.promise, 3000, {
    timeoutError: () => new Error("removal never acquired commit order"),
  });
  const binding = bind(target, login);
  const refused = expect(binding).rejects.toMatchObject({ code: "forbidden" });
  release.resolve();
  await removal;
  await refused;
  expect(
    (
      await db
        .selectFrom("authSessions")
        .select("deviceId")
        .where("id", "=", login)
        .executeTakeFirstOrThrow()
    ).deviceId,
  ).toBeNull();
});

it("signed leave is idempotent and an old proof cannot remove a later identity", async () => {
  const old = await device();
  const login = await session();
  await bind(old, login);
  await leave(old);
  await leave(old);
  const newer = await device();
  await leave(old);
  expect((await policy(newer.runnerId)).revokedAt).toBeNull();
  const issuedAt = new Date().toISOString();
  await expect(
    store.leaveDevice({
      deploymentId: fixture.deploymentId,
      runnerId: newer.runnerId,
      issuedAt,
      signature: createDeviceLeaveSignature(old.privateKey, {
        deploymentId: fixture.deploymentId,
        runnerId: old.runnerId,
        issuedAt,
      }),
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("retires a prepared key even when issuance never committed and refuses a late issuance", async () => {
  const target = identity();
  await expect(leave(target)).rejects.toMatchObject({ code: "forbidden" });
  const proof = {
    deploymentId: fixture.deploymentId,
    runnerId: target.runnerId,
    issuedAt: new Date().toISOString(),
  };
  const cancel = {
    ...proof,
    signature: createDeviceLeaveSignature(target.privateKey, proof),
    preparedIdentity: { runnerId: target.runnerId, publicKeyPem: target.publicKeyPem },
  };
  await store.leaveDevice(cancel);
  await store.leaveDevice(cancel);
  await expect(enrollment(undefined, target)).rejects.toMatchObject({ code: "forbidden" });
  const differentKey = identity();
  await expect(
    store.leaveDevice({
      ...cancel,
      preparedIdentity: { runnerId: target.runnerId, publicKeyPem: differentKey.publicKeyPem },
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("cancels only the prepared self-setup enrollment before first redemption", async () => {
  const target = await enrollment();
  const generic = await enrollment(undefined, identity(), false);
  await leave(target);
  await leave(target);
  await expect(store.enrollRunnerConnection(target.connection)).rejects.toMatchObject({
    reason: "runner-enrollment-expired",
  });
  await expect(store.enrollRunnerConnection(generic.connection)).resolves.toMatchObject({
    runnerId: generic.runnerId,
  });
});

it("publishes the runner tombstone and bound-session deletion in one commit", async () => {
  const target = await device();
  const login = await session();
  await bind(target, login);
  const written = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const removing = withPersonalTransaction(db, async (transaction) => {
    const removed = await new OpensteerStore(transaction).revokeRunner(
      target.runnerId,
      fixture.userId,
    );
    written.resolve();
    await withTimeout(release.promise, 3000, {
      timeoutError: () => new Error("atomic removal was not released"),
    });
    return removed;
  });
  try {
    await withTimeout(written.promise, 3000, {
      timeoutError: () => new Error("removal did not write its transaction"),
    });
    expect((await policy(target.runnerId)).revokedAt).toBeNull();
    expect(
      await db.selectFrom("authSessions").select("id").where("id", "=", login).executeTakeFirst(),
    ).toBeDefined();
  } finally {
    release.resolve();
  }
  expect((await removing).endedSessionIds).toEqual([login]);
  expect((await policy(target.runnerId)).revokedAt).not.toBeNull();
  expect(
    await db.selectFrom("authSessions").select("id").where("id", "=", login).executeTakeFirst(),
  ).toBeUndefined();
});

it.each(["cancel", "redeem"] as const)(
  "serializes self-setup cancellation with first redemption when %s wins",
  async (winner) => {
    const target = await enrollment();
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withPersonalTransaction(db, async (transaction) => {
      const transactional = new OpensteerStore(transaction);
      if (winner === "cancel") {
        const proof = {
          deploymentId: fixture.deploymentId,
          runnerId: target.runnerId,
          issuedAt: new Date().toISOString(),
        };
        await transactional.leaveDevice({
          ...proof,
          signature: createDeviceLeaveSignature(target.privateKey, proof),
        });
      } else await transactional.enrollRunnerConnection(target.connection);
      written.resolve();
      await withTimeout(release.promise, 3000, {
        timeoutError: () => new Error("self-setup race was not released"),
      });
    });
    await withTimeout(written.promise, 3000, {
      timeoutError: () => new Error("first self-setup operation never wrote"),
    });
    const second =
      winner === "cancel" ? store.enrollRunnerConnection(target.connection) : leave(target);
    const result =
      winner === "cancel"
        ? expect(second).rejects.toMatchObject({ reason: "runner-enrollment-expired" })
        : expect(second).resolves.toBeDefined();
    release.resolve();
    await first;
    await result;
    const runner = await db
      .selectFrom("runners")
      .select("revokedAt")
      .where("id", "=", target.runnerId)
      .executeTakeFirst();
    if (winner === "cancel") expect(runner).toBeUndefined();
    else expect(runner?.revokedAt).toBeInstanceOf(Date);
  },
);

it("keeps Home Browser fixed while allowing its Apps switch to change", async () => {
  const home = await policy(fixture.runnerId);
  const input = {
    runnerId: fixture.runnerId,
    ownerId: fixture.userId,
    allowDeployment: true,
    expectedRevision: home.accessPolicyRevision,
    policy: { ...home.accessPolicy, browser: false },
  };
  await expect(store.updateMachineAccessPolicy(input)).rejects.toMatchObject({
    code: "bad_request",
  });
  await expect(
    store.updateMachineAccessPolicy({ ...input, policy: { ...home.accessPolicy, apps: false } }),
  ).resolves.toMatchObject({ outcome: "updated" });
  expect(deviceAccess((await policy(fixture.runnerId)).accessPolicy)).toMatchObject({
    browser: true,
    apps: false,
  });
});
