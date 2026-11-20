import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopLocalStop, localStopFileStore, type LocalStopStore } from "./local-stop.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

function fixture(saved = false) {
  const calls: string[] = [];
  const part = (name: string) => ({
    pause: vi.fn(() => {
      calls.push(`${name}:pause`);
    }),
    resume: vi.fn(() => {
      calls.push(`${name}:resume`);
    }),
  });
  let stored = saved;
  const store: LocalStopStore = {
    load: async () => stored,
    save: async (value) => {
      stored = value;
    },
  };
  const log = vi.fn();
  const stop = new DesktopLocalStop({
    browser: part("browser"),
    computerUse: part("computer-use"),
    runners: part("runners"),
    store,
    log,
  });
  return { calls, log, stop, stored: () => stored };
}

it("stops tabs, apps and Device Runners locally, and holds it across a relaunch", async () => {
  const { calls, stop, stored } = fixture();
  const changed = vi.fn();
  stop.subscribe(changed);
  const stopping = stop.stop();
  await stopping;
  expect(stop.stopped).toBe(true);
  expect(calls).toEqual(["browser:pause", "computer-use:pause", "runners:pause"]);
  expect(stored()).toBe(true);
  expect(changed).toHaveBeenCalled();

  await stop.stop();
  expect(calls).toHaveLength(3);

  const relaunched = fixture(true);
  await relaunched.stop.restore();
  expect(relaunched.stop.stopped).toBe(true);
  expect(relaunched.calls).toEqual(["browser:pause", "computer-use:pause", "runners:pause"]);
});

it("resumes every part and forgets the Stop", async () => {
  const { calls, stop, stored } = fixture(true);
  await stop.restore();
  calls.length = 0;
  await stop.resume();
  expect(stop.stopped).toBe(false);
  expect(calls).toEqual(["browser:resume", "computer-use:resume", "runners:resume"]);
  expect(stored()).toBe(false);
});

it("still stops the other parts when one fails, and says which", async () => {
  const log = vi.fn();
  const resumed = { pause: vi.fn(), resume: vi.fn() };
  const stop = new DesktopLocalStop({
    browser: resumed,
    computerUse: {
      pause: () => Promise.reject(new Error("helper gone")),
      resume: vi.fn(),
    },
    runners: resumed,
    store: { load: async () => false, save: async () => undefined },
    log,
  });
  await stop.stop();
  expect(stop.stopped).toBe(true);
  expect(resumed.pause).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith("desktop.local-stop.part-failed", {
    part: "computer-use",
    stopped: true,
    message: "helper gone",
  });
});

it("keeps the person's Stop in a file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-stop-"));
  directories.push(directory);
  const store = localStopFileStore(path.join(directory, "local-stop.json"));
  await expect(store.load()).resolves.toBe(false);
  await store.save(true);
  await expect(store.load()).resolves.toBe(true);
  await store.save(false);
  await expect(store.load()).resolves.toBe(false);
});
