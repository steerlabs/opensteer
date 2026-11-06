import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { CallableIntegrationTool } from "@opensteer/database";
import { InputCall } from "./integration-input.js";

describe("computer MCP call deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps ordinary calls at one minute and extends input to three minutes total", async () => {
    vi.useFakeTimers();
    const callable = {} as CallableIntegrationTool;
    const caller = { run: null, threadId: createId("thread") };
    const ordinary = new InputCall(callable, caller);
    const input = new InputCall(callable, caller);
    try {
      await vi.advanceTimersByTimeAsync(50_000);
      input.extend();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ordinary.signal.aborted, "An ordinary call must still expire after one minute").toBe(
        true,
      );
      expect(input.signal.aborted, "The input call must outlive its original deadline").toBe(false);
      await vi.advanceTimersByTimeAsync(100_000);
      input.extend();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(input.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        input.signal.aborted,
        "A second elicitation must not extend the total beyond three minutes",
      ).toBe(true);
    } finally {
      await ordinary.close();
      await input.close();
    }
  });
});
