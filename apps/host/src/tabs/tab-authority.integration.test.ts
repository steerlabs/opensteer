import { createId, TabIdSchema, WindowIdSchema } from "@opensteer/core";
import { TabStore } from "@opensteer/database";
import { createStoreFixture } from "@opensteer/database/test-support/store";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeTabTarget,
  canReadTab,
  tabComputer,
  tabComputers,
  tabReadAuthority,
} from "./tab-authority.js";
import { TabService } from "./tab-service.js";
import type { NativeTargetAcquiredHandler, TabActor } from "./ports.js";
import type { RunToolScope } from "../agents/run-tool-tokens.js";

const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);
integration("production tab authority", () => {
  async function fixture() {
    const f = await createStoreFixture(),
      run = await f.startRunFixture("tab-authority");
    const claims: RunToolScope = {
      aud: "opensteer-run-tools",
      iss: "opensteer-host",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: randomUUID(),
      requestedBy: run.userId,
      threadId: run.threadId,
      runId: run.runId,
      environmentId: run.environmentId,
      runnerId: run.runnerId,
      runnerBootId: run.runnerBootId,
      bindingGeneration: run.bindingGeneration,
    };
    const store = new TabStore(f.database);
    let acquired: NativeTargetAcquiredHandler | undefined,
      capture: ((ownerId: typeof run.userId) => Promise<number>) | undefined;
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected native work");
    };
    const service = new TabService({
      store,
      pages: {
        open: unused,
        state: async () => ({ state: "asleep", usedBy: [] }),
        activate: unused,
        bind: unused,
        closeViewers: async () => {},
      },
      nativeTargets: {
        resolveWindow: unused,
        windowState: async () => ({ state: "asleep", usedBy: [] }),
        phoneState: async () => ({ state: "asleep", usedBy: [] }),
        openOwnerView: unused,
        closeOwnerViews: async () => {},
        onTargetAcquired: (handler, before) => {
          acquired = handler;
          capture = before;
          return () => {};
        },
      },
      apps: { get: unused },
      computer: async (owner, id, db) => ({
        ...(await tabComputer(owner, id, db)),
        connected: false,
      }),
      canRead: canReadTab,
      readAuthority: tabReadAuthority,
      canReadTask: async () => true,
      authorize: authorizeTabTarget,
      onError: (error) => {
        throw error;
      },
    });
    const page = async (computerId: typeof run.runnerId, label: string) => {
      const sessionId = `bsn_${randomUUID()}` as import("@opensteer/core").BrowserSessionId;
      await f.store.createBrowserSession({
        id: sessionId,
        ownerId: run.userId,
        runnerId: computerId,
        origin: "agent",
        opener: { kind: "person", userId: run.userId },
        placementKey: "test",
        profileId: null,
        runtimeId: "test",
      });
      const id = TabIdSchema.parse(`bsf_${label}`);
      await store.open(
        {
          id,
          ownerId: run.userId,
          computerId,
          kind: "page",
          title: label,
          url: `https://${label}.test/private`,
          openedBy: "person",
          pageBinding: { lineageId: sessionId, sessionId, surfaceId: id },
        },
        label,
      );
      return id;
    };
    return {
      f,
      run,
      claims,
      store,
      service,
      actor: { kind: "run", claims } as TabActor,
      page,
      acquired: () => acquired!,
      capture: () => capture!,
    };
  }
  it("keeps denied computer tabs and partial-group metadata secret, even when computers are offline", async () => {
    const t = await fixture();
    try {
      const denied = createId("runner");
      const source = await t.f.database
        .selectFrom("runners")
        .selectAll()
        .where("id", "=", t.run.runnerId)
        .executeTakeFirstOrThrow();
      await t.f.database
        .insertInto("runners")
        .values({
          ...source,
          id: denied,
          name: "Denied computer",
          kind: "local",
          ownerKind: "user",
          ownerUserId: t.run.userId,
          publicKeyFingerprint: `sha256:${randomUUID()}`,
          enrollmentTokenHash: `sha256:${randomUUID()}`,
          capabilities: sql`${JSON.stringify(source.capabilities)}::jsonb`,
          allowedModules: sql`${JSON.stringify(source.allowedModules)}::jsonb`,
          moduleDescriptors: sql`${JSON.stringify(source.moduleDescriptors)}::jsonb`,
          accessPolicy: sql`${JSON.stringify(source.accessPolicy)}::jsonb`,
        })
        .execute();
      await t.f.database
        .updateTable("runners")
        .set({ accessPolicy: sql`'{"browser":true,"apps":true,"files":true}'::jsonb` })
        .where("id", "=", t.run.runnerId)
        .execute();
      await t.f.database
        .updateTable("runners")
        .set({ accessPolicy: sql`'{"browser":false,"apps":true,"files":true}'::jsonb` })
        .where("id", "=", denied)
        .execute();
      const allowedId = await t.page(t.run.runnerId, "allowed"),
        deniedId = await t.page(denied, "denied");
      await t.store.organize(
        t.run.userId,
        { tabIds: [allowedId, deniedId], group: { name: "Secret mixed group", color: "blue" } },
        "group",
      );
      const list = await t.service.list(t.actor, {});
      expect(list.tabs).toMatchObject([
        {
          tabId: allowedId,
          groupId: null,
          state: "unavailable",
          unavailableCode: "computer-offline",
        },
      ]);
      expect(list.groups).toEqual([]);
      expect(JSON.stringify(list)).not.toContain("denied.test");
      expect(JSON.stringify(list)).not.toContain("Secret mixed group");
      await expect(t.service.authorizeShow(t.claims, deniedId)).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await t.service.close(t.actor, [deniedId], "close-denied")).toMatchObject({
        closed: [],
        failed: [{ tabId: deniedId }],
      });
    } finally {
      t.service.dispose();
      await t.f.close();
    }
  });
  it("allows limited Runs to read but rechecks write authority within the membership transaction", async () => {
    const t = await fixture();
    try {
      await t.f.database
        .updateTable("runners")
        .set({ accessPolicy: sql`'{"browser":true,"apps":true,"files":true}'::jsonb` })
        .where("id", "=", t.run.runnerId)
        .execute();
      const id = await t.page(t.run.runnerId, "readable");
      await t.f.database
        .updateTable("runs")
        .set({ accessMode: "approval-required" })
        .where("id", "=", t.run.runId)
        .execute();
      expect((await t.service.list(t.actor, {})).tabs.map((tab) => tab.tabId)).toEqual([id]);
      expect(await t.service.close(t.actor, [id], "close-readonly")).toMatchObject({
        closed: [],
        failed: [{ error: { code: "access_denied" } }],
      });
      await expect(
        t.service.organize(
          t.actor,
          { tabIds: [id], group: { name: "No write", color: "blue" } },
          "organize-readonly",
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        t.service.open(t.actor, { kind: "phone", computerId: t.run.runnerId }, "open-readonly"),
      ).rejects.toMatchObject({ code: "forbidden" });
      await t.f.database
        .updateTable("runs")
        .set({ accessMode: "full-access" })
        .where("id", "=", t.run.runId)
        .execute();
      const admitted = (await t.store.get(t.run.userId, id))!;
      const lateId = TabIdSchema.parse("surface_uncommitted");
      t.service.options.pages.open = async () => {
        await t.f.database
          .updateTable("runs")
          .set({ accessMode: "approval-required" })
          .where("id", "=", t.run.runId)
          .execute();
        return {
          id: lateId,
          ownerId: t.run.userId,
          computerId: t.run.runnerId,
          kind: "page",
          title: "Not admitted",
          url: "https://not-admitted.test",
          openedBy: { taskId: t.run.threadId },
          pageBinding: { ...admitted.pageBinding!, surfaceId: lateId },
        };
      };
      await expect(
        t.service.open(
          t.actor,
          { kind: "page", guest: true, url: "https://not-admitted.test" },
          "revoked-after-native-open",
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(await t.store.get(t.run.userId, lateId, true)).toBeNull();
      expect((await t.store.snapshot(t.run.userId)).layout.items).toEqual([
        { kind: "tab", tabId: id },
      ]);
    } finally {
      t.service.dispose();
      await t.f.close();
    }
  });
  it("returns a late acquired handle without reopening membership closed after admission", async () => {
    const t = await fixture();
    try {
      const id = TabIdSchema.parse(`tab_${randomUUID()}`),
        windowId = WindowIdSchema.parse(`win_${randomUUID()}`);
      await t.store.open(
        {
          id,
          ownerId: t.run.userId,
          computerId: t.run.runnerId,
          kind: "window",
          windowId,
          windowApp: { bundleId: "test.app", displayName: "Test", teamId: null },
          title: "Window",
          openedBy: "person",
        },
        "window",
      );
      const membershipRevision = await t.capture()(t.run.userId);
      await t.store.close(t.run.userId, [id], "close-during-bind");
      // Native acquisition already checked its resource; isolate the membership race here.
      t.service.options.authorize = async () => {};
      expect(
        await t.acquired()({
          ownerId: t.run.userId,
          runClaims: t.claims,
          computerId: t.run.runnerId,
          kind: "window",
          windowId,
          key: "late",
          membershipRevision,
        }),
      ).toBe(id);
      expect(await t.store.get(t.run.userId, id)).toBeNull();
      expect((await t.store.get(t.run.userId, id, true))?.closedAt).not.toBeNull();
    } finally {
      t.service.dispose();
      await t.f.close();
    }
  });
});

integration("tab projection database cost", () => {
  it("uses one batched owner projection and one native RPC for a changed row across two subscribers", async () => {
    const f = await createStoreFixture(),
      run = await f.startRunFixture("tab-projection-cost");
    let queries = 0,
      nativeRPCs = 0;
    const database = f.database.withPlugin({
      transformQuery: ({ node }) => {
        queries++;
        return node;
      },
      transformResult: async ({ result }) => result,
    });
    const store = new TabStore(database),
      rows = [];
    for (let index = 0; index < 40; index++) {
      const id = TabIdSchema.parse(`tab_${randomUUID()}`);
      await store.open(
        {
          id,
          ownerId: run.userId,
          computerId: run.runnerId,
          kind: "window",
          windowId: WindowIdSchema.parse(`win_${randomUUID()}`),
          windowApp: { bundleId: "test.app", displayName: "Test", teamId: null },
          title: `Window ${index}`,
          openedBy: "person",
        },
        `open-${index}`,
      );
      rows.push(id);
    }
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected action");
    };
    const service = new TabService({
      store,
      pages: {
        open: unused,
        state: unused,
        activate: unused,
        bind: unused,
        closeViewers: async () => {},
      },
      nativeTargets: {
        resolveWindow: unused,
        windowState: async () => {
          nativeRPCs++;
          return { state: "asleep", usedBy: [] };
        },
        phoneState: unused,
        openOwnerView: unused,
        closeOwnerViews: async () => {},
        onTargetAcquired: () => () => {},
      },
      apps: { get: unused },
      computer: async (owner, id, db) => ({
        ...(await tabComputer(owner, id, db)),
        connected: true,
      }),
      computers: async (owner, ids, db) =>
        new Map(
          [...(await tabComputers(owner, ids, db))].map(([id, value]) => [
            id,
            { ...value, connected: true },
          ]),
        ),
      canRead: canReadTab,
      readAuthority: tabReadAuthority,
      readableTasks: async () => new Set(),
      canReadTask: async () => true,
      authorize: authorizeTabTarget,
      onError: (error) => {
        throw error;
      },
    });
    const devices = [
      service.streams.subscribe(run.userId, async () => {}),
      service.streams.subscribe(run.userId, async () => {}),
    ];
    try {
      await Promise.all(devices.map((device) => device.ready));
      expect(nativeRPCs).toBe(40);
      await database
        .updateTable("personalTabs")
        .set({ title: "Changed", updatedAt: new Date() })
        .where("id", "=", rows[0]!)
        .execute();
      queries = 0;
      nativeRPCs = 0;
      service.changed(run.userId, [rows[0]!]);
      await Promise.all(devices.map((device) => device.flush()));
      expect(nativeRPCs).toBe(1);
      expect(queries).toBeLessThanOrEqual(12);
    } finally {
      for (const device of devices) device.close();
      service.dispose();
      await f.close();
    }
  });
});
