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
  it("opens the app's current window in the same tab when its own window is gone", async () => {
    const a = { ...row("window"), openedBy: "person" as const },
      f = fixture([a]);
    const dead = a.windowId!,
      next = WindowIdSchema.parse(`win_${randomUUID()}`);
    const view = (windowId: typeof next, state: "ready" | "unavailable") =>
      ({
        viewId: "cvw_test",
        generation: 1,
        state,
        unavailableReason: state === "ready" ? null : "window-closed",
        target: { kind: "app", app: a.windowApp, windowId },
      }) as unknown as ComputerView;
    const opened: string[] = [];
    f.native.openOwnerView = vi.fn(async (_owner, input) => {
      const windowId = (input.target as { windowId: typeof next }).windowId;
      opened.push(windowId);
      return view(windowId, windowId === dead ? "unavailable" : "ready");
    });
    f.native.currentWindow = vi.fn(async () => ({
      windowId: next,
      app: a.windowApp!,
      appName: "Test",
      bundleId: "test.app",
      title: "After relaunch",
    }));
    const byBundle = vi.spyOn(f.native, "resolveWindow");
    const rebindWindow = vi.fn(
      async (
        _owner: unknown,
        id: unknown,
        generation: number,
        from: unknown,
        to: { windowId: typeof next; title: string },
      ) => {
        if (id !== a.id || generation !== a.generation || from !== a.windowId) return null;
        a.windowId = to.windowId;
        a.title = to.title;
        return structuredClone(a);
      },
    );
    (f.options.store as unknown as Record<string, unknown>).rebindWindow = rebindWindow;

    const activated = await f.service.activate(ownerId, a.id, "open-again");

    // Found from the app's own window list, never resolved by bundle (which launches the app).
    expect(f.native.currentWindow).toHaveBeenCalledWith(ownerId, computerId, a.windowApp);
    expect(byBundle).not.toHaveBeenCalled();
    expect(rebindWindow).toHaveBeenCalledWith(ownerId, a.id, 1, dead, {
      windowId: next,
      windowApp: a.windowApp,
      title: "After relaunch",
    });
    expect(opened).toEqual([dead, next]);
    expect(activated.viewer).toMatchObject({ kind: "window", view: { state: "ready" } });
    expect(activated.tab.title).toBe("After relaunch");
    f.service.dispose();
  });
  it("names a window tab for the window its opened view shows", async () => {
    const a = row("window"),
      f = fixture([a]);
    f.native.openOwnerView = vi.fn(
      async () =>
        ({
          viewId: "cvw_test",
          generation: 1,
          state: "ready",
          unavailableReason: null,
          target: { kind: "app", app: a.windowApp, windowId: a.windowId },
          window: { windowId: a.windowId, title: "Sol 3 Moving Clock" },
        }) as unknown as ComputerView,
    );
    const retitleWindow = vi.fn(
      async (_owner: unknown, id: unknown, windowId: unknown, title: string) => {
        if (id !== a.id || windowId !== a.windowId || title === a.title) return false;
        a.title = title;
        return true;
      },
    );
    (f.options.store as unknown as Record<string, unknown>).retitleWindow = retitleWindow;
    const activated = await f.service.activate(ownerId, a.id, "open");
    expect(retitleWindow).toHaveBeenCalledWith(ownerId, a.id, a.windowId, "Sol 3 Moving Clock");
    expect(activated.tab.title).toBe("Sol 3 Moving Clock");
    f.service.dispose();
  });
  it("never rebinds a task's window tab: its Run keeps the window it observed", async () => {
    // Review finding 9: an agent opened this window tab; the person clicks Open again after
    // the app quit and came back. A rebind would hand the Run's same tab id a window it never
    // observed, under the same generation.
    const a = row("window"),
      f = fixture([a]);
    expect(a.openedBy).toEqual({ taskId });
    f.native.openOwnerView = vi.fn(
      async () =>
        ({
          viewId: "cvw_test",
          generation: 1,
          state: "unavailable",
          unavailableReason: "window-closed",
          target: { kind: "app", app: a.windowApp, windowId: a.windowId },
        }) as unknown as ComputerView,
    );
    f.native.currentWindow = vi.fn(async () => ({
      windowId: WindowIdSchema.parse(`win_${randomUUID()}`),
      app: a.windowApp!,
      appName: "Test",
      bundleId: "test.app",
      title: "After relaunch",
    }));
    const rebindWindow = vi.fn();
    (f.options.store as unknown as Record<string, unknown>).rebindWindow = rebindWindow;
    const activated = await f.service.activate(ownerId, a.id, "open-again");
    expect(f.native.currentWindow).not.toHaveBeenCalled();
    expect(rebindWindow).not.toHaveBeenCalled();
    expect(activated.viewer).toMatchObject({
      kind: "window",
      view: { state: "unavailable", unavailableReason: "window-closed" },
    });
    f.service.dispose();
  });
  it("never moves a window tab to a window of another app", async () => {
    const a = { ...row("window"), openedBy: "person" as const },
      f = fixture([a]);
    f.native.openOwnerView = vi.fn(
      async () =>
        ({
          viewId: "cvw_test",
          generation: 1,
          state: "unavailable",
          unavailableReason: "window-closed",
          target: { kind: "app", app: a.windowApp, windowId: a.windowId },
        }) as unknown as ComputerView,
    );
    f.native.currentWindow = vi.fn(async () => ({
      windowId: WindowIdSchema.parse(`win_${randomUUID()}`),
      app: { bundleId: "other.app", displayName: "Other", teamId: null },
      appName: "Other",
      bundleId: "other.app",
      title: "Someone else's window",
    }));
    const rebindWindow = vi.fn();
    (f.options.store as unknown as Record<string, unknown>).rebindWindow = rebindWindow;
    await f.service.activate(ownerId, a.id, "open-again");
    expect(rebindWindow).not.toHaveBeenCalled();
    expect(f.native.openOwnerView).toHaveBeenCalledTimes(1);
    f.service.dispose();
  });
  it("keeps a window tab whose app has no window unavailable, and rebinds nothing", async () => {
    const a = { ...row("window"), openedBy: "person" as const },
      f = fixture([a]);
    f.native.openOwnerView = vi.fn(
      async () =>
        ({
          viewId: "cvw_test",
          generation: 1,
          state: "unavailable",
          unavailableReason: "window-closed",
          target: { kind: "app", app: a.windowApp, windowId: a.windowId },
        }) as unknown as ComputerView,
    );
    // The app quit: its window list is empty, and nothing launches it.
    f.native.currentWindow = vi.fn(async () => null);
    const rebindWindow = vi.fn();
    (f.options.store as unknown as Record<string, unknown>).rebindWindow = rebindWindow;
    const activated = await f.service.activate(ownerId, a.id, "open-again");
    expect(f.native.currentWindow).toHaveBeenCalledTimes(1);
    expect(rebindWindow).not.toHaveBeenCalled();
    expect(f.native.openOwnerView).toHaveBeenCalledTimes(1);
    expect(activated.viewer).toMatchObject({
      kind: "window",
      view: { state: "unavailable", unavailableReason: "window-closed" },
    });
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

it("resolves earlier projection callers without starvation when changed() fires mid-pass", async () => {
  const a = row("window"),
    f = fixture([a]);
  const firstPass = Promise.withResolvers<void>();
  const secondPass = Promise.withResolvers<void>();
  let pass = 0;
  f.native.windowState = vi.fn(async () => {
    pass += 1;
    if (pass === 1) await firstPass.promise;
    else await secondPass.promise;
    return { state: "asleep" as const, usedBy: [] };
  });

  const firstCaller = f.service.project(actor);
  await vi.waitFor(() => {
    expect(pass).toBe(1);
  });

  // A new mutation arrives while the first pass is still in flight.
  a.title = "Updated during pass 1";
  f.service.changed(ownerId, [a.id]);
  const secondCaller = f.service.project(actor);

  // Finishing pass 1 must immediately resolve the first caller without waiting for pass 2.
  firstPass.resolve();
  const firstResult = await withTimeout(firstCaller, 1_000, {
    timeoutError: () => new Error("First caller starved behind later invalidation"),
  });
  expect(firstResult.tabs[0]?.title).toBe("window");

  // Second caller advances to pass 2 and sees the updated state.
  await vi.waitFor(() => {
    expect(pass).toBe(2);
  });
  secondPass.resolve();
  const secondResult = await secondCaller;
  expect(secondResult.tabs[0]?.title).toBe("Updated during pass 1");
  f.service.dispose();
});

it("refreshes only the matching window tab on windowChanged()", async () => {
  const first = row("window"),
    second = row("window"),
    f = fixture([first, second]);
  await f.service.project(actor);
  const reads = vi.spyOn(f.options.store, "snapshot");
  const windowStates = vi.spyOn(f.native, "windowState");
  windowStates.mockResolvedValueOnce({
    state: "unavailable",
    unavailableCode: "window-closed",
    unavailableReason: "Window closed",
    usedBy: [],
  });

  f.service.windowChanged(ownerId, first.windowId!);
  const projected = await f.service.project(actor);
  expect(reads).not.toHaveBeenCalled();
  expect(windowStates).toHaveBeenCalledTimes(1);
  expect(windowStates).toHaveBeenCalledWith(
    ownerId,
    expect.any(String),
    first.windowId,
    first.windowApp,
  );
  expect(projected.tabs).toMatchObject([
    { tabId: first.id, state: "unavailable", unavailableCode: "window-closed" },
    { tabId: second.id, state: "asleep" },
  ]);
  f.service.dispose();
});

describe("targeted tab mutations, single-tab reads, and projection batching", () => {
  it("closes, opens, reopens, organizes, updates, and deletes groups via executeCommand without full-catalog projection", async () => {
    const a = row("window");
    const b = row("window");
    const c = row("window");
    const rows = [a, b, c];
    let layout: TabLayout = {
      revision: 1,
      items: rows.map((item) => ({ kind: "tab", tabId: item.id })),
    };
    const f = fixture(rows);
    const closedRows = new Map<string, TabRecord>();
    const openRow = (id: TabRecord["id"], title: string): TabRecord => ({
      ...row("window"),
      id,
      title,
    });
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.resourceLayout = vi.fn(async () => ({
      revision: layout.revision,
      entries: [],
    }));
    storeMock.resourceTabGroups = vi.fn(async (_db: unknown, _owner: unknown, ids: string[]) => {
      const map = new Map<string, string>();
      for (const item of layout.items) {
        if (item.kind === "group") {
          for (const id of item.group.tabIds) {
            if (ids.includes(id)) map.set(id, item.group.groupId);
          }
        }
      }
      return map;
    });
    storeMock.open = vi.fn(async (write: { id: TabRecord["id"]; title: string }) => {
      const created = openRow(write.id, write.title);
      rows.push(created);
      layout = {
        revision: layout.revision + 1,
        items: [...layout.items, { kind: "tab", tabId: created.id }],
      };
      return { tabIds: [created.id], layout: structuredClone(layout) };
    });
    const closeMock = vi.fn(
      async (
        _owner: unknown,
        tabIds: string[],
        _key: string,
        authorize: (tx: unknown, all: TabRecord[], current: TabLayout) => Promise<void>,
      ): Promise<{
        tabIds: string[];
        layout: TabLayout;
        replayed?: boolean;
        currentLayout?: TabLayout;
      }> => {
        await authorize(f.options.store.database, rows, layout);
        for (const id of tabIds) {
          const found = rows.find((item) => item.id === id && !item.closedAt);
          if (found) {
            found.closedAt = new Date();
            closedRows.set(id, found);
          }
        }
        layout = {
          revision: layout.revision + 1,
          items: layout.items.filter((item) => item.kind !== "tab" || !tabIds.includes(item.tabId)),
        };
        return { tabIds, layout: structuredClone(layout) };
      },
    );
    storeMock.close = closeMock;
    storeMock.reopen = vi.fn(async (_owner: unknown, targetId?: string) => {
      const found = targetId ? closedRows.get(targetId) : [...closedRows.values()].at(-1);
      if (!found) throw new Error("missing closed row");
      found.closedAt = null;
      found.generation += 1;
      closedRows.delete(found.id);
      layout = {
        revision: layout.revision + 1,
        items: [...layout.items, { kind: "tab", tabId: found.id }],
      };
      return { tabIds: [found.id], layout: structuredClone(layout) };
    });
    const groupId = TabGroupIdSchema.parse(`tgp_${randomUUID()}`);
    storeMock.organize = vi.fn(async (_owner: unknown, input: { tabIds: TabRecord["id"][] }) => {
      layout = {
        revision: layout.revision + 1,
        items: [
          {
            kind: "group",
            group: {
              groupId,
              name: "Work",
              color: "blue",
              collapsed: false,
              tabIds: [...input.tabIds],
            },
          },
          ...layout.items.filter(
            (item) => item.kind !== "tab" || !input.tabIds.includes(item.tabId),
          ),
        ],
      };
      return { tabIds: input.tabIds, layout: structuredClone(layout) };
    });
    storeMock.updateGroup = vi.fn(async (_owner: unknown, input: { name?: string }) => {
      layout = {
        revision: layout.revision + 1,
        items: layout.items.map((item) =>
          item.kind === "group" && item.group.groupId === groupId
            ? {
                kind: "group",
                group: { ...item.group, name: input.name ?? item.group.name },
              }
            : item,
        ),
      };
      return { tabIds: [a.id], layout: structuredClone(layout) };
    });
    storeMock.deleteGroup = vi.fn(async () => {
      layout = {
        revision: layout.revision + 1,
        items: layout.items.flatMap((item) =>
          item.kind === "group" && item.group.groupId === groupId
            ? item.group.tabIds.map((id) => ({ kind: "tab" as const, tabId: id }))
            : [item],
        ),
      };
      return { tabIds: [a.id], layout: structuredClone(layout) };
    });

    // Warm the owner catalog once.
    await f.service.project(actor);

    const snapshots = vi.spyOn(f.options.store, "snapshot");
    const windowStates = vi.spyOn(f.native, "windowState");
    snapshots.mockClear();
    windowStates.mockClear();

    // Close does ZERO snapshot reads and ZERO windowState probes, and updates the cache.
    const closed = await f.service.executeCommand(ownerId, {
      type: "tab.close",
      idempotencyKey: "close-b",
      tabIds: [b.id],
    });
    expect(closed).toMatchObject({
      type: "tab.close",
      closed: [b.id],
      failed: [],
      layout: { revision: 2 },
    });
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).not.toHaveBeenCalled();
    expect((await f.service.project(actor)).tabs.map((tab) => tab.tabId)).toEqual([a.id, c.id]);
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).not.toHaveBeenCalled();

    // Reopen projects ONLY the reopened tab (1 windowState call, 0 snapshots).
    const reopened = await f.service.executeCommand(ownerId, {
      type: "tab.reopen",
      idempotencyKey: "reopen-b",
      tabId: b.id,
    });
    expect(reopened).toMatchObject({
      type: "tab.reopen",
      tab: { tabId: b.id },
      layout: { revision: 3 },
    });
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).toHaveBeenCalledTimes(1);
    windowStates.mockClear();

    // Organize projects ONLY the moved tab(s), updates groupId on cache cleanly.
    const organized = await f.service.executeCommand(ownerId, {
      type: "tab.organize",
      idempotencyKey: "org-a",
      tabIds: [a.id],
      group: { name: "Work", color: "blue" },
    });
    expect(organized).toMatchObject({
      type: "tab.organize",
      tabs: [{ tabId: a.id, groupId }],
      layout: { revision: 4 },
    });
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).toHaveBeenCalledTimes(1);
    windowStates.mockClear();

    // Update group does ZERO tab projections and updates cached layout.
    const updatedGroup = await f.service.executeCommand(ownerId, {
      type: "tab.group.update",
      idempotencyKey: "rename-group",
      groupId,
      name: "Focus",
    });
    expect(updatedGroup).toMatchObject({
      type: "tab.group.update",
      group: { groupId, name: "Focus" },
      layout: { revision: 5 },
    });
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).not.toHaveBeenCalled();

    // Delete group does ZERO tab projections and clears cached groupId.
    const deletedGroup = await f.service.executeCommand(ownerId, {
      type: "tab.group.delete",
      idempotencyKey: "delete-group",
      groupId,
    });
    expect(deletedGroup).toMatchObject({
      type: "tab.group.delete",
      layout: { revision: 6 },
    });
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).not.toHaveBeenCalled();
    const afterDelete = await f.service.project(actor);
    expect(afterDelete.tabs.find((tab) => tab.tabId === a.id)?.groupId).toBeNull();
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).not.toHaveBeenCalled();

    // Open projects ONLY the newly opened tab.
    f.native.resolveWindow = vi.fn(async () => ({
      windowId: WindowIdSchema.parse(`win_${randomUUID()}`),
      app: { bundleId: "test.app", displayName: "Test", teamId: null },
      appName: "Test",
      bundleId: "test.app",
      title: "Opened",
    }));
    const opened = await f.service.executeCommand(ownerId, {
      type: "tab.open",
      idempotencyKey: "open-d",
      target: { kind: "window", computerId: a.computerId, bundleId: "test.app" },
    });
    expect(opened).toMatchObject({
      type: "tab.open",
      layout: { revision: 7 },
    });
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).toHaveBeenCalledTimes(1);

    // Idempotent replay returning an older layout revision must NOT regress cached layout
    // and must NOT terminate viewers for a reopened tab or return stale historical layout.
    const staleLayout: TabLayout = {
      revision: 2,
      items: [{ kind: "tab", tabId: a.id }],
    };
    const closeOwnerViews = vi.spyOn(f.native, "closeOwnerViews");
    closeOwnerViews.mockClear();
    closeMock.mockImplementationOnce(
      async (
        _owner: unknown,
        _tabIds: string[],
        _key: string,
        authorize: (tx: unknown, all: TabRecord[], current: TabLayout) => Promise<void>,
      ) => {
        // Real TabStore runs authorize against current open rows before returning the replay receipt.
        await authorize(f.options.store.database, rows, layout);
        return {
          tabIds: [b.id],
          layout: staleLayout,
          replayed: true,
          currentLayout: structuredClone(layout),
        };
      },
    );
    const replayedClose = await f.service.executeCommand(ownerId, {
      type: "tab.close",
      idempotencyKey: "close-b",
      tabIds: [b.id],
    });
    expect(closeOwnerViews).not.toHaveBeenCalled();
    expect(replayedClose).toMatchObject({
      type: "tab.close",
      layout: { revision: 7 },
    });
    const current = await f.service.project(actor);
    expect(current.layout.revision).toBe(7);
    expect(current.tabs).toHaveLength(4);
    f.service.dispose();
  });

  it("invalidates warm catalog when post-commit projection fails after open/reopen/organize", async () => {
    const a = row("window");
    const rows = [a];
    let layout: TabLayout = {
      revision: 1,
      items: [{ kind: "tab", tabId: a.id }],
    };
    const f = fixture(rows);
    f.setLayout(layout);
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.resourceLayout = vi.fn(async () => ({ revision: layout.revision, entries: [] }));
    storeMock.open = vi.fn(async (write: { id: TabRecord["id"]; title: string }) => {
      const created = { ...row("window"), id: write.id, title: write.title };
      rows.push(created);
      layout = {
        revision: layout.revision + 1,
        items: [...layout.items, { kind: "tab", tabId: created.id }],
      };
      f.setLayout(layout);
      return { tabIds: [created.id], layout: structuredClone(layout) };
    });
    f.native.resolveWindow = vi.fn(async () => ({
      windowId: WindowIdSchema.parse(`win_${randomUUID()}`),
      app: { bundleId: "test.app", displayName: "Test", teamId: null },
      appName: "Test",
      bundleId: "test.app",
      title: "Opened",
    }));

    // Warm catalog at revision 1.
    expect((await f.service.project(actor)).tabs).toHaveLength(1);

    // Simulate post-commit projection failure during open.
    const windowState = vi.spyOn(f.native, "windowState");
    windowState.mockRejectedValueOnce(new Error("transient projection failure"));
    await expect(
      f.service.executeCommand(ownerId, {
        type: "tab.open",
        idempotencyKey: "open-fail-proj",
        target: { kind: "window", computerId: a.computerId, bundleId: "test.app" },
      }),
    ).rejects.toThrow("transient projection failure");

    // Warm catalog must have been invalidated so next project() sees the committed revision 2.
    const afterFailure = await f.service.project(actor);
    expect(afterFailure.layout.revision).toBe(2);
    expect(afterFailure.tabs).toHaveLength(2);
    f.service.dispose();
  });

  it("preserves mid-projection invalidations during organize and open without erasing newer updates", async () => {
    const a = row("window");
    const b = row("window");
    const rows = [a, b];
    let layout: TabLayout = {
      revision: 1,
      items: rows.map((item) => ({ kind: "tab", tabId: item.id })),
    };
    const f = fixture(rows);
    f.setLayout(layout);
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.resourceLayout = vi.fn(async () => ({ revision: layout.revision, entries: [] }));
    storeMock.organize = vi.fn(async () => {
      layout = {
        revision: layout.revision + 1,
        items: [
          { kind: "tab", tabId: b.id },
          { kind: "tab", tabId: a.id },
        ],
      };
      f.setLayout(layout);
      return { tabIds: [b.id], layout: structuredClone(layout) };
    });

    await f.service.project(actor);

    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.native.windowState = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      return { state: "asleep" as const, usedBy: [] };
    });

    const organizing = f.service.executeCommand(ownerId, {
      type: "tab.organize",
      idempotencyKey: "move-b",
      tabIds: [b.id],
      group: null,
      beforeTabId: a.id,
    });
    await started.promise;

    // A title update + invalidation arrives while organize's projection is still in flight.
    b.title = "Fresh Title After Move";
    f.service.changed(ownerId, [b.id]);

    finish.resolve();
    await organizing;

    // Reset windowState for the follow-up refresh.
    f.native.windowState = vi.fn(async () => ({ state: "asleep" as const, usedBy: [] }));
    const projected = await f.service.project(actor);
    expect(projected.tabs.map((tab) => tab.tabId)).toEqual([b.id, a.id]);
    expect(projected.tabs[0]?.title).toBe("Fresh Title After Move");
    f.service.dispose();
  });

  it("does not overwrite a newer groupId when organize runs concurrently with activate", async () => {
    const a = row("window");
    const rows = [a];
    const groupId = TabGroupIdSchema.parse(`tgp_${randomUUID()}`);
    let layout: TabLayout = {
      revision: 1,
      items: [{ kind: "tab", tabId: a.id }],
    };
    const f = fixture(rows);
    f.setLayout(layout);
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.resourceTabGroups = vi.fn(async () => new Map());
    storeMock.organize = vi.fn(async () => {
      layout = {
        revision: layout.revision + 1,
        items: [
          {
            kind: "group",
            group: {
              groupId,
              name: "Grouped",
              color: "blue",
              collapsed: false,
              tabIds: [a.id],
            },
          },
        ],
      };
      f.setLayout(layout);
      return { tabIds: [a.id], layout: structuredClone(layout) };
    });
    f.native.openOwnerView = vi.fn(async () => ({}) as ComputerView);

    await f.service.project(actor);

    const fenceStarted = Promise.withResolvers<void>();
    const finishFence = Promise.withResolvers<void>();
    const originalGet = f.options.store.get.bind(f.options.store);
    let getCalls = 0;
    f.options.store.get = vi.fn(async (owner, id) => {
      getCalls += 1;
      // 1st get: activate #row, 2nd get: activate this.get, 3rd get: activate #fence
      if (getCalls === 3) {
        fenceStarted.resolve();
        await finishFence.promise;
      }
      return originalGet(owner, id);
    });

    const activating = f.service.activate(ownerId, a.id, "act-1");
    await fenceStarted.promise;

    // Organize moves `a` into `groupId` while activate is paused at #fence.
    await f.service.executeCommand(ownerId, {
      type: "tab.organize",
      idempotencyKey: "group-a",
      tabIds: [a.id],
      group: { name: "Grouped", color: "blue" },
    });

    finishFence.resolve();
    await activating;

    // Catalog must retain `groupId` from organize rather than being overwritten with null.
    const after = await f.service.project(actor);
    expect(after.tabs[0]?.groupId).toBe(groupId);
    f.service.dispose();
  });

  it("uses currentLayout on replayed group.update so a deleted group throws not_found", async () => {
    const a = row("window");
    const groupId = TabGroupIdSchema.parse(`tgp_${randomUUID()}`);
    const historicalLayout: TabLayout = {
      revision: 2,
      items: [
        {
          kind: "group",
          group: {
            groupId,
            name: "Renamed",
            color: "blue",
            collapsed: false,
            tabIds: [a.id],
          },
        },
      ],
    };
    const currentLayout: TabLayout = {
      revision: 3,
      items: [{ kind: "tab", tabId: a.id }],
    };
    const f = fixture([a]);
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.updateGroup = vi.fn(async () => ({
      tabIds: [a.id],
      layout: historicalLayout,
      replayed: true,
      currentLayout,
    }));

    await expect(
      f.service.executeCommand(ownerId, {
        type: "tab.group.update",
        idempotencyKey: "rename-old",
        groupId,
        name: "Renamed",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    f.service.dispose();
  });

  it("does not let an older organize overwrite a refresh that already completed while paused", async () => {
    const a = row("window");
    const b = row("window");
    b.title = "Original";
    const rows = [a, b];
    let layout: TabLayout = {
      revision: 1,
      items: rows.map((item) => ({ kind: "tab", tabId: item.id })),
    };
    const f = fixture(rows);
    f.setLayout(layout);
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.organize = vi.fn(async () => {
      layout = {
        revision: layout.revision + 1,
        items: [
          { kind: "tab", tabId: b.id },
          { kind: "tab", tabId: a.id },
        ],
      };
      f.setLayout(layout);
      return { tabIds: [b.id], layout: structuredClone(layout) };
    });

    await f.service.project(actor);

    const organizePaused = Promise.withResolvers<void>();
    const resumeOrganize = Promise.withResolvers<void>();
    let calls = 0;
    f.native.windowState = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        organizePaused.resolve();
        await resumeOrganize.promise;
      }
      return { state: "asleep" as const, usedBy: [] };
    });

    const organizing = f.service.executeCommand(ownerId, {
      type: "tab.organize",
      idempotencyKey: "org-raced",
      tabIds: [b.id],
      group: null,
      beforeTabId: a.id,
    });
    await organizePaused.promise;

    // While organize is paused, b changes AND project() completes its refresh, consuming dirty.
    b.title = "Updated";
    f.service.changed(ownerId, [b.id]);
    const refreshed = await f.service.project(actor);
    expect(refreshed.tabs.find((tab) => tab.tabId === b.id)?.title).toBe("Updated");

    // Resume the older organize; it must keep the newer refreshed row instead of overwriting with Original.
    resumeOrganize.resolve();
    await organizing;

    const after = await f.service.project(actor);
    expect(after.tabs.map((tab) => tab.tabId)).toEqual([b.id, a.id]);
    expect(after.tabs[0]?.title).toBe("Updated");
    f.service.dispose();
  });

  it("still calls pages.admitted on replayed page open and authorizes replayed reopen-latest against replayedTabIds", async () => {
    const pageRow: TabRecord = {
      ...row("phone"),
      kind: "page",
      url: "https://example.com",
      title: "Example",
      generation: 3,
      pageBinding: {
        lineageId: "lin_1" as NonNullable<TabRecord["pageBinding"]>["lineageId"],
        sessionId: "bsn_1" as NonNullable<TabRecord["pageBinding"]>["sessionId"],
        surfaceId: tabId(),
      },
    };
    pageRow.id = pageRow.pageBinding!.surfaceId;
    const f = fixture([pageRow]);
    const layout: TabLayout = {
      revision: 3,
      items: [{ kind: "tab", tabId: pageRow.id }],
    };
    f.setLayout(layout);
    const admitted = vi.fn(async () => {});
    f.options.pages.admitted = admitted;
    f.options.pages.open = vi.fn(async () => ({
      id: pageRow.id,
      ownerId,
      kind: "page" as const,
      computerId: pageRow.computerId,
      title: "Example",
      url: "https://example.com",
      openedBy: "person" as const,
      pageBinding: pageRow.pageBinding!,
    }));
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.resourceLayout = vi.fn(async () => ({ revision: layout.revision, entries: [] }));
    storeMock.open = vi.fn(async () => ({
      tabIds: [pageRow.id],
      layout: { revision: 1, items: [{ kind: "tab", tabId: pageRow.id }] },
      replayed: true,
      currentLayout: structuredClone(layout),
    }));

    await f.service.executeCommand(ownerId, {
      type: "tab.open",
      idempotencyKey: "open-page-replay",
      target: {
        kind: "page",
        computerId: pageRow.computerId,
        guest: true,
        url: "https://example.com",
      },
    });
    expect(admitted).toHaveBeenCalledTimes(1);

    // Replaying reopen without tabId when no closed rows remain must authorize against replayedTabIds.
    storeMock.reopen = vi.fn(
      async (
        _owner: unknown,
        _target: unknown,
        _key: string,
        authorize: (
          tx: unknown,
          all: TabRecord[],
          current: TabLayout,
          replayedTabIds?: readonly TabRecord["id"][],
        ) => Promise<void>,
      ) => {
        await authorize(f.options.store.database, [pageRow], layout, [pageRow.id]);
        return {
          tabIds: [pageRow.id],
          layout: structuredClone(layout),
          replayed: true,
          currentLayout: structuredClone(layout),
        };
      },
    );
    const reopened = await f.service.executeCommand(ownerId, {
      type: "tab.reopen",
      idempotencyKey: "reopen-latest-replay",
    });
    expect(reopened).toMatchObject({ type: "tab.reopen", tab: { tabId: pageRow.id } });
    f.service.dispose();
  });

  it("does not let a paused organize overwrite a completed activation in the warm catalog", async () => {
    const a = row("window");
    const b = row("window");
    const rows = [a, b];
    let layout: TabLayout = {
      revision: 1,
      items: rows.map((item) => ({ kind: "tab", tabId: item.id })),
    };
    const f = fixture(rows);
    f.setLayout(layout);
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.resourceTabGroups = vi.fn(async () => new Map());
    storeMock.organize = vi.fn(async () => {
      layout = {
        revision: layout.revision + 1,
        items: [
          { kind: "tab", tabId: b.id },
          { kind: "tab", tabId: a.id },
        ],
      };
      f.setLayout(layout);
      return { tabIds: [b.id], layout: structuredClone(layout) };
    });
    f.native.openOwnerView = vi.fn(async () => ({}) as ComputerView);

    await f.service.project(actor);

    const organizePaused = Promise.withResolvers<void>();
    const resumeOrganize = Promise.withResolvers<void>();
    let stateCalls = 0;
    f.native.windowState = vi.fn(async () => {
      stateCalls += 1;
      if (stateCalls === 1) {
        organizePaused.resolve();
        await resumeOrganize.promise;
        return { state: "asleep" as const, usedBy: [] };
      }
      return { state: "open" as const, usedBy: [] };
    });

    const organizing = f.service.executeCommand(ownerId, {
      type: "tab.organize",
      idempotencyKey: "org-vs-activate",
      tabIds: [b.id],
      group: null,
      beforeTabId: a.id,
    });
    await organizePaused.promise;

    // Activate b while organize is paused -> completes and records b as "open".
    const activated = await f.service.activate(ownerId, b.id, "act-b");
    expect(activated.tab.state).toBe("open");

    // Resume the older organize; it must not overwrite "open" with its stale "asleep" projection.
    resumeOrganize.resolve();
    await organizing;

    const after = await f.service.project(actor);
    expect(after.tabs.find((tab) => tab.tabId === b.id)?.state).toBe("open");
    f.service.dispose();
  });

  it("projects only the single target tab for get() and authorizeShow()", async () => {
    const rows = Array.from({ length: 10 }, () => row("window"));
    const f = fixture(rows);
    const storeMock = f.options.store as unknown as Record<string, unknown>;
    storeMock.resourceTabGroups = vi.fn(async () => new Map());
    const snapshots = vi.spyOn(f.options.store, "snapshot");
    const windowStates = vi.spyOn(f.native, "windowState");

    const single = await f.service.get(ownerId, rows[3]!.id);
    expect(single.tabId).toBe(rows[3]!.id);
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).toHaveBeenCalledTimes(1);

    windowStates.mockClear();
    await f.service.authorizeShow(
      {
        aud: "opensteer-run-tools",
        bindingGeneration: 1,
        environmentId: createId("environment"),
        requestedBy: ownerId,
        runId: createId("run"),
        runnerBootId: "boot",
        runnerId: computerId,
        threadId: taskId,
        exp: 100,
        iat: 1,
        iss: "opensteer-host",
        jti: "token",
      },
      rows[5]!.id,
    );
    expect(snapshots).not.toHaveBeenCalled();
    expect(windowStates).toHaveBeenCalledTimes(1);
    f.service.dispose();
  });

  it("batches windowStates, deduplicates apps.get, and reuses computer.selfRunnerId", async () => {
    const appId = `app_${randomUUID()}`;
    const win1 = row("window");
    const win2 = row("window");
    const app1 = { ...row(), kind: "app" as const, appId };
    const app2 = { ...row(), kind: "app" as const, appId };
    const f = fixture([win1, win2, app1, app2]);
    const selfRunnerId = RunnerIdSchema.parse(computerId);
    f.options.computer = async () => ({
      name: "Computer",
      connected: true,
      removed: false,
      selfRunnerId,
    });
    const requireRunner = vi.spyOn(f.options.devices, "requireDeviceSelfRunnerId");
    const appsGet = vi.fn(async () => ({
      appId,
      computerId: win1.computerId,
      name: "Dashboard",
      kind: "html" as const,
      state: "running" as const,
      version: 1,
      server: null,
    }));
    f.options.apps.get = appsGet as unknown as TabServiceOptions["apps"]["get"];
    const windowStatesBatch = vi.fn(
      async (_owner: unknown, windows: readonly { readonly tabId: TabRecord["id"] }[]) =>
        new Map(
          windows.map((entry) => [entry.tabId, { state: "asleep" as const, usedBy: [{ taskId }] }]),
        ),
    );
    f.native.windowStates = windowStatesBatch;
    const singleWindowState = vi.spyOn(f.native, "windowState");

    const projected = await f.service.project(actor);
    expect(projected.tabs).toHaveLength(4);
    expect(requireRunner).not.toHaveBeenCalled();
    expect(appsGet).toHaveBeenCalledTimes(1);
    expect(windowStatesBatch).toHaveBeenCalledTimes(1);
    expect(windowStatesBatch.mock.calls[0]?.[1]).toHaveLength(2);
    expect(singleWindowState).not.toHaveBeenCalled();
    f.service.dispose();
  });
});

