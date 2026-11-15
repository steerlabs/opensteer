import { describe, expect, it } from "vitest";
import { ComposerRevision, type NativeComposerState } from "./composer-editor-revision.js";

const caret = (at: number) => ({ start: at, end: at });
const native = (
  eventCount: number,
  value: string,
  selection = caret(value.length),
  generation = 0,
): NativeComposerState => ({ composing: false, eventCount, generation, selection, value });

describe("ComposerRevision", () => {
  it("drops native events delivered out of order", () => {
    const revision = new ComposerRevision();
    expect(revision.accept(native(2, "ab"))).toBe(true);
    expect(revision.accept(native(1, "a")), "an older event arrived late").toBe(false);
    expect(revision.accept(native(2, "ab")), "a repeated event is not new").toBe(false);
    expect(revision.eventCount).toBe(2);
  });

  it("stamps a lagging render behind native so it cannot restore stale text", () => {
    const revision = new ComposerRevision();
    revision.accept(native(1, "a"));
    revision.accept(native(2, "ab"));
    // React re-renders with the first keystroke while native already holds the second.
    const stale = revision.stamp("a", caret(1));
    expect(stale).toMatchObject({ eventCount: 1, isNativeEcho: false });
    // The latest native text and caret are an echo native keeps as it is.
    expect(revision.stamp("ab", caret(2))).toMatchObject({ eventCount: 2, isNativeEcho: true });
    // The latest text with a caret from an earlier render stays behind too.
    expect(revision.stamp("ab", caret(1)).eventCount).toBe(1);
    // A parent edit computed after the latest event is applied at its revision.
    expect(revision.stamp("ab [x](opensteer:thr_1) ", caret(24))).toMatchObject({
      eventCount: 2,
      isNativeEcho: false,
    });
  });

  it("keeps the newest acknowledged state an echo after settling, however long the backlog", () => {
    const revision = new ComposerRevision();
    for (let count = 1; count <= 500; count += 1) revision.accept(native(count, "x".repeat(count)));
    const value = "x".repeat(500);
    const stamp = revision.stamp(value, caret(500));
    revision.settle(stamp, value, caret(500));
    expect(revision.stamp(value, caret(500)).isNativeEcho).toBe(true);
    // Native typing past the settled render is still accepted.
    expect(revision.accept(native(501, value + "y"))).toBe(true);
  });

  it("re-applies a parent value that returns to text native reported earlier", () => {
    const revision = new ComposerRevision();
    revision.accept(native(3, "typed"));
    const cleared = revision.stamp("", caret(0));
    revision.settle(cleared, "", caret(0));
    const back = revision.stamp("typed", caret(5));
    expect(back).toMatchObject({ eventCount: 3, isNativeEcho: false });
  });

  it("lets a reset win over native edits the parent could not see, and drops them", () => {
    const revision = new ComposerRevision();
    revision.accept(native(4, "sent words"));
    const generation = revision.reset();
    expect(generation).toBe(1);
    const reset = revision.stamp("", caret(0));
    expect(reset).toEqual({ eventCount: 4, generation: 1, isNativeEcho: false });
    revision.settle(reset, "", caret(0));
    // A keystroke native made before it applied the reset describes replaced text.
    expect(revision.accept(native(5, "sent words!", caret(11), 0))).toBe(false);
    // Native restarts at the reset's stamp; its next event is accepted.
    expect(revision.accept(native(5, "n", caret(1), 1))).toBe(true);
    expect(revision.stamp("n", caret(1))).toMatchObject({ eventCount: 5, isNativeEcho: true });
  });

  it("acknowledges a flush's native state once, without duplicating a delivered event", () => {
    const revision = new ComposerRevision();
    revision.accept(native(7, "almost"));
    // The final word's change event has not reached JS; the flush reads native directly.
    const flushed = native(8, "almost done");
    expect(revision.accept(flushed)).toBe(true);
    // Its event arriving afterwards is the same revision, not a new edit.
    expect(revision.accept(flushed)).toBe(false);
    expect(revision.stamp("almost done", caret(11)).isNativeEcho).toBe(true);
  });
});
