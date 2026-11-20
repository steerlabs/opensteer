import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentAdmission, AgentsStoppedError } from "./agent-admission.js";
import { DesktopLocalStop, localStopFileStore, type LocalStopStore } from "./local-stop.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

function fixture(input: { saved?: boolean; store?: Partial<LocalStopStore> } = {}) {
  const calls: string[] = [];
  const admission = new AgentAdmission();
  const part = (name: string) => ({
    pause: vi.fn(() => {
      calls.push(`${name}:pause:${admission.open ? "open" : "closed"}`);
    }),
    resume: vi.fn(() => {
      calls.push(`${name}:resume:${admission.open ? "open" : "closed"}`);
    }),
  });
  let stored = input.saved ?? false;
  let storedAt: string | null = input.saved ? "2026-11-20T09:15:00.000Z" : null;
  const store: LocalStopStore = {
    load: async () => ({ stopped: stored, at: storedAt }),
    save: async (value) => {
      calls.push(`save:${value.stopped}:${admission.open ? "open" : "closed"}`);
      stored = value.stopped;
      storedAt = value.at;
    },
    ...input.store,
  };
  const log = vi.fn();
  const computerUse = part("computer-use");
  const stop = new DesktopLocalStop({
    now: () => new Date("2026-11-20T10:42:00.000Z"),
    admission,
    computerUse,
    runners: part("runners"),
    store,
    log,
  });
  return {
    admission,
    calls,
    computerUse,
    log,
    stop,
    stored: () => stored,
    storedAt: () => storedAt,
  };
}

it("keeps admission closed until the saved choice is read, then opens it", async () => {
  const { admission, stop } = fixture();
  expect(admission.open).toBe(false);
  await stop.restore();
  expect(admission.open).toBe(true);
  const relaunched = fixture({ saved: true });
  await relaunched.stop.restore();
  expect(relaunched.admission.open).toBe(false);
  expect(relaunched.stop.stopped).toBe(true);
});

it("stays stopped when the saved choice cannot be read", async () => {
  const { admission, stop } = fixture({
    store: { load: () => Promise.reject(new Error("corrupt")) },
  });
  await stop.restore();
  expect(admission.open).toBe(false);
  expect(stop.problem).toMatch(/stay stopped/);
});

it("closes admission before anything is awaited and saves before waiting on teardown", async () => {
  const { admission, calls, stop, stored } = fixture();
  await stop.restore();
  const ticket = admission.admit();
  const stopping = stop.stop();
  expect(admission.open).toBe(false);
  expect(admission.current(ticket)).toBe(false);
  expect(() => admission.admit()).toThrow(AgentsStoppedError);
  await stopping;
  expect(calls).toEqual(["save:true:closed", "computer-use:pause:closed", "runners:pause:closed"]);
  expect(stored()).toBe(true);
  expect(stop.phase).toBe("stopped");
});

it("tears nothing down and claims nothing until the Stop is saved, so a crash before then loses nothing", async () => {
  const save = Promise.withResolvers<void>();
  const saving = Promise.withResolvers<void>();
  let saved = false;
  const { calls, stop } = fixture({
    store: {
      save: async (value) => {
        saving.resolve();
        await save.promise;
        saved = value.stopped;
      },
    },
  });
  await stop.restore();
  const stopping = stop.stop();
  await saving.promise;
  // The app could die here: nothing was ended, and nothing says it was.
  expect(calls).toEqual([]);
  expect(stop.phase).toBe("stopping");
  expect(stop.stoppedAt).toBeNull();
  expect(saved).toBe(false);
  save.resolve();
  await stopping;
  expect(calls).toEqual(["computer-use:pause:closed", "runners:pause:closed"]);
  expect(stop.phase).toBe("stopped");
});

it("says stopping until teardown is confirmed, and runs Resume only after it settles", async () => {
  const { admission, calls, computerUse, stop } = fixture();
  await stop.restore();
  const ended = Promise.withResolvers<void>();
  computerUse.pause.mockImplementationOnce(() => ended.promise);
  const stopping = stop.stop();
  await vi.waitFor(() => expect(computerUse.pause).toHaveBeenCalled());
  expect(stop.phase).toBe("stopping");
  expect(stop.stoppedAt).toBeNull();
  const resuming = stop.resume();
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  expect(admission.open).toBe(false);
  expect(calls).not.toContain("save:false:closed");
  ended.resolve();
  await stopping;
  await resuming;
  expect(calls.slice(-3)).toEqual([
    "save:false:closed",
    "computer-use:resume:open",
    "runners:resume:open",
  ]);
  expect(admission.open).toBe(true);
  expect(stop.phase).toBe("running");
});

