import { createId } from "@opensteer/core";
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
  it("keeps Runner metadata on pages beyond 100 self Devices", async () => {
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
      const handler = new AdministrationToolHandlers(
        new AdministrationService(
          {
            store: f.store,
            runners: { isRunnerConnected: () => true, moduleReadiness: () => "ready" },
            computerApps: { status: () => [], attached: () => false, deviceStatus: () => null },
            integrations: { platform: { deviceConnections: async () => [] } },
          } as unknown as AdministrationDependencies,
          vi.fn(),
        ),
        async () => [],
        () => true,
      );
      const caller = {
        kind: "connection",
        key: "connection:pagination",
        connectionId: "pagination",
        userId: f.ownerId,
        accessMode: "full-access",
      } as const;
      const first = await handler.computer_list({ caller, input: {}, operationKey: "first" });
      expect(first.computers).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      const second = await handler.computer_list({
        caller,
        input: { cursor: first.nextCursor! },
        operationKey: "second",
      });
      expect(second.nextCursor).toBeNull();
      expect(second.computers).toHaveLength(2);
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
