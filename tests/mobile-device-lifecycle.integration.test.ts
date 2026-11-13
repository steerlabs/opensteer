import type { HostClient } from "../packages/client/src/host/client.js";
import { IphoneAppsController } from "../apps/mobile/src/iphone-apps/controller.js";
import { createFakeIphoneApps } from "../apps/mobile/src/iphone-apps/fake-bridge.js";
import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { createId } from "../packages/core/src/index.js";
import { createDeviceLeaveSignature } from "../packages/runner-auth/src/index.js";
import { networkLeaveDelivery } from "../apps/mobile/src/platform/phone-leave.js";
import {
  createMachineAccessDatabase,
  startPersonalMachineHost,
} from "../apps/host/src/runtime/personal-machine.test-support.js";
import { testRpcData, testRpcRequest } from "../apps/host/src/server/test-host-api-request.js";
import { testRunnerDescriptor } from "../packages/database/src/runner-fixture.test-support.js";

it.each(["failed-before-commit", "committed-with-lost-reply", "leave-before-late-mint"] as const)(
  "retires a native phone obligation after %s through the Host leave handler",
  async (boundary) => {
    const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    let host: Awaited<ReturnType<typeof startPersonalMachineHost>> | undefined;
    try {
      host = await startPersonalMachineHost({ databaseUrl: database.url, remoteAccess: true });
      const home = host;
      const deploymentId = home.runtime.deployment.id;
      const keys = generateKeyPairSync("ed25519");
      const runnerId = createId("runner");
      const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
      const preparedIdentity = { runnerId, publicKeyPem };
      const command = {
        type: "runner.enrollment.createPhone" as const,
        name: "Prepared phone",
        profile: "iphone" as const,
        idempotencyKey: `phone:${runnerId}`,
        preparedIdentity,
      };
      if (boundary === "failed-before-commit") {
        await testRpcData(
          home.origin,
          "commands.dispatch",
          { ...command, preparedIdentity: undefined, name: "Other phone" },
          { headers: home.ownerHeaders },
        );
        expect(
          (
            await testRpcRequest(home.origin, "commands.dispatch", command, {
              headers: home.ownerHeaders,
            })
          ).status,
        ).toBe(409);
      }
      const minted =
        boundary === "committed-with-lost-reply"
          ? await testRpcData(home.origin, "commands.dispatch", command, {
              headers: home.ownerHeaders,
            })
          : null;
      const issuedAt = new Date().toISOString();
      const obligation = {
        version: 1,
        deploymentId,
        runnerId,
        hostUrl: "https://phone-fixture.opensteer.test",
        issuedAt,
        signature: createDeviceLeaveSignature(keys.privateKey, {
          deploymentId,
          runnerId,
          issuedAt,
        }),
        devicesV1: true,
        enrolled: false,
        enrollmentId: null,
        preparedIdentity,
      };
      const deliver = networkLeaveDelivery(async (_url, init) =>
        fetch(new URL("/v1/runner/leave", home.origin), init),
      );
      await expect(deliver(JSON.parse(JSON.stringify(obligation)))).resolves.toBe("removed");
      await expect(deliver(obligation)).resolves.toBe("removed");
      expect(
        await home.store.database
          .selectFrom("deviceSetupRetirements")
          .select("runnerId")
          .where("runnerId", "=", runnerId)
          .executeTakeFirst(),
      ).toEqual({ runnerId });
      expect(
        (
          await testRpcRequest(
            home.origin,
            "commands.dispatch",
            { ...command, idempotencyKey: `late:${runnerId}` },
            { headers: home.ownerHeaders },
          )
        ).status,
      ).toBe(403);
      if (minted?.type === "runner.enrollment.createPhone") {
        await expect(
          home.store.enrollRunnerConnection({
            descriptor: {
              ...testRunnerDescriptor({
                runnerId,
                runnerKind: "local",
                name: "Prepared phone",
                environmentId: createId("environment"),
                modules: { integrations: { platform: "ios", protocolVersion: 2 } },
              }),
              capabilities: [],
              device: { form: "phone", platform: "ios", app: "opensteer" },
            },
            enrollmentTokenHash: `sha256:${createHash("sha256").update(minted.token).digest("base64url")}`,
            publicKeyPem,
            publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyPem).digest("base64url")}`,
          }),
        ).rejects.toMatchObject({ code: "forbidden", reason: "runner-enrollment-expired" });
      }
    } finally {
      await host?.close();
      await database.drop();
    }
  },
);

it.each([
  { committed: false, profile: undefined },
  { committed: true, profile: undefined },
  { committed: false, profile: "iphone" as const },
  { committed: true, profile: "iphone" as const },
])(
  "recovers a legacy phone issuance receipt before retirement ($committed, $profile)",
  async ({ committed, profile }) => {
    const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    let host: Awaited<ReturnType<typeof startPersonalMachineHost>> | undefined;
    let controller: IphoneAppsController | undefined;
    try {
      host = await startPersonalMachineHost({ databaseUrl: database.url, remoteAccess: true });
      const home = host;
      const deploymentId = home.runtime.deployment.id;
      const mintKey = `legacy:${createId("runner")}`;
      const command = {
        type: "runner.enrollment.createPhone" as const,
        idempotencyKey: mintKey,
        name: "Legacy phone",
        ...(profile ? { profile } : {}),
      };
      const original = committed
        ? await testRpcData(home.origin, "commands.dispatch", command, {
            headers: home.ownerHeaders,
          })
        : null;
      const obligation = {
        deploymentId,
        runnerId: createId("runner"),
        hostUrl: "https://legacy.example",
        issuedAt: new Date().toISOString(),
        signature: "S".repeat(86),
        devicesV1: false,
        enrolled: false,
        enrollmentId: null,
        mintKey,
        name: command.name,
        ...(profile ? { profile } : {}),
      };
      const fake = createFakeIphoneApps();
      let pending = true;
      controller = new IphoneAppsController({
        bridge: {
          ...fake.bridge,
          getSnapshot: () => ({
            ...fake.bridge.getSnapshot(),
            pendingLeaves: pending ? [obligation] : [],
          }),
          completeLeave: async () => {
            pending = false;
          },
        },
        shownApprovals: { read: async () => [], write: async () => undefined },
      });
      const client = {
        getSnapshot: () => ({ machines: [] }),
        subscribe: () => () => undefined,
        dispatch: (input: Parameters<HostClient["dispatch"]>[0]) =>
          testRpcData(home.origin, "commands.dispatch", input, { headers: home.ownerHeaders }),
      } as unknown as HostClient;
      controller.attachHost({ deploymentId, hostClient: client });
      await expect(controller.retryLeave()).resolves.toBe("removed");
      expect(pending).toBe(false);
      const enrollments = await home.store.database
        .selectFrom("runnerEnrollments")
        .select(["id", "expiresAt"])
        .where("name", "=", command.name)
        .execute();
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0]!.expiresAt.getTime()).toBeLessThan(Date.now());
      if (original?.type === "runner.enrollment.createPhone")
        expect(enrollments[0]!.id).toBe(original.enrollmentId);
    } finally {
      controller?.dispose();
      await host?.close();
      await database.drop();
    }
  },
);