it("reports a Stop it could not save, stays stopped, and saves on the retry", async () => {
  let fail = true;
  const saves: boolean[] = [];
  const { admission, stop } = fixture({
    store: {
      save: async (value) => {
        if (fail) throw new Error("disk full");
        saves.push(value.stopped);
      },
    },
  });
  await stop.restore();
  await expect(stop.stop()).rejects.toThrow(/couldn’t save/);
  expect(admission.open).toBe(false);
  expect(stop.phase).toBe("failed");
  expect(stop.stoppedAt).toBeNull();
  expect(stop.problem).toMatch(/Press Stop everything to try again/);
  fail = false;
  await stop.stop();
  expect(saves).toEqual([true]);
  expect(stop.problem).toBeNull();
  expect(stop.phase).toBe("stopped");
});

it("reports teardown that failed instead of success", async () => {
  const { computerUse, stop } = fixture();
  await stop.restore();
  computerUse.pause.mockImplementationOnce(() => {
    throw new Error("helper stuck");
  });
  await expect(stop.stop()).rejects.toThrow(/didn’t stop \(apps\)/);
  expect(stop.stopped).toBe(true);
  expect(stop.phase).toBe("failed");
  expect(stop.stoppedAt).toBeNull();
  // Stop everything again retries, and only a confirmed end is called stopped.
  await stop.stop();
  expect(stop.phase).toBe("stopped");
  expect(stop.problem).toBeNull();
});

it("opens admission only after Resume is saved, and not at all when saving fails", async () => {
  const { admission, calls, stop } = fixture({ saved: true });
  await stop.restore();
  await stop.resume();
  expect(calls).toEqual(["save:false:closed", "computer-use:resume:open", "runners:resume:open"]);
  expect(admission.open).toBe(true);

  const failing = fixture({
    saved: true,
    store: { save: () => Promise.reject(new Error("read-only")) },
  });
  await failing.stop.restore();
  await expect(failing.stop.resume()).rejects.toThrow(/stay stopped/);
  expect(failing.admission.open).toBe(false);
});

it("lets a Stop pressed while Resume saves win", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: boolean[] = [];
  let first = true;
  const saving = Promise.withResolvers<void>();
  const { admission, stop } = fixture({
    saved: true,
    store: {
      save: async (value) => {
        if (first) {
          first = false;
          saving.resolve();
          await held;
        }
        writes.push(value.stopped);
      },
    },
  });
  await stop.restore();
  const resuming = stop.resume();
  await saving.promise;
  const stopping = stop.stop();
  release();
  await Promise.all([resuming, stopping]);
  expect(writes).toEqual([false, true]);
  expect(admission.open).toBe(false);
});

it("keeps the person's Stop in a file and treats an unreadable one as unknown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-stop-"));
  directories.push(directory);
  const file = path.join(directory, "local-stop.json");
  const store = localStopFileStore(file);
  await expect(store.load()).resolves.toEqual({ stopped: false, at: null });
  await store.save({ stopped: true, at: "2026-11-20T10:42:00.000Z" });
  await expect(store.load()).resolves.toEqual({ stopped: true, at: "2026-11-20T10:42:00.000Z" });
  await writeFile(file, JSON.stringify({ stopped: true }));
  await expect(store.load()).resolves.toEqual({ stopped: true, at: null });
  await writeFile(file, "{");
  await expect(store.load()).rejects.toThrow();
});

it("says when everything was stopped, across a relaunch, and forgets it on Resume", async () => {
  const { stop, storedAt } = fixture();
  await stop.restore();
  expect(stop.stoppedAt).toBeNull();
  await stop.stop();
  expect(stop.stoppedAt).toBe("2026-11-20T10:42:00.000Z");
  expect(storedAt()).toBe("2026-11-20T10:42:00.000Z");
  const relaunched = fixture({ saved: true });
  await relaunched.stop.restore();
  expect(relaunched.stop.stoppedAt).toBe("2026-11-20T09:15:00.000Z");
  await relaunched.stop.resume();
  expect(relaunched.stop.stoppedAt).toBeNull();
});
