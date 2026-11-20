import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DesktopUpdateState } from "@opensteer/protocol/desktop";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backgroundUpdateDue,
  DesktopBackgroundUpdate,
  hiddenRelaunchFreshMs,
  rememberHiddenRelaunch,
  takeHiddenRelaunch,
} from "./background-update.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

const state = (change: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  status: "downloaded",
  reservedBy: null,
  channel: "stable",
  latestVersion: "2.0.0",
  currentVersion: "1.0.0",
  availableVersion: "2.0.0",
  downloadPercent: null,
  failed: null,
  ...change,
});

describe("background update rule", () => {
  const idle = { windowVisible: false, activeWork: false, stopping: false };
  it("installs a staged update only while the window is away and nothing uses this Mac", () => {
    expect(backgroundUpdateDue({ state: state(), ...idle })).toBe(true);
    expect(backgroundUpdateDue({ state: state(), ...idle, windowVisible: true })).toBe(false);
    expect(backgroundUpdateDue({ state: state(), ...idle, activeWork: true })).toBe(false);
    expect(backgroundUpdateDue({ state: state(), ...idle, stopping: true })).toBe(false);
    expect(backgroundUpdateDue({ state: state({ reservedBy: "remote" }), ...idle })).toBe(false);
    expect(backgroundUpdateDue({ state: state({ status: "available" }), ...idle })).toBe(false);
  });
});

function fixture(input: {
  visible?: boolean;
  busy?: boolean[];
  status?: DesktopUpdateState["status"];
}) {
  let current = state(input.status ? { status: input.status } : {});
  const listeners = new Set<(value: DesktopUpdateState) => void>();
  const busy = [...(input.busy ?? [false])];
  const install = vi.fn(async () => undefined);
  const restart = vi.fn(async (run: () => Promise<void>) => {
    await run();
  });
  const background = new DesktopBackgroundUpdate({
    updater: {
      state: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      restart,
    },
    install,
    windowVisible: () => input.visible ?? false,
    activeWork: async () => busy.shift() ?? false,
    stopping: () => false,
    log: vi.fn(),
    recheckMs: 1_000,
  });
  const publish = (change: Partial<DesktopUpdateState>) => {
    current = { ...current, ...change };
    for (const listener of listeners) listener(current);
  };
  return { background, install, publish, restart };
}

describe("background update", () => {
  it("installs as soon as a download stages while the app is in the menu bar", async () => {
    const { background, install, publish } = fixture({ status: "downloading" });
    background.start(new AbortController().signal);
    await vi.waitFor(() => expect(install).not.toHaveBeenCalled());
    publish({ status: "downloaded" });
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });

  it("never restarts under an open window", async () => {
    const { background, restart } = fixture({ visible: true });
    background.start(new AbortController().signal);
    background.evaluate();
    await Promise.resolve();
    expect(restart).not.toHaveBeenCalled();
  });

  it("waits for agent work on this Mac to finish, looking again later", async () => {
    vi.useFakeTimers();
    const { background, install } = fixture({ busy: [true, true, false] });
    background.start(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("stops looking once the app is shutting down", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { background, install } = fixture({ busy: [true] });
    background.start(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(install).not.toHaveBeenCalled();
  });
});

describe("hidden relaunch", () => {
  it("brings the new version back hidden once, and only soon after the install", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hidden-relaunch-"));
    directories.push(directory);
    const marker = path.join(directory, "relaunch-hidden.json");
    await expect(takeHiddenRelaunch(marker)).resolves.toBe(false);

    await rememberHiddenRelaunch(marker, 1_000);
    await expect(takeHiddenRelaunch(marker, 2_000)).resolves.toBe(true);
    expect(existsSync(marker)).toBe(false);
    await expect(takeHiddenRelaunch(marker, 2_000)).resolves.toBe(false);

    await rememberHiddenRelaunch(marker, 1_000);
    await expect(takeHiddenRelaunch(marker, 1_001 + hiddenRelaunchFreshMs)).resolves.toBe(false);

    await writeFile(marker, "not json");
    await expect(takeHiddenRelaunch(marker)).resolves.toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
