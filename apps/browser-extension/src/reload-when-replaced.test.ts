import { beforeEach, expect, it, vi } from "vitest";
import { reloadWhenReplaced } from "./reload-when-replaced.js";
import { loadConnections, storageTurn } from "./storage.js";

const self = "chrome-extension://id/b/old/worker.js";
const next = "chrome-extension://id/b/new/worker.js";
const order: string[] = [];
let heldRead: (() => void) | undefined;
beforeEach(() => {
  order.length = 0;
  heldRead = undefined;
  let reads = 0;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        // The first read is held, as one the popup's status refresh has in flight at the check.
        get: async () => {
          const read = ++reads;
          if (read === 1) await new Promise<void>((resolve) => (heldRead = resolve));
          order.push(`read ${read}`);
          return {};
        },
        set: async () => undefined,
      },
    },
  });
});

it("reloads once a storage read in flight at the check has ended, before a read queued after it", async () => {
  const first = loadConnections();
  await vi.waitFor(() => expect(heldRead).toBeDefined());
  let turnQueued!: () => void;
  const queued = new Promise<void>((resolve) => (turnQueued = resolve));
  const checked = reloadWhenReplaced({
    self,
    replacement: async () => next,
    pairing: () => null,
    storageTurn: (step) => {
      const turn = storageTurn(step);
      turnQueued();
      return turn;
    },
    reload: () => order.push("reload"),
  });
  await Promise.race([queued, checked]);
  const second = loadConnections();
  await Promise.resolve();
  expect(order).toEqual([]);
  heldRead?.();
  await expect(checked).resolves.toBe(true);
  await Promise.all([first, second]);
  expect(order).toEqual(["read 1", "reload", "read 2"]);
});

it("reloads only after the pairing in progress has ended", async () => {
  let endPairing!: () => void;
  let pairing: Promise<void> | null = new Promise<void>((resolve) => {
    endPairing = () => {
      pairing = null;
      resolve();
    };
  });
  const reload = vi.fn();
  let looked = false;
  const checked = reloadWhenReplaced({
    self,
    replacement: async () => {
      looked = true;
      return next;
    },
    pairing: () => pairing,
    storageTurn,
    reload,
  });
  await vi.waitFor(() => expect(looked).toBe(true));
  await Promise.resolve();
  expect(reload).not.toHaveBeenCalled();
  endPairing();
  await expect(checked).resolves.toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it("keeps running when the files on disk name this worker, or cannot be read", async () => {
  const reload = vi.fn();
  const check = (replacement: string | null) =>
    reloadWhenReplaced({
      self,
      replacement: async () => replacement,
      pairing: () => null,
      storageTurn,
      reload,
    });
  await expect(check(self)).resolves.toBe(false);
  await expect(check(null)).resolves.toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
