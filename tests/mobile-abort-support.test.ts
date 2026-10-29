import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { installAbortSupport } from "../apps/mobile/src/platform/abort-support.js";

// Exercise the phone's actual implementation; Node's native signal already
// supports these methods and would hide this regression.
const require = createRequire(import.meta.url);
const requireReactNative = createRequire(
  require.resolve("../apps/mobile/node_modules/react-native/package.json"),
);
const legacy: {
  AbortController: typeof AbortController;
  AbortSignal: typeof AbortSignal;
} = requireReactNative("abort-controller/dist/abort-controller");

describe("phone AbortSignal compatibility", () => {
  it("permits a live Account lease and throws its original reason after cancellation", () => {
    installAbortSupport(legacy.AbortController, legacy.AbortSignal);
    const controller = new legacy.AbortController();
    expect(() => controller.signal.throwIfAborted()).not.toThrow();
    const reason = new Error("Account signed out");
    let observed: unknown;
    controller.signal.addEventListener("abort", () => {
      observed = controller.signal.reason;
    });
    controller.abort(reason);
    expect(observed).toBe(reason);
    expect(() => controller.signal.throwIfAborted()).toThrow(reason);
    controller.abort(new Error("Later cancellation"));
    expect(controller.signal.reason).toBe(reason);
  });

  it("uses AbortError when no reason is supplied and preserves explicit null", () => {
    installAbortSupport(legacy.AbortController, legacy.AbortSignal);
    const first = new legacy.AbortController();
    first.abort();
    expect(first.signal.reason).toMatchObject({ name: "AbortError" });
    const second = new legacy.AbortController();
    second.abort(null);
    expect(second.signal.reason).toBeNull();
  });

  it("leaves a complete runtime unchanged", () => {
    const abort = AbortController.prototype.abort;
    const check = AbortSignal.prototype.throwIfAborted;
    installAbortSupport(AbortController, AbortSignal);
    expect(AbortController.prototype.abort).toBe(abort);
    expect(AbortSignal.prototype.throwIfAborted).toBe(check);
  });
});
