import { afterEach, describe, expect, test, vi } from "vitest";

import { createPageRef, type BrowserCoreEngine } from "../../packages/browser-core/src/index.js";
import {
  defaultPolicy,
  delayWithSignal,
  runWithPolicyTimeout,
  settleWithPolicy,
  type SettleContext,
  type SettlePolicy,
  type TimeoutPolicy,
} from "../../packages/opensteer/src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Phase 7 policy timeout", () => {
  test("returns results that complete before the deadline", async () => {
    vi.useFakeTimers();
    const policy: TimeoutPolicy = {
      resolveTimeoutMs() {
        return 50;
      },
    };

    const promise = runWithPolicyTimeout(policy, { operation: "dom.click" }, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      return "ok";
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(promise).resolves.toBe("ok");
  });

  test("prevents post-timeout continuation when steps use the timeout context", async () => {
    vi.useFakeTimers();
    let sideEffect = false;
    const policy: TimeoutPolicy = {
      resolveTimeoutMs() {
        return 50;
      },
    };

    const promise = runWithPolicyTimeout(policy, { operation: "dom.click" }, async (timeout) => {
      await timeout.runStep(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 60);
          }),
      );
      sideEffect = true;
      return "late";
    });

    const assertion = expect(promise).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    await vi.advanceTimersByTimeAsync(20);
    expect(sideEffect).toBe(false);
  });

  test("throws timeout errors with operation details", async () => {
    vi.useFakeTimers();
    const policy: TimeoutPolicy = {
      resolveTimeoutMs() {
        return 50;
      },
    };

    const promise = runWithPolicyTimeout(policy, { operation: "page.snapshot" }, async () => {
      await new Promise<void>(() => undefined);
      return "never";
    });

    const assertion = expect(promise).rejects.toMatchObject({
      name: "OpensteerProtocolError",
      code: "timeout",
      details: {
        policy: "timeout",
        operation: "page.snapshot",
        budgetMs: 50,
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});

describe("Phase 7 policy settle", () => {
  test("exports immutable default policy objects", () => {
    const policy = defaultPolicy();

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.settle)).toBe(true);
    expect(Object.isFrozen(policy.settle.observers)).toBe(true);
    expect(() =>
      Array.prototype.push.call(policy.settle.observers, {
        settle: async () => true,
      }),
    ).toThrow(TypeError);
    expect(defaultPolicy().settle.observers).toHaveLength(2);
  });

  test("skips fixed delays when configured as zero", async () => {
    vi.useFakeTimers();
    const policy: SettlePolicy = {
      observers: [],
      resolveDelayMs() {
        return 0;
      },
    };

    const promise = settleWithPolicy(policy, createSettleContext("dom-action"));
    await expect(promise).resolves.toBeUndefined();
  });

  test("uses dom-action and navigation defaults", async () => {
    vi.useFakeTimers();
    const policy = defaultPolicy().settle;

    const domPromise = settleWithPolicy(policy, createSettleContext("dom-action"));
    await vi.advanceTimersByTimeAsync(99);
    let domSettled = false;
    void domPromise.then(() => {
      domSettled = true;
    });
    expect(domSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await domPromise;

    const navigationPromise = settleWithPolicy(policy, createSettleContext("navigation"));
    await vi.advanceTimersByTimeAsync(499);
    let navigationSettled = false;
    void navigationPromise.then(() => {
      navigationSettled = true;
    });
    expect(navigationSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await navigationPromise;
  });

  test("lets observers short-circuit the fallback delay", async () => {
    vi.useFakeTimers();
    const observer = vi.fn(async () => true);
    const policy: SettlePolicy = {
      observers: [{ settle: observer }],
      resolveDelayMs() {
        return 500;
      },
    };

    const promise = settleWithPolicy(policy, createSettleContext("navigation"));
    await expect(promise).resolves.toBeUndefined();
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test("falls back to fixed delay when observers decline", async () => {
    vi.useFakeTimers();
    const observer = vi.fn(async () => false);
    const policy: SettlePolicy = {
      observers: [{ settle: observer }],
      resolveDelayMs() {
        return 100;
      },
    };

    const promise = settleWithPolicy(policy, createSettleContext("dom-action"));
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test("aborts settle delays via AbortSignal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = delayWithSignal(100, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });

    setTimeout(() => controller.abort(), 10);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});

describe("Phase 7 visual stability settle observers", () => {
  function createMockEngine(waitImpl?: () => Promise<void>) {
    return {
      waitForPostLoadQuiet: vi.fn(() => Promise.resolve()),
      waitForVisualStability: vi.fn(waitImpl ?? (() => Promise.resolve())),
    } as unknown as BrowserCoreEngine;
  }

  function createContextWithEngine(
    trigger: "navigation" | "dom-action",
    engine: BrowserCoreEngine,
    options?: { operation?: SettleContext["operation"]; remainingMs?: number },
  ): SettleContext {
    return {
      operation: options?.operation ?? (trigger === "navigation" ? "page.goto" : "dom.click"),
      trigger,
      engine,
      pageRef: createPageRef(`page-${trigger}`),
      signal: new AbortController().signal,
      remainingMs: options?.remainingMs,
    };
  }

  test("dom-action observer calls waitForVisualStability for click", async () => {
    const engine = createMockEngine();
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("dom-action", engine, { operation: "dom.click" });

    await settleWithPolicy(policy, context);

    expect(engine.waitForVisualStability).toHaveBeenCalledTimes(1);
    expect(engine.waitForVisualStability).toHaveBeenCalledWith({
      pageRef: context.pageRef,
      timeoutMs: 7_000,
      settleMs: 750,
      scope: "visible-frames",
    });
  });

  test("dom-action observer uses hover-specific profile", async () => {
    const engine = createMockEngine();
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("dom-action", engine, { operation: "dom.hover" });

    await settleWithPolicy(policy, context);

    expect(engine.waitForVisualStability).toHaveBeenCalledWith({
      pageRef: context.pageRef,
      timeoutMs: 2_500,
      settleMs: 200,
      scope: "main-frame",
    });
  });

  test("dom-action observer uses scroll-specific profile", async () => {
    const engine = createMockEngine();
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("dom-action", engine, { operation: "dom.scroll" });

    await settleWithPolicy(policy, context);

    expect(engine.waitForVisualStability).toHaveBeenCalledWith({
      pageRef: context.pageRef,
      timeoutMs: 7_000,
      settleMs: 600,
      scope: "visible-frames",
    });
  });

  test("dom-action observer caps timeout to remainingMs", async () => {
    const engine = createMockEngine();
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("dom-action", engine, {
      operation: "dom.click",
      remainingMs: 1_500,
    });

    await settleWithPolicy(policy, context);

    expect(engine.waitForVisualStability).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_500 }),
    );
  });

  test("hover timeout cap applies even when remainingMs is larger", async () => {
    const engine = createMockEngine();
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("dom-action", engine, {
      operation: "dom.hover",
      remainingMs: 9_000,
    });

    await settleWithPolicy(policy, context);

    expect(engine.waitForVisualStability).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 2_500 }),
    );
  });

  test("dom-action observer returns false on error, falls back to delay", async () => {
    vi.useFakeTimers();
    const engine = createMockEngine(() => Promise.reject(new Error("CDP unavailable")));
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("dom-action", engine);

    const promise = settleWithPolicy(policy, context);
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
  });

  test("dom-action observer returns false when remainingMs is zero", async () => {
    vi.useFakeTimers();
    const engine = createMockEngine();
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("dom-action", engine, { remainingMs: 0 });

    const promise = settleWithPolicy(policy, context);
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(engine.waitForVisualStability).not.toHaveBeenCalled();
  });

  test("navigation observer waits for post-load quiet before visual stability", async () => {
    const engine = createMockEngine();
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("navigation", engine);

    await settleWithPolicy(policy, context);

    expect(engine.waitForPostLoadQuiet).toHaveBeenCalledWith({
      pageRef: context.pageRef,
      timeoutMs: 7_000,
      quietMs: 400,
      captureWindowMs: 1_000,
      signal: context.signal,
    });
    expect(engine.waitForVisualStability).toHaveBeenCalledWith({
      pageRef: context.pageRef,
      timeoutMs: 7_000,
      settleMs: 750,
      scope: "visible-frames",
    });
  });

  test("navigation observer returns false on error, falls back to delay", async () => {
    vi.useFakeTimers();
    const engine = createMockEngine(() => Promise.reject(new Error("page closed")));
    engine.waitForPostLoadQuiet = vi.fn(() => Promise.reject(new Error("page closed")));
    const policy = defaultPolicy().settle;
    const context = createContextWithEngine("navigation", engine);

    const promise = settleWithPolicy(policy, context);
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
  });

  test("snapshot trigger settles immediately without visual stability wait", async () => {
    const engine = createMockEngine();
    const policy = defaultPolicy().settle;
    const context = {
      operation: "page.snapshot" as const,
      trigger: "snapshot" as const,
      engine,
      pageRef: createPageRef("page-snapshot"),
      signal: new AbortController().signal,
      remainingMs: undefined,
    };

    await settleWithPolicy(policy, context);

    expect(engine.waitForVisualStability).not.toHaveBeenCalled();
  });
});

function createSettleContext(trigger: "navigation" | "dom-action") {
  return {
    operation: trigger === "navigation" ? "page.goto" : "dom.click",
    trigger,
    engine: {} as BrowserCoreEngine,
    pageRef: createPageRef(`page-${trigger}`),
    signal: new AbortController().signal,
    remainingMs: undefined,
  } as const;
}
