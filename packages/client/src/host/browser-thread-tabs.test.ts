import type { PlaceOccupant } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { BrowserSessionIdSchema, BrowserSurfaceIdSchema, ThreadIdSchema } from "@opensteer/core";
import type {
  BrowserTabRow as BrowserTabSummary,
  BrowserGroupRow,
} from "@opensteer/protocol/browser-tabs";
import { browserStoreFixture } from "../test-support/browser-snapshot.js";
import type { BrowserSessionSummary, PlaceEntry } from "./client.js";
import { browserThreadAgentTab, browserThreadTabs } from "./browser-thread-tabs.js";

const thread = ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000001");
const other = ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000002");
const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001");
const occupant = (overrides: Partial<PlaceOccupant> = {}): PlaceOccupant => ({
  threadId: thread,
  home: false,
  holding: false,
  acting: false,
  lastActiveAt: "2026-11-01T10:00:00Z",
  ...overrides,
});
const tab = (id: string, order: number, occupants: PlaceOccupant[] = []): BrowserTabSummary => ({
  id: BrowserSurfaceIdSchema.parse(id),
  order,
  occupants,
  title: id,
  site: "https://example.com",
  iconRef: null,
  openerId: null,
  documentId: null,
  availability: "ready",
  loading: false,
  navigationFailed: false,
  canGoBack: false,
  canGoForward: false,
  sessionId,
  createdAt: "2026-01-01",
  state: "live",
});
const session = (tabs: BrowserTabSummary[]): Pick<BrowserSessionSummary, "id" | "browserTabs"> => ({
  id: sessionId,
  browserTabs: browserStoreFixture(
    [{ id: sessionId, sessionId, createdAt: "2026-01-01" } as BrowserGroupRow],
    [{ groupId: sessionId, rows: tabs }],
  ),
});
const place = (id: string): PlaceEntry => ({
  id,
  kind: "place",
  runId: "run",
  createdAt: "2026-11-01T10:00:00Z",
  title: id,
  site: null,
  place: { kind: "browser", sessionId, surfaceId: BrowserSurfaceIdSchema.parse(id) },
});

describe("Thread browser tabs", () => {
  it("ranks only that Thread's occupants by acting, holding, recency, then browser order", () => {
    const a = tab("a", 1, [occupant({ holding: true, lastActiveAt: "2026-11-01T12:00:00Z" })]);
    const b = tab("b", 2, [occupant({ acting: true })]);
    const c = tab("c", 3, [
      occupant({ threadId: other, acting: true, lastActiveAt: "2026-11-01T15:00:00Z" }),
    ]);
    expect(browserThreadAgentTab([session([c, a, b])], thread)?.tabId).toBe("b");
    expect(browserThreadAgentTab([session([c, a])], thread)?.tabId).toBe("a");
    const d = tab("d", 4, [occupant({ acting: true, holding: true })]);
    expect(browserThreadAgentTab([session([b, d])], thread)?.tabId).toBe("d");
    const e = tab("e", 5, [occupant({ acting: true, lastActiveAt: "2026-11-01T11:00:00Z" })]);
    expect(browserThreadAgentTab([session([b, e])], thread)?.tabId).toBe("e");
    expect(browserThreadAgentTab([session([tab("z", 6, b.occupants), b])], thread)?.tabId).toBe(
      "b",
    );
    expect(browserThreadAgentTab([session([c])], thread)).toBeNull();
  });

  it("unions occupancy and transcript history, preserves order and remembered membership, drops closed tabs", () => {
    const a = tab("a", 1, [occupant()]);
    const b = tab("b", 2);
    const c = tab("c", 3, [occupant({ threadId: other, acting: true })]);
    const foreignPlace = place("c");
    foreignPlace.place = {
      kind: "browser",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000002"),
      surfaceId: c.id,
    };
    const first = browserThreadTabs(session([c, b, a]), thread, [
      place("b"),
      place("closed"),
      foreignPlace,
    ]);
    expect(first.taskTabs.map((row) => row.id)).toEqual(["a", "b"]);
    expect(first.otherTabs.map((row) => row.id)).toEqual(["c"]);
    const next = browserThreadTabs(session([{ ...a, occupants: [] }, b, c]), thread, [], first);
    expect(next.taskTabs.map((row) => row.id)).toEqual(["a", "b"]);
    expect(browserThreadTabs(session([b, c]), thread, [], next).rememberedTabIds).toEqual(["b"]);
    expect(browserThreadTabs(session([b]), other, [], next).taskTabs).toEqual([]);
  });
});
