import { describe, expect, it, vi } from "vitest";

/*
 * Which screen is top-level, and what choosing one from the sidebar does to
 * the stack. What can go wrong:
 * - a step over Home such as phone setup, or a sheet, is taken for a place to
 *   be, so it loses its Back or gets the sidebar's swipe;
 * - a drill-in, or a streamed page that owns its edges, gets the sidebar's swipe;
 * - choosing a row piles screens up, rebuilds Home and loses its draft, or
 *   leaves drill-ins behind the new screen;
 * - choosing the task already open remounts it, or a question in it, even
 *   one shown before, is not brought forward.
 */

vi.mock("@react-navigation/native", () => ({
  CommonActions: {
    reset: (payload: object) => ({ payload, type: "RESET" }),
  },
  StackActions: {
    pop: (count: number) => ({ payload: { count }, type: "POP" }),
    popToTop: () => ({ type: "POP_TO_TOP" }),
  },
}));

const { openTopLevel, sidebarSwipes, topLevelIndex } = await import("./top-level.js");

type Route = { readonly key: string; readonly name: string; readonly params?: object };

function stack(...routes: readonly Route[]) {
  return { index: routes.length - 1, routes };
}

const home = { key: "home", name: "Home", params: { deploymentId: "d" } };
const taskA = { key: "a", name: "Thread", params: { deploymentId: "d", threadId: "a" } };
const taskB = { name: "Thread", params: { deploymentId: "d", threadId: "b" } };
const subagent = { key: "sub", name: "Subagent" };
const asked = { name: "Thread", params: { ...taskA.params, requestId: "r" } };

describe("the top-level screen", () => {
  it("is Home, or the screen on it that can be a place to be", () => {
    expect(topLevelIndex(stack(home))).toBe(0);
    expect(topLevelIndex(stack(home, taskA, subagent))).toBe(1);
    expect(topLevelIndex(stack(home, { key: "setup", name: "SetUpPhone" }))).toBe(0);
    expect(topLevelIndex(stack(home, { key: "sheet", name: "ThreadAround" }))).toBe(0);
    expect(topLevelIndex(stack(taskA))).toBeNull();
  });

  it("gives the edge swipe to the sidebar only while it is in front and its edges are free", () => {
    expect(sidebarSwipes(taskA, stack(home, taskA))).toBe(true);
    expect(sidebarSwipes(subagent, stack(home, taskA, subagent))).toBe(false);
    const page = { key: "page", name: "WorkspaceBrowser", params: { tabId: "t" } };
    expect(sidebarSwipes(page, stack(home, page))).toBe(false);
  });
});

describe("making a screen top-level", () => {
  it("replaces whatever is over the same mounted Home", () => {
    expect(openTopLevel(stack(home, taskA, subagent), taskB)).toEqual({
      payload: { index: 1, routes: [home, taskB] },
      type: "RESET",
    });
    const action = openTopLevel(stack(home), taskB) as { payload: { routes: object[] } };
    expect(action.payload.routes[0]).toBe(home);
  });

  it("returns to the task already open without remounting it", () => {
    expect(openTopLevel(stack(home, taskA), taskA)).toBeNull();
    expect(openTopLevel(stack(home, taskA, subagent), taskA)).toEqual({
      payload: { count: 1 },
      type: "POP",
    });
  });

  it("lands on a question in the task already open with a fresh screen, as its landing is spent once shown", () => {
    // Even the same question again: its first screen spent it, so it would not move.
    for (const open of [stack(home, taskA), stack(home, taskA, subagent)]) {
      expect(openTopLevel(open, asked)).toEqual({
        payload: { index: 1, routes: [home, asked] },
        type: "RESET",
      });
    }
  });

  it("goes to Home by closing everything over it", () => {
    expect(openTopLevel(stack(home, taskA, subagent), { name: "Home", params: {} })).toEqual({
      type: "POP_TO_TOP",
    });
    expect(openTopLevel(stack(home), { name: "Home", params: {} })).toBeNull();
  });

  it("does nothing outside a Deployment's stack", () => {
    expect(openTopLevel(stack(taskA), taskB)).toBeNull();
  });
});
