import { afterEach, describe, expect, test, vi } from "vitest";

import { createPageRef, type BrowserCoreEngine } from "../../packages/browser-core/src/index.js";
import {
  defaultPolicy,
  delayWithSignal,
  runWithPolicyTimeout,
  settleWithPolicy,
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
    expect(defaultPolicy().settle.observers).toHaveLength(1);
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
