import { expect, it } from "vitest";
import { SpaceLedger } from "./space.js";

const GiB = 1024 ** 3;

// Review G10: two saves that each fit alone cannot both start into space for one.
it("refuses a second save whose space the first one already claimed", () => {
  const ledger = new SpaceLedger();
  const first = ledger.reserve(3 * GiB, 2.5 * GiB);
  expect(() => ledger.reserve(3 * GiB, 2.5 * GiB)).toThrow("no room");
  first();
  first();
  expect(ledger.reserved).toBe(0);
  const again = ledger.reserve(3 * GiB, 2.5 * GiB);
  again();
});
