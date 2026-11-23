import { BrowserSessionIdSchema, createId, TabIdSchema, WindowIdSchema } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { randomUUID } from "node:crypto";
import { TabStore } from "@opensteer/database";
import {
  macOwnerViewVersion,
  RunnerBootIdSchema,
  RunnerDescriptorSchema,
  runnerIntegrationsProtocolVersion,
} from "@opensteer/protocol";
import { browserRuntimeWireVersion } from "@opensteer/protocol/browser";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { openAuxiliaryStream } from "./computer-apps.test-support.js";
import {
  closed,
  connectCallerMachine,
  connectPrimary,
  createMachineAccessDatabase,
  enrollmentToken,
  startMachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";

describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)("tab computer connectivity", () => {
  it("keeps browser pages available without an integrations stream", async () => {
    const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    try {
      const host = await startMachineAccessWireHost(database.url, { manualRunner: true });
      try {
        const computer = await connectCallerMachine(host, {
          name: "Browser computer",
          token: host.hostingRunnerEnrollmentToken,
          browser: { runtimeId: "browser-tabs", wireVersion: browserRuntimeWireVersion },
        });
        try {
          const browser = await openAuxiliaryStream(host.hostPort, computer.primary, "browser");
          try {
            const deviceId = await host.store.requireSelfDeviceId(computer.runnerId);
            expect(host.runtime.computerApps.attached(deviceId)).toBe(false);
            const tabs = new TabStore(host.store.database);
            const tabId = TabIdSchema.parse("browser-without-integrations");
            const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
            await host.store.createBrowserSession({
              id: sessionId,
              ownerId: host.ownerId,
              runnerId: computer.runnerId,
              origin: "agent",
              opener: { kind: "person", userId: host.ownerId },
              placementKey: "test",
              profileId: null,
              runtimeId: "browser-tabs",
            });
            await tabs.open(
              {
                id: tabId,
                computerId: deviceId,
                ownerId: host.ownerId,
                kind: "page",
                title: "Saved page",
                url: "https://example.test",
                openedBy: "person",
                pageBinding: { lineageId: sessionId, sessionId, surfaceId: tabId },
              },
              "browser-page",
            );
            host.runtime.tabs.changed(host.ownerId);
            expect(
              await host.runtime.tabs.options.computer(host.ownerId, deviceId, tabs.database),
            ).toMatchObject({ connected: true, removed: false });
            expect(await host.runtime.tabs.get(host.ownerId, tabId)).toMatchObject({
              state: "asleep",
            });
          } finally {
            browser.socket.close();
            await closed(browser.socket);
          }
        } finally {
          await computer.close();
        }
      } finally {
        await host.close();
      }
    } finally {
      await database.drop();
    }
  });

  it("never blocks tab reads or resource projections on an unresponsive remote window runner", async () => {
    const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    try {
      const host = await startMachineAccessWireHost(database.url, {
        manualRunner: true,
        remoteAccess: true,
      });
      try {
        const browserComputer = await connectCallerMachine(host, {
          name: "Local Mac",
          token: host.hostingRunnerEnrollmentToken,
          browser: { runtimeId: "browser-tabs", wireVersion: browserRuntimeWireVersion },
        });
        const silentRunnerId = createId("runner");
        const silentMacToken = await enrollmentToken(host, {
          allowedModules: ["integrations"],
          idempotencyKey: `silent-mac:${silentRunnerId}`,
          name: "Silent Remote Mac",
        });
        const silentPrimary = await connectPrimary(
          host.hostPort,
          RunnerDescriptorSchema.parse({
            bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
            capabilities: [],
            modules: {
              integrations: {
                ownerViewVersion: macOwnerViewVersion,
                platform: "darwin",
                protocolVersion: runnerIntegrationsProtocolVersion,
              },
            },
            name: "Silent Remote Mac",
            runnerId: silentRunnerId,
            runnerKind: "local",
            runtimeVersion: "integration",
          }),
          { token: silentMacToken },
        );
        try {
          const browser = await openAuxiliaryStream(
            host.hostPort,
            browserComputer.primary,
            "browser",
          );
          const integrations = await openAuxiliaryStream(
            host.hostPort,
            silentPrimary,
            "integrations",
          );
          // Observe incoming window-resolve frames without ever replying (simulates a half-open dead Mac).
          let resolveRequests = 0;
          const firstResolveRequest = Promise.withResolvers<void>();
          integrations.socket.on("message", (raw) => {
            const parsed = JSON.parse(raw.toString()) as { type?: string };
            if (parsed.type === "host.integrations.window-resolve") {
              resolveRequests += 1;
              firstResolveRequest.resolve();
            }
          });
          try {
            const localDeviceId = await host.store.requireSelfDeviceId(browserComputer.runnerId);
            const remoteDeviceId = await host.store.requireSelfDeviceId(silentRunnerId);
            expect(host.runtime.computerApps.attached(silentRunnerId)).toBe(true);

            const app = {
              bundleId: "net.whatsapp.WhatsApp",
              displayName: "WhatsApp",
              teamId: null,
            };
            await host.store.database
              .insertInto("integrationConnections")
              .values({
                id: createIntegrationId("connection"),
                ownerUserId: host.ownerId,
                deviceId: remoteDeviceId,
                runnerId: null,
                connectionKind: "computer",
                computerAccess: "read-write",
                computerApp: sql`${JSON.stringify(app)}::jsonb`,
                computerBlockedAt: null,
                provider: "macos-app",
                integrationDefinitionId: "macos-app",
                displayName: "WhatsApp",
                status: "connected",
                connectionMethod: "computer",
                capabilities: sql`'[]'::jsonb`,
                accountIdentifier: null,
                credentialId: null,
                integrationServerId: null,
                externalIdentityId: null,
                externalTenantId: null,
                statusDetail: null,
                transportKind: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .execute();

            const tabs = new TabStore(host.store.database);
            const pageTabId = TabIdSchema.parse(`tab_${randomUUID()}`);
            const windowTabId = TabIdSchema.parse(`tab_${randomUUID()}`);
            const windowId = WindowIdSchema.parse(`win_${randomUUID()}`);
            const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
            await host.store.createBrowserSession({
              id: sessionId,
              ownerId: host.ownerId,
              runnerId: browserComputer.runnerId,
              origin: "agent",
              opener: { kind: "person", userId: host.ownerId },
              placementKey: "test",
              profileId: null,
              runtimeId: "browser-tabs",
            });
            await tabs.open(
              {
                id: pageTabId,
                computerId: localDeviceId,
                ownerId: host.ownerId,
                kind: "page",
                title: "Search result",
                url: "https://example.test/search",
                openedBy: "person",
                pageBinding: { lineageId: sessionId, sessionId, surfaceId: pageTabId },
              },
              "local-page",
            );
            await tabs.open(
              {
                id: windowTabId,
                computerId: remoteDeviceId,
                ownerId: host.ownerId,
                kind: "window",
                title: "WhatsApp",
                windowId,
                windowApp: app,
                openedBy: "person",
              },
              "remote-window",
            );
            host.runtime.tabs.changed(host.ownerId);

            // Listing, getting, and projecting resource tabs must complete promptly
            // instead of blocking 16s on the silent remote Mac's window.resolve RPC.
            const listed = await withTimeout(
              host.runtime.tabs.list({ kind: "person", ownerId: host.ownerId }, {}),
              2_000,
              { timeoutError: () => new Error("tabs.list blocked on silent remote Mac") },
            );
            expect(listed.tabs).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ tabId: pageTabId, state: "asleep" }),
                expect.objectContaining({ tabId: windowTabId, state: "asleep" }),
              ]),
            );
            const details = await withTimeout(
              host.runtime.tabs.resourceTabs(host.ownerId, host.store.database, {
                limit: 10,
              }),
              2_000,
              { timeoutError: () => new Error("tabs.resourceTabs blocked on silent remote Mac") },
            );
            expect(details).toHaveLength(2);
            await withTimeout(firstResolveRequest.promise, 2_000, {
              timeoutError: () => new Error("Expected background window-resolve probe"),
            });
            expect(resolveRequests).toBe(1);

            // Dropping the silent Mac's integrations stream automatically invalidates
            // the cached window tab to computer-offline.
            integrations.socket.close();
            await closed(integrations.socket);
            const afterDrop = await host.runtime.tabs.get(host.ownerId, windowTabId);
            expect(afterDrop).toMatchObject({
              tabId: windowTabId,
              state: "unavailable",
              unavailableCode: "computer-offline",
            });
          } finally {
            if (integrations.socket.readyState !== integrations.socket.CLOSED) {
              integrations.socket.close();
              await closed(integrations.socket);
            }
            browser.socket.close();
            await closed(browser.socket);
          }
        } finally {
          silentPrimary.socket.close();
          await closed(silentPrimary.socket);
          await browserComputer.close();
        }
      } finally {
        await host.close();
      }
    } finally {
      await database.drop();
    }
  });
});
