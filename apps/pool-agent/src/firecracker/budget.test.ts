/**
 * Round D, D1: the slot proxies' slice counted inside the host's budget for guests, and how many
 * guests a host is sized for. An n2-standard-8 has 32 GiB.
 */
import { describe, expect, it } from "vitest";
import { guestBudget } from "./cgroup.js";

const mib = 1024 ** 2;
const gib = 1024 ** 3;

describe("the host's memory budget", () => {
  it("leaves the host its room and the proxies' slice, and fits the guests it is sized for", () => {
    const total = 32 * gib;
    const slice = 1536 * mib;
    const budget = guestBudget(total, slice);
    // 32 GiB less 3.2 GiB for the host and 1.5 GiB for the proxies.
    expect(budget).toBe(total - Math.floor(total / 10) - slice);
    // A guest in memory is held to memory.high = its 2 GiB + 512 MiB: ten fit.
    const perGuest = 2 * gib + 512 * mib;
    const sized = Math.floor(budget / perGuest);
    expect(sized).toBe(10);
    // Ten guests' proxies at 128 MiB each stay inside the slice: 1280 MiB of 1536 MiB.
    expect(sized * 128 * mib).toBeLessThanOrEqual(slice);
  });
});
