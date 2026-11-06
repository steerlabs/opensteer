import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserAgentFollow,
  transitionBrowserAgentFollow,
  initialBrowserAgentFollowState,
  type BrowserAgentFollowTimers,
} from "./browser-agent-follow.js";
import type { BrowserTabDestination } from "./browser-thread-tabs.js";

const a = { sessionId: "session", tabId: "a" };
const b = { sessionId: "session", tabId: "b" };
const c = { sessionId: "other-session", tabId: "c" };
const timers: BrowserAgentFollowTimers = {
  now: () => Date.now(),
  schedule: (callback, delay) => {
    const handle = setTimeout(callback, delay);
    return () => clearTimeout(handle);
  },
};
const controllers: BrowserAgentFollow[] = [];
function setup() {
  const onFollow = vi.fn<(tab: BrowserTabDestination) => void>();
  const controller = new BrowserAgentFollow(onFollow, undefined, timers);
  controllers.push(controller);
  const update = (agentTab: BrowserTabDestination | null, shownTab = a, threadId = "thread") =>
    controller.update({ threadId, shownTab, agentTab });
  update(a);
  return { controller, update, onFollow };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("browser agent following", () => {
  it("switches in place after settling, including across browser sessions", () => {
    const { controller, update, onFollow } = setup();
    expect(controller.state.following).toBe(true);
    update(b);
    vi.advanceTimersByTime(999);
    expect(onFollow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(b);
    update(c, b);
    vi.advanceTimersByTime(1000);
    expect(onFollow.mock.calls.map(([destination]) => destination)).toEqual([b, c]);
  });
  it("coalesces A,B,A,B inside a second into one switch to the latest tab", () => {
    const { update, onFollow } = setup();
    update(b);
    vi.advanceTimersByTime(200);
    update(a);
    vi.advanceTimersByTime(200);
    update(b);
    vi.advanceTimersByTime(599);
    expect(onFollow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(b);
    vi.advanceTimersByTime(2000);
    expect(onFollow).toHaveBeenCalledTimes(1);
  });
  it("does not switch when the latest tab is the shown tab", () => {
    const { update, onFollow } = setup();
    update(b);
    vi.advanceTimersByTime(200);
    update(a);
    vi.advanceTimersByTime(1000);
    expect(onFollow).not.toHaveBeenCalled();
  });
  it("person action cancels pending follow and stays paused until immediate resume", () => {
    const { controller, update, onFollow } = setup();
    update(b);
    controller.pause();
    vi.advanceTimersByTime(5000);
    update(a);
    update(c);
    vi.advanceTimersByTime(5000);
    expect(controller.state.following).toBe(false);
    expect(onFollow).not.toHaveBeenCalled();
    expect(controller.resume()).toEqual(c);
    expect(controller.state.following).toBe(true);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(c);
  });
  it("run end cancels pending switches and following quietly", () => {
    const { controller, update, onFollow } = setup();
    update(b);
    update(null);
    vi.advanceTimersByTime(2000);
    expect(controller.state.following).toBe(false);
    expect(controller.resume()).toBeNull();
    expect(onFollow).not.toHaveBeenCalled();
  });
  it("starts only on a matching destination, resets on Thread changes, and cancels on unmount", () => {
    const { controller, update, onFollow } = setup();
    update(b, a, "next-thread");
    vi.advanceTimersByTime(2000);
    expect(controller.state.following).toBe(false);
    update(b, b, "next-thread");
    expect(controller.state.following).toBe(true);
    update(c, b, "next-thread");
    controller.dispose();
    vi.advanceTimersByTime(2000);
    expect(onFollow).not.toHaveBeenCalled();
  });
  it("pure transitions ignore early timer events and missing companion Threads", () => {
    const start = transitionBrowserAgentFollow(
      initialBrowserAgentFollowState(),
      { type: "update", input: { threadId: "thread", shownTab: a, agentTab: a } },
      0,
    ).state;
    const pending = transitionBrowserAgentFollow(
      start,
      { type: "update", input: { threadId: "thread", shownTab: a, agentTab: b } },
      0,
    ).state;
    expect(transitionBrowserAgentFollow(pending, { type: "settle" }, 999).follow).toBeNull();
    const removed = transitionBrowserAgentFollow(
      pending,
      { type: "update", input: { threadId: null, shownTab: a, agentTab: b } },
      1000,
    ).state;
    expect(removed.following).toBe(false);
    expect(transitionBrowserAgentFollow(removed, { type: "resume" }, 1000).follow).toBeNull();
  });
});
