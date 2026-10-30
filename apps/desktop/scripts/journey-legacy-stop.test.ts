import { expect, it } from "vitest";
import { stopLegacyGroup } from "./journey-legacy-stop.js";
import type { ProcessIO, ProcessRow } from "./journey-processes.js";

const group = { pid: 42, pgid: 42, startedAt: "start" };
function fixture(exitAfter: number) {
  let elapsed = 0;
  let alive = true;
  let marker = false;
  const signals: string[] = [];
  const io: ProcessIO = {
    processes: () => (alive ? [{ ...group, ppid: 1, command: "fixture" } as ProcessRow] : []),
    signal: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
      return true;
    },
    pause: async (ms) => {
      elapsed += ms;
      if (elapsed >= exitAfter) {
        marker = true;
        alive = false;
      }
    },
  };
  return { io, signals, now: () => elapsed, state: () => ({ elapsed, alive, marker }) };
}
it("lets a legacy trap finish before the hard stop", async () => {
  const f = fixture(300);
  await stopLegacyGroup(group, f.io, 1000, f.now);
  expect(f.state().marker).toBe(true);
  expect(f.signals).toEqual(["SIGTERM"]);
});
it("falls back to the hard stop when the legacy trap hangs", async () => {
  const f = fixture(Infinity);
  await stopLegacyGroup(group, f.io, 300, f.now);
  expect(f.state().alive).toBe(false);
  expect(f.state().elapsed).toBeLessThanOrEqual(500);
  expect(f.signals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
});
