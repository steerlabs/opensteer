import { describe, expect, it } from "vitest";
import {
  freshRunPageMemory,
  runPageActed,
  runPageFolded,
  runPageSize,
  runPageOpened,
  runPageShown,
} from "./run-page.js";

const idle = { cellular: false, scrolledUp: false, typing: false };
const tall = true;

describe("the page above a conversation", () => {
  it("opens by itself on the agent's first action in a Run, once", () => {
    const acted = runPageActed(freshRunPageMemory, "run-1", idle);
    expect(runPageShown(acted, "run-1", tall)).toBe("open");
    // A later action in the same Run never reopens what the person put away.
    const folded = runPageFolded(acted);
    expect(runPageShown(runPageActed(folded, "run-1", idle), "run-1", tall)).toBe("folded");
  });

  it.each([
    ["scrolled up", { ...idle, scrolledUp: true }],
    ["typing", { ...idle, typing: true }],
    ["on cellular", { ...idle, cellular: true }],
  ])("stays folded when the person is %s at the first action", (_, moment) => {
    const acted = runPageActed(freshRunPageMemory, "run-1", moment);
    expect(runPageShown(acted, "run-1", tall)).toBe("folded");
    // The moment passing does not open it: only the next Run decides again.
    expect(runPageShown(runPageActed(acted, "run-1", idle), "run-1", tall)).toBe("folded");
  });

  it("stays folded in this conversation after the person folds it, until they open it", () => {
    const folded = runPageFolded(runPageActed(freshRunPageMemory, "run-1", idle));
    const next = runPageActed(folded, "run-2", idle);
    expect(runPageShown(next, "run-2", tall)).toBe("folded");
    const opened = runPageOpened("run-2");
    expect(runPageShown(opened, "run-2", tall)).toBe("open");
    expect(runPageShown(runPageActed(opened, "run-3", idle), "run-3", tall)).toBe("open");
  });

  it("opens when the person asks, even on cellular", () => {
    const acted = runPageActed(freshRunPageMemory, "run-1", { ...idle, cellular: true });
    expect(runPageShown(acted, "run-1", tall)).toBe("folded");
    expect(runPageShown(runPageOpened("run-1"), "run-1", tall)).toBe("open");
  });

  it("folds by itself with too little room, and returns when the room does", () => {
    const acted = runPageActed(freshRunPageMemory, "run-1", idle);
    expect(runPageShown(acted, "run-1", false)).toBe("folded");
    expect(runPageShown(acted, "run-1", tall)).toBe("open");
  });

  it("ends with the Run, and a new Run decides afresh", () => {
    const acted = runPageActed(freshRunPageMemory, "run-1", idle);
    expect(runPageShown(acted, null, tall)).toBe("none");
    expect(runPageShown(acted, "run-2", tall)).toBe("folded");
    expect(runPageShown(runPageActed(acted, "run-2", idle), "run-2", tall)).toBe("open");
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
