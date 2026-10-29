import { createBrowserSessionId } from "@opensteer/protocol/browser";
import { describe, expect, it, vi } from "vitest";
import { PlaceActivityStore, placeActivityPoint } from "./place-activity.js";
import { BrowserSurfaceIdSchema, createId } from "@opensteer/core";

const sessionId = createBrowserSessionId();
const surfaceId = BrowserSurfaceIdSchema.parse("tab-x");
const otherSurfaceId = BrowserSurfaceIdSchema.parse("tab-y");
const place = { kind: "browser" as const, sessionId, surfaceId };
const key = `browser:${sessionId}:tab-x`;
const other = { kind: "browser" as const, sessionId, surfaceId: otherSurfaceId };
const otherKey = `browser:${sessionId}:tab-y`;
const threadId = createId("thread");
const runId = createId("run");
const activity = {
  place,
  threadId,
  home: false,
  runId,
  generation: 1,
  seq: 1,
  order: 1,
  at: 1000,
  expiresAt: 2000,
  pointer: { x: 0.2, y: 0.8 },
  geometryRevision: 1,
};
const header = {
  surfaceId,
  geometryRevision: 1,
  viewportWidth: 1000,
  viewportHeight: 800,
};

/*
 * Ways the store can fail its presence contract:
 *  - a record goes when its wire `expiresAt` passes, though the agent is still there;
 *  - a replayed or older record replaces a newer one, or comes back after a clear;
 *  - a pointer-less record hides the agent instead of keeping it present;
 *  - the same Run acting in another place stays in the first one;
 *  - an older arrival from another place, delivered last, moves the Run back;
 *  - two Runs that share a thread id, in two places, lose one of their records;
 *  - a place is notified for a change that is not its own.
 */
