import { expect, it, vi } from "vitest";
import { boundedJsonSize } from "./bounded-json.js";

const budget = { maxBytes: 1024, maxDepth: 4, maxEntries: 16 };

it("counts escaped UTF-8 bytes before serialization", () => {
  const value = { '\n"': ["abcé€🍎\ud800\\\n\u0000", null, true, 1e21] };
  const size = Buffer.byteLength(JSON.stringify(value));
  expect(boundedJsonSize(value, { ...budget, maxBytes: size })).toBe(size);
  expect(boundedJsonSize(value, { ...budget, maxBytes: size - 1 })).toBeUndefined();
});

it("stops at the depth and entry limits without invoking accessors", () => {
  expect(boundedJsonSize({ a: { b: 1 } }, { ...budget, maxDepth: 1 })).toBeUndefined();
  expect(boundedJsonSize([0, 1, 2, 3], { ...budget, maxEntries: 4 })).toBeUndefined();
  const getter = vi.fn(() => 1);
  const value = Object.defineProperty({}, "value", { enumerable: true, get: getter });
  expect(boundedJsonSize(value, budget)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
});
