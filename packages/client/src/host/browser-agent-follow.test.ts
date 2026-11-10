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
  const update = (
    agentTab: BrowserTabDestination | null,
    shownTab = a,
    threadId = "thread",
    held = false,
  ) => controller.update({ threadId, shownTab, agentTab, held });
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
  it("switches immediately on the leading edge and throttles the latest destination", () => {
    const { update, onFollow } = setup();
    update(b);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(b);
    vi.advanceTimersByTime(200);
    update(a, b);
    vi.advanceTimersByTime(200);
    update(b, b);
    vi.advanceTimersByTime(200);
    update(c, b);
    vi.advanceTimersByTime(399);
    expect(onFollow).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onFollow.mock.calls.map(([tab]) => tab)).toEqual([b, c]);
    vi.advanceTimersByTime(1000);
    update(a, c);
    expect(onFollow.mock.calls.map(([tab]) => tab)).toEqual([b, c, a]);
  });
  it("cancels the trailing switch when the agent returns to the shown tab", () => {
    const { update, onFollow } = setup();
    update(b);
    update(a, b);
    vi.advanceTimersByTime(200);
    update(b, b);
    vi.advanceTimersByTime(1000);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(b);
  });
  it("stops when the person moves the page, and follows again when they go to the agent's tab", () => {
    const { controller, update, onFollow } = setup();
    update(b);
    update(c, b);
    update(c, a);
    vi.advanceTimersByTime(2000);
    expect(controller.state.following).toBe(false);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(b);
    // The agent arriving in the person's page does not take it back from them.
    update(a, a);
    update(b, a);
    vi.advanceTimersByTime(2000);
    expect(controller.state.following).toBe(false);
    expect(onFollow).toHaveBeenCalledOnce();
    // Their own return to the agent's tab, such as from its live card, does.
    update(b, b);
    expect(controller.state.following).toBe(true);
    update(c, b);
    expect(onFollow.mock.calls.map(([tab]) => tab)).toEqual([b, c]);
  });
  it("follows again after steering within the tab once the person returns to it", () => {
    const { controller, update, onFollow } = setup();
    update(b);
    update(b, b);
    controller.steer();
    expect(controller.state.following).toBe(false);
    update(c, b);
    vi.advanceTimersByTime(2000);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(b);
    update(c, a);
    // The tab following last moved to is still the person's own return.
    update(b, a);
    update(b, b);
    expect(controller.state.following).toBe(true);
    update(c, b);
    expect(onFollow.mock.calls.map(([tab]) => tab)).toEqual([b, c]);
  });
  it("waits while the page is held and catches up once it is not", () => {
    const { controller, update, onFollow } = setup();
    update(a, a, "thread", true);
    update(b, a, "thread", true);
    vi.advanceTimersByTime(5000);
    expect(onFollow).not.toHaveBeenCalled();
    expect(controller.state.following).toBe(true);
    update(b, a);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(b);
  });
  it("lets the person's choice under a held page stop following", () => {
    const { controller, update, onFollow } = setup();
    update(b, a, "thread", true);
    update(b, c, "thread", true);
    update(b, c);
    vi.advanceTimersByTime(5000);
    expect(controller.state.following).toBe(false);
    expect(onFollow).not.toHaveBeenCalled();
  });
  it("accepts delayed acknowledgements of its own destination without stopping", () => {
    const { controller, update, onFollow } = setup();
    update(b);
    update(c);
    update(c, b);
    expect(controller.state.following).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(onFollow.mock.calls.map(([tab]) => tab)).toEqual([b, c]);
    update(c, c);
    expect(controller.state.following).toBe(true);
  });
  it("ends quietly when the agent leaves the browser, forgetting that the person steered", () => {
    const { controller, update, onFollow } = setup();
    update(b);
    update(c, b);
    update(c, a);
    expect(controller.state.steering).toBe(true);
    update(null, a);
    vi.advanceTimersByTime(2000);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(b);
    expect(controller.state).toMatchObject({ following: false, steering: false });
    update(b);
    expect(controller.state.following).toBe(false);
    update(a);
    expect(controller.state.following).toBe(true);
    update(b);
    expect(onFollow.mock.calls.map(([tab]) => tab)).toEqual([b, b]);
  });
  it("starts only where the page and the agent meet, resets on Thread changes, and cancels on unmount", () => {
    const { controller, update, onFollow } = setup();
    update(b, a, "next-thread");
    vi.advanceTimersByTime(2000);
    expect(controller.state.following).toBe(false);
    update(b, b, "next-thread");
    expect(controller.state.following).toBe(true);
    update(c, b, "next-thread");
    update(a, c, "next-thread");
    controller.dispose();
    vi.advanceTimersByTime(2000);
    expect(onFollow).toHaveBeenCalledExactlyOnceWith(c);
  });
  it("pure transitions ignore early timer events and missing companion Threads", () => {
    const update = (shownTab: BrowserTabDestination, agentTab: BrowserTabDestination) =>
      ({ type: "update", input: { threadId: "thread", shownTab, agentTab } }) as const;
    const start = transitionBrowserAgentFollow(initialBrowserAgentFollowState(), update(a, a), 0);
    const switched = transitionBrowserAgentFollow(start.state, update(a, b), 0);
    const pending = transitionBrowserAgentFollow(switched.state, update(b, c), 0);
    expect(transitionBrowserAgentFollow(pending.state, { type: "settle" }, 999).follow).toBeNull();
    const removed = transitionBrowserAgentFollow(
      pending.state,
      { type: "update", input: { threadId: null, shownTab: a, agentTab: b } },
      1000,
    );
    expect(removed).toEqual({ state: initialBrowserAgentFollowState(), follow: null });
  });
});
