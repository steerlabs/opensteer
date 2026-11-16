import { describe, expect, it } from "vitest";
import {
  freshRunPageMemory,
  runPageConsidered,
  runPageFolded,
  runPageSize,
  runPageOpened,
  runPagePaged,
  runPageShown,
} from "./run-page.js";

const idle = { visible: true, picture: true, cellular: false, scrolledUp: false, typing: false };

describe("the page above a conversation", () => {
  it.each([
    ["hidden", { ...idle, visible: false }],
    ["without a picture", { ...idle, picture: false }],
    ["typing", { ...idle, typing: true }],
    ["network unknown", { ...idle, cellular: null }],
  ])("defers while %s and opens when ready", (_, moment) => {
    const deferred = runPageConsidered(freshRunPageMemory, "run-1", moment);
    expect(deferred.run?.intent).toBe("undecided");
    const ready = runPageConsidered(deferred, "run-1", idle);
    expect(runPageShown(ready, "run-1", true)).toBe("page");
  });

  it.each([
    ["scrolled up", { ...idle, scrolledUp: true }],
    ["on cellular", { ...idle, cellular: true }],
  ])("consumes automatic opening when %s", (_, moment) => {
    const closed = runPageConsidered(freshRunPageMemory, "run-1", moment);
    expect(closed.run?.intent).toBe("closed");
    expect(runPageShown(runPageConsidered(closed, "run-1", idle), "run-1", true)).toBe("folded");
    expect(runPageShown(runPageConsidered(closed, "run-2", idle), "run-2", true)).toBe("page");
  });

  it("keeps an explicit fold across Runs until explicitly opened, even on cellular", () => {
    const folded = runPageFolded(runPageConsidered(freshRunPageMemory, "run-1", idle));
    const next = runPageConsidered(folded, "run-2", idle);
    expect(next.run?.intent).toBe("closed");
    const opened = runPageConsidered(runPageOpened("run-2", next), "run-2", {
      ...idle,
      cellular: true,
    });
    expect(opened.folded).toBe(false);
    expect(runPageShown(opened, "run-2", true)).toBe("page");
  });

  it("folds with too little room and returns when room does, without consuming the intent", () => {
    const opened = runPageConsidered(freshRunPageMemory, "run-1", idle);
    expect(runPageShown(opened, "run-1", false)).toBe("folded");
    expect(runPageShown(opened, "run-1", true)).toBe("page");
    expect(runPageShown(opened, "run-1", false, { picture: true, headHasRoom: false })).toBe("row");
  });

  it("keeps a drawn page through picture loss and place changes until the Run ends", () => {
    const opened = runPageOpened("run-1");
    expect(runPageShown(opened, "run-1", true, { picture: false })).toBe("row");
    const paged = runPagePaged(opened, "run-1");
    expect(runPageShown(paged, "run-1", true, { picture: false })).toBe("page");
    expect(runPageShown(paged, null, true)).toBe("none");
    const next = runPageConsidered(paged, "run-2", { ...idle, picture: false });
    expect(next.run).toEqual({ runId: "run-2", intent: "undecided", paged: false });
    expect(runPageShown(next, "run-2", true)).toBe("folded");
  });

  it("uses a row when folded has no room in the head", () => {
    const closed = runPageConsidered(freshRunPageMemory, "run-1", { ...idle, cellular: true });
    expect(runPageShown(closed, "run-1", true, { picture: true, headHasRoom: false })).toBe("row");
  });
});

describe("the page's size", () => {
  it("takes the page's own shape at the width it is given", () => {
    // A desktop-shaped page across an iPhone's width.
    expect(runPageSize({ aspect: 1.6, room: 600, transcript: 132, width: 393 })).toEqual({
      height: 245,
      width: 393,
    });
  });

  it("takes at most half the room, narrowing to keep the page's shape", () => {
    // A phone-shaped page would be taller than the screen: it is drawn narrower, never resized.
    expect(runPageSize({ aspect: 0.46, room: 600, transcript: 132, width: 393 })).toEqual({
      height: 300,
      width: 138,
    });
  });

  it("always leaves the conversation its share when the room is short", () => {
    // Requests docked: the room is mostly the transcript's.
    expect(runPageSize({ aspect: 1.6, room: 420, transcript: 132, width: 393 })).toEqual({
      height: 210,
      width: 336,
    });
  });

  it("folds when the cap would leave it too small to read", () => {
    // The keyboard is up and a Request is docked.
    expect(runPageSize({ aspect: 1.6, room: 260, transcript: 132, width: 393 })).toBeNull();
    // A page smaller than that is kept whole if it fits.
    expect(runPageSize({ aspect: 4, room: 260, transcript: 132, width: 393 })).toEqual({
      height: 98,
      width: 393,
    });
  });
});
