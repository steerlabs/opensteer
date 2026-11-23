import { RunnerIdSchema } from "@opensteer/core";
import { DeviceIdSchema } from "@opensteer/core";
import {
  createId,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  TabGroupIdSchema,
  TabIdSchema,
  WindowIdSchema,
  type TabLayout,
} from "@opensteer/core";
import type { ComputerView } from "@opensteer/protocol";
import type { TabAuthorization, TabRecord, TabStore } from "@opensteer/database";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NativeTabTargetsPort, NativeTargetAcquiredHandler, TabActor } from "./ports.js";
import { TabService, type TabServiceOptions } from "./tab-service.js";

const ownerId = createId("user"),
  computerId = createId("runner"),
  taskId = createId("thread"),
  hiddenTask = createId("thread");
const tabId = () => TabIdSchema.parse(`tab_${randomUUID()}`);
const actor: TabActor = { kind: "person", ownerId };
function row(kind: "phone" | "window" = "phone"): TabRecord {
  return {
    id: tabId(),
    kind,
    ownerId,
    computerId: DeviceIdSchema.parse(computerId),
    title: kind,
    openedBy: { taskId },
    generation: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
    closedPosition: null,
    pageBinding: null,
    url: null,
    profileId: null,
    profileName: null,
    appId: null,
    windowId: kind === "window" ? WindowIdSchema.parse(`win_${randomUUID()}`) : null,
    windowApp:
      kind === "window" ? { bundleId: "test.app", displayName: "Test", teamId: null } : null,
    favicon: null,
    iconRef: null,
    openerTabId: null,
  };
}
function fixture(rows: TabRecord[]) {
  let layout: TabLayout = {
    revision: 1,
    items: rows.map((row) => ({ kind: "tab", tabId: row.id })),
  };
  let acquired: NativeTargetAcquiredHandler | undefined;
  const unavailable = async () => {
    throw new Error("Unexpected native action");
  };
  const native: NativeTabTargetsPort = {
    resolveWindow: unavailable,
    windowState: async () => ({
      state: "asleep",
      usedBy: [{ taskId }, { taskId: hiddenTask }, { taskId }],
    }),
    phoneState: async () => ({ state: "asleep", usedBy: [{ taskId }] }),
    openOwnerView: unavailable,
    closeOwnerViews: async () => {},
    onTargetAcquired: (handler) => {
      acquired = handler;
      return () => {
        acquired = undefined;
      };
    },
  };
  const store = {
    database: {} as TabStore["database"],
    snapshot: async () => ({
      rows: rows.filter((row) => !row.closedAt),
      layout: structuredClone(layout),
    }),
    rows: async (_owner: unknown, ids: string[]) =>
      rows
        .filter((row) => ids.includes(row.id) && !row.closedAt)
        .map((row) => structuredClone(row)),
    get: async (_owner: unknown, id: unknown) =>
      structuredClone(rows.find((row) => row.id === id && !row.closedAt) ?? null),
  } as unknown as TabStore;
  const options: TabServiceOptions = {
    store,
    devices: {
      requireSelfDeviceId: async (id) => DeviceIdSchema.parse(id),
      requireDeviceSelfRunnerId: async (id) => RunnerIdSchema.parse(id),
    },
    nativeTargets: native,
    apps: { get: unavailable },
    pages: {
      open: unavailable,
      activate: unavailable,
      bind: unavailable,
      closeViewers: async () => {},
      state: async () => ({ state: "asleep", usedBy: [] }),
    },
    computer: async () => ({ name: "Computer", connected: true, removed: false }),
    canRead: async () => true,
    canReadTask: async (_actor, id) => id !== hiddenTask,
    authorize: async () => {},
    authorizeMembership: async () => {},
    onError: (error) => {
      throw error;
    },
  };
  const service = new TabService(options);
  return {
    service,
    options,
    native,
    acquired: () => acquired,
    setLayout: (next: TabLayout) => {
      layout = next;
    },
  };
}
describe("tab projection and viewer admission", () => {
  it("requests a physical close only for direct work and keeps a Run's page in the same lineage", async () => {
    const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    const page = (id: typeof taskId): TabRecord => ({
      ...row(),
      kind: "page",
      openedBy: { taskId: id },
      pageBinding: {
        lineageId: sessionId,
        sessionId,
        surfaceId: BrowserSurfaceIdSchema.parse(`bsf_${randomUUID()}`),
      },
    });
    const direct = page(taskId),
      run = page(hiddenTask);
    const f = fixture([direct, run]);
    const originConnectionId = randomUUID();
    const closes = vi.spyOn(f.options.pages, "closeViewers");
    const selectFrom = vi.fn(() => {
      const where = vi.fn((_column: string, _op: string, value: string) => {
        return {
          where: () => ({
            executeTakeFirst: async () => ({
              originConnectionId,
              worker: value === taskId ? "external" : "native",
            }),
          }),
        };
      });
      return { select: () => ({ where }) };
    });
    f.options.store.close = async (_owner, ids, _key, authorize, include) => {
      const rows = [direct, run];
      const layout: TabLayout = { revision: 2, items: [] };
      await authorize?.({ selectFrom } as unknown as Parameters<TabAuthorization>[0], rows, layout);
      const closed = rows.filter((row) => ids.includes(row.id) && (!include || include(row)));
      for (const row of closed) row.closedAt = new Date();
      return { tabIds: closed.map(({ id }) => id), layout };
    };
    try {
      expect(await f.service.close(actor, [direct.id, run.id], "same-lineage-close")).toEqual({
        closed: [direct.id, run.id],
        failed: [],
      });
      expect(closes.mock.calls).toEqual([
        [ownerId, direct, true],
        [ownerId, run, false],
      ]);
    } finally {
      f.service.dispose();
    }
  });

  it("hides the entire partial-reach group and unauthorized holders without hiding offline tabs", async () => {
    const a = row("window"),
      b = row();
    const f = fixture([a, b]);
    f.setLayout({
      revision: 5,
      items: [
        {
          kind: "group",
          group: {
            groupId: TabGroupIdSchema.parse(`tgp_${randomUUID()}`),
            name: "Private",
            color: "blue",
            collapsed: false,
            tabIds: [a.id, b.id],
          },
        },
      ],
    });
    f.options.canRead = async (_actor, tab) => tab.id !== b.id;
    const visible = await f.service.list(actor, {});
    expect(visible.groups).toEqual([]);
    expect(visible.tabs).toMatchObject([
      { tabId: a.id, groupId: null, state: "asleep", usedBy: [{ taskId }] },
    ]);
    f.options.computer = async (_owner, id) => ({
      name: "Computer",
      connected: id !== a.computerId,
      removed: false,
    });
    f.service.changed(ownerId);
    expect((await f.service.list(actor, {})).tabs[0]).toMatchObject({
      tabId: a.id,
      state: "unavailable",
      unavailableCode: "computer-offline",
      openedBy: { taskId },
    });
    f.service.dispose();
  });
  it("refuses a late owner-view reply after close/reopen and cleans only that old viewer generation", async () => {
    const a = row("window"),
      f = fixture([a]);
    let finish!: (value: ComputerView) => void;
    const started = Promise.withResolvers<void>();
    f.native.openOwnerView = async () => {
      started.resolve();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const close = vi.spyOn(f.native, "closeOwnerViews");
    const activation = f.service.activate(ownerId, a.id, "view");
    await withTimeout(started.promise, 1000, {
      timeoutError: () => new Error("Owner view did not start"),
    });
    a.generation = 3;
    finish({} as ComputerView);
    await expect(activation).rejects.toMatchObject({ code: "conflict" });
    expect(close).toHaveBeenCalledWith(ownerId, a.id, 1);
    f.service.dispose();
  });
  it("projects an ordered bounded prefix and refreshes changed tab state", async () => {
    const a = row(),
      b = row("window"),
      f = fixture([a, b]);
    b.computerId = DeviceIdSchema.parse(createId("runner"));
    const full = await f.service.bootstrap(ownerId, 65536);
    const prefix = await f.service.bootstrap(
      ownerId,
      Buffer.byteLength(JSON.stringify({ ...full, tabs: [full.tabs[0]], complete: false })),
    );
    expect(prefix.tabs.map((tab) => tab.tabId)).toEqual([a.id]);
    expect(prefix.complete).toBe(false);
    a.title = "New title";
    f.service.changed(ownerId);
    const updated = await f.service.project(actor);
    expect(updated.tabs).toMatchObject([{ tabId: a.id, title: "New title" }, { tabId: b.id }]);
    expect(updated.layout).toEqual(full.layout);
    f.options.computer = async (_owner, id) => ({
      name: "Computer",
      connected: id !== a.computerId,
      removed: false,
    });
    f.service.changed(ownerId);
    expect((await f.service.project(actor)).tabs[0]).toMatchObject({
      state: "unavailable",
      unavailableCode: "computer-offline",
    });
    f.options.computer = async () => ({ name: "Computer", connected: true, removed: false });
    f.service.changed(ownerId);
    const online = (await f.service.project(actor)).tabs[0];
    expect(online).toMatchObject({ state: "asleep" });
    expect(online).not.toHaveProperty("unavailableCode");
    f.service.dispose();
  });
});

it("keeps unrelated tabs listable while an app is deleting or missing", async () => {
  const ordinary = row(),
    app = { ...row(), kind: "app" as const, appId: `app_${randomUUID()}` };
  const f = fixture([ordinary, app]);
  const { OpensteerError } = await import("@opensteer/core");
  f.options.apps.get = async () => {
    throw new OpensteerError({ code: "not_found", message: "App not found" });
  };
  const listed = await f.service.list(actor, {});
  expect(listed.tabs).toMatchObject([
    { tabId: ordinary.id },
    { tabId: app.id, state: "unavailable", unavailableCode: "app-failed" },
  ]);
  ordinary.title = "Still available";
  f.service.changed(ownerId, [ordinary.id]);
  expect((await f.service.project(actor)).tabs).toMatchObject([
    { tabId: ordinary.id, title: "Still available" },
    { tabId: app.id, state: "unavailable", unavailableCode: "app-failed" },
  ]);
  f.service.dispose();
});

it("shares one owner read and refreshes only the changed binding for two devices", async () => {
  const rows = Array.from({ length: 80 }, () => row("window")),
    f = fixture(rows);
  const reads = vi.spyOn(f.options.store, "snapshot"),
    windows = vi.spyOn(f.native, "windowState"),
    computers = vi.spyOn(f.options, "computer"),
    tasks = vi.spyOn(f.options, "canReadTask");
  await Promise.all([f.service.project(actor), f.service.project(actor)]);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(windows).toHaveBeenCalledTimes(80);
  await f.service.bootstrap(ownerId, 240 * 1024);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(windows).toHaveBeenCalledTimes(80);
  reads.mockClear();
  windows.mockClear();
  computers.mockClear();
  tasks.mockClear();
  rows[0]!.title = "Changed";
  f.service.changed(ownerId, [rows[0]!.id]);
  const projections = await Promise.all([f.service.project(actor), f.service.project(actor)]);
  for (const projection of projections) expect(projection.tabs[0]?.title).toBe("Changed");
  expect({
    databaseSnapshots: reads.mock.calls.length,
    nativeRPCs: windows.mock.calls.length,
    computerReads: computers.mock.calls.length,
    taskReads: tasks.mock.calls.length,
  }).toEqual({ databaseSnapshots: 0, nativeRPCs: 1, computerReads: 1, taskReads: 2 });
  f.service.dispose();
});

it("projects only the opened ungrouped tab for a Run actor without scanning unrelated tabs", async () => {
  const existing = Array.from({ length: 12 }, () => row("window"));
  const f = fixture(existing);
  const runActor: TabActor = {
    kind: "run",
    claims: {
      aud: "opensteer-run-tools",
      iss: "opensteer-host",
      iat: 1,
      exp: 9_999_999_999,
      jti: "jti-1",
      runId: createId("run"),
      threadId: taskId,
      environmentId: createId("environment"),
      requestedBy: ownerId,
      runnerId: computerId,
      runnerBootId: "boot-1",
      bindingGeneration: 1,
      grantId: createId("grant"),
    },
  };
  let openedRow: TabRecord | undefined;
  f.options.pages.open = async (_actor, target) => ({
    id: tabId(),
    ownerId,
    kind: "page",
    computerId: DeviceIdSchema.parse(computerId),
    title: "Opened",
    url: target.url ?? null,
    openedBy: { taskId },
    pageBinding: {
      lineageId: BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`),
      sessionId: BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`),
      surfaceId: BrowserSurfaceIdSchema.parse(`bsf_${randomUUID()}`),
    },
  });
  f.options.store.open = async (write) => {
    const created: TabRecord = {
      ...row("phone"),
      id: write.id,
      kind: "page",
      title: write.title,
      url: write.kind === "page" ? (write.url ?? null) : null,
      openedBy: write.openedBy,
      pageBinding: write.kind === "page" ? (write.pageBinding ?? null) : null,
    };
    openedRow = created;
    existing.push(created);
    const layout: TabLayout = {
      revision: 2,
      items: existing.map((item) => ({ kind: "tab", tabId: item.id })),
    };
    f.setLayout(layout);
    return { tab: created, tabIds: [created.id], layout };
  };
  const snapshots = vi.spyOn(f.options.store, "snapshot");
  const windows = vi.spyOn(f.native, "windowState");
  const pageStates = vi.spyOn(f.options.pages, "state");

  const opened = await f.service.open(
    runActor,
    { kind: "page", guest: true, url: "https://example.test/" },
    "run-open-key",
    1,
  );
  expect(opened.tab.tabId).toBe(openedRow!.id);
  expect(snapshots).not.toHaveBeenCalled();
  expect(windows).not.toHaveBeenCalled();
  expect(pageStates).toHaveBeenCalledTimes(1);
  f.service.dispose();
});