describe("closing a group", () => {
  it("answers a replay with the same key exactly as the first call answered", async () => {
    const [kept, closed] = [row(), row()];
    const groupId = TabGroupIdSchema.parse(`tgp_${randomUUID()}`);
    const f = fixture([kept, closed]);
    const group = (tabIds: TabRecord["id"][]): TabLayout["items"][number] => ({
      kind: "group",
      group: { groupId, name: "Research", color: "blue", collapsed: false, tabIds },
    });
    let layout: TabLayout = { revision: 1, items: [group([kept.id, closed.id])] };
    const answered = new Map<string, { tabIds: TabRecord["id"][]; layout: TabLayout }>();
    // As the store does: authority first, then a replay's stored answer or the close itself.
    (f.options.store as unknown as Record<string, unknown>).closeGroup = async (
      _owner: unknown,
      _group: unknown,
      key: string,
      authorize: TabAuthorization,
      canClose: (row: TabRecord) => boolean,
    ) => {
      const open = [kept, closed].filter((row) => !row.closedAt);
      await authorize({} as never, open, structuredClone(layout));
      const stored = answered.get(key);
      if (stored) return { ...structuredClone(stored), replayed: true, currentLayout: layout };
      const tabIds = open.filter(canClose).map((row) => row.id);
      for (const row of open) if (tabIds.includes(row.id)) row.closedAt = new Date();
      const remaining = open.filter((row) => !tabIds.includes(row.id)).map((row) => row.id);
      layout = { revision: 2, items: remaining.length ? [group(remaining)] : [] };
      answered.set(key, { tabIds, layout: structuredClone(layout) });
      return { tabIds, layout: structuredClone(layout) };
    };
    // The first call may not close `kept`; by the replay that refusal has gone.
    let refused = new Set([kept.id]);
    f.options.deniedRows = async () => refused;
    const first = await f.service.closeGroup(actor, groupId, "close-group");
    expect(first).toMatchObject({
      closed: [closed.id],
      failed: [{ tabId: kept.id }],
      groupClosed: false,
    });
    refused = new Set();
    const replay = await f.service.closeGroup(actor, groupId, "close-group");
    expect({ ...replay, layout: undefined }).toEqual({ ...first, layout: undefined });
    f.service.dispose();
  });
});
