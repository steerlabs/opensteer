import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserClientStreams,
  type BrowserClientStreamMessage,
  type BrowserRowPorts,
} from "./browser-client-streams.js";
import type {
  BrowserGroupRow,
  BrowserTabRow,
  BrowserTabRecord,
} from "@opensteer/protocol/browser-tabs";
import type { BrowserGroupFacts, PersonalTabStreamRow } from "@opensteer/database";
import { keyedStreamBytes } from "@opensteer/protocol/keyed-stream";
import type { UserId } from "@opensteer/core";

const alice = "usr_00000000-0000-4000-8000-000000000001" as UserId;
const bob = "usr_00000000-0000-4000-8000-000000000002" as UserId;
const groupId = "bsn_00000000-0000-4000-8000-000000000001" as BrowserGroupRow["id"];
const tabId = "surface_1" as BrowserTabRow["id"];
const group: BrowserGroupRow = {
  id: groupId,
  createdAt: "2026-01-01T00:00:00.000Z",
  unavailableReason: null,
  tabCount: 1,
  inventoryRevision: 1,
  sessionId: groupId,
  workspaceId: "wsp_00000000-0000-4000-8000-000000000001" as BrowserGroupRow["workspaceId"],
  state: "ready",
  origin: "workspace",
  access: "read-write",
  placement: {
    kind: "runner",
    runnerId:
      "rnr_00000000-0000-4000-8000-000000000001" as BrowserGroupRow["placement"]["runnerId"],
  },
  profileId: null,
  runtimeId: "runtime",
  opener: { kind: "you" },
  navigation: true,
  sessionCreatedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  acting: false,
  page: null,
  attachedRunIds: [],
  threadIds: [],
};
const tab: BrowserTabRow = {
  id: tabId,
  sessionId: groupId,
  title: "Page",
  site: "https://example.com",
  iconRef: null,
  order: 0,
  openerId: null,
  createdAt: group.createdAt,
  state: "live",
  availability: "ready",
  loading: false,
  navigationFailed: false,
  documentId: "doc",
  canGoBack: false,
  canGoForward: false,
  occupants: [],
};
function fixture(count = 1) {
  const facts: BrowserGroupFacts = { ...group, tabCount: count };
  const durable = new Map<string, PersonalTabStreamRow>(
    Array.from({ length: count }, (_, index) => {
      const id = index ? (`surface_${index + 1}` as BrowserTabRow["id"]) : tabId;
      return [id, { ...tab, id, order: index, kind: "browser", groupId }];
    }),
  );
  const records = new Map<string, BrowserTabRecord>(
    [...durable.values()].map((row) => [
      row.id,
      {
        ...tab,
        ...row,
        state: "live",
        url: "https://example.com/private/path?never=sent",
        icon: null,
        documentId: "doc",
        geometryRevision: 1,
        sizedByAgent: false,
      },
    ]),
  );
  let visible = true,
    live = true,
    acting = false;
  let occupants: BrowserRowPorts["occupants"] = () => [];
  const ports: BrowserRowPorts = {
    authorityGeneration: () => 0,
    groupIds: vi.fn(async (user) => (user === alice && !visible ? [] : [groupId])),
    readGroups: vi.fn(async (user, ids) =>
      (user === alice && !visible) || !ids.includes(groupId) ? [] : [{ ...facts }],
    ),
    readTabs: vi.fn(async () => [...durable.values()]),
    groupId: vi.fn(async () => groupId),
    live: () =>
      live
        ? {
            groupId,
            records,
            inventoryRevision: 1,
            navigation: true,
            ready: true,
            acting,
            page: null,
            iconRef: () => null,
          }
        : undefined,
    occupants: (user, session, id) => occupants(user, session, id),
    onError: (error) => {
      throw error;
    },
  };
  const streams = new BrowserClientStreams(ports);
  const attach = async (
    user = alice,
    bufferedAmount = () => 0,
    send?: (message: BrowserClientStreamMessage) => Promise<void>,
  ) => {
    const messages: BrowserClientStreamMessage[] = [];
    const connection = await streams.attach(user, {
      bufferedAmount,
      send: async (message) => {
        messages.push(message);
        await send?.(message);
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    return { ...connection, messages };
  };
  return {
    facts,
    durable,
    records,
    ports,
    streams,
    attach,
    set visible(value: boolean) {
      visible = value;
    },
    set live(value: boolean) {
      live = value;
    },
    set acting(value: boolean) {
      acting = value;
    },
    set occupants(value: BrowserRowPorts["occupants"]) {
      occupants = value;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("BrowserClientStreams", () => {
  it("continues only a matching authorized bootstrap and falls back after changes or revocation", async () => {
    vi.useFakeTimers();
    const f = fixture(200);
    const prefix = await f.streams.source.bootstrap(alice);
    expect(prefix.tabs[0]!.complete).toBe(false);
    const frames: BrowserClientStreamMessage[] = [];
    const connection = await f.streams.attach(
      alice,
      {
        bufferedAmount: () => 0,
        send: async (frame) => {
          frames.push(frame);
        },
      },
      prefix.continuation,
    );
    await vi.advanceTimersByTimeAsync(50);
    const rows = frames.flatMap<BrowserGroupRow | BrowserTabRow>((frame) =>
      frame.type === "host.browser-tabs" && frame.stream.op === "rows" ? frame.stream.rows : [],
    );
    expect([...prefix.tabs[0]!.rows, ...rows]).toHaveLength(200);
    expect(frames[0]).toMatchObject({ stream: { op: "begin", prefix: 1 } });
    connection.close();
    frames.length = 0;
    f.records.set(tabId, { ...f.records.get(tabId)!, title: "Changed since bootstrap" });
    const stale = await f.streams.attach(
      alice,
      {
        bufferedAmount: () => 0,
        send: async (frame) => {
          frames.push(frame);
        },
      },
      prefix.continuation,
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(frames[0]!.stream).not.toHaveProperty("prefix");
    expect(
      frames.flatMap<BrowserGroupRow | BrowserTabRow>((frame) =>
        frame.stream.op === "rows" ? frame.stream.rows : [],
      ),
    ).toContainEqual(expect.objectContaining({ id: tabId, title: "Changed since bootstrap" }));
    stale.close();
    frames.length = 0;
    f.visible = false;
    await f.streams.attach(
      alice,
      {
        bufferedAmount: () => 0,
        send: async (frame) => {
          frames.push(frame);
        },
      },
      prefix.continuation,
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(
      frames.flatMap<BrowserGroupRow | BrowserTabRow>((frame) =>
        frame.stream.op === "rows" ? frame.stream.rows : [],
      ),
    ).toEqual([]);
    expect(frames[0]!.stream).not.toHaveProperty("prefix");
    f.streams.close();
  });
  it("finishes a continued attach revoked after its prefix read without retaining a tab publisher", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const prefix = await f.streams.source.bootstrap(alice);
    const bootstrap = f.streams.source.bootstrap.bind(f.streams.source);
    vi.spyOn(f.streams.source, "bootstrap").mockImplementationOnce(async (user) => {
      const rows = await bootstrap(user);
      f.visible = false;
      await f.streams.source.reauthorize(alice);
      return rows;
    });
    const frames: BrowserClientStreamMessage[] = [];
    await f.streams.attach(
      alice,
      {
        bufferedAmount: () => 0,
        send: async (frame) => {
          frames.push(frame);
        },
      },
      prefix.continuation,
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(frames.at(-1)).toMatchObject({
      type: "host.browser-groups",
      stream: { op: "change", remove: [groupId] },
    });
    expect(frames.some((frame) => frame.type === "host.browser-tabs")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    f.streams.close();
  });
  it("shares viewer projections but keeps each connection's revision independent", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const a = await f.attach(),
      b = await f.attach(bob),
      second = await f.attach();
    expect(f.ports.groupIds).toHaveBeenCalledTimes(2);
    a.messages.length = b.messages.length = second.messages.length = 0;
    a.resync();
    await vi.advanceTimersByTimeAsync(50);
    expect(
      a.messages.some(
        (message) => message.type === "host.browser-tabs" && message.stream.op === "begin",
      ),
    ).toBe(true);
    expect(second.messages).toHaveLength(0);
    a.messages.length = 0;
    f.occupants = (user) =>
      user === alice
        ? [
            {
              threadId:
                "thr_00000000-0000-4000-8000-000000000001" as BrowserTabRow["occupants"][number]["threadId"],
              home: false,
              holding: true,
              acting: true,
              lastActiveAt: group.createdAt,
            },
          ]
        : [];
    f.streams.source.markTabs(groupId, [tabId]);
    await vi.advanceTimersByTimeAsync(50);
    expect(a.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(0);
    expect(a.messages[0]?.type).toBe("host.browser-tabs");
    a.messages.length = 0;
    f.visible = false;
    await f.streams.source.reauthorize(alice);
    await vi.advanceTimersByTimeAsync(50);
    expect(a.messages).toEqual([
      expect.objectContaining({
        type: "host.browser-groups",
        stream: expect.objectContaining({ op: "change", remove: [groupId] }),
      }),
    ]);
    a.messages.length = 0;
    f.occupants = () => [];
    f.streams.source.markTabs(groupId, [tabId]);
    a.resync(groupId);
    await vi.advanceTimersByTimeAsync(50);
    expect(a.messages).toHaveLength(0);
    f.streams.close();
  });
  it("coalesces a blocked connection to the latest title without a backlog", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let blocked = false;
    const a = await f.attach(alice, () => (blocked ? 300_000 : 0));
    a.messages.length = 0;
    blocked = true;
    for (const title of ["Old", "Latest"]) {
      f.records.set(tabId, { ...f.records.get(tabId)!, title });
      f.streams.source.markTabs(groupId, [tabId]);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(a.messages).toHaveLength(0);
    blocked = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(a.messages).toEqual([
      expect.objectContaining({
        type: "host.browser-tabs",
        stream: expect.objectContaining({ op: "change", update: [{ id: tabId, title: "Latest" }] }),
      }),
    ]);
    f.streams.close();
  });
  it("drops a revoked group's publisher during an unfinished tab snapshot and regrants with a new generation", async () => {
    vi.useFakeTimers();
    const f = fixture(200);
    let release: (() => void) | undefined;
    const a = await f.attach(
      alice,
      () => 0,
      async (message) => {
        if (message.type === "host.browser-tabs" && message.stream.op === "rows" && !release)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
    );
    expect(release).toBeDefined();
    const first = a.messages.find(
      (message) => message.type === "host.browser-tabs" && message.stream.op === "begin",
    );
    f.visible = false;
    let authorize!: (ids: BrowserGroupRow["id"][]) => void;
    vi.mocked(f.ports.groupIds).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    );
    const reauthorization = f.streams.source.reauthorize(alice);
    release!();
    await vi.advanceTimersByTimeAsync(50);
    expect(
      a.messages.some(
        (message) => message.type === "host.browser-tabs" && message.stream.op === "end",
      ),
    ).toBe(false);
    authorize([]);
    await reauthorization;
    await vi.advanceTimersByTimeAsync(50);
    const removed = a.messages.findIndex(
      (message) =>
        message.type === "host.browser-groups" &&
        message.stream.op === "change" &&
        message.stream.remove?.includes(groupId),
    );
    expect(removed).toBeGreaterThan(0);
    expect(
      a.messages.slice(removed + 1).filter((message) => message.type === "host.browser-tabs"),
    ).toEqual([]);
    f.visible = true;
    await f.streams.source.reauthorize(alice);
    await vi.advanceTimersByTimeAsync(50);
    const next = a.messages.findLast(
      (message) => message.type === "host.browser-tabs" && message.stream.op === "begin",
    );
    expect(next).toBeDefined();
    expect(next).not.toEqual(first);
    f.streams.close();
  });
  it("projects only the changed tab per viewer, with constant bytes at 10 and 1,000 rows and no duplicate after its write", async () => {
    vi.useFakeTimers();
    const sizes: number[] = [];
    for (const count of [10, 1000]) {
      const f = fixture(count);
      const a = await f.attach(),
        second = await f.attach(),
        b = await f.attach(bob);
      a.messages.length = second.messages.length = b.messages.length = 0;
      vi.mocked(f.ports.groupIds).mockClear();
      vi.mocked(f.ports.readGroups).mockClear();
      vi.mocked(f.ports.readTabs).mockClear();
      const project = vi.spyOn(f.ports, "occupants");
      f.records.set(tabId, { ...f.records.get(tabId)!, title: "Changed" });
      f.streams.source.markTabs(groupId, [tabId]);
      await vi.advanceTimersByTimeAsync(50);
      expect(project).toHaveBeenCalledTimes(2);
      expect(f.ports.groupIds).not.toHaveBeenCalled();
      expect(f.ports.readGroups).not.toHaveBeenCalled();
      expect(f.ports.readTabs).not.toHaveBeenCalled();
      expect(a.messages).toHaveLength(1);
      expect(a.messages[0]).toMatchObject({
        type: "host.browser-tabs",
        stream: { op: "change", update: [{ id: tabId, title: "Changed" }] },
      });
      expect(JSON.stringify(a.messages)).not.toContain("private/path");
      sizes.push(keyedStreamBytes(a.messages[0]));
      a.messages.length = 0;
      const written = { ...f.durable.get(tabId)!, title: "Changed" };
      f.durable.set(tabId, written);
      f.streams.source.tabsWritten(groupId, [written], []);
      await vi.advanceTimersByTimeAsync(50);
      expect(a.messages).toHaveLength(0);
      f.streams.close();
    }
    expect(sizes[0]).toBe(sizes[1]);
  });
  it("suspends open durable tabs on session end and removes an empty terminal group", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const a = await f.attach();
    a.messages.length = 0;
    f.live = false;
    f.facts.state = "closed";
    await f.streams.source.groupChanged(groupId, { tabs: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(a.messages).toContainEqual(
      expect.objectContaining({
        type: "host.browser-tabs",
        stream: expect.objectContaining({
          update: [expect.objectContaining({ id: tabId, state: "suspended", documentId: null })],
        }),
      }),
    );
    expect(
      a.messages.some(
        (message) =>
          message.type === "host.browser-groups" &&
          message.stream.op === "change" &&
          message.stream.remove?.includes(groupId),
      ),
    ).toBe(false);
    a.messages.length = 0;
    f.durable.clear();
    f.facts.tabCount = 0;
    await f.streams.source.groupChanged(groupId, { tabs: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(a.messages).toEqual([
      expect.objectContaining({
        type: "host.browser-groups",
        stream: expect.objectContaining({ remove: [groupId] }),
      }),
    ]);
    f.streams.close();
  });
  it("repairs just the requested publishers and leaves the other connection untouched", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const other = "bsn_00000000-0000-4000-8000-000000000099" as BrowserGroupRow["id"];
    const facts = { ...f.facts, id: other, sessionId: other };
    const live = f.ports.live;
    f.ports.live = (id) => (id === other ? { ...live(groupId)!, groupId: other } : live(id));
    vi.mocked(f.ports.groupIds).mockResolvedValue([groupId, other]);
    vi.mocked(f.ports.readGroups).mockImplementation(async (_user, ids) =>
      [f.facts, facts].filter((row) => ids.includes(row.id)),
    );
    vi.mocked(f.ports.readTabs).mockImplementation(async (ids) =>
      ids.flatMap((id) =>
        [...f.durable.values()].map((row) => ({ ...row, groupId: id, sessionId: id })),
      ),
    );
    const a = await f.attach(),
      b = await f.attach();
    a.messages.length = b.messages.length = 0;
    a.resync(other);
    await vi.advanceTimersByTimeAsync(50);
    expect(
      a.messages
        .filter((message) => message.stream.op === "begin")
        .map((message) => (message.type === "host.browser-tabs" ? message.groupId : "groups")),
    ).toEqual([other]);
    a.messages.length = 0;
    a.resync();
    await vi.advanceTimersByTimeAsync(50);
    expect(
      a.messages
        .filter((message) => message.stream.op === "begin")
        .map((message) => (message.type === "host.browser-tabs" ? message.groupId : "groups")),
    ).toEqual(["groups", groupId, other]);
    expect(b.messages).toHaveLength(0);
    const project = vi.spyOn(f.ports, "occupants");
    f.facts.attachedRunIds = [
      "run_00000000-0000-4000-8000-000000000001" as BrowserGroupRow["attachedRunIds"][number],
    ];
    await f.streams.source.groupChanged(groupId);
    expect(project).not.toHaveBeenCalled();
    f.streams.close();
  });
  it("keeps restoring labels through a blank record and overlays sleep without a durable write", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.durable.set(tabId, { ...f.durable.get(tabId)!, state: "restoring" });
    f.records.set(tabId, { ...f.records.get(tabId)!, title: "", url: "about:blank" });
    const a = await f.attach();
    const rows = a.messages.flatMap((message) =>
      message.type === "host.browser-tabs" && message.stream.op === "rows"
        ? message.stream.rows
        : [],
    );
    expect(rows).toMatchObject([
      {
        id: tabId,
        state: "restoring",
        title: "Page",
        site: "https://example.com",
        documentId: null,
      },
    ]);
    a.messages.length = 0;
    f.records.set(tabId, {
      ...f.records.get(tabId)!,
      title: "Restored",
      url: "https://example.com/restored",
      state: "suspended",
    });
    vi.mocked(f.ports.readTabs).mockClear();
    f.streams.source.markTabs(groupId, [tabId]);
    await vi.advanceTimersByTimeAsync(50);
    expect(a.messages).toContainEqual(
      expect.objectContaining({
        type: "host.browser-tabs",
        stream: expect.objectContaining({
          update: [expect.objectContaining({ state: "suspended", title: "Restored" })],
        }),
      }),
    );
    expect(f.ports.readTabs).not.toHaveBeenCalled();
    expect(f.durable.get(tabId)?.state).toBe("restoring");
    f.streams.close();
  });
  it("keeps a regrant pending when a revoked publisher's final send completes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release: (() => void) | undefined;
    const a = await f.attach(
      alice,
      () => 0,
      async (frame) => {
        if (frame.type === "host.browser-tabs" && frame.stream.op === "end" && !release)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
    );
    expect(release).toBeDefined();
    f.visible = false;
    await f.streams.source.reauthorize(alice);
    f.visible = true;
    await f.streams.source.reauthorize(alice);
    release!();
    await vi.advanceTimersByTimeAsync(50);
    const starts = a.messages.filter(
      (frame) => frame.type === "host.browser-tabs" && frame.stream.op === "begin",
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]).not.toEqual(starts[1]);
    f.streams.close();
  });
  it("does not read durable rows for a group no connected person may see", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const a = await f.attach();
    a.messages.length = 0;
    const hidden = "bsn_00000000-0000-4000-8000-000000000088" as BrowserGroupRow["id"];
    const live = f.ports.live;
    f.ports.live = (id) => (id === hidden ? undefined : live(id));
    vi.mocked(f.ports.groupId).mockResolvedValue(hidden);
    vi.mocked(f.ports.readTabs).mockClear();
    await f.streams.source.groupChanged(hidden, { tabs: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(f.ports.readTabs).not.toHaveBeenCalled();
    expect(a.messages).toHaveLength(0);
    f.streams.close();
  });
  it("keeps durable rows when another viewer disconnects during a shared-cache attach", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.live = false;
    f.facts.state = "closed";
    const b = await f.attach(bob);
    const frames: BrowserClientStreamMessage[] = [];
    const attaching = f.streams.attach(alice, {
      bufferedAmount: () => 0,
      send: async (frame) => {
        frames.push(frame);
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    b.close();
    await attaching;
    await vi.advanceTimersByTimeAsync(50);
    expect(
      frames.flatMap<BrowserGroupRow | BrowserTabRow>((frame) =>
        frame.type === "host.browser-tabs" && frame.stream.op === "rows" ? frame.stream.rows : [],
      ),
    ).toMatchObject([{ id: tabId, state: "suspended", title: "Page" }]);
    f.streams.close();
  });
  it("discards a keyed group read started before reauthorization", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const a = await f.attach();
    a.messages.length = 0;
    let finish!: (rows: BrowserGroupFacts[]) => void;
    vi.mocked(f.ports.readGroups).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = f.streams.source.groupChanged(groupId);
    await vi.advanceTimersByTimeAsync(0);
    f.visible = false;
    await f.streams.source.reauthorize(alice);
    finish([f.facts]);
    await old;
    await vi.advanceTimersByTimeAsync(50);
    expect(a.messages).toEqual([
      expect.objectContaining({
        type: "host.browser-groups",
        stream: expect.objectContaining({ remove: [groupId] }),
      }),
    ]);
    f.streams.close();
  });
});
