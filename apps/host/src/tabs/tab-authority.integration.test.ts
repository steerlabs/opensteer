import { createIntegrationId } from "@opensteer/integration-core";
import { upsertSelfDeviceInTransaction } from "@opensteer/database";
import { DeviceIdSchema } from "@opensteer/core";
import { createId, TabIdSchema, WindowIdSchema, type TabId } from "@opensteer/core";
import { TabStore } from "@opensteer/database";
import { createStoreFixture } from "@opensteer/database/test-support/store";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeTabTarget,
  authorizeTabActor,
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
      devices: f.store,
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
      authorizeMembership: authorizeTabActor,
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
          computerId: DeviceIdSchema.parse(computerId),
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
        })
        .execute();
      await upsertSelfDeviceInTransaction(t.f.database, denied);
      await t.f.database
        .updateTable("devices")
        .set({ accessPolicy: sql`'{"browser":true,"apps":true,"files":true}'::jsonb` })
        .where("id", "=", DeviceIdSchema.parse(t.run.runnerId))
        .execute();
      await t.f.database
        .updateTable("devices")
        .set({ accessPolicy: sql`'{"browser":false,"apps":true,"files":true}'::jsonb` })
        .where("id", "=", DeviceIdSchema.parse(denied))
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
        closed: [deniedId],
        failed: [],
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
        .updateTable("devices")
        .set({ accessPolicy: sql`'{"browser":true,"apps":true,"files":true}'::jsonb` })
        .where("id", "=", DeviceIdSchema.parse(t.run.runnerId))
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
          computerId: DeviceIdSchema.parse(t.run.runnerId),
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
  it("lets the owner and writable Runs organize and close removed targets while acquisition still fails", async () => {
    const t = await fixture();
    try {
      const removed = await t.page(t.run.runnerId, "removed-computer");
      const profileTab = await t.page(t.run.runnerId, "deleted-profile");
      await t.f.database
        .updateTable("personalTabs")
        .set({ profileId: createId("browserProfile"), profileName: "Deleted" })
        .where("id", "=", profileTab)
        .execute();
      // Retain the hosting computer's authority but remove the saved target computer.
      const removedDeviceId = createId("device");
      const home = await t.f.store.getDevice(await t.f.store.requireSelfDeviceId(t.run.runnerId));
      if (!home) throw new Error("Fixture Device missing");
      await t.f.database
        .insertInto("devices")
        .values({
          ...home,
          id: removedDeviceId,
          accessPolicy: sql`${JSON.stringify(home.accessPolicy)}::jsonb`,
          removedAt: new Date(),
        })
        .execute();
      await t.f.database
        .updateTable("personalTabs")
        .set({ computerId: removedDeviceId })
        .where("id", "=", removed)
        .execute();
      const person = { kind: "person", ownerId: t.run.userId } as const;
      const grouped = await t.service.organize(
        person,
        { tabIds: [removed, profileTab], group: { name: "Unavailable", color: "blue" } },
        "organize-removed",
      );
      for (const id of [removed, profileTab]) {
        await expect(t.service.activate(t.run.userId, id, `activate-${id}`)).rejects.toMatchObject({
          code: "not_found",
        });
      }
      await t.service.organize(
        t.actor,
        { tabIds: [removed, profileTab], group: null },
        "agent-organize-removed",
      );
      await t.f.database
        .updateTable("runs")
        .set({ accessMode: "approval-required" })
        .where("id", "=", t.run.runId)
        .execute();
      await expect(
        t.service.updateGroup(
          t.actor,
          { groupId: grouped.groups[0]!.groupId, name: "Denied" },
          "readonly-empty-group",
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await t.f.database
        .updateTable("runs")
        .set({ accessMode: "full-access" })
        .where("id", "=", t.run.runId)
        .execute();
      expect(await t.service.close(person, [removed], "close-removed")).toEqual({
        closed: [removed],
        failed: [],
      });
      expect(await t.service.close(t.actor, [profileTab], "close-profile")).toEqual({
        closed: [profileTab],
        failed: [],
      });
    } finally {
      t.service.dispose();
      await t.f.close();
    }
  });
  it("shares one iPhone Device tab with approved Runs and cannot reacquire it after removal", async () => {
    const t = await fixture();
    try {
      const deviceId = createId("device");
      const home = await t.f.store.getDevice(await t.f.store.requireSelfDeviceId(t.run.runnerId));
      if (!home) throw new Error("Fixture Device missing");
      await t.f.database
        .insertInto("devices")
        .values({
          ...home,
          id: deviceId,
          name: "Travel iPhone",
          kind: "phone",
          platform: "ios",
          form: "phone",
          ownerKind: "user",
          ownerUserId: t.run.userId,
          accessPolicy: sql`'{"browser":false,"apps":true,"reach":"nobody"}'::jsonb`,
        })
        .execute();
      await t.f.database
        .insertInto("integrationConnections")
        .values({
          id: createIntegrationId("connection"),
          ownerUserId: t.run.userId,
          deviceId,
          runnerId: null,
          connectionKind: "computer",
          computerAccess: "read-write",
          computerBlockedAt: null,
          provider: "iphone-screen",
          integrationDefinitionId: "iphone-screen",
          displayName: "Travel iPhone",
          status: "connected",
          connectionMethod: "computer",
          capabilities: sql`'[]'::jsonb`,
          grantedScopes: sql`'[]'::jsonb`,
          applicationSource: sql`'null'::jsonb`,
          accountIdentifier: null,
          authMethodId: null,
          authorizationDigest: null,
          credentialId: null,
          integrationServerId: null,
          providerApplicationId: null,
          externalIdentityId: null,
          externalTenantId: null,
          statusDetail: null,
          transportKind: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute();
      const person = { kind: "person", ownerId: t.run.userId } as const;
      const first = await t.service.open(
        person,
        { kind: "phone", computerId: deviceId },
        "phone-first",
      );
      const second = await t.service.open(
        person,
        { kind: "phone", computerId: deviceId },
        "phone-second",
      );
      expect(second.tab.tabId).toBe(first.tab.tabId);
      const acquisition = {
        ownerId: t.run.userId,
        runClaims: t.claims,
        kind: "phone" as const,
        computerId: deviceId,
        key: "phone-acquired",
        membershipRevision: (await t.store.snapshot(t.run.userId)).layout.revision,
      };
      expect(await t.service.acquired(acquisition)).toBe(first.tab.tabId);
      expect((await t.service.list(t.actor, {})).tabs).toMatchObject([
        { tabId: first.tab.tabId, computer: { computerId: deviceId, name: "Travel iPhone" } },
      ]);
      await t.f.store.removeDevice(deviceId, t.run.userId);
      await expect(
        t.service.activate(t.run.userId, first.tab.tabId, "removed-view"),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        t.service.acquired({ ...acquisition, key: "removed-acquisition" }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect((await t.store.snapshot(t.run.userId)).rows).toHaveLength(1);
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
          computerId: DeviceIdSchema.parse(t.run.runnerId),
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
        await t.service.acquired({
          ownerId: t.run.userId,
          runClaims: t.claims,
          computerId: await t.f.store.requireSelfDeviceId(t.run.runnerId),
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
      rows: TabId[] = [];
    const snapshots = vi.spyOn(store, "snapshot"),
      targeted = vi.spyOn(store, "rows");
    for (let index = 0; index < 40; index++) {
      const id = TabIdSchema.parse(`tab_${randomUUID()}`);
      await store.open(
        {
          id,
          ownerId: run.userId,
          computerId: DeviceIdSchema.parse(run.runnerId),
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
      devices: f.store,
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
      authorizeMembership: authorizeTabActor,
      onError: (error) => {
        throw error;
      },
    });
    const actor = { kind: "person", ownerId: run.userId } as const;
    const projectForDevices = () => Promise.all([service.project(actor), service.project(actor)]);
    try {
      await projectForDevices();
      expect(nativeRPCs).toBe(40);
      await database
        .updateTable("personalTabs")
        .set({ title: "Changed", updatedAt: new Date() })
        .where("id", "=", rows[0]!)
        .execute();
      queries = 0;
      nativeRPCs = 0;
      snapshots.mockClear();
      targeted.mockClear();
      service.changed(run.userId, [rows[0]!]);
      const projections = await projectForDevices();
      expect(snapshots).not.toHaveBeenCalled();
      expect(targeted).toHaveBeenCalledExactlyOnceWith(run.userId, [rows[0]!]);
      expect(await targeted.mock.results[0]!.value).toHaveLength(1);
      expect(nativeRPCs, "rows projected through the native state port").toBe(1);
      expect(queries).toBe(7);
      for (const { tabs } of projections)
        expect(tabs.find((tab) => tab.tabId === rows[0])).toMatchObject({ title: "Changed" });
    } finally {
      service.dispose();
      await f.close();
    }
  });
});
