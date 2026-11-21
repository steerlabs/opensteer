import { createId, DeviceIdSchema } from "@opensteer/core";
import { machineAccessPolicyDefault, type RunnerModuleName } from "@opensteer/protocol";
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
      const ids = Array.from({ length: 101 }, () => createId("runner"));
      const now = new Date();
      const allowedModules = sql<readonly RunnerModuleName[]>`
        '["browser","integrations","messaging","shell"]'::jsonb
      `;
      const tokenHash = (id: string) => `sha256:pagination-token-${id}`;
      await f.database
        .insertInto("runners")
        .values(
          ids.map((id) => ({
            id,
            ownerKind: "user",
            ownerUserId: f.ownerId,
            name: `Computer ${id}`,
            kind: "local",
            publicKeyPem: "unused",
            publicKeyFingerprint: `sha256:pagination-key-${id}`,
            enrollmentTokenHash: tokenHash(id),
            capabilities: sql`'["filesystem"]'::jsonb`,
            allowedModules,
            moduleDescriptors: sql`'{"browser":{"runtimeId":"browser","wireVersion":2}}'::jsonb`,
            device: null,
            connectionGeneration: 1,
            maxConcurrentRuns: null,
            enrolledAt: now,
            lastSeenAt: now,
            revokedAt: null,
          })),
        )
        .execute();
      await f.database
        .insertInto("runnerEnrollments")
        .values([
          {
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
            expiresAt: now,
            consumedAt: now,
            createdAt: now,
          },
          ...ids.map((id) => ({
            id: `ren_${randomUUID()}`,
            name: `Computer ${id}`,
            runnerId: id,
            tokenHash: tokenHash(id),
            allowedModules,
            createdBy: f.ownerId,
            ownerKind: "user" as const,
            ownerUserId: f.ownerId,
            idempotencyKey: `pagination-${id}`,
            requestFingerprint: tokenHash(id),
            runnerKind: "local" as const,
            expiresAt: now,
            consumedAt: now,
            createdAt: now,
          })),
        ])
        .execute();
      await f.database
        .updateTable("personalRemoteAccess")
        .set({ mode: "private", routeOrigin: "https://personal.mcp.test", generation: 1 })
        .execute();
      await f.database
        .insertInto("devices")
        .values(
          ids.map((id) => ({
            id: DeviceIdSchema.parse(id),
            deploymentId: f.deployment.id,
            ownerKind: "user",
            ownerUserId: f.ownerId,
            name: `Computer ${id}`,
            kind: "unknown",
            platform: null,
            form: null,
            accessPolicy: sql`${JSON.stringify(machineAccessPolicyDefault)}::jsonb`,
            removedAt: null,
          })),
        )
        .execute();
      await f.database
        .insertInto("deviceDrivers")
        .values(
          ids.map((id) => ({
            deviceId: DeviceIdSchema.parse(id),
            role: "self",
            runnerId: id,
            generation: 1,
            detachedAt: null,
          })),
        )
        .execute();
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
              agentsStoppedSince: () => null,
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
