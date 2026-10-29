import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { holdQueuedSlot } from "../scripts/test-vm/slot-queue.js";
import { vmSlotCount } from "../scripts/test-vm/slots.js";

/*
 * Ways the VM slot count could overcommit a machine or hide a mistake:
 * - a machine with room for one guest admits two;
 * - a mistyped count silently falls back to the default;
 * - a count above Apple's licence limit of two admits a guest that then fails.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("VM slots", () => {
  it("defaults to two and accepts only one or two", () => {
    expect(vmSlotCount({})).toBe(2);
    expect(vmSlotCount({ OPENSTEER_VM_SLOTS: "1" })).toBe(1);
    expect(vmSlotCount({ OPENSTEER_VM_SLOTS: "2" })).toBe(2);
    for (const value of ["", "0", "-1", "3", "10", "two", "1.5", " 2", "2 ", "02", "02x"])
      expect(() => vmSlotCount({ OPENSTEER_VM_SLOTS: value })).toThrow(
        /OPENSTEER_VM_SLOTS must be 1 or 2/u,
      );
  });

  it.runIf(process.platform === "darwin")(
    "makes a second job wait for the first when one slot is configured",
    async () => {
      const locks = await mkdtemp(path.join(tmpdir(), "opensteer-vm-slots-"));
      directories.push(locks);
      const count = vmSlotCount({ OPENSTEER_VM_SLOTS: "1" });
      const options = { label: "VM slot", count, log: () => {} };
      const first = await holdQueuedSlot(locks, { ...options, purpose: "first job" });
      let admitted = false;
      const second = holdQueuedSlot(locks, { ...options, purpose: "second job" }).then((slot) => {
        admitted = true;
        return slot;
      });
      await delay(1_000);
      expect(admitted).toBe(false);
      first.release();
      (await second).release();
      expect(admitted).toBe(true);
    },
  );
});
