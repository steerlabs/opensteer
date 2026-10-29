import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { payloadThenSlot, timedWait, type Phases } from "../scripts/test-vm/phases.js";

/*
 * Ways a VM job could waste a guest slot or hide where its time went:
 * - it holds a slot while it waits for the payload lock or storage,
 *   so a job with a cached payload cannot boot meanwhile;
 * - a wait before the suite is in no phase, so job.json cannot explain it.
 */

/** A lock the test releases by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("VM job admission", () => {
  it("takes its slot only after the payload is ready, recording every wait", async () => {
    const phases: Phases = {};
    const events: string[] = [];
    const payloadLock = gate();
    const storage = gate();
    const slotFree = gate();
    let slotHeld = false;
    const job = payloadThenSlot({
      phases,
      preparePayload: async () => {
        await timedWait(phases, "payload-lock-wait", async () => {
          events.push("waiting for the payload lock");
          await payloadLock.opened;
        });
        await timedWait(phases, "storage-wait", async () => {
          events.push(`waiting for storage (slot held: ${slotHeld})`);
          await storage.opened;
        });
        events.push("payload built");
        return "/cache/payload";
      },
      takeSlot: async () => {
        events.push("waiting for a slot");
        await slotFree.opened;
        slotHeld = true;
        return { release: () => (slotHeld = false) };
      },
    });
    await delay(50);
    expect(slotHeld).toBe(false);
    payloadLock.open();
    await delay(50);
    // Still preparing: no slot taken or asked for yet.
    expect(events).not.toContain("waiting for a slot");
    storage.open();
    await delay(50);
    slotFree.open();
    const { payload, slot } = await job;
    expect(payload).toBe("/cache/payload");
    expect(slotHeld).toBe(true);
    expect(events).toEqual([
      "waiting for the payload lock",
      "waiting for storage (slot held: false)",
      "payload built",
      "waiting for a slot",
    ]);
    for (const name of ["payload-lock-wait", "storage-wait", "slot-wait"])
      expect(phases[name]!.seconds).toBeGreaterThan(0.03);
    slot.release();
    expect(slotHeld).toBe(false);
  });

  it("never takes a slot when preparing the payload fails", async () => {
    let asked = false;
    await expect(
      payloadThenSlot({
        phases: {},
        preparePayload: async () => {
          throw new Error("payload build failed");
        },
        takeSlot: async () => {
          asked = true;
          return { release() {} };
        },
      }),
    ).rejects.toThrow("payload build failed");
    expect(asked).toBe(false);
  });
});
