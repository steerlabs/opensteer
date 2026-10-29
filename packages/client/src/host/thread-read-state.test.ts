import { describe, expect, it } from "vitest";
import { SequenceSchema, ThreadIdSchema, type ThreadReadState } from "@opensteer/core";
import { isThreadUnread, mergeThreadReadState } from "./thread-read-state.js";

const threadId = ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000001");
function state(cut: string, read: string | null, unread: string | null): ThreadReadState {
  return {
    threadId,
    asOfSequence: SequenceSchema.parse(cut),
    readSequence: read === null ? null : SequenceSchema.parse(read),
    unreadSequence: unread === null ? null : SequenceSchema.parse(unread),
  };
}

describe("authoritative read positions", () => {
  it("keeps a new arrival unread across either delivery order of a read response", () => {
    const read = state("10", "2", null);
    const arrival = state("11", "1", "3");
    for (const [first, second] of [
      [read, arrival],
      [arrival, read],
    ] as const) {
      const merged = mergeThreadReadState(first, second);
      expect(merged).toEqual(state("11", "2", "3"));
      expect(isThreadUnread(merged)).toBe(true);
    }
  });
  it("accepts a newer read marker from an older content cut without reviving cancelled content", () => {
    const cancellation = state("12", "1", null);
    const delayedMark = state("11", "3", null);
    for (const [first, second] of [
      [cancellation, delayedMark],
      [delayedMark, cancellation],
    ] as const) {
      const merged = mergeThreadReadState(first, second);
      expect(merged).toEqual(state("12", "3", null));
      expect(isThreadUnread(merged)).toBe(false);
    }
  });
  it("converges for same-cut responses computed on either side of a mark", () => {
    const unread = state("10", null, "2");
    const read = state("10", "2", null);
    expect(mergeThreadReadState(unread, read)).toEqual(mergeThreadReadState(read, unread));
    expect(isThreadUnread(mergeThreadReadState(unread, read))).toBe(false);
  });
  it("lets a cancellation lower the candidate, even when a stale page finishes later", () => {
    const before = state("10", "1", "5");
    const cancelled = state("11", "1", "3");
    expect(mergeThreadReadState(cancelled, before)).toEqual(cancelled);
    expect(mergeThreadReadState(before, cancelled)).toEqual(cancelled);
  });
  it("is associative and idempotent across a burst of page, mark, arrival and cancellation results", () => {
    const states = [
      state("10", null, "2"),
      state("10", "2", null),
      state("11", "2", "3"),
      state("12", "2", null),
    ];
    for (const a of states) {
      expect(mergeThreadReadState(a, a)).toEqual(a);
      for (const b of states)
        for (const c of states) {
          expect(mergeThreadReadState(mergeThreadReadState(a, b), c)).toEqual(
            mergeThreadReadState(a, mergeThreadReadState(b, c)),
          );
        }
    }
  });
});
