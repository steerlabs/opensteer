import { afterEach, expect, it, vi } from "vitest";
const mocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: { isPackaged: true, isInApplicationsFolder: () => true },
    updater: Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(), logger: null }),
    native: new EventEmitter(),
  };
});
vi.mock("electron", () => ({ app: mocks.app, autoUpdater: mocks.native }));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.updater }));
import { AppUpdater } from "electron-updater/out/AppUpdater.js";
import { startDesktopUpdater } from "./desktop-updater.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  mocks.updater.removeAllListeners();
  mocks.native.removeAllListeners();
});
it("sets the channel before refusing downgrades and waits for native staging, clearing readiness on errors", async () => {
  vi.useFakeTimers();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  const order: string[] = [];
  const properties = {
    channel: "",
    allowDowngrade: true,
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
  };
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(properties))
    Object.defineProperty(mocks.updater, key, {
      configurable: true,
      get: () => values[key],
      set: (value: unknown) => {
        order.push(key);
        values[key] = value;
        if (key === "channel")
          Object.getOwnPropertyDescriptor(AppUpdater.prototype, "channel")!.set!.call(
            mocks.updater,
            value,
          );
      },
    });
  mocks.updater.checkForUpdates.mockResolvedValue({ downloadPromise: Promise.resolve([]) });
  const controller = new AbortController();
  const readinessChanged = vi.fn();
  startDesktopUpdater({
    updates: { owner: "steerlabs", repo: "opensteer", channel: "insider" },
    signal: controller.signal,
    log: vi.fn(),
    readinessChanged,
  });
  expect(order).toEqual([
    "channel",
    "allowDowngrade",
    "allowPrerelease",
    "allowDowngrade",
    "autoDownload",
    "autoInstallOnAppQuit",
  ]);
  expect(values).toMatchObject({
    channel: "insider",
    allowDowngrade: false,
    allowPrerelease: true,
    autoDownload: true,
    autoInstallOnAppQuit: true,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
  mocks.updater.emit("update-downloaded");
  expect(readinessChanged).not.toHaveBeenCalled();
  mocks.native.emit("update-downloaded");
  expect(readinessChanged).toHaveBeenLastCalledWith(true);
  mocks.native.emit("error", new Error("private URL"));
  expect(readinessChanged).toHaveBeenLastCalledWith(false);
  mocks.updater.emit("error", new Error("private URL"));
  expect(readinessChanged).toHaveBeenLastCalledWith(false);
  mocks.updater.checkForUpdates.mockImplementation(async () => ({
    downloadPromise: Promise.reject(new Error("download failed")),
  }));
  await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
  expect(readinessChanged).toHaveBeenLastCalledWith(false);
  controller.abort();
  expect(vi.getTimerCount()).toBe(0);
});
