import { KeyedStreamReceiver } from "@opensteer/protocol/keyed-stream";
import {
  createId,
  TabGroupIdSchema,
  TabIdSchema,
  WindowIdSchema,
  type TabLayout,
  type Tab,
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
    computerId,
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
    get: async (_owner: unknown, id: unknown) =>
      structuredClone(rows.find((row) => row.id === id && !row.closedAt) ?? null),
  } as unknown as TabStore;
  const options: TabServiceOptions = {
    store,
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
    f.options.computer = async () => ({ name: "Computer", connected: false, removed: false });
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
  it("bootstraps an ordered bounded prefix and patches one row without repeating layout metadata", async () => {
    const a = row(),
      b = row("window"),
      f = fixture([a, b]);
    const full = await f.service.bootstrap(ownerId, 65536);
    const prefix = await f.service.bootstrap(
      ownerId,
      Buffer.byteLength(JSON.stringify({ ...full, tabs: [full.tabs[0]], complete: false })),
    );
    expect(prefix.tabs.map((tab) => tab.tabId)).toEqual([a.id]);
    expect(prefix.complete).toBe(false);
    const messages: unknown[] = [];
    const receiver = new KeyedStreamReceiver<Tab, { layout: TabLayout }, "tabId">({ key: "tabId" });
    receiver.seed(prefix.tabs, { layout: prefix.layout });
    const stream = f.service.streams.subscribe(
      ownerId,
      async (message) => {
        messages.push(message);
        receiver.apply(message.stream);
      },
      prefix.tabs,
    );
    await stream.ready;
    messages.length = 0;
    a.title = "New title";
    f.service.changed(ownerId);
    await stream.flush();
    expect(messages).toEqual([
      {
        type: "host.tabs",
        stream: expect.objectContaining({
          op: "change",
          update: [{ tabId: a.id, title: "New title" }],
        }),
      },
    ]);
    expect(messages[0]).not.toHaveProperty("stream.meta");
    f.options.computer = async () => ({ name: "Computer", connected: false, removed: false });
    f.service.changed(ownerId);
    await stream.flush();
    expect(receiver.rows.get(a.id)).toMatchObject({
      state: "unavailable",
      unavailableCode: "computer-offline",
    });
    f.options.computer = async () => ({ name: "Computer", connected: true, removed: false });
    f.service.changed(ownerId);
    await stream.flush();
    expect(receiver.rows.get(a.id)).toMatchObject({ state: "asleep" });
    expect(receiver.rows.get(a.id)).not.toHaveProperty("unavailableCode");
    stream.close();
    f.service.dispose();
  });
});
