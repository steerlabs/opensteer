import type { CommandRequestStore } from "@opensteer/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRequestExpiry, titleFirst } from "./requests.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("the expiry of agents' asks (X16)", () => {
  it("arms nothing while no ask is open, and one timer for the earliest one", async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    let next: Date | null = null;
    const store = {
      expire: async () => {
        passes.push("expire");
        return [];
      },
      nextExpiry: async () => next,
    } as unknown as CommandRequestStore;
    const expiry = new CommandRequestExpiry(store, (error) => {
      throw error;
    });
    // An idle Home: nothing is armed, and nothing runs however long it waits.
    expiry.arm(null);
    expect(expiry.armed).toBe(false);
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000);
    expect(passes).toEqual([]);
    // Two asks open: one wake, at the earlier.
    const now = Date.now();
    expiry.arm(new Date(now + 2 * 60_000));
    expiry.arm(new Date(now + 60_000));
    expiry.arm(new Date(now + 3 * 60_000));
    next = new Date(now + 2 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(passes).toEqual(["expire"]);
    // It arms for the next one, and once none is open, for nothing.
    next = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(passes).toEqual(["expire", "expire"]);
    expect(expiry.armed).toBe(false);
    expiry.stop();
  });
});

describe("the expiry after an error (AD7)", () => {
  it("arms again after a pass that failed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const store = {
      expire: async () => {
        calls += 1;
        if (calls === 1) throw new Error("The database went away");
        return [];
      },
      nextExpiry: async () => null,
    } as unknown as CommandRequestStore;
    const errors: unknown[] = [];
    const expiry = new CommandRequestExpiry(store, (error) => errors.push(error));
    expiry.arm(new Date(Date.now() + 1_000));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors).toHaveLength(1);
    expect(expiry.armed).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toBe(2);
    expiry.stop();
  });
});

describe("a command Request's title (X3)", () => {
  it("keeps the Home's sentence whole and cuts only what follows", () => {
    const sentence = "Rename an AI engine account";
    const title = titleFirst(sentence, ` · Asked by the agent “${"n".repeat(400)}”`);
    expect(title.startsWith(sentence)).toBe(true);
    expect(title).toHaveLength(240);
    expect(title.endsWith("…")).toBe(true);
    expect(titleFirst(sentence, " · short")).toBe(`${sentence} · short`);
  });
});
