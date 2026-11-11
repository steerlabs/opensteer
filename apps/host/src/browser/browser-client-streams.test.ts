import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserClientStreams, type BrowserClientStreamMessage } from "./browser-client-streams.js";
import type { BrowserGroupRow, BrowserTabRow } from "@opensteer/protocol/browser-tabs";
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
afterEach(() => vi.useRealTimers());
describe("BrowserClientStreams", () => {
  it("shares viewer projections but keeps each connection's revision independent", async () => {
    vi.useFakeTimers();
    let visible = true,
      acting = false;
    const streams = new BrowserClientStreams({
      read: async (user) => ({
        groups: visible || user === bob ? [group] : [],
        tabs: new Map([
          [
            groupId,
            [
              {
                ...tab,
                occupants:
                  user === alice && acting
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
                    : [],
              },
            ],
          ],
        ]),
      }),
      onError: (error) => {
        throw error;
      },
    });
    const a: BrowserClientStreamMessage[] = [],
      b: BrowserClientStreamMessage[] = [],
      second: BrowserClientStreamMessage[] = [];
    const connect = (user: UserId, messages: BrowserClientStreamMessage[]) =>
      streams.attach(user, {
        send: async (message) => {
          messages.push(message);
        },
        bufferedAmount: () => 0,
      });
    const first = await connect(alice, a);
    await connect(bob, b);
    await vi.advanceTimersByTimeAsync(50);
    await connect(alice, second);
    await vi.advanceTimersByTimeAsync(50);
    a.length = b.length = second.length = 0;
    acting = true;
    await streams.refresh();
    await vi.advanceTimersByTimeAsync(50);
    expect(a).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(b).toHaveLength(0);
    expect(a[0]?.type).toBe("host.browser-tabs");
    a.length = 0;
    visible = false;
    await streams.refresh(alice);
    await vi.advanceTimersByTimeAsync(50);
    expect(a).toEqual([
      expect.objectContaining({
        type: "host.browser-groups",
        stream: expect.objectContaining({ op: "change", remove: [groupId] }),
      }),
    ]);
    a.length = 0;
    acting = false;
    await streams.refresh();
    first.resync(groupId);
    await vi.advanceTimersByTimeAsync(50);
    expect(a).toHaveLength(0);
    streams.close();
  });
  it("coalesces a blocked connection to the latest title without a backlog", async () => {
    vi.useFakeTimers();
    let title = "Page",
      blocked = false;
    const messages: BrowserClientStreamMessage[] = [];
    const streams = new BrowserClientStreams({
      read: async () => ({ groups: [group], tabs: new Map([[groupId, [{ ...tab, title }]]]) }),
      onError: (error) => {
        throw error;
      },
    });
    await streams.attach(alice, {
      send: async (message) => {
        messages.push(message);
      },
      bufferedAmount: () => (blocked ? 300_000 : 0),
    });
    await vi.advanceTimersByTimeAsync(50);
    messages.length = 0;
    blocked = true;
    title = "Old";
    await streams.refresh();
    await vi.advanceTimersByTimeAsync(50);
    title = "Latest";
    await streams.refresh();
    await vi.advanceTimersByTimeAsync(50);
    expect(messages).toHaveLength(0);
    blocked = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(messages).toEqual([
      expect.objectContaining({
        type: "host.browser-tabs",
        stream: expect.objectContaining({ op: "change", update: [{ id: tabId, title: "Latest" }] }),
      }),
    ]);
    streams.close();
  });
  it("drops a revoked group's publisher during an unfinished tab snapshot", async () => {
    vi.useFakeTimers();
    let visible = true;
    let release: (() => void) | undefined;
    const messages: BrowserClientStreamMessage[] = [];
    const streams = new BrowserClientStreams({
      read: async () => ({
        groups: visible ? [group] : [],
        tabs: new Map([
          [
            groupId,
            Array.from({ length: 200 }, (_, index) => ({
              ...tab,
              id: `surface_${index}` as BrowserTabRow["id"],
              title: "x".repeat(256),
              order: index,
            })),
          ],
        ]),
      }),
      onError: (error) => {
        throw error;
      },
    });
    await streams.attach(alice, {
      bufferedAmount: () => 0,
      send: async (message) => {
        messages.push(message);
        if (message.type === "host.browser-tabs" && message.stream.op === "rows" && !release)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(release).toBeDefined();
    visible = false;
    await streams.refresh(alice);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    const removed = messages.findIndex(
      (message) =>
        message.type === "host.browser-groups" &&
        message.stream.op === "change" &&
        message.stream.remove?.includes(groupId),
    );
    expect(removed).toBeGreaterThan(0);
    expect(
      messages.slice(removed + 1).filter((message) => message.type === "host.browser-tabs"),
    ).toEqual([]);
    expect(
      messages.some(
        (message) => message.type === "host.browser-tabs" && message.stream.op === "end",
      ),
    ).toBe(false);
    streams.close();
  });
});
