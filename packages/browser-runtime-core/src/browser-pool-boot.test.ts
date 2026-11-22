/**
 * A runtime in a pool guest takes its pool identity from its boot (pool-runtime-in-guest.md,
 * decision 2): the slot, the controller's key and the sequence floor, never its first caller.
 */
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  browserPoolControlBytes,
  type BrowserPoolControl,
  type BrowserPoolRuntimeBoot,
} from "./browser-pool.js";
import { BrowserRuntime } from "./runtime.js";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeTicketVerifier,
  testSessionFilesRoot,
} from "./test-support/fakes.js";

const controller = generateKeyPairSync("ed25519");
const boot: BrowserPoolRuntimeBoot = { slot: "slot-a", floor: { term: 3, sequence: 7 } };

function runtime(options: { boot?: BrowserPoolRuntimeBoot } = { boot }) {
  return new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([new FakePage()]))),
    runtimeId: "runtime_test",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: new FakeTicketVerifier(),
    pool: {
      controllerKey: controller.publicKey,
      probePage: async () => [],
      ...(options.boot ? { boot: options.boot } : {}),
    },
  });
}

function install(
  overrides: { slot?: string; term?: number; sequence?: number } = {},
): BrowserPoolControl {
  return {
    kind: "install",
    fence: {
      slot: overrides.slot ?? "slot-a",
      term: overrides.term ?? 3,
      instance: randomUUID(),
      epoch: 1,
    },
    sequence: overrides.sequence ?? 8,
    expect: null,
  };
}

const signed = (control: BrowserPoolControl, key: KeyObject = controller.privateKey) =>
  sign(null, browserPoolControlBytes(control), key);

describe("a pooled runtime's identity comes from its boot", () => {
  it("installs the slot's first control above the floor", async () => {
    const guest = runtime();
    const control = install();
    await expect(guest.controlPool(control, signed(control))).resolves.toMatchObject({
      phase: "running",
      fence: control.fence,
    });
  });

  it("refuses an install for another slot, though the controller's key signed it", async () => {
    const guest = runtime();
    const control = install({ slot: "slot-b" });
    await expect(guest.controlPool(control, signed(control))).rejects.toThrow("another slot");
    expect(guest.poolState()?.phase).toBe("uninstalled");
  });

  it("refuses an install signed by another key", async () => {
    const guest = runtime();
    const control = install();
    const other = generateKeyPairSync("ed25519").privateKey;
    await expect(guest.controlPool(control, signed(control, other))).rejects.toThrow(
      "not authorized",
    );
    expect(guest.poolState()?.phase).toBe("uninstalled");
  });

  it("refuses an install at or below the floor: an old start's install replayed", async () => {
    for (const replay of [
      install({ sequence: 7 }),
      install({ sequence: 1 }),
      install({ term: 2, sequence: 99 }),
    ]) {
      const guest = runtime();
      await expect(guest.controlPool(replay, signed(replay))).rejects.toThrow("superseded");
      expect(guest.poolState()?.phase).toBe("uninstalled");
    }
  });

  it("still accepts an empty runtime's first install when it was booted with no identity", async () => {
    // The loopback stand-in: unchanged for a Home without a pooled guest.
    const guest = runtime({});
    const control = install({ slot: "anything", term: 1, sequence: 1 });
    await expect(guest.controlPool(control, signed(control))).resolves.toMatchObject({
      phase: "running",
    });
  });

  it("refuses a malformed boot identity", () => {
    expect(() => runtime({ boot: { slot: "", floor: { term: 1, sequence: 0 } } })).toThrow(
      "boot identity",
    );
    expect(() => runtime({ boot: { slot: "s", floor: { term: 0, sequence: 0 } } })).toThrow(
      "boot identity",
    );
  });
});
