import { createId, DeviceIdSchema, WindowIdSchema, type App } from "../packages/core/src/index.js";
import { createBrowserSessionId } from "../packages/protocol/src/index.js";
import { tabDatabaseFixture } from "../apps/host/src/tabs/tab-service.integration.test-support.js";
import { TabService } from "../apps/host/src/tabs/tab-service.js";
import type {
  NativeTabTargetsPort,
  NativeTargetAcquiredHandler,
} from "../apps/host/src/tabs/ports.js";
import type { RunToolScope } from "../apps/host/src/agents/run-tool-tokens.js";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);
integration("mixed workspace layout", () => {
  it("keeps the same page/window/phone/app group and a held-tab closure on a second client reconnect", async () => {
    const f = await tabDatabaseFixture();
    const taskId = createId("thread"),
      windowId = WindowIdSchema.parse(`win_${randomUUID()}`);
    const app: App = {
      appId: `app_${randomUUID()}`,
      name: "Report",
      kind: "html",
      state: "running",
      computerId: f.runnerId,
      taskId: null,
      version: 1,
      server: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await f.database
      .insertInto("apps")
      .values({
        id: app.appId,
        ownerId: f.ownerId,
        computerId: f.runnerId,
        name: app.name,
        threadId: null,
        runId: null,
        creationKey: null,
        latestVersion: 1,
      })
      .execute();
    let agentHoldingPhone = true;
    let acquired: NativeTargetAcquiredHandler | undefined;
    const native: NativeTabTargetsPort = {
      resolveWindow: async () => ({
        windowId,
        app: { bundleId: "test.editor", displayName: "Editor", teamId: null },
        appName: "Editor",
        bundleId: "test.editor",
        title: "Plan",
      }),
      windowState: async () => ({ state: "asleep", usedBy: [] }),
      phoneState: async () => ({ state: "open", usedBy: agentHoldingPhone ? [{ taskId }] : [] }),
      openOwnerView: async () => {
        throw new Error("Unexpected viewer activation");
      },
      closeOwnerViews: async () => {},
      onTargetAcquired: (handler) => {
        acquired = handler;
        return () => {
          acquired = undefined;
        };
      },
    };
    const tabs = new TabService({
      store: f.tabs,
      devices: f.store,
      nativeTargets: native,
      apps: { get: async () => app },
      computer: async () => ({ name: "Computer", connected: true, removed: false }),
      canRead: async (actor, row) =>
        row.ownerId ===
        (actor.kind === "person"
          ? actor.ownerId
          : actor.kind === "run"
            ? actor.claims.requestedBy
            : actor.kind === "browser-binding"
              ? actor.authority.ownerId
              : actor.caller.userId),
      canReadTask: async () => true,
      authorize: async () => {},
      authorizeMembership: async () => {},
      onError: (error) => {
        throw error;
      },
      pages: {
        state: async () => ({ state: "open", usedBy: [] }),
        bind: async () => {
          throw new Error("Unexpected page bind");
        },
        activate: async () => {
          throw new Error("Unexpected page viewer");
        },
        closeViewers: async () => {},
        open: async (actor, target) => {
          const sessionId = createBrowserSessionId(),
            id = createId("run");
          const { TabIdSchema } = await import("../packages/core/src/index.js");
          const tabId = TabIdSchema.parse(`surface_${id}`);
          await f.store.createBrowserSession({
            id: sessionId,
            runnerId: f.runnerId,
            ownerId: f.ownerId,
            origin: "agent",
            opener: { kind: "person", userId: f.ownerId },
            placementKey: "fixture",
            runtimeId: "fixture",
            profileId: null,
          });
          return {
            id: tabId,
            ownerId: f.ownerId,
            kind: "page",
            computerId: DeviceIdSchema.parse(f.runnerId),
            title: "Page",
            url: target.url,
            openedBy: actor.kind === "run" ? { taskId: actor.claims.threadId } : "person",
            pageBinding: { lineageId: sessionId, sessionId, surfaceId: tabId },
          };
        },
      },
    });
    const actor = { kind: "person", ownerId: f.ownerId } as const;
    try {
      const opened = await Promise.all([
        tabs.open(actor, { kind: "page", guest: true, url: "https://example.com" }, "page"),
        tabs.open(
          actor,
          { kind: "window", computerId: DeviceIdSchema.parse(f.runnerId), windowId },
          "window",
        ),
        tabs.open(actor, { kind: "phone", computerId: f.runnerId }, "phone"),
        tabs.open(actor, { kind: "app", appId: app.appId }, "app"),
      ]);
      const ids = opened.map((result) => result.tab.tabId);
      const grouped = await tabs.organize(
        actor,
        { tabIds: ids, group: { name: "Project", color: "green" } },
        "organize",
      );
      expect(grouped.groups[0]?.tabIds).toEqual(ids);
      const phoneId = ids[2]!;
      const claims = {
        requestedBy: f.ownerId,
        threadId: taskId,
        runId: createId("run"),
        bindingGeneration: 1,
      } as RunToolScope;
      const acquisition = {
        ownerId: f.ownerId,
        runClaims: claims,
        kind: "phone" as const,
        computerId: f.runnerId,
        key: "acquisition",
        membershipRevision: (await f.tabs.snapshot(f.ownerId)).layout.revision,
      };
      expect(await acquired!(acquisition)).toBe(phoneId);
      const openedView = await tabs.bootstrap(f.ownerId, 65536);
      expect(openedView.tabs.find((tab) => tab.tabId === phoneId)?.usedBy).toEqual([{ taskId }]);
      expect(await tabs.close(actor, [phoneId], "close-held-phone")).toEqual({
        closed: [phoneId],
        failed: [],
      });
      expect(agentHoldingPhone).toBe(true);
      const closedView = await tabs.bootstrap(f.ownerId, 65536);
      expect(closedView.tabs.map((tab) => tab.tabId).sort()).toEqual(
        ids.filter((id) => id !== phoneId).sort(),
      );
      const bootstrap = await tabs.bootstrap(f.ownerId, 65536);
      expect(bootstrap).toEqual(closedView);
      expect(bootstrap.layout.items[0]).toMatchObject({
        kind: "group",
        group: { tabIds: ids.filter((id) => id !== phoneId) },
      });
      await expect(acquired!(acquisition)).rejects.toMatchObject({ code: "not_found" });
      await expect(tabs.authorizeShow(claims, phoneId)).rejects.toMatchObject({
        code: "not_found",
      });
      agentHoldingPhone = false;
      tabs.changed(f.ownerId);
      expect(
        (await tabs.bootstrap(f.ownerId, 65536)).tabs.some((tab) => tab.tabId === phoneId),
      ).toBe(false);
    } finally {
      tabs.dispose();
    }
  });
});
