import { expect, it } from "vitest";
import { warmEngineIdleCap } from "./warm-engine-pool.js";

it("keeps one or two idle engines on an 8 GB computer or smaller", () => {
  const gib = 1024 ** 3;
  expect([4, 8, 16, 32].map((size) => warmEngineIdleCap(size * gib))).toEqual([1, 2, 8, 8]);
});
