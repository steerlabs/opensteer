import { createId, DeviceIdSchema } from "@opensteer/core";
import { HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { withDeviceSwitch } from "@opensteer/client/computers";
import { cloneTestDatabase, type TestDatabase } from "@opensteer/database/test-support/database";
import { testRunnerDescriptor } from "@opensteer/database/test-support/store";
import {
  createDeviceLeaveSignature,
  createDeviceSessionBindingSignature,
  hashRunnerEnrollmentToken,
  runnerPublicKeyFingerprint,
} from "@opensteer/runner-auth";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  startPrivateMachineHost,
  type MachineAccessHost,
} from "../runtime/private-machine-host.test-support.js";
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

it("applies the Home's Apps receipt before a delayed machine read arrives", async () => {
  const { runnerId } = await enrolled();
  const read = () => host.api["resources.detail.get"]({ kind: "machine" });
  const before = await read();
  if (!before.ok || before.data.data.kind !== "machine") throw new Error("Missing devices");
  const device = before.data.data.machines.find(({ id }) => id === runnerId)!;
  const turnOn = await host.api["commands.dispatch"]({
    type: "machine.access.update",
    idempotencyKey: "enable-apps-for-test",
    deviceId: DeviceIdSchema.parse(runnerId),
    expectedRevision: device.access!.revision,
    policy: withDeviceSwitch(device.access!.policy, "apps", true),
  });
  expect(turnOn).toMatchObject({ ok: true, data: { outcome: "updated" } });

  const releaseList = Promise.withResolvers<void>();
  const listRequested = Promise.withResolvers<void>();
  let holdReads = false;
  const person = new HttpHostClient({
    baseUrl: host.origin,
    capabilities: ["devices-v1"],
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        holdReads &&
        url.pathname.endsWith("/resources.detail.get") &&
        JSON.parse(url.searchParams.get("input")!).kind === "machine"
      ) {
        listRequested.resolve();
        await releaseList.promise;
      }
      return fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), ...host.ownerHeaders },
      });
    },
    webSocketFactory: (url) =>
      new WebSocket(url, { headers: host.ownerHeaders }) as unknown as WebSocketClient,
  });
  try {
    await person.load();
    const stop = person.watchPersonalResource("machine", () => undefined);
    const shown = () => person.getSnapshot().machines.find(({ id }) => id === runnerId)?.access;
    await vi.waitFor(() => expect(shown()?.policy.apps).toBe(true));
    const starting = shown()!;
    holdReads = true;
    const receipt = await person.updateMachineAccess({
      deviceId: runnerId,
      expectedRevision: starting.revision,
      policy: withDeviceSwitch(starting.policy, "apps", false),
    });
    expect(receipt).toEqual({ outcome: "updated", revision: starting.revision + 1 });
    const current = await read();
    if (!current.ok || current.data.data.kind !== "machine") throw new Error("Missing devices");
    expect(current.data.data.machines.find(({ id }) => id === runnerId)?.access).toMatchObject({
      revision: starting.revision + 1,
      policy: { apps: false },
    });
    expect(shown()).toMatchObject({ revision: starting.revision + 1, policy: { apps: false } });
    const patched = person.getSnapshot().machineRevision;
    await listRequested.promise;
    releaseList.resolve();
    await vi.waitFor(() => expect(person.getSnapshot().machineRevision).toBeGreaterThan(patched));
    expect(shown()).toMatchObject({ revision: starting.revision + 1, policy: { apps: false } });
    stop();
  } finally {
    releaseList.resolve();
    person.dispose();
  }
});

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
