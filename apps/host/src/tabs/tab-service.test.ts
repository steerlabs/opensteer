import { RunnerIdSchema } from "@opensteer/core";
import { DeviceIdSchema } from "@opensteer/core";
import {
  createId,
  TabGroupIdSchema,
  TabIdSchema,
  WindowIdSchema,
  type TabLayout,
} from "@opensteer/core";
import type { ComputerView } from "@opensteer/protocol";
import type { TabRecord, TabStore } from "@opensteer/database";
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
