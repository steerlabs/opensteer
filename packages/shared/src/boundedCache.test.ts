import { describe, expect, it } from "vitest";
import { BoundedCache } from "./boundedCache.js";

describe("a bounded cache", () => {
  it("drops the least recently used past its count", () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("a")).toBe(1);
    expect(cache.peek("c")).toBe(3);
    expect(cache.count).toBe(2);
  });

  it("drops the oldest past its size, and a peek leaves the order alone", () => {
    const cache = new BoundedCache<string, string>({ maxSize: 100 });
    cache.set("a", "a", 20);
    cache.set("b", "b", 20);
    cache.set("c", "c", 20);
    cache.set("d", "d", 20);
    expect(cache.peek("a")).toBe("a");
    cache.set("e", "e", 25);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.size).toBe(85);
    cache.set("b", "b again", 20);
    cache.set("f", "f", 20);
    expect(cache.peek("c")).toBeUndefined();
    expect(cache.peek("b")).toBe("b again");
    expect(cache.size).toBe(85);
  });

  it("keeps nothing charged more than a quarter of its size", () => {
    const cache = new BoundedCache<string, string>({ maxSize: 100 });
    cache.set("small", "kept", 25);
    cache.set("huge", "dropped", 26);
    expect(cache.peek("huge")).toBeUndefined();
    expect(cache.peek("small")).toBe("kept");
    // Setting a key again replaces it, even with a value too large to keep.
    cache.set("small", "too big now", 30);
    expect(cache.peek("small")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
