import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
/** Failure modes: parent locking can leave child cascades unordered; reclamation can
 * hold member A while a cascade holds B; transaction retries can hide the deadlock.
 * Force the first-member interleaving for pruning and Workspace deletion and record it. */
import { createId } from "@opensteer/core";
import {
  BrowserSurfaceIdSchema,
  browserFaviconMaxBytes,
  browserTabOpenReplayWindowMs,
  createBrowserSessionId,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it as baseIt, describe, expect } from "vitest";
import { createDatabase } from "./connection.js";

import { BrowserTabGroupStore } from "./browser-tab-group-store.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { jsonValue } from "./store-primitives.js";
import { OpensteerStore } from "./store.js";
import { WorkspaceTabStore } from "./workspace-tab-store.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const cascadeEvidence: Array<Record<string, unknown>> = [];
afterEach(async ({ task }) => {
  if (!cascadeEvidence.length) return;
  const directory =
    process.env.OPENSTEER_TAB_GROUPS_EVIDENCE_DIR ??
    join(tmpdir(), `opensteer-tab-group-cascades-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${randomUUID()}.json`),
    JSON.stringify(
      {
        gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        journey: task.name,
        result: task.result,
        evidence: cascadeEvidence.splice(0),
      },
      null,
      2,
    ),
  );
});

// Distinct one-pixel PNGs: a tab's durable icon is the browser's own raster data URL.
const iconA =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=";
const iconB =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const iconC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

