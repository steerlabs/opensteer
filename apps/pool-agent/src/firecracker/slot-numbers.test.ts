import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SlotNumbers } from "./slot-numbers.js";

// Review G1: one slot number per slot, never two slots on one number.
async function numbers() {
  const directory = await mkdtemp(join(tmpdir(), "osp-numbers-"));
  const store = new SlotNumbers(directory);
  await store.load();
  const file = async () =>
    JSON.parse(await readFile(join(directory, "slots.json"), "utf8")) as Record<string, number>;
  return { store, file, directory };
}

it("gives many concurrent creates distinct numbers, all in the file", async () => {
  const { store, file } = await numbers();
  const ids = Array.from({ length: 40 }, (_, index) => `slot-${index}`);
  const given = await Promise.all(ids.map((id) => store.allocate(id)));
  expect(new Set(given).size).toBe(ids.length);
  const written = await file();
  expect(Object.keys(written).sort()).toEqual([...ids].sort());
  expect(new Set(Object.values(written)).size).toBe(ids.length);
});

it("never gives a create a number a concurrent delete is still cleaning up", async () => {
  const { store } = await numbers();
  const first = await store.allocate("slot-old");
  let release!: () => void;
  const cleaning = new Promise<void>((resolve) => (release = resolve));
  let inCleanup = false;
  const deleting = store.release("slot-old", async () => {
    inCleanup = true;
    await cleaning;
    inCleanup = false;
  });
  await expect.poll(() => inCleanup).toBe(true);
  let reuse: number | undefined;
  const creating = store.allocate("slot-new").then((index) => (reuse = index));
  // While the old slot's namespace and users are being removed, its number stays taken.
  await Promise.resolve();
  expect(reuse).toBeUndefined();
  release();
  await deleting;
  await creating;
  expect(reuse).toBe(first);
  expect(inCleanup).toBe(false);
});

it("releases a newly allocated number when its preparation fails", async () => {
  const { store, file } = await numbers();
  await expect(
    store.allocate("slot-broken", async () => {
      throw new Error("ip failed");
    }),
  ).rejects.toThrow("ip failed");
  expect(store.get("slot-broken")).toBeUndefined();
  expect(await file()).toEqual({});
  expect(await store.allocate("slot-next")).toBe(0);
});

it("keeps the numbers across a reload", async () => {
  const { store, directory } = await numbers();
  await Promise.all(["a", "b", "c"].map((id) => store.allocate(id)));
  const again = new SlotNumbers(directory);
  await again.load();
  expect(["a", "b", "c"].map((id) => again.get(id)).sort()).toEqual([0, 1, 2]);
});
