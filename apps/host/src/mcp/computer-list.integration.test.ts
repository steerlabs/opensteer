import { createId, DeviceIdSchema } from "@opensteer/core";
import { machineAccessPolicyDefault } from "@opensteer/protocol";
import { enrollTestRunner } from "@opensteer/database/test-support/store";
import { describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "../administration/administration-service.js";
import { createPersonalOwnerFixture } from "../runtime/personal-owner.test-support.js";
import { AdministrationToolHandlers } from "./handlers/administration.js";

describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)("computer_list pagination", () => {
  it("keeps Runner metadata across pages for self and screen drivers", async () => {
    const f = await createPersonalOwnerFixture();
    try {
      if (!f.resources) throw new Error("Personal owner resources missing");
      await f.database
        .insertInto("runnerEnrollments")
        .values({
          id: `ren_${randomUUID()}`,
          name: "Hosting computer",
          runnerId: f.resources.runnerId,
          tokenHash: "sha256:pagination-home",
          allowedModules: sql`'["agents"]'::jsonb`,
          createdBy: null,
          ownerKind: "deployment",
          ownerUserId: null,
          idempotencyKey: "pagination-home",
          requestFingerprint: "sha256:pagination-home",
          runnerKind: "main",
          expiresAt: new Date(),
          consumedAt: new Date(),
          createdAt: new Date(),
        })
        .execute();
      const ids = Array.from({ length: 101 }, () => createId("runner"));
      await f.database
        .updateTable("personalRemoteAccess")
        .set({ mode: "private", routeOrigin: "https://personal.mcp.test", generation: 1 })
        .execute();
      for (const id of ids) {
        await enrollTestRunner(f.store, {
          createdBy: f.ownerId,
          environmentId: createId("environment"),
          runnerId: id,
          runnerKind: "local",
          allowedModules: ["browser", "integrations", "messaging", "shell"],
          modules: { browser: { runtimeId: "browser", wireVersion: 2 } },
          name: `Computer ${id}`,
          tokenSuffix: id,
        });
      }
      const driverId = [...ids].sort().at(-1)!;
      const phoneId = DeviceIdSchema.parse(createId("device"));
      await f.database
        .insertInto("devices")
        .values({
          id: phoneId,
          deploymentId: f.deployment.id,
          ownerKind: "user",
          ownerUserId: f.ownerId,
          name: "Travel iPhone",
          kind: "phone",
          platform: "ios",
          form: "phone",
          accessPolicy: sql`${JSON.stringify({ ...machineAccessPolicyDefault, browser: false, apps: false, reach: "nobody" })}::jsonb`,
          accessPolicyRevision: 1,
          removedAt: null,
        })
        .execute();
      await f.database
        .insertInto("deviceDrivers")
        .values({
          deviceId: phoneId,
          role: "screen",
          runnerId: driverId,
          generation: 1,
          detachedAt: null,
        })
        .execute();
      const handler = new AdministrationToolHandlers(
        new AdministrationService(
          {
            store: f.store,
            runners: {
              asleepSince: () => null,
              identityForRunner: () => undefined,
              isRunnerConnected: () => true,
              moduleReadiness: () => "ready",
            },
            computerApps: { status: () => [], attached: () => false, deviceStatus: () => null },
            integrations: { devices: { deviceConnections: async () => [] } },
          } as unknown as AdministrationDependencies,
          vi.fn(),
        ),
        () => true,
      );
      const caller = {
        kind: "connection",
        grant: { scope: "everything" },
        grantRevision: 1,
        key: "connection:pagination",
        connectionId: "pagination",
        userId: f.ownerId,
        accessMode: "full-access",
      } as const;
      const first = await handler.computer_list({ caller, input: {}, operationKey: "first" });
      expect(first.computers).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      expect(first.computers.some((computer) => computer.selfRunnerId === driverId)).toBe(false);
      expect(first.computers.find((computer) => computer.computerId === phoneId)).toMatchObject({
        drivers: [{ role: "screen", runnerId: driverId, runnerName: `Computer ${driverId}` }],
        phoneDisplay: {
          setup: { driverRunnerId: driverId, driverRunnerName: `Computer ${driverId}` },
        },
      });
      const second = await handler.computer_list({
        caller,
        input: { cursor: first.nextCursor! },
        operationKey: "second",
      });
      expect(second.nextCursor).toBeNull();
      expect(second.computers).toHaveLength(3);
      const remaining = ids.filter(
        (id) => !first.computers.some((computer) => computer.selfRunnerId === id),
      );
      expect(remaining.length).toBeGreaterThan(0);
      for (const id of remaining)
        expect(second.computers.find((computer) => computer.selfRunnerId === id)).toMatchObject({
          computerId: id,
          online: true,
          capabilities: ["filesystem"],
          deviceCapabilities: { browser: { supported: true } },
          drivers: [{ runnerName: `Computer ${id}` }],
        });
    } finally {
      await f.close();
    }
  });
});
