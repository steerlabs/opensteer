import { expect, it, vi } from "vitest";
import { answerTooLargeWords, boundedJsonSize } from "./bounded-json.js";

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

it.each([
  // [answer bytes, limit bytes, size printed, limit printed]
  [8 * 1_024 * 1_024 + 1, 8 * 1_024 * 1_024, 8_193, 8_192],
  [1_024 * 1_024 + 1, 1_024 * 1_024, 1_025, 1_024],
  [10 * 1_024 + 1, 10 * 1_024, 11, 10],
  [442_369, 442_368, 433, 432],
  [1_044_481, 1_020 * 1_024, 1_021, 1_020],
  // A limit that is not a whole KiB: it prints rounded down, the size up.
  [1_000, 999, 1, 0],
  [5_000, 4_097, 5, 4],
] as const)(
  "prints an answer of %i bytes over a %i-byte limit as %i KiB over %i KiB: always more than the limit",
  (size, limit, sizeKiB, limitKiB) => {
    const words = answerTooLargeWords(size, limit);
    expect(words).toContain(`is ${sizeKiB} KiB, over the ${limitKiB} KiB limit for one answer`);
    expect(sizeKiB).toBeGreaterThan(limitKiB);
  },
);

it("says the command ran, and gives a page read the page's own advice", () => {
  expect(answerTooLargeWords(2_048, 1_024, "Storage.getCookies")).toBe(
    "The command ran, but its answer is 2 KiB, over the 1 KiB limit for one answer, so it exceeds the bounded agent transport and was dropped. Ask for less. If the command changed something, do not run it again.",
  );
  expect(answerTooLargeWords(2_048, 1_024, "Runtime.evaluate")).toContain(
    "Ask the page for less: a slice of the text, an element by selector, or innerText instead of the HTML.",
  );
  // Within the limit, it was the answer's shape that failed: no size is given.
  expect(answerTooLargeWords(512, 1_024)).toContain(
    "its answer is too deeply nested or has too many entries",
  );
  expect(answerTooLargeWords(undefined, 1_024)).toContain("too deeply nested");
});