integration.sequential("durable workspace tabs", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "workspace-tabs-test",
        connectionString: databaseUrl,
        maxConnections: 3,
      });
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const tabs = new WorkspaceTabStore(database);
    async function fixture() {
      const ownerId = await store.createUser("Tab owner");
      const strangerId = await store.createUser("Stranger");
      await store.ensureDeployment({
        canonicalOrigin: "https://tabs.test",
        deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
        hostInstanceId: createId("hostInstance"),
      });
      const workspace = await store.createWorkspace({
        backing: { kind: "portablefs", generation: 1, serviceId: "test", volumeId: randomUUID() },
        capacityPolicy: { blockHardLimitBytes: 1000000, inodeHardLimit: 1000, kind: "hard-quota" },
        createdBy: ownerId,
        idempotencyKey: randomUUID(),
        name: "Tabs",
        status: "ready",
      });
      const runnerId = createId("runner");
      await database
        .insertInto("runners")
        .values({
          id: runnerId,
          ownerKind: "user",
          ownerUserId: ownerId,
          name: "Browser",
          kind: "local",
          publicKeyPem: "fixture",
          publicKeyFingerprint: `sha256:${runnerId}`,
          enrollmentTokenHash: `sha256:${runnerId}`,
          capabilities: jsonValue([]),
          allowedModules: jsonValue(["browser"]),
          moduleDescriptors: jsonValue({}),
          accessPolicy: { commands: false, forwarding: false, reach: "nobody", shares: [] },
          accessPolicyRevision: 1,
          connectionGeneration: 0,
          device: null,
          maxConcurrentRuns: null,
          enrolledAt: new Date(),
          lastSeenAt: null,
          revokedAt: null,
        })
        .execute();
      const groupId = createBrowserSessionId();
      const session = {
        id: groupId,
        runnerId,
        origin: "workspace" as const,
        placementKey: "test",
        profileId: null,
        runtimeId: "test",
        workspaceId: workspace.id,
      };
      await store.createBrowserSession(session);
      const first = {
        id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
        title: "One",
        url: "https://tabs.test/one",
        order: 0,
        openerId: null,
      };
      const second = {
        ...first,
        id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
        title: "Popup",
        order: 1,
        openerId: first.id,
      };
      return { ownerId, strangerId, groupId, session, first, second };
    }
    const allowReopen = async () => undefined;

    return Object.freeze({ database, store, tabs, fixture, allowReopen, databaseUrl });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  it.for(["prune", "workspace deletion"] as const)(
    "orders membership cascades against reclamation during %s without retrying",
    async (path, { storeFixture }) => {
      const { fixture, tabs, database, store, databaseUrl } = storeFixture;
      const f = await fixture();
      const a = BrowserSurfaceIdSchema.parse("surface_00000000-0000-4000-8000-000000000001");
      const b = BrowserSurfaceIdSchema.parse("surface_00000000-0000-4000-8000-000000000002");
      await tabs.record(
        f.groupId,
        [
          { ...f.second, id: b, openerId: null },
          { ...f.first, id: a },
        ],
        [],
      );
      const grouped = await new BrowserTabGroupStore(database).group(f.ownerId, {
        tabIds: [a, b],
        title: "Reclaim",
        idempotencyKey: randomUUID(),
      });
      await database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("browserSessions")
          .select("id")
          .where("id", "=", f.groupId)
          .forNoKeyUpdate()
          .execute();
        await transaction
          .updateTable("browserSessions")
          .set({ state: "closed" })
          .where("id", "=", f.groupId)
          .execute();
        await transaction
          .selectFrom("workspaceTabs")
          .select("id")
          .where("id", "in", [a, b])
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        for (const id of [b, a])
          await transaction
            .updateTable("workspaceTabs")
            .set({ closedAt: new Date(Date.now() - browserTabOpenReplayWindowMs - 1000) })
            .where("id", "=", id)
            .execute();
      });
      expect(
        (
          await sql<{ id: string }>`select id from workspace_tabs order by ctid`.execute(database)
        ).rows.map((row) => row.id),
      ).toEqual([b, a]);
      if (path === "workspace deletion")
        await store.requestWorkspaceDeletion({
          workspaceId: f.session.workspaceId,
          requestedBy: f.ownerId,
          purgeAfter: new Date(),
        });
      const applicationName = `workspace-tabs-cascade-${path}`;
      const deletingDatabase = createDatabase({
        connectionString: databaseUrl!,
        maxConnections: 1,
        applicationName,
      });
      // A sequential DELETE visits B then A even though its parent locks were acquired A then B.
      await sql`set enable_indexscan = off`.execute(deletingDatabase);
      await sql`set enable_bitmapscan = off`.execute(deletingDatabase);
      const barrier = pauseAfterLock(
        database,
        (node) =>
          /"name":"browser_?tab_?group_?members"/iu.test(node) && node.includes("ForUpdate"),
      );
      // A raw peer isolates reclamation's A -> B edge so it can pause between real row locks.
      const reclaiming = barrier.database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("browserTabLayouts")
          .select("ownerId")
          .where("ownerId", "=", f.ownerId)
          .forNoKeyUpdate()
          .execute();
        await transaction
          .selectFrom("browserTabGroups")
          .select("id")
          .where("id", "=", grouped.groupId)
          .forUpdate()
          .execute();
        for (const tabId of [a, b])
          await transaction
            .selectFrom("browserTabGroupMembers")
            .select(["ownerId", "tabId"])
            .where("ownerId", "=", f.ownerId)
            .where("tabId", "=", tabId)
            .forUpdate()
            .execute();
        await transaction
          .deleteFrom("browserTabGroupMembers")
          .where("ownerId", "=", f.ownerId)
          .where("tabId", "in", [a, b])
          .execute();
        await transaction
          .deleteFrom("browserTabGroups")
          .where("id", "=", grouped.groupId)
          .execute();
      });
      void reclaiming.catch(() => undefined);
      let deleting: Promise<unknown> | undefined;
      let blockedQuery: string | undefined;
      let held: string[] = [];
      let outcomes: PromiseSettledResult<unknown>[] = [];
      try {
        await barrier.reached;
        deleting =
          path === "prune"
            ? new WorkspaceTabStore(deletingDatabase).prune()
            : new OpensteerStore(deletingDatabase).markWorkspaceDeleted({
                workspaceId: f.session.workspaceId,
              });
        void deleting.catch(() => undefined);
        await expect
          .poll(async () => {
            blockedQuery = (
              await sql<{
                query: string;
              }>`select query from pg_stat_activity where datname=current_database() and application_name=${applicationName} and wait_event_type='Lock'`.execute(
                database,
              )
            ).rows[0]?.query;
            return blockedQuery !== undefined;
          })
          .toBe(true);
        held = (
          await sql<{
            tabId: string;
          }>`select member.tab_id from pgrowlocks('browser_tab_group_members') as held join browser_tab_group_members as member on member.ctid=held.locked_row order by member.owner_id, member.tab_id`.execute(
            database,
          )
        ).rows.map((row) => row.tabId);
        expect(held).toEqual([a]);
        expect(blockedQuery).toContain('"browser_tab_group_members"');
      } finally {
        barrier.release();
        outcomes = await Promise.allSettled([reclaiming, ...(deleting ? [deleting] : [])]);
        await deletingDatabase.destroy();
        cascadeEvidence.push({
          path,
          parentHeapOrder: [b, a],
          reclamationLockOrder: [a, b],
          heldWhileBlocked: held,
          blockedQuery,
          outcomes: outcomes.map((outcome) =>
            outcome.status === "fulfilled"
              ? { status: outcome.status }
              : { status: outcome.status, error: String(outcome.reason) },
          ),
          conflicts: barrier.conflicts,
        });
      }
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(barrier.conflicts).toEqual([]);
      expect(await database.selectFrom("workspaceTabs").select("id").execute()).toEqual([]);
      expect(await database.selectFrom("browserTabGroupMembers").selectAll().execute()).toEqual([]);
      expect((await new BrowserTabGroupStore(database).layout(f.ownerId)).groups).toEqual([]);
    },
  );

  it("commits membership, diffs metadata, and preserves dormant siblings on suspension", async ({
    storeFixture,
  }) => {
    const { fixture, tabs } = storeFixture;
    const f = await fixture();
    expect(await tabs.record(f.groupId, [f.first, f.second], [])).toBe(true);
    const before = await tabs.read(f.ownerId, f.groupId);
    expect(before?.tabs).toHaveLength(2);
    expect(await tabs.record(f.groupId, [f.first, f.second], [])).toBe(false);
    expect((await tabs.read(f.ownerId, f.groupId))?.revision).toBe(before?.revision);
    await tabs.suspend(f.groupId);
    expect((await tabs.read(f.ownerId, f.groupId))?.tabs?.map((t) => t.state)).toEqual([
      "suspended",
      "suspended",
    ]);
    await tabs.close(f.ownerId, f.first.id);
    expect((await tabs.read(f.ownerId, f.groupId))?.tabs?.map((t) => t.id)).toEqual([f.second.id]);
    await tabs.record(f.groupId, [f.first, f.second], []);
    expect((await tabs.read(f.ownerId, f.groupId))?.tabs?.map((t) => t.id)).toEqual([f.second.id]);
  });
  it("fences old producers and rejects resurrection after a close during activation", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, store } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first, f.second], []);
    await tabs.suspend(f.groupId);
    const replacement = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id: replacement, tabGroupId: f.groupId });
    await tabs.bind(f.groupId, replacement, f.first.id);
    await tabs.record(replacement, [{ ...f.first, title: "", url: "about:blank" }], []);
    await tabs.record(replacement, [{ ...f.first, title: "", url: "about:blank" }], []);
    expect((await tabs.get(f.ownerId, f.first.id))?.url).toBe(f.first.url);
    await tabs.record(f.groupId, [{ ...f.first, title: "Stale" }], [f.second.id]);
    expect((await tabs.get(f.ownerId, f.first.id))?.title).toBe("One");
    await tabs.close(f.ownerId, f.first.id);
    await tabs.record(replacement, [f.first], []);
    expect(await tabs.get(f.ownerId, f.first.id)).toBeNull();
    await tabs.record(replacement, [f.second], []);
    await tabs.closeLineage(replacement);
    expect((await tabs.read(f.ownerId, f.groupId))?.tabs).toEqual([]);
  });
  it("ignores an obsolete session close after rebinding its group", async ({ storeFixture }) => {
    const { fixture, tabs, store } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first, f.second], []);
    await tabs.suspend(f.groupId);
    const replacement = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id: replacement, tabGroupId: f.groupId });
    await tabs.bind(f.groupId, replacement, f.first.id);
    await tabs.record(replacement, [f.first], []);
    const before = await tabs.read(f.ownerId, f.groupId);
    await tabs.closeLineage(f.groupId);
    expect(await tabs.read(f.ownerId, f.groupId)).toEqual(before);
    await tabs.closeLineage(replacement);
    expect((await tabs.read(f.ownerId, f.groupId))?.tabs).toEqual([]);
  });
  it("admits a replacement in the same flush that closes a tab at capacity", async ({
    storeFixture,
  }) => {
    const { fixture, tabs } = storeFixture;
    const f = await fixture();
    const original = Array.from({ length: 64 }, (_, order) => ({
      ...f.first,
      id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
      order,
    }));
    await tabs.record(f.groupId, original, []);
    expect(await tabs.record(f.groupId, [...original.slice(1), f.second], [original[0]!.id])).toBe(
      true,
    );
    const group = await tabs.read(f.ownerId, f.groupId);
    expect(group?.tabs).toHaveLength(64);
    expect(group?.tabs?.some((tab) => tab.id === original[0]!.id)).toBe(false);
    expect(group?.tabs?.some((tab) => tab.id === f.second.id)).toBe(true);
    expect(await tabs.record(f.groupId, original, [])).toBe(false);
    await expect(tabs.record(f.groupId, [f.first], [])).rejects.toMatchObject({ code: "conflict" });
  });
  it("preserves a long durable URL and resolves an omitted group's replacement session", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, store, database } = storeFixture;
    const f = await fixture();
    const url = `https://tabs.test/${"x".repeat(9000)}#/document/42`;
    await tabs.record(f.groupId, [{ ...f.first, url }], []);
    const replacement = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id: replacement, tabGroupId: f.groupId });
    await tabs.bind(f.groupId, replacement, f.first.id);
    for (let index = 0; index < 100; index++) {
      const id = createBrowserSessionId();
      await store.createBrowserSession({ ...f.session, id });
      await tabs.record(
        id,
        [{ ...f.second, id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`) }],
        [],
      );
    }
    expect((await tabs.list(f.ownerId)).some((group) => group.id === f.groupId)).toBe(false);
    const grouped = await new BrowserTabGroupStore(database).group(f.ownerId, {
      tabIds: [f.first.id],
      title: "Still relevant",
      idempotencyKey: randomUUID(),
    });
    const preferred = await tabs.list(f.ownerId);
    expect(preferred).toHaveLength(100);
    expect(preferred[0]?.id).toBe(f.groupId);
    expect(preferred.flatMap((lineage) => lineage.tabs ?? []).map((tab) => tab.id)).toContain(
      f.first.id,
    );
    await new BrowserTabGroupStore(database).ungroup(f.ownerId, {
      tabIds: [f.first.id],
      idempotencyKey: randomUUID(),
    });
    expect((await tabs.list(f.ownerId)).some((lineage) => lineage.id === f.groupId)).toBe(false);
    expect(grouped.layout.groups[0]?.tabIds).toEqual([f.first.id]);
    expect(await tabs.lineageForSession(replacement)).toBe(f.groupId);
    expect((await tabs.read(f.ownerId, f.groupId))?.tabs?.[0]?.id).toBe(f.first.id);
    expect((await tabs.get(f.ownerId, f.first.id))?.url).toBe(url);
    expect(await tabs.read(f.strangerId, f.groupId)).toBeNull();
  });
  it("reuses session authority and removes rows on Workspace deletion", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, store } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first], []);
    expect(await tabs.read(f.strangerId, f.groupId)).toBeNull();
    expect(await tabs.get(f.strangerId, f.first.id)).toBeNull();
    expect(await tabs.list(f.strangerId)).toEqual([]);
    await store.requestWorkspaceDeletion({
      workspaceId: f.session.workspaceId,
      requestedBy: f.ownerId,
      purgeAfter: new Date(),
    });
    await store.markWorkspaceDeleted({ workspaceId: f.session.workspaceId });
    expect(await tabs.list(f.ownerId)).toEqual([]);
  });
  it("lists the newest 100 groups without refusing new dormant groups", async ({
    storeFixture,
  }) => {
    const { fixture, store, tabs } = storeFixture;
    const f = await fixture();
    for (let index = 0; index < 101; index++) {
      const id = createBrowserSessionId();
      await store.createBrowserSession({ ...f.session, id });
      expect(
        await tabs.record(
          id,
          [{ ...f.first, id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`) }],
          [],
        ),
      ).toBe(true);
      await tabs.suspend(id);
    }
    const listed = await tabs.list(f.ownerId);
    expect(listed).toHaveLength(100);
    expect(listed.every((group) => group.tabs?.[0]?.state === "suspended")).toBe(true);
    expect(listed.map((group) => group.createdAt)).toEqual(
      listed
        .map((group) => group.createdAt)
        .sort()
        .reverse(),
    );
  });
  it("uses the latest session identity and retains archived-profile metadata only for its owner", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, store, database } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first], []);
    const replacement = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id: replacement, tabGroupId: f.groupId });
    const profile = await store.createBrowserProfile({
      idempotencyKey: "workspace-tab-store.integration.test-browser-profile-1",
      name: "Saved Guest",
      ownerId: f.ownerId,
    });
    await database
      .updateTable("browserSessions")
      .set({ profileId: profile.id })
      .where("id", "=", replacement)
      .execute();
    expect((await tabs.read(f.ownerId, f.groupId))?.session.profileId).toBe(profile.id);
    await database
      .updateTable("browserProfiles")
      .set({ archivedAt: new Date() })
      .where("id", "=", profile.id)
      .execute();
    expect(await store.getBrowserProfile(profile.id, f.ownerId)).toBeNull();
    expect((await tabs.read(f.ownerId, f.groupId))?.tabs?.[0]?.id).toBe(f.first.id);
    expect(await tabs.read(f.strangerId, f.groupId)).toBeNull();
  });
  it("persists an icon-only change once, then holds it through same-URL silence and failures", async ({
    storeFixture,
  }) => {
    const { fixture, tabs } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first, f.second], []);
    const base = (await tabs.read(f.ownerId, f.groupId))!.revision;
    expect(await tabs.record(f.groupId, [{ ...f.first, favicon: iconA }, f.second], [])).toBe(true);
    expect((await tabs.read(f.ownerId, f.groupId))!.revision).toBe(base + 1);
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon).toBe(iconA);
    expect(await tabs.record(f.groupId, [{ ...f.first, favicon: iconA }, f.second], [])).toBe(
      false,
    );
    // Omission is "unknown" and null on the same URL is a failed reload: both keep the icon.
    expect(await tabs.record(f.groupId, [f.first, f.second], [])).toBe(false);
    expect(await tabs.record(f.groupId, [{ ...f.first, favicon: null }, f.second], [])).toBe(false);
    expect((await tabs.read(f.ownerId, f.groupId))!.revision).toBe(base + 1);
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon).toBe(iconA);
    expect(await tabs.record(f.groupId, [{ ...f.first, favicon: iconB }, f.second], [])).toBe(true);
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon).toBe(iconB);
    expect((await tabs.read(f.ownerId, f.groupId))!.revision).toBe(base + 2);
  });
  it("clears an icon when the committed URL changes unless the new page names one", async ({
    storeFixture,
  }) => {
    const { fixture, tabs } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [{ ...f.first, favicon: iconA }], []);
    const before = (await tabs.read(f.ownerId, f.groupId))!;
    const oldRef = before.tabs![0]!.iconRef;
    expect(oldRef).toEqual(expect.any(String));
    const moved = { ...f.first, url: "https://tabs.test/elsewhere" };
    expect(await tabs.record(f.groupId, [moved], [])).toBe(true);
    let row = await tabs.get(f.ownerId, f.first.id);
    expect(row?.favicon ?? null).toBeNull();
    expect(row?.iconRef ?? null).toBeNull();
    expect((await tabs.read(f.ownerId, f.groupId))!.tabs![0]!.iconRef ?? null).toBeNull();
    expect(await tabs.icon(f.ownerId, f.groupId, oldRef!)).toBeNull();
    await tabs.record(f.groupId, [{ ...moved, favicon: iconA }], []);
    const nulled = { ...f.first, url: "https://tabs.test/third", favicon: null };
    expect(await tabs.record(f.groupId, [nulled], [])).toBe(true);
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon ?? null).toBeNull();
    const settled = { ...f.first, url: "https://tabs.test/fourth", favicon: iconB };
    expect(await tabs.record(f.groupId, [settled], [])).toBe(true);
    row = await tabs.get(f.ownerId, f.first.id);
    expect(row?.favicon).toBe(iconB);
    expect(row?.iconRef).toEqual(expect.any(String));
  });
  it("keeps the restoring tab's and dormant siblings' icons and refs through rebind and about:blank", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, store } = storeFixture;
    const f = await fixture();
    await tabs.record(
      f.groupId,
      [
        { ...f.first, favicon: iconA },
        { ...f.second, favicon: iconB },
      ],
      [],
    );
    const before = (await tabs.read(f.ownerId, f.groupId))!.tabs!;
    await tabs.suspend(f.groupId);
    const replacement = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id: replacement, tabGroupId: f.groupId });
    await tabs.bind(f.groupId, replacement, f.first.id);
    await tabs.record(replacement, [{ ...f.first, title: "", url: "about:blank" }], []);
    await tabs.record(
      replacement,
      [{ ...f.first, title: "", url: "about:blank", favicon: null }],
      [],
    );
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon).toBe(iconA);
    // The page reloads at its durable URL; the Runtime has not fetched its icon yet.
    await tabs.record(replacement, [f.first], []);
    const after = (await tabs.read(f.ownerId, f.groupId))!.tabs!;
    expect(after.map((tab) => [tab.id, tab.state])).toEqual([
      [f.first.id, "live"],
      [f.second.id, "suspended"],
    ]);
    expect(after.map((tab) => tab.iconRef)).toEqual(before.map((tab) => tab.iconRef));
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon).toBe(iconA);
    expect((await tabs.get(f.ownerId, f.second.id))?.favicon).toBe(iconB);
    expect(await tabs.icon(f.ownerId, replacement, before[0]!.iconRef!)).toBe(iconA);
    expect(await tabs.icon(f.ownerId, replacement, before[1]!.iconRef!)).toBe(iconB);
    // The obsolete producer neither reads nor rewrites the group's icons.
    expect(await tabs.icon(f.ownerId, f.groupId, before[0]!.iconRef!)).toBeNull();
    expect(await tabs.record(f.groupId, [{ ...f.first, favicon: iconC }], [])).toBe(false);
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon).toBe(iconA);
  });
  it("does not resurrect a closed tab's icon or serve it after close", async ({ storeFixture }) => {
    const { fixture, tabs } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [{ ...f.first, favicon: iconA }, f.second], []);
    const ref = (await tabs.read(f.ownerId, f.groupId))!.tabs![0]!.iconRef!;
    expect(await tabs.icon(f.ownerId, f.groupId, ref)).toBe(iconA);
    await tabs.close(f.ownerId, f.first.id);
    expect(await tabs.icon(f.ownerId, f.groupId, ref)).toBeNull();
    expect(await tabs.record(f.groupId, [{ ...f.first, favicon: iconA }, f.second], [])).toBe(
      false,
    );
    expect(await tabs.get(f.ownerId, f.first.id)).toBeNull();
    expect(await tabs.icon(f.ownerId, f.groupId, ref)).toBeNull();
  });
  it("serves an icon only to its owner, through its group's bound session, by its own ref", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, store } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [{ ...f.first, favicon: iconA }], []);
    const ref = (await tabs.read(f.ownerId, f.groupId))!.tabs![0]!.iconRef!;
    const other = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id: other });
    const otherTab = {
      ...f.second,
      id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
      openerId: null,
      favicon: iconB,
    };
    await tabs.record(other, [otherTab], []);
    const otherRef = (await tabs.read(f.ownerId, other))!.tabs![0]!.iconRef!;
    expect(otherRef).not.toBe(ref);
    expect(await tabs.icon(f.ownerId, f.groupId, ref)).toBe(iconA);
    expect(await tabs.icon(f.ownerId, other, otherRef)).toBe(iconB);
    expect(await tabs.icon(f.strangerId, f.groupId, ref)).toBeNull();
    expect(await tabs.icon(f.ownerId, other, ref)).toBeNull();
    expect(await tabs.icon(f.ownerId, f.groupId, otherRef)).toBeNull();
    expect(await tabs.icon(f.ownerId, f.groupId, "A".repeat(43))).toBeNull();
    expect(await tabs.icon(f.ownerId, createBrowserSessionId(), ref)).toBeNull();
    const metadata = JSON.stringify([
      await tabs.read(f.ownerId, f.groupId),
      await tabs.list(f.ownerId),
    ]);
    expect(metadata).toContain(ref);
    expect(metadata).not.toContain("data:image");
  });
  it("rejects icons that are not bounded raster data URLs without writing", async ({
    storeFixture,
  }) => {
    const { fixture, tabs } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [{ ...f.first, favicon: iconA }], []);
    const revision = (await tabs.read(f.ownerId, f.groupId))!.revision;
    const prefix = "data:image/png;base64,";
    const largest = 64 + Math.ceil(browserFaviconMaxBytes / 3) * 4;
    for (const favicon of [
      "data:image/svg+xml;base64,PHN2Zy8+",
      "https://tabs.test/favicon.ico",
      `${prefix}not base64!`,
      prefix + "A".repeat(largest - prefix.length + 4),
      "",
    ])
      await expect(tabs.record(f.groupId, [{ ...f.first, favicon }], [])).rejects.toThrow();
    expect((await tabs.read(f.ownerId, f.groupId))!.revision).toBe(revision);
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon).toBe(iconA);
    const bounded = prefix + "A".repeat(largest - prefix.length);
    expect(await tabs.record(f.groupId, [{ ...f.first, favicon: bounded }], [])).toBe(true);
    expect((await tabs.get(f.ownerId, f.first.id))?.favicon).toBe(bounded);
  });
  // Reopen failures: wrong actor, expired/consumed marker, stale producer, lost
  // layout context, capacity/access refusal, and close/reopen lock interleavings.

  it("reopens newest-first with fresh IDs, preserving descriptors and closed-surface fencing", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, database, allowReopen } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [{ ...f.first, favicon: iconA }, f.second], []);
    await tabs.close(f.ownerId, f.first.id);
    await database
      .updateTable("workspaceTabs")
      .set({ closedAt: new Date(Date.now() - 1000) })
      .where("id", "=", f.first.id)
      .execute();
    await tabs.close(f.ownerId, f.second.id);
    const key = randomUUID();
    const second = await tabs.reopen(f.ownerId, allowReopen, key);
    expect((await tabs.reopen(f.ownerId, allowReopen, key)).id).toBe(second.id);
    const first = await tabs.reopen(f.ownerId, allowReopen);
    expect(second.id).not.toBe(f.second.id);
    expect(first.id).not.toBe(f.first.id);
    expect(first).toMatchObject({
      groupId: f.groupId,
      title: "One",
      url: f.first.url,
      favicon: iconA,
      state: "suspended",
    });
    expect(second).toMatchObject({ groupId: f.groupId, title: "Popup", state: "suspended" });
    await tabs.record(f.groupId, [{ ...f.first, title: "Late", favicon: iconB }], []);
    expect(await tabs.get(f.ownerId, f.first.id)).toBeNull();
    expect((await tabs.get(f.ownerId, first.id))?.title).toBe("One");
    await expect(tabs.reopen(f.ownerId, allowReopen)).rejects.toMatchObject({
      message: "No recently closed tab to reopen.",
    });
    cascadeEvidence.push({
      reopened: [second, first],
      source: await database
        .selectFrom("workspaceTabs")
        .selectAll()
        .where("closedAt", "is not", null)
        .execute(),
    });
  });
  it("serializes concurrent reopens across lineages without consuming a close twice", async ({
    storeFixture,
  }) => {
    const { fixture, store, tabs, allowReopen } = storeFixture;
    const f = await fixture();
    const other = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id: other });
    const originals = Array.from({ length: 8 }, (_, index) => ({
      ...f.first,
      id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
      title: `Concurrent ${index}`,
    }));
    for (const [index, row] of originals.entries()) {
      await tabs.record(index % 2 ? other : f.groupId, [row], []);
      await tabs.close(f.ownerId, row.id);
    }
    const reopened = await Promise.all(
      originals.map(() =>
        tabs.reopen(f.ownerId, async (source, transaction) => {
          expect(
            await new WorkspaceTabStore(transaction).session(f.ownerId, source.groupId),
          ).not.toBeNull();
        }),
      ),
    );
    expect(new Set(reopened.map((row) => row.id)).size).toBe(8);
    expect(new Set(reopened.map((row) => row.title))).toEqual(
      new Set(originals.map((row) => row.title)),
    );
    expect(new Set(reopened.map((row) => row.groupId))).toEqual(new Set([f.groupId, other]));
    await expect(tabs.reopen(f.ownerId, allowReopen)).rejects.toMatchObject({ code: "not_found" });
    cascadeEvidence.push({ concurrentReopened: reopened });
  });
  it("excludes other people's, agent, inventory and lineage closes and expired live markers", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, database, allowReopen } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first, f.second], []);
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: f.session.workspaceId,
        userId: f.strangerId,
        role: "collaborator",
        state: "active",
        generation: 1,
        invitedBy: f.ownerId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    const shared = { ...f.first, id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`) };
    await tabs.record(f.groupId, [shared], []);
    await tabs.close(f.strangerId, shared.id);
    await expect(tabs.reopen(f.ownerId, allowReopen)).rejects.toMatchObject({ code: "not_found" });
    expect((await tabs.reopen(f.strangerId, allowReopen)).title).toBe("One");
    await tabs.close(f.ownerId, f.first.id, false);
    await tabs.record(f.groupId, [], [f.second.id]);
    await expect(tabs.reopen(f.ownerId, allowReopen)).rejects.toMatchObject({ code: "not_found" });
    const third = { ...f.first, id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`) };
    await tabs.record(f.groupId, [third], []);
    await tabs.close(f.ownerId, third.id);
    await expect(tabs.reopen(f.strangerId, allowReopen)).rejects.toMatchObject({
      code: "not_found",
    });
    await database
      .updateTable("workspaceTabs")
      .set({ closedAt: new Date(Date.now() - browserTabOpenReplayWindowMs - 1000) })
      .where("id", "=", third.id)
      .execute();
    await tabs.prune();
    expect(
      await database
        .selectFrom("workspaceTabs")
        .select("id")
        .where("id", "=", third.id)
        .executeTakeFirst(),
    ).toBeDefined();
    await expect(tabs.reopen(f.ownerId, allowReopen)).rejects.toMatchObject({ code: "not_found" });
    const fourth = { ...third, id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`) };
    await tabs.record(f.groupId, [fourth], []);
    await tabs.closeLineage(f.groupId);
    await expect(tabs.reopen(f.ownerId, allowReopen)).rejects.toMatchObject({ code: "not_found" });
  });
  it("does not consume refused access or a close at the 64-tab bound", async ({ storeFixture }) => {
    const { fixture, tabs, allowReopen } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first], []);
    await tabs.close(f.ownerId, f.first.id);
    await expect(
      tabs.reopen(f.ownerId, async () => {
        throw new Error("Access refused");
      }),
    ).rejects.toThrow("Access refused");
    const full = Array.from({ length: 64 }, () => ({
      ...f.second,
      id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
    }));
    await tabs.record(f.groupId, full, []);
    await expect(tabs.reopen(f.ownerId, allowReopen)).rejects.toMatchObject({
      message: "Browser tab limit reached.",
    });
    await tabs.close(f.ownerId, full[0]!.id, false);
    const reopened = await tabs.reopen(f.ownerId, allowReopen);
    expect(reopened.title).toBe("One");
    expect((await tabs.read(f.ownerId, f.groupId))?.tabs).toHaveLength(64);
  });
  it("refuses a full surviving group without consuming its close", async ({ storeFixture }) => {
    const { fixture, database, store, tabs, allowReopen } = storeFixture;
    const f = await fixture();
    const groups = new BrowserTabGroupStore(database);
    const descriptors = Array.from({ length: 501 }, () => ({
      ...f.first,
      id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
    }));
    for (let offset = 0; offset < descriptors.length; offset += 64) {
      const id = offset === 0 ? f.groupId : createBrowserSessionId();
      if (offset) await store.createBrowserSession({ ...f.session, id });
      await database
        .insertInto("workspaceTabs")
        .values(
          descriptors.slice(offset, offset + 64).map((tab, order) => ({
            ...tab,
            order,
            groupId: id,
            sessionId: id,
            state: "suspended" as const,
            closedAt: null,
            createdAt: new Date(),
          })),
        )
        .execute();
    }
    const grouped = await groups.group(f.ownerId, {
      tabIds: [descriptors[0]!.id],
      idempotencyKey: randomUUID(),
    });
    await database
      .insertInto("browserTabGroupMembers")
      .values(
        descriptors
          .slice(1, 500)
          .map((tab) => ({ ownerId: f.ownerId, tabId: tab.id, groupId: grouped.groupId })),
      )
      .execute();
    await tabs.close(f.ownerId, descriptors[0]!.id);
    await database
      .insertInto("browserTabGroupMembers")
      .values({ ownerId: f.ownerId, tabId: descriptors[500]!.id, groupId: grouped.groupId })
      .execute();
    await expect(tabs.reopen(f.ownerId, allowReopen)).rejects.toMatchObject({
      message: "A tab group can keep at most 500 tabs.",
    });
    await groups.ungroup(f.ownerId, { tabIds: [descriptors[1]!.id], idempotencyKey: randomUUID() });
    const reopened = await tabs.reopen(f.ownerId, allowReopen);
    expect((await groups.layout(f.ownerId)).groups[0]?.tabIds).toHaveLength(500);
    cascadeEvidence.push({ fullGroupReopened: reopened.id });
  });
  it("keeps close-during-activation fenced when its successor is reopened", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, store, allowReopen } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first, f.second], []);
    await tabs.suspend(f.groupId);
    const replacement = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id: replacement, tabGroupId: f.groupId });
    await tabs.bind(f.groupId, replacement, f.first.id);
    await tabs.close(f.ownerId, f.first.id);
    const reopened = await tabs.reopen(f.ownerId, allowReopen);
    await tabs.record(replacement, [{ ...f.first, title: "Late activation" }], []);
    expect(await tabs.get(f.ownerId, f.first.id)).toBeNull();
    expect(await tabs.get(f.ownerId, reopened.id)).toMatchObject({
      title: "One",
      state: "suspended",
      sessionId: replacement,
    });
  });
  it("restores personal position and surviving group after reorder and layout pruning", async ({
    storeFixture,
  }) => {
    const { fixture, tabs, database, allowReopen } = storeFixture;
    const f = await fixture();
    const third = {
      ...f.first,
      id: BrowserSurfaceIdSchema.parse(`surface_${randomUUID()}`),
      order: 2,
      openerId: null,
    };
    await tabs.record(f.groupId, [f.first, f.second, third], []);
    const groups = new BrowserTabGroupStore(database);
    const grouped = await groups.group(f.ownerId, {
      tabIds: [f.first.id, f.second.id],
      idempotencyKey: randomUUID(),
    });
    await tabs.close(f.ownerId, f.second.id);
    await groups.move(f.ownerId, {
      item: { tabIds: [third.id] },
      to: { groupId: null, before: { groupId: grouped.groupId } },
      idempotencyKey: randomUUID(),
    });
    const reopened = await tabs.reopen(f.ownerId, allowReopen);
    let layout = await groups.layout(f.ownerId);
    expect(layout.order).toEqual([third.id, f.first.id, reopened.id]);
    expect(layout.groups[0]?.tabIds).toContain(reopened.id);
    await tabs.close(f.ownerId, reopened.id);
    await groups.ungroup(f.ownerId, { tabIds: [f.first.id], idempotencyKey: randomUUID() });
    expect((await groups.layout(f.ownerId)).groups).toEqual([]);
    await database.deleteFrom("browserTabLayouts").where("ownerId", "=", f.ownerId).execute();
    const again = await tabs.reopen(f.ownerId, allowReopen);
    layout = await groups.layout(f.ownerId);
    expect(layout.groups).toEqual([]);
    expect(layout.order!.indexOf(BrowserSurfaceIdSchema.parse(again.id))).toBe(
      layout.order!.indexOf(f.first.id) + 1,
    );
    cascadeEvidence.push({ afterGroupDeletionAndPruning: layout });
  });
  it("serializes a close during reopen using tab-before-layout locks", async ({ storeFixture }) => {
    const { fixture, tabs, database, allowReopen } = storeFixture;
    const f = await fixture();
    await tabs.record(f.groupId, [f.first, f.second], []);
    await tabs.close(f.ownerId, f.first.id);
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const reopening = tabs.reopen(f.ownerId, async () => {
      reached();
      await held;
    });
    let closing: Promise<unknown> | undefined;
    try {
      await entered;
      closing = tabs.close(f.ownerId, f.second.id);
      await expect
        .poll(
          async () =>
            (
              await sql<{ query: string }>`select query from pg_stat_activity
        where datname=current_database() and application_name='workspace-tabs-test'
        and wait_event_type='Lock' and query like '%browser_sessions%'`.execute(database)
            ).rows.length,
        )
        .toBe(1);
    } finally {
      release();
    }
    const [reopened] = await Promise.all([reopening, closing]);
    expect(reopened.title).toBe("One");
    expect((await tabs.reopen(f.ownerId, allowReopen)).title).toBe("Popup");
    cascadeEvidence.push({ closeDuringReopen: reopened.id });
  });
  it("does not persist automation sessions", async ({ storeFixture }) => {
    const { fixture, store, tabs } = storeFixture;
    const f = await fixture();
    const id = createBrowserSessionId();
    await store.createBrowserSession({ ...f.session, id, origin: "trigger" });
    expect(await tabs.record(id, [f.first], [])).toBe(false);
    expect(await tabs.list(f.ownerId)).toEqual([]);
  });
});
