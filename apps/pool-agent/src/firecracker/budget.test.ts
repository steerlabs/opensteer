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
    const slice = 1024 * mib;
    const budget = guestBudget(total, slice);
    // 32 GiB less 3.2 GiB for the host and 1 GiB for the proxies.
    expect(budget).toBe(total - Math.floor(total / 10) - slice);
    // A guest in memory is held to memory.high = its 2 GiB + 512 MiB: eleven fit.
    const perGuest = 2 * gib + 512 * mib;
    const sized = Math.floor(budget / perGuest);
    expect(sized).toBe(11);
    // Eleven guests' proxies at 80 MiB each stay inside the slice: 880 MiB of 1024 MiB.
    expect(sized * 80 * mib).toBeLessThanOrEqual(slice);
  });
});