describe("place activity presence", () => {
  it("keeps a record past its wire expiry, rejects replay and honors null and clear", () => {
    vi.useFakeTimers();
    try {
      const store = new PlaceActivityStore();
      const changed = vi.fn();
      const unrelated = vi.fn();
      store.subscribe(key, changed);
      store.subscribe("elsewhere", unrelated);
      store.apply({ type: "host.place-activity", activity });
      store.apply({ type: "host.place-activity", activity: { ...activity, seq: 0 } });
      expect(store.get(key)[0]?.pointer).toEqual(activity.pointer);
      vi.advanceTimersByTime(60_000);
      expect(store.get(key)).toHaveLength(1);
      store.apply({
        type: "host.place-activity",
        activity: { ...activity, seq: 2, order: 2, pointer: null },
      });
      expect(store.get(key)).toEqual([expect.objectContaining({ pointer: null, placeKey: key })]);
      store.apply({ type: "host.place-activity-cleared", place, runId, generation: 1, seq: 3 });
      store.apply({ type: "host.place-activity", activity: { ...activity, seq: 2, order: 3 } });
      expect(store.get(key)).toEqual([]);
      store.apply({
        type: "host.place-activity",
        activity: { ...activity, generation: 2, order: 4 },
      });
      vi.advanceTimersByTime(60_000);
      expect(store.get(key)).toHaveLength(1);
      expect(unrelated).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledTimes(4);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a Run to the place it acted in last, whatever order the places arrive in", () => {
    const store = new PlaceActivityStore();
    const here = vi.fn();
    const there = vi.fn();
    store.subscribe(key, here);
    store.subscribe(otherKey, there);
    store.apply({ type: "host.place-activity", activity: { ...activity, order: 5 } });
    store.apply({
      type: "host.place-activity",
      activity: { ...activity, place: other, seq: 2, order: 6 },
    });
    expect(store.get(key)).toEqual([]);
    expect(store.get(otherKey)).toEqual([expect.objectContaining({ runId, order: 6 })]);
    expect(here).toHaveBeenCalledTimes(2);
    // Each place flushes on its own timer: an older record from the first place arrives last.
    store.apply({ type: "host.place-activity", activity: { ...activity, seq: 3, order: 4 } });
    expect(store.get(key)).toEqual([]);
    expect(store.get(otherKey)).toHaveLength(1);
    expect(here).toHaveBeenCalledTimes(2);
    store.apply({ type: "host.place-activity", activity: { ...activity, seq: 4, order: 7 } });
    expect(store.get(key)).toEqual([expect.objectContaining({ runId, order: 7 })]);
    expect(store.get(otherKey)).toEqual([]);
    expect(there).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("keeps two Runs that share a thread id in two places, and one per thread in a place", () => {
    const store = new PlaceActivityStore();
    const delegated = createId("run");
    store.apply({ type: "host.place-activity", activity });
    store.apply({
      type: "host.place-activity",
      activity: { ...activity, place: other, runId: delegated, order: 2 },
    });
    expect(store.get(key)).toEqual([expect.objectContaining({ runId })]);
    expect(store.get(otherKey)).toEqual([expect.objectContaining({ runId: delegated })]);
    store.apply({
      type: "host.place-activity",
      activity: { ...activity, runId: delegated, seq: 2, order: 3 },
    });
    expect(store.get(key)).toEqual([expect.objectContaining({ runId: delegated, order: 3 })]);
    expect(store.get(otherKey)).toEqual([]);
    store.dispose();
  });

  it("reconciles places away and starts over after clear", () => {
    const store = new PlaceActivityStore();
    store.apply({ type: "host.place-activity", activity: { ...activity, order: 9 } });
    store.reconcile(new Set([otherKey]));
    expect(store.get(key)).toEqual([]);
    store.apply({ type: "host.place-activity", activity: { ...activity, seq: 2, order: 10 } });
    store.clear();
    expect(store.get(key)).toEqual([]);
    // A new connection's Host counts again: nothing from before the clear holds it back.
    store.apply({
      type: "host.place-activity",
      activity: { ...activity, place: other, order: 1 },
    });
    expect(store.get(otherKey)).toHaveLength(1);
    store.dispose();
  });
});

/*
 * Ways the point helper can fail: a pointer is drawn against geometry it was not
 * measured in, on another surface or with no pointer at all, instead of saying
 * nothing; a point outside the captured region is drawn instead of hidden; a
 * point inside it is not re-normalised into the region.
 */
describe("a record's point on a drawn picture", () => {
  const record = { ...activity, placeKey: key };
  it("re-normalises into the captured region and hides outside it", () => {
    expect(placeActivityPoint(record, header)).toEqual({ kind: "point", x: 0.2, y: 0.8 });
    const capture = { width: 500, height: 400, revision: 1 };
    expect(
      placeActivityPoint({ ...record, pointer: { x: 0.25, y: 0.5 } }, { ...header, capture }),
    ).toEqual({ kind: "point", x: 0.5, y: 1 });
    expect(placeActivityPoint(record, { ...header, capture })).toEqual({ kind: "hidden" });
    expect(
      placeActivityPoint({ ...record, pointer: { x: 0.6, y: 0.1 } }, { ...header, capture }),
    ).toEqual({ kind: "hidden" });
  });
  it("says nothing for no pointer, another surface, other geometry or another kind of place", () => {
    const unknown = { kind: "unknown" };
    expect(placeActivityPoint({ ...record, pointer: null }, header)).toEqual(unknown);
    expect(placeActivityPoint(record, { ...header, surfaceId: otherSurfaceId })).toEqual(unknown);
    expect(placeActivityPoint(record, { ...header, geometryRevision: 2 })).toEqual(unknown);
    expect(placeActivityPoint(record, { ...header, geometryRevision: undefined })).toEqual(unknown);
    expect(
      placeActivityPoint(
        {
          ...record,
          place: { kind: "app", machineId: createId("runner"), appKey: "com.apple.notes" },
        },
        header,
      ),
    ).toEqual(unknown);
  });
});
