import { createId } from "@opensteer/core";
import {
  BrowserGroupRowSchema,
  BrowserTabRowSchema,
  BrowserTabRecordSchema,
} from "./browser-tabs.js";
import { describe, expect, it } from "vitest";
import {
  KeyedStreamPublisher,
  KeyedStreamReceiver,
  keyedStreamBytes,
  keyedStreamHardCapBytes,
} from "./keyed-stream.js";

type Row = { id: string; title: string; order: number };
function fixture(count = 10, targetBytes = 256) {
  const rows = new Map(
    Array.from({ length: count }, (_, order) => [
      String(order),
      { id: String(order), title: "Title", order },
    ]),
  );
  const publisher = new KeyedStreamPublisher({
    ids: () => rows.keys(),
    read: (id) => rows.get(id),
    meta: () => ({ activeId: "0" }),
    targetBytes,
    envelopeBytes: 40,
  });
  const receiver = new KeyedStreamReceiver<Row, { activeId: string }>();
  function drain() {
    const frames = [];
    for (let frame = publisher.next(); frame; frame = publisher.next()) {
      frames.push(frame);
      receiver.apply(frame);
      publisher.settled(frame, true);
    }
    return frames;
  }
  return { rows, publisher, receiver, drain };
}
describe("keyed streams", () => {
  it("continues a seeded prefix without implying closes until the matching end", () => {
    const f = fixture();
    const prefix = [...f.rows.values()].slice(0, 3);
    f.receiver.seed(prefix, { activeId: "0" });
    f.publisher.seed(prefix);
    const begin = f.publisher.next()!;
    expect(begin).toMatchObject({ op: "begin", prefix: 3 });
    expect(f.receiver.apply(begin)).toBe("staged");
    f.publisher.settled(begin, true);
    f.rows.delete("0");
    f.publisher.mark("0");
    const firstRows = f.publisher.next()!;
    expect(f.receiver.apply(firstRows)).toBe("staged");
    expect([...f.receiver.rows.values()]).toEqual(prefix);
    f.publisher.settled(firstRows, true);
    const frames = [firstRows, ...f.drain()];
    expect(frames.filter((frame) => frame.op === "rows").flatMap((frame) => frame.rows)).toEqual(
      [...f.rows.values()].slice(2),
    );
    expect(frames.at(-1)).toMatchObject({ op: "change", remove: ["0"] });
    expect(f.receiver.rows.size).toBe(9);
    f.publisher.reset();
    expect(f.publisher.next()).not.toHaveProperty("prefix");
    const empty = fixture();
    expect(empty.receiver.apply({ op: "begin", generation: "bad", prefix: 3 })).toBe("resync");
    expect(empty.receiver.rows.size).toBe(0);
  });
  it("sends one field at the same size regardless of catalog size", () => {
    const sizes = [10, 1000].map((count) => {
      const f = fixture(count);
      f.drain();
      f.rows.set("0", { ...f.rows.get("0")!, title: "Changed" });
      f.publisher.mark("0");
      const frames = f.drain();
      expect(frames).toEqual([
        {
          op: "change",
          generation: expect.any(String),
          base: 0,
          revision: 1,
          update: [{ id: "0", title: "Changed" }],
        },
      ]);
      return keyedStreamBytes(frames[0]);
    });
    expect(sizes[0]).toBe(sizes[1]);
  });
  it("stages snapshots, requests a gap once, and retains committed identities", () => {
    const f = fixture();
    f.drain();
    const before = f.receiver.rows.get("0");
    f.receiver.apply({ op: "begin", generation: "next" });
    f.receiver.apply({ op: "rows", rows: [{ id: "other", title: "Other", order: 1 }] });
    expect(f.receiver.rows.get("0")).toBe(before);
    expect(
      f.receiver.apply({ op: "end", count: 2, revision: 0, meta: { activeId: "other" } }),
    ).toBe("resync");
    expect(f.receiver.apply({ op: "rows", rows: [] })).toBe("staged");
    expect(f.receiver.rows.get("0")).toBe(before);
    f.publisher.reset();
    f.drain();
    expect(f.receiver.rows.get("0")).toBe(before);
    f.rows.set("1", { ...f.rows.get("1")!, title: "Changed" });
    f.publisher.mark("1");
    f.drain();
    expect(f.receiver.rows.get("0")).toBe(before);
    const bad = { op: "change" as const, generation: "wrong", base: 1, revision: 2, remove: ["0"] };
    expect(f.receiver.apply(bad)).toBe("resync");
    expect(f.receiver.apply(bad)).toBe("staged");
    expect(f.receiver.rows.get("0")).toBe(before);
  });
  it("merges changes while a snapshot is in flight and preserves closes", () => {
    const f = fixture();
    let frame = f.publisher.next()!;
    f.receiver.apply(frame);
    f.publisher.settled(frame, true);
    frame = f.publisher.next()!;
    expect(frame.op).toBe("rows");
    f.rows.set("0", { ...f.rows.get("0")!, title: "Newest" });
    f.publisher.mark("0");
    f.rows.set("new", { id: "new", title: "New", order: 20 });
    f.publisher.mark("new");
    f.rows.delete("new");
    f.publisher.mark("new");
    f.rows.delete("1");
    f.publisher.mark("1");
    f.receiver.apply(frame);
    f.publisher.settled(frame, true);
    const frames = f.drain();
    expect(frames.at(-1)).toMatchObject({
      op: "change",
      update: [{ id: "0", title: "Newest" }],
      remove: ["1"],
    });
    expect(f.receiver.rows.get("0")?.title).toBe("Newest");
    expect(f.receiver.rows.has("1")).toBe(false);
    expect(f.receiver.rows.has("new")).toBe(false);
  });
  it.each(["before", "during"])(
    "preserves a durable removal when the close happens %s a reset snapshot",
    (timing) => {
      const f = fixture();
      f.drain();
      f.publisher.reset();
      if (timing === "during") {
        const begin = f.publisher.next()!;
        f.receiver.apply(begin);
        f.publisher.settled(begin, true);
      }
      f.rows.delete("0");
      f.publisher.mark("0");
      const frames = f.drain();
      expect(
        frames.some((frame) => frame.op === "change" && frame.remove?.includes("0")),
        "A snapshot must not absorb a durable close.",
      ).toBe(true);
      expect(f.receiver.rows.has("0")).toBe(false);
    },
  );
  it("retries a refused frame whole before advancing its revision", () => {
    const f = fixture();
    f.drain();
    f.rows.delete("0");
    f.publisher.mark("0");
    const frame = f.publisher.next()!;
    f.publisher.settled(frame, false);
    f.rows.set("1", { ...f.rows.get("1")!, title: "After" });
    f.publisher.mark("1");
    expect(f.publisher.next()).toBe(frame);
    f.receiver.apply(frame);
    f.publisher.settled(frame, true);
    expect(f.drain()).toMatchObject([
      { base: 1, revision: 2, update: [{ id: "1", title: "After" }] },
    ]);
  });
  it("retains nested row identity and reports structural changes only for membership or order", () => {
    type Nested = Row & { occupants: { name: string }[] };
    const receiver = new KeyedStreamReceiver<Nested, Record<string, never>>();
    const events: { structural: boolean; updated: string[] }[] = [];
    receiver.onChange((change) => events.push(change));
    const row = { id: "a", title: "Title", order: 0, occupants: [{ name: "Person" }] };
    receiver.apply({ op: "begin", generation: "first" });
    receiver.apply({ op: "rows", rows: [row] });
    expect(receiver.rows.size).toBe(0);
    receiver.apply({ op: "end", count: 1, revision: 0, meta: {} });
    receiver.apply({ op: "begin", generation: "second" });
    receiver.apply({ op: "rows", rows: [{ ...row, occupants: [{ name: "Person" }] }] });
    receiver.apply({ op: "end", count: 1, revision: 0, meta: {} });
    expect(receiver.rows.get("a")).toBe(row);
    expect(events.at(-1)).toMatchObject({ structural: false, updated: [] });
    receiver.apply({
      op: "change",
      generation: "second",
      base: 0,
      revision: 1,
      update: [{ id: "a", title: "New" }],
    });
    expect(events.at(-1)).toMatchObject({ structural: false, updated: ["a"] });
    receiver.apply({
      op: "change",
      generation: "second",
      base: 1,
      revision: 2,
      update: [{ id: "a", order: 1 }],
    });
    expect(events.at(-1)).toMatchObject({ structural: true, updated: ["a"] });
  });
  it("packs UTF-8 bytes, allows a row above target, and rejects above the hard cap", () => {
    const f = fixture(1);
    f.rows.set("0", { id: "0", order: 0, title: "\u0000".repeat(16384) });
    const frames = f.drain();
    expect(frames.every((frame) => keyedStreamBytes(frame) + 40 <= keyedStreamHardCapBytes)).toBe(
      true,
    );
    expect(f.receiver.rows.get("0")?.title.length).toBe(16384);
    f.rows.set("0", { id: "0", order: 0, title: "x".repeat(keyedStreamHardCapBytes) });
    f.publisher.mark("0");
    expect(() => f.publisher.next()).toThrow("hard byte cap");
  });
});

