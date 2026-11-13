import { createId } from "@opensteer/core";
import { cloneTestDatabase, type TestDatabase } from "@opensteer/database/test-support/database";
import { testRunnerDescriptor } from "@opensteer/database/test-support/store";
import {
  createDeviceLeaveSignature,
  createDeviceSessionBindingSignature,
  hashRunnerEnrollmentToken,
  runnerPublicKeyFingerprint,
} from "@opensteer/runner-auth";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  startPrivateMachineHost,
  type MachineAccessHost,
} from "../integrations/personal-machine.test-support.js";
import { testRpcData } from "./test-host-api-request.js";

let clone: TestDatabase;
let host: MachineAccessHost;
beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  host = await startPrivateMachineHost(clone.url, { remoteAccess: true });
});
afterEach(async () => {
  try {
    await host?.close();
  } finally {
    await clone?.drop();
  }
});
async function enrolled() {
  const keys = generateKeyPairSync("ed25519");
  const runnerId = createId("runner");
  const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const enrollment = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      type: "runner.enrollment.createLocal",
      name: "Signed in Mac",
      allowedModules: ["integrations"],
      idempotencyKey: runnerId,
      access: { browser: false, apps: false, files: false },
      preparedIdentity: { runnerId, publicKeyPem },
    },
    { headers: host.ownerHeaders },
  );
  if (enrollment.type !== "runner.enrollment.createLocal") throw new Error("Expected enrollment");
  await host.store.enrollRunnerConnection({
    descriptor: testRunnerDescriptor({
      runnerId,
      runnerKind: "local",
      name: "Signed in Mac",
      environmentId: createId("environment"),
      modules: { integrations: { platform: "darwin" } },
    }),
    enrollmentTokenHash: hashRunnerEnrollmentToken(enrollment.token),
    publicKeyPem,
    publicKeyFingerprint: runnerPublicKeyFingerprint(keys.publicKey),
  });
  const device = (
    await testRpcData(host.origin, "machines.list", {}, { headers: host.ownerHeaders })
  ).machines.find((row) => row.id === runnerId)!;
  expect(device.allowedModules).toEqual(["browser", "integrations", "messaging", "shell"]);
  expect(device.access?.policy).toMatchObject({ browser: false, apps: false, reach: "nobody" });
  return { ...keys, runnerId };
}

it("binds the current session and signs out by removing its non-Home device after the response", async () => {
  const target = await enrolled();
  const current = (
    await testRpcData(host.origin, "sessions.list", {}, { headers: host.ownerHeaders })
  ).sessions.find((row) => row.current)!;
  const deployment = await host.store.database
    .selectFrom("deployments")
    .select("id")
    .executeTakeFirstOrThrow();
  const issuedAt = new Date().toISOString();
  await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      type: "machine.session.bind",
      idempotencyKey: "bind",
      machineId: target.runnerId,
      proof: {
        issuedAt,
        signature: createDeviceSessionBindingSignature(target.privateKey, {
          deploymentId: deployment.id,
          runnerId: target.runnerId,
          sessionId: current.id,
          issuedAt,
        }),
      },
    },
    { headers: host.ownerHeaders },
  );
  const bound = await testRpcData(host.origin, "sessions.list", {}, { headers: host.ownerHeaders });
  expect(bound.sessions.find((row) => row.current)?.deviceId).toBe(target.runnerId);
  await testRpcData(host.origin, "auth.signOut", {}, { headers: host.ownerHeaders });
  expect(
    (
      await host.store.database
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", target.runnerId)
        .executeTakeFirstOrThrow()
    ).revokedAt,
  ).not.toBeNull();
  expect(
    await host.store.database
      .selectFrom("authSessions")
      .select("id")
      .where("id", "=", current.id)
      .executeTakeFirst(),
  ).toBeUndefined();
});

it("accepts signed leave without a session, version header or module admission and replays the tombstone", async () => {
  const target = await enrolled();
  const deployment = await host.store.database
    .selectFrom("deployments")
    .select("id")
    .executeTakeFirstOrThrow();
  const context = {
    deploymentId: deployment.id,
    runnerId: target.runnerId,
    issuedAt: new Date().toISOString(),
  };
  const proof = { ...context, signature: createDeviceLeaveSignature(target.privateKey, context) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await host.runtime.app.inject({
      method: "POST",
      url: "/v1/runner/leave",
      payload: proof,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: "removed" });
  }
  const newer = await enrolled();
  const replay = await host.runtime.app.inject({
    method: "POST",
    url: "/v1/runner/leave",
    payload: { ...proof, runnerId: newer.runnerId },
  });
  expect(replay.statusCode).toBe(403);
  expect(
    (
      await host.store.database
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", newer.runnerId)
        .executeTakeFirstOrThrow()
    ).revokedAt,
  ).toBeNull();
});
