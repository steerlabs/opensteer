import { expect, it } from "vitest";
import { descendantPids } from "../scripts/smoke-desktop-release-processes.js";
it("captures nested children regardless of ps order without selecting shared-Mac peers", () => {
  expect(descendantPids("4 3\n2 1\n3 2\n5 1\n6 5", 2)).toEqual([3, 4]);
  expect(descendantPids("", 2)).toEqual([]);
});
