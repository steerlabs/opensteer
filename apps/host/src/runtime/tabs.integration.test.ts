import { BrowserSessionIdSchema, TabIdSchema } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { TabStore } from "@opensteer/database";
import { browserRuntimeWireVersion } from "@opensteer/protocol/browser";
import { describe, expect, it } from "vitest";
import { openAuxiliaryStream } from "./computer-apps.test-support.js";
import {
  closed,
  connectCallerMachine,
  createMachineAccessDatabase,
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
});
