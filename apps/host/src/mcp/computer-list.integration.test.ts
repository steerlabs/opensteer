import { discoverHandler } from "./handlers/discover.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { createId, DeviceIdSchema } from "@opensteer/core";
import { AgentConnectionStore } from "@opensteer/database";
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
      const connections = new AgentConnectionStore(f.database);
      const record = await connections.create({
        userId: f.ownerId,
        label: "Pagination test",
        clientName: "Pagination test",
        resource: "https://host.test/mcp",
        accessMode: "full-access",
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await connections.activate(record.id, "5".repeat(64))).toBe(true);
      const caller = {
        kind: "connection",
        grant: { scope: "everything" },
        grantRevision: 1,
        key: `connection:${record.id}`,
        connectionId: record.id,
        userId: f.ownerId,
        accessMode: "full-access",
      } as const;
      const discover = discoverHandler(
        {
          browser_profile_list: async () => ({ profiles: [], sites: [] }),
          computer_list: (call) => handler.computer_list(call),
          computer_apps: async () => ({
            computers: ids.map((id) => ({
              computerId: id,
              name: `Computer ${id}`,
              apps: [{ name: "Notes", bundleId: "com.apple.Notes", access: "read" }],
            })),
            phones: [
              {
                computerId: phoneId,
                name: "Travel iPhone",
                definitionId: "iphone-screen",
                access: "read",
              },
            ],
          }),
          opensteer_task_list: async () => ({ threads: [], hasMore: false, nextBefore: null }),
        },
        {
          store: f.store,
          tabs: { project: async () => ({ tabs: [], layout: { revision: 0, items: [] } }) },
          browserSources: { grantableChromeTabs: async () => [] },
        },
      );
      const mcp = new OpensteerMcpService({
        callers: { authenticate: async () => caller },
        handlers: {
          computer_list: (call) => handler.computer_list(call),
          discover: (call) => {
            if (call.caller.kind !== "connection") throw new Error("Expected a connection");
            return discover({ ...call, caller: call.caller });
          },
        },
        store: f.store,
        publicUrl: new URL("https://host.test"),
      });
      try {
        const options = { operationKey: "unavailable-list" };
        const absent = await mcp.callToolResult("token", "unknown_fixture_tool", {}, options);
        const removed = await mcp.callToolResult("token", "computer_list", {}, options);
        expect(removed).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "not_found" } },
        });
        expect(JSON.stringify(removed)).toBe(JSON.stringify(absent));
        const all: unknown[] = [];
        let cursor: string | undefined;
        do {
          const reply = await mcp.callTool(
            "token",
            "discover",
            { cursor },
            { operationKey: "discover-devices" },
          );
          if (typeof reply === "string" || !Array.isArray(reply.items))
            throw new Error("Missing inventory");
          all.push(...reply.items);
          expect(reply.items).toHaveLength(cursor ? (all.length === 102 ? 2 : 50) : 50);
          cursor = typeof reply.nextCursor === "string" ? reply.nextCursor : undefined;
        } while (cursor);
        expect(all).toHaveLength(102);
        expect(all.at(-1)).toMatchObject({
          id: phoneId,
          kind: "phone",
          phoneSetup: { location: "driver-mac", driverRunnerName: `Computer ${driverId}` },
        });
      } finally {
        await mcp.close();
      }
      // The retained handler still projects all device metadata for the person's own agents.
      const native = {
        kind: "run" as const,
        key: "run:pagination",
        userId: f.ownerId,
        accessMode: "full-access" as const,
        thread: {} as import("@opensteer/core").Thread,
        claims: {} as never,
      };
      const first = await handler.computer_list({
        caller: native,
        input: {},
        operationKey: "first",
      });
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
        caller: native,
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
