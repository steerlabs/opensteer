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

// The gate's refusal journeys need the cause, but native messages carry URLs and paths.
it("logs a fixed refusal reason and never the native message", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  const log = vi.fn();
  const controller = new AbortController();
  startDesktopUpdater({
    updates: { owner: "steerlabs", repo: "opensteer", channel: "latest" },
    signal: controller.signal,
    log,
    readinessChanged: vi.fn(),
  });
  mocks.native.emit(
    "error",
    Object.assign(
      new Error(
        "Code signature at URL file:///private/var/update/Opensteer.app did not pass validation",
      ),
      { code: -1, domain: "SQRLCodeSignatureErrorDomain" },
    ),
  );
  mocks.native.emit(
    "error",
    Object.assign(
      new Error(
        "Update failed:The application has ElectronSquirrelPreventDowngrades enabled and is trying to update from '0.1.220' to '0.1.219' which appears to be a downgrade",
      ),
      { code: 2, domain: "SQRLUpdaterErrorDomain" },
    ),
  );
  mocks.updater.emit("error", new Error("https://objects.example/private-token"));
  expect(log.mock.calls.filter(([event]) => event === "desktop.update.failed")).toEqual([
    ["desktop.update.failed", { reason: "signature" }],
    ["desktop.update.failed", { reason: "downgrade" }],
    ["desktop.update.failed", { reason: "other" }],
  ]);
  controller.abort();
});
