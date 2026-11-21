/**
 * Round D, D1 and round E, E4: the slot proxies' slice counted inside the host's budget for
 * guests, and how many guests a host holds in memory, by the arithmetic the agent admits a start
 * or a wake by. An n2-standard-8 has 32 GiB.
 */
import { describe, expect, it } from "vitest";
import { fits, guestBudget, guestCharge, hostCapacity } from "../capacity.js";

const mib = 1024 ** 2;
const gib = 1024 ** 3;

describe("the host's memory budget", () => {
  it("leaves the host its room and the proxies' slice, and admits ten 2 GiB guests, not eleven", () => {
    const total = 32 * gib;
    const slice = 1536 * mib;
    // 32 GiB less 3.2 GiB for the host and 1.5 GiB for the proxies.
    expect(guestBudget(total, slice)).toBe(total - Math.floor(total / 10) - slice);
    const capacity = hostCapacity(total, slice, 128 * mib);
    // A guest in memory is charged its memory.high = its 2 GiB + 512 MiB.
    expect(guestCharge(2048)).toBe(2 * gib + 512 * mib);
    const inMemory: number[] = [];
    while (fits(capacity, inMemory, guestCharge(2048))) inMemory.push(guestCharge(2048));
    expect(inMemory).toHaveLength(10);
    // The slice holds twelve proxies at 128 MiB: the guests' budget is the bound that binds.
    expect(capacity.proxies).toBe(12);
  });

  it("bounds the guests in memory by the proxies too", () => {
    const capacity = { guestBytes: 100 * gib, proxies: 3 };
    expect(fits(capacity, [1, 1], 1)).toBe(true);
    expect(fits(capacity, [1, 1, 1], 1)).toBe(false);
  });
});
