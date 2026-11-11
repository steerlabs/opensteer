import { describe, expect, it } from "vitest";
import { TabLease } from "./tab-lease.js";

describe("TabLease", () => {
  it("aborts capture on demand, then runs the operation on the retained page", async () => {
    const lease = new TabLease();
    expect(lease.beginSleep()).toBe(true);
    let ran = false;
    const operation = lease.use(async () => {
      ran = true;
    });
    expect(lease.demanded).toBe(true);
    expect(ran).toBe(false);
    lease.endSleep(false);
    await operation;
    expect(ran).toBe(true);
    expect(lease.busy).toBe(false);
  });
  it("holds asynchronous commands and lets close win a resume", async () => {
    const lease = new TabLease();
    const hold = Promise.withResolvers<void>();
    const using = lease.use(() => hold.promise);
    expect(lease.beginSleep()).toBe(false);
    hold.resolve();
    await using;
    expect(lease.beginSleep()).toBe(true);
    lease.endSleep(true);
    await expect(lease.use(async () => {})).rejects.toMatchObject({ reason: "target-suspended" });
    const waking = lease.resume(() => hold.promise);
    lease.close();
    await waking;
    expect(lease.state).toBe("closing");
    await expect(lease.use(async () => {})).rejects.toMatchObject({ code: "not_found" });
  });
});
