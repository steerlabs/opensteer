import { DeviceIdSchema } from "@opensteer/core";
import { TabIdSchema, WindowIdSchema } from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";
import { personalFixtureOwner } from "./personal-run-fixture.test-support.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";
import { OpensteerStore } from "./store.js";
import { TabStore, tabLayoutIds, type TabWrite } from "./tab-store.js";

// The integration launcher supplies an isolated PostgreSQL database.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
const id = () => TabIdSchema.parse(`tab_${randomUUID()}`);
integration("workspace tabs", () => {
  async function fixture() {
    const clone = await cloneTestDatabase("host");
    const { legacy, database } = await ownTestDatabaseProducer(clone.url, async () => {
      const legacy = createDatabase({ connectionString: clone.url });
      const database = createDatabase<DatabaseSchema>({ connectionString: clone.url });
      return {
        legacy,
        database,
        close: async () => {
          await database.destroy();
          await legacy.destroy();
        },
      };
    });
    const { userId: ownerId } = await personalFixtureOwner(legacy, clone.url);
    const settings = await database
      .selectFrom("personalSettings")
      .select("agentHomeComputerId")
      .executeTakeFirstOrThrow();
    const computerId = settings.agentHomeComputerId;
    const tabs = new TabStore(database);
    const write = (kind: "phone" | "app" | "window", extra: Partial<TabWrite> = {}): TabWrite => ({
      id: id(),
      ownerId,
      computerId: DeviceIdSchema.parse(computerId),
      kind,
      title: kind,
      openedBy: "person",
      ...extra,
    });
    return { database, legacy, ownerId, computerId, tabs, write };
  }
  it("keeps one mixed layout and singleton identity across concurrent opens, close, replay and reopen", async () => {
    const { tabs, write, ownerId, database } = await fixture();
    const phone = write("phone", {
        id: TabIdSchema.parse("tab_00000000-0000-4000-8000-000000000000"),
      }),
      app = write("app", { appId: `app_${randomUUID()}` });
    const window = write("window", {
      windowId: WindowIdSchema.parse(`win_${randomUUID()}`),
      windowApp: { bundleId: "test.app", displayName: "Test", teamId: null },
    });
    const results = await Promise.all([
      tabs.open(phone, "phone-a"),
      tabs.open({ ...phone, id: id() }, "phone-b"),
      tabs.open(app, "app"),
      tabs.open(window, "window"),
    ]);
    expect(results[0]!.tabIds).toEqual(results[1]!.tabIds);
    // Either concurrent open may win, and its id becomes the phone's.
    const phoneId = results[0]!.tabIds[0]!;
    const ids = [phoneId, app.id, window.id];
    const grouped = await tabs.organize(
      ownerId,
      { tabIds: ids, group: { name: "Work", color: "blue" } },
      "group",
    );
    expect(tabLayoutIds(grouped.layout)).toEqual(ids);
    const group = grouped.layout.items[0]!;
    expect(group.kind).toBe("group");
    const first = await tabs.resourceTabs(database, ownerId, { limit: 2 });
    const next = await tabs.resourceTabs(database, ownerId, { limit: 2, after: first[1]!.id });
    expect([...first, ...next].map(({ id }) => id)).toEqual([...ids].sort());
    expect(await tabs.resourceLayout(database, ownerId, { after: 0, limit: 1 })).toEqual({
      revision: grouped.layout.revision,
      entries: [{ item: group, ordinal: 1 }],
    });
    expect(await tabs.resourceLayout(database, ownerId, { after: 1, limit: 1 })).toEqual({
      revision: grouped.layout.revision,
      entries: [],
    });
    expect([...(await tabs.resourceTabGroups(database, ownerId, [phoneId]))]).toEqual([
      [phoneId, group.kind === "group" ? group.group.groupId : null],
    ]);
    await tabs.close(ownerId, [app.id], "close");
    await expect(
      tabs.open(app, "late-open", undefined, app, grouped.layout.revision),
    ).rejects.toMatchObject({ code: "conflict" });
    const closed = await tabs.get(ownerId, app.id, true);
    expect(closed).toMatchObject({ generation: 2, closedPosition: { beforeTabId: window.id } });
    await tabs.open(app, "app");
    expect(await tabs.get(ownerId, app.id)).toBeNull();
    const reopened = await tabs.reopen(ownerId, app.id, "reopen");
    expect(tabLayoutIds(reopened.layout)).toEqual(ids);
    expect(await tabs.get(ownerId, app.id)).toMatchObject({ id: app.id, generation: 3 });
    await tabs.close(ownerId, [phoneId], "close-phone");
    expect((await tabs.open({ ...phone, id: id() }, "reopen-phone")).tabIds).toEqual([phoneId]);
    expect(await tabs.get(ownerId, phoneId)).toMatchObject({ generation: 3 });
    expect((await tabs.snapshot(ownerId)).rows).toHaveLength(3);
  });
  it("moves whole groups, rejects stale anchors atomically, retains empty groups and dissolves in place", async () => {
    const { tabs, write, ownerId } = await fixture();
    const a = write("app", { appId: `app_${randomUUID()}` }),
      b = write("phone"),
      c = write("app", { appId: `app_${randomUUID()}` });
    await tabs.open(a, "a");
    await tabs.open(b, "b");
    await tabs.open(c, "c");
    const grouped = await tabs.organize(
      ownerId,
      { tabIds: [a.id, b.id], group: { name: "Mixed", color: "green" } },
      "group",
    );
    const item = grouped.layout.items[0]!;
    if (item.kind !== "group") throw new Error("Mixed group missing");
    const before = await tabs.snapshot(ownerId);
    await expect(
      tabs.organize(
        ownerId,
        { tabIds: [a.id], group: { groupId: item.group.groupId }, beforeTabId: c.id },
        "invalid",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await tabs.snapshot(ownerId)).toEqual(before);
    await tabs.organize(
      ownerId,
      { tabIds: [b.id, a.id], group: { groupId: item.group.groupId }, beforeTabId: c.id },
      "move",
    );
    await tabs.close(ownerId, [a.id, b.id], "close");
    expect((await tabs.snapshot(ownerId)).layout.items[0]).toMatchObject({
      kind: "group",
      group: { tabIds: [] },
    });
    await tabs.deleteGroup(ownerId, item.group.groupId, "delete");
    await tabs.reopen(ownerId, a.id, "reopen");
    expect(tabLayoutIds((await tabs.snapshot(ownerId)).layout)).toEqual([c.id, a.id]);
  });
  it("inserts roots at a group's first-member boundary and appends whole group blocks without an anchor", async () => {
    const { tabs, write, ownerId } = await fixture();
    const [a, b, c, d] = Array.from({ length: 4 }, () =>
      write("app", { appId: `app_${randomUUID()}` }),
    );
    for (const row of [a!, b!, c!, d!]) await tabs.open(row, row.id);
    const grouped = await tabs.organize(
      ownerId,
      { tabIds: [b!.id, c!.id], group: { name: "Block", color: "blue" } },
      "block",
    );
    const group = grouped.layout.items[1]!;
    if (group.kind !== "group") throw new Error("Block missing");
    const moved = await tabs.organize(
      ownerId,
      { tabIds: [d!.id], group: null, beforeTabId: b!.id },
      "root-before-group",
    );
    expect(moved.layout.items).toEqual([
      { kind: "tab", tabId: a!.id },
      { kind: "tab", tabId: d!.id },
      group,
    ]);
    await expect(
      tabs.organize(
        ownerId,
        { tabIds: [a!.id], group: null, beforeTabId: c!.id },
        "root-inside-group",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await tabs.organize(
      ownerId,
      { tabIds: [b!.id, c!.id], group: { groupId: group.group.groupId }, beforeTabId: a!.id },
      "group-first",
    );
    const appended = await tabs.organize(
      ownerId,
      { tabIds: [b!.id, c!.id], group: { groupId: group.group.groupId } },
      "group-last",
    );
    expect(appended.layout.items).toEqual(moved.layout.items);
    await tabs.close(ownerId, [b!.id, c!.id], "empty-group");
    const rootEnd = await tabs.organize(
      ownerId,
      { tabIds: [a!.id], group: null },
      "append-after-empty-group",
    );
    expect(rootEnd.layout.items).toMatchObject([
      { kind: "tab", tabId: d!.id },
      { kind: "group", group: { tabIds: [] } },
      { kind: "tab", tabId: a!.id },
    ]);
  });
  it("moves a group's first tab out to just before its own group", async () => {
    const { tabs, write, ownerId } = await fixture();
    const [a, b, c] = Array.from({ length: 3 }, () =>
      write("app", { appId: `app_${randomUUID()}` }),
    );
    for (const row of [a!, b!, c!]) await tabs.open(row, row.id);
    const grouped = await tabs.organize(
      ownerId,
      { tabIds: [b!.id, c!.id], group: { name: "Block", color: "blue" } },
      "block",
    );
    const group = grouped.layout.items[1]!;
    if (group.kind !== "group") throw new Error("Block missing");
    // The group's place is named by its first member that stays, as the UI sends it.
    const out = await tabs.organize(
      ownerId,
      { tabIds: [b!.id], group: null, beforeTabId: c!.id },
      "first-out",
    );
    expect(out.layout.items).toEqual([
      { kind: "tab", tabId: a!.id },
      { kind: "tab", tabId: b!.id },
      { kind: "group", group: { ...group.group, tabIds: [c!.id] } },
    ]);
  });
  it("fences per-tab session descriptors, preserves restore URLs and never resurrects closed pages or automation", async () => {
    const { tabs, legacy, database, ownerId, computerId } = await fixture();
    const store = new OpensteerStore(legacy),
      sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      runnerId: computerId,
      ownerId,
      origin: "agent",
      opener: { kind: "person", userId: ownerId },
      placementKey: "test",
      profileId: null,
      runtimeId: "test",
    });
    // The database clock can be ahead of the Host clock, especially in a VM.
    await database
      .updateTable("browserSessions")
      .set({ createdAt: new Date("2100-01-01T00:00:00.000Z") })
      .where("id", "=", sessionId)
      .execute();
    const tabId = id(),
      binding = { lineageId: sessionId, sessionId, surfaceId: tabId };
    const page: TabWrite = {
      id: tabId,
      ownerId,
      computerId: DeviceIdSchema.parse(computerId),
      kind: "page",
      title: "Saved",
      url: `https://example.com/saved?query=${"a".repeat(12000)}`,
      favicon:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=",
      pageBinding: binding,
      openedBy: "person",
    };
    await tabs.open(page, "open");
    expect(
      await tabs.updatePage(
        ownerId,
        tabId,
        1,
        binding,
        { title: "Blank", url: "about:blank" },
        true,
      ),
    ).toBe(false);
    expect((await tabs.get(ownerId, tabId))?.url).toBe(page.url);
    const iconRef = (await tabs.get(ownerId, tabId))?.iconRef;
    expect(
      await tabs.updatePage(ownerId, tabId, 1, binding, { title: "Changed title", url: page.url! }),
    ).toBe(true);
    expect((await tabs.get(ownerId, tabId))?.iconRef).toBe(iconRef);
    await expect(
      tabs.updatePage(ownerId, tabId, 1, binding, {
        title: "Invalid icon",
        url: page.url!,
        favicon: "https://example.com/icon.png",
      }),
    ).rejects.toThrow();
    const strangerId = await store.createUser("Stranger");
    expect(await tabs.get(strangerId, tabId)).toBeNull();
    const later = createBrowserSessionId();
    await store.createBrowserSession({
      id: later,
      tabGroupId: sessionId,
      runnerId: computerId,
      ownerId,
      origin: "agent",
      opener: { kind: "person", userId: ownerId },
      placementKey: "test",
      profileId: null,
      runtimeId: "test",
    });
    await database
      .updateTable("browserSessions")
      .set({
        createdAt: sql<Date>`(select created_at + interval '1 second' from browser_sessions where id = ${sessionId})`,
      })
      .where("id", "=", later)
      .execute();
    expect(
      await tabs.updatePage(ownerId, tabId, 1, binding, {
        title: "Stale",
        url: "https://example.com/stale",
      }),
    ).toBe(true);
    const next = { ...binding, sessionId: later };
    expect(await tabs.bindPage(ownerId, tabId, 1, binding, next)).toBe(true);
    expect(
      await tabs.updatePage(ownerId, tabId, 1, binding, {
        title: "Retired",
        url: "https://example.com/retired",
      }),
    ).toBe(false);
    await tabs.close(ownerId, [tabId], "close");
    expect(
      await tabs.updatePage(ownerId, tabId, 1, next, {
        title: "Late",
        url: "https://example.com/late",
      }),
    ).toBe(false);
    expect(await tabs.bindPage(ownerId, tabId, 1, next, next)).toBe(false);
    const automation = createBrowserSessionId();
    await store.createBrowserSession({
      id: automation,
      runnerId: computerId,
      ownerId,
      origin: "trigger",
      opener: { kind: "automation" },
      placementKey: "test",
      profileId: null,
      runtimeId: "test",
    });
    const automationTab = id();
    await expect(
      tabs.open(
        {
          ...page,
          id: automationTab,
          pageBinding: { lineageId: automation, sessionId: automation, surfaceId: automationTab },
        },
        "automation",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await tabs.snapshot(ownerId)).rows).toEqual([]);
  });
  it("removes open and closed app records inside the app deletion transaction without disturbing other kinds", async () => {
    const { tabs, database, ownerId, write } = await fixture();
    const app = write("app", {
        id: TabIdSchema.parse("tab_00000000-0000-4000-8000-000000000000"),
        appId: `app_${randomUUID()}`,
      }),
      phone = write("phone", {
        id: TabIdSchema.parse("tab_ffffffff-ffff-4fff-bfff-ffffffffffff"),
      });
    await tabs.open(app, "app");
    await tabs.open(phone, "phone");
    await tabs.close(ownerId, [app.id], "close");
    const { commitPersonalMutation } = await import("./personal-mutation.js");
    await commitPersonalMutation(database, (tx) => tabs.removeTabs(tx, app.appId!));
    expect(await tabs.get(ownerId, app.id, true)).toBeNull();
    expect(tabLayoutIds((await tabs.snapshot(ownerId)).layout)).toEqual([phone.id]);
  });
  it("rolls back opens and new groups at the shared workspace caps", async () => {
    const { tabs, database, ownerId, computerId, write } = await fixture();
    const ids = Array.from({ length: 1000 }, () => id());
    await sql`insert into personal_tabs(id,owner_id,kind,computer_id,title,app_id,opened_by)
      select value->>'id',${ownerId},'app',${computerId},'App',value->>'appId','"person"'::jsonb
      from jsonb_array_elements(${JSON.stringify(ids.map((id) => ({ id, appId: `app_${randomUUID()}` })))}::jsonb) value`.execute(
      database,
    );
    const groups = Array.from({ length: 200 }, (_, index) => ({
      kind: "group",
      group: {
        groupId: `tgp_${randomUUID()}`,
        name: `Group ${index}`,
        color: "blue",
        collapsed: false,
        tabIds: [],
      },
    }));
    const items = [...groups, ...ids.map((tabId) => ({ kind: "tab", tabId }))];
    await database
      .insertInto("tabLayouts")
      .values({ ownerId, revision: 1, items: sql`${JSON.stringify(items)}::jsonb` })
      .execute();
    const phone = write("phone");
    await expect(tabs.open(phone, "overflow")).rejects.toMatchObject({ code: "conflict" });
    expect(await tabs.get(ownerId, phone.id)).toBeNull();
    await expect(
      tabs.organize(
        ownerId,
        { tabIds: [ids[0]!], group: { name: "Overflow", color: "red" } },
        "group-overflow",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const snapshot = await tabs.snapshot(ownerId);
    expect(snapshot.rows).toHaveLength(1000);
    expect(snapshot.layout).toEqual({ revision: 1, items });
  });
});