it("fits the worst legal runtime, client tab and group rows including envelopes", () => {
  const bad = (size: number) => "\u0000".repeat(size);
  const date = "2026-11-10T00:00:00." + "0".repeat(43) + "Z";
  const sessionId = "bsn_00000000-0000-0000-0000-000000000000";
  const tab = BrowserTabRecordSchema.parse({
    id: bad(512),
    state: "suspended",
    title: bad(256),
    url: bad(16384),
    icon: "x".repeat(43),
    order: Number.MAX_SAFE_INTEGER,
    openerId: bad(512),
    documentId: bad(255),
    geometryRevision: Number.MAX_SAFE_INTEGER,
    loading: true,
    navigationFailed: true,
    canGoBack: true,
    canGoForward: true,
    sizedByAgent: true,
  });
  const row = BrowserTabRowSchema.parse({
    id: bad(512),
    sessionId,
    title: bad(256),
    site: bad(2048),
    iconRef: "x".repeat(128),
    order: Number.MAX_SAFE_INTEGER,
    openerId: bad(512),
    createdAt: date,
    state: "restoring",
    availability: "unavailable",
    loading: true,
    navigationFailed: true,
    documentId: bad(255),
    canGoBack: true,
    canGoForward: true,
    occupants: Array.from({ length: 16 }, () => ({
      threadId: createId("thread"),
      home: true,
      holding: true,
      acting: true,
      lastActiveAt: date,
    })),
  });
  const group = BrowserGroupRowSchema.parse({
    id: sessionId,
    createdAt: date,
    unavailableReason: bad(1000),
    tabCount: Number.MAX_SAFE_INTEGER,
    inventoryRevision: Number.MAX_SAFE_INTEGER,
    sessionId,
    workspaceId: createId("workspace"),
    state: "starting",
    origin: "workspace",
    access: "read-write",
    placement: { kind: "runner", runnerId: createId("runner") },
    profileId: createId("browserProfile"),
    runtimeId: bad(255),
    opener: { kind: "task", threadId: createId("thread") },
    navigation: true,
    sessionCreatedAt: date,
    updatedAt: date,
    acting: true,
    page: { title: bad(256), url: bad(2048) },
    attachedRunIds: Array.from({ length: 128 }, () => createId("run")),
    threadIds: Array.from({ length: 16 }, () => createId("thread")),
  });
  for (const value of [tab, row, group]) {
    expect(
      keyedStreamBytes({ type: "browser.tabs", stream: { op: "rows", rows: [value] } }) + 1024,
    ).toBeLessThan(keyedStreamHardCapBytes);
    expect(
      keyedStreamBytes({
        type: "browser.tabs",
        stream: {
          op: "change",
          generation: "x".repeat(64),
          base: Number.MAX_SAFE_INTEGER - 1,
          revision: Number.MAX_SAFE_INTEGER,
          add: [value],
        },
      }) + 1024,
    ).toBeLessThan(keyedStreamHardCapBytes);
  }
});
