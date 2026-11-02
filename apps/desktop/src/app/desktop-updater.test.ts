import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: {
      isPackaged: true,
      isInApplicationsFolder: (): boolean => true,
      getVersion: () => "0.1.396",
    },
    updater: Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      logger: null,
    }),
    native: new EventEmitter(),
  };
});
vi.mock("electron", () => ({ app: mocks.app, autoUpdater: mocks.native }));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.updater }));
import { AppUpdater } from "electron-updater/out/AppUpdater.js";
import {
  DesktopUpdater,
  desktopUpdateCheckIntervalMs,
  desktopUpdateFirstCheckMs,
} from "./desktop-updater.js";

const insider = { owner: "steerlabs", repo: "opensteer", channel: "insider" } as const;
const offer = (version: string) => ({ isUpdateAvailable: true, updateInfo: { version } });
const current = { isUpdateAvailable: false, updateInfo: { version: "0.1.396" } };

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  mocks.updater.checkForUpdates.mockReset();
  mocks.updater.downloadUpdate.mockReset();
  mocks.updater.removeAllListeners();
  mocks.native.removeAllListeners();
});

it("sets the channel before refusing downgrades, and leaves downloading to the person", () => {
  const order: string[] = [];
  const values: Record<string, unknown> = {};
  for (const key of [
    "channel",
    "allowDowngrade",
    "allowPrerelease",
    "autoDownload",
    "autoInstallOnAppQuit",
  ])
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
  new DesktopUpdater({ updates: insider, log: vi.fn() });
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
    autoDownload: false,
    // Hands the finished download to Squirrel, which verifies and stages it.
    autoInstallOnAppQuit: true,
  });
});

it("checks on its own, downloads when asked, and is ready only once Squirrel staged the bundle", async () => {
  vi.useFakeTimers();
  const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
  const statuses: string[] = [];
  updater.subscribe((state) => statuses.push(state.status));
  const controller = new AbortController();
  updater.start(controller.signal);
  mocks.updater.checkForUpdates.mockResolvedValue(current);
  await vi.advanceTimersByTimeAsync(desktopUpdateFirstCheckMs);
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
  // A background check never shows `checking`.
  expect(statuses).toEqual(["up-to-date"]);

  mocks.updater.checkForUpdates.mockResolvedValue(offer("0.1.397"));
  await vi.advanceTimersByTimeAsync(desktopUpdateCheckIntervalMs);
  expect(updater.state()).toMatchObject({ status: "available", availableVersion: "0.1.397" });
  // A failed background check keeps the offer.
  mocks.updater.checkForUpdates.mockRejectedValue(new Error("offline"));
  await vi.advanceTimersByTimeAsync(desktopUpdateCheckIntervalMs);
  expect(updater.state()).toMatchObject({ status: "available", availableVersion: "0.1.397" });
  // A newer release replaces an offer nobody has downloaded yet.
  mocks.updater.checkForUpdates.mockResolvedValue(offer("0.1.398"));
  await vi.advanceTimersByTimeAsync(desktopUpdateCheckIntervalMs);
  expect(updater.state().availableVersion).toBe("0.1.398");

  let finish!: () => void;
  mocks.updater.downloadUpdate.mockImplementation(() => {
    mocks.updater.emit("download-progress", { percent: 41.7 });
    return new Promise<void>((resolve) => (finish = resolve));
  });
  const downloading = updater.download();
  expect(updater.state()).toMatchObject({ status: "downloading", downloadPercent: 41 });
  // Checks wait while the download runs and after it is ready.
  await vi.advanceTimersByTimeAsync(desktopUpdateCheckIntervalMs);
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(4);
  finish();
  await downloading;
  // electron-updater's own event, and its resolved download, precede Squirrel's verification.
  mocks.updater.emit("update-downloaded");
  expect(updater.state().status).toBe("downloading");
  mocks.native.emit("update-downloaded");
  expect(updater.state()).toMatchObject({
    status: "downloaded",
    availableVersion: "0.1.398",
    downloadPercent: null,
  });
  await vi.advanceTimersByTimeAsync(desktopUpdateCheckIntervalMs);
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(4);
  expect(await updater.check()).toMatchObject({ status: "downloaded" });
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(4);

  controller.abort();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports the person's failed check, and runs it fresh after a background one", async () => {
  vi.useFakeTimers();
  const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
  const controller = new AbortController();
  updater.start(controller.signal);
  let answer!: (value: typeof current) => void;
  mocks.updater.checkForUpdates.mockImplementationOnce(
    () => new Promise((resolve) => (answer = resolve)),
  );
  await vi.advanceTimersByTimeAsync(desktopUpdateFirstCheckMs);
  mocks.updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
  const checked = updater.check();
  answer(current);
  expect(await checked).toMatchObject({ status: "error", failed: "check" });
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2);

  mocks.updater.checkForUpdates.mockResolvedValueOnce(current);
  const statuses: string[] = [];
  updater.subscribe((state) => statuses.push(state.status));
  expect(await updater.check()).toMatchObject({ status: "up-to-date", failed: null });
  expect(statuses).toEqual(["checking", "up-to-date"]);
  controller.abort();
});

it("lets the person retry a failed download, or one Squirrel refused or lost", async () => {
  const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
  mocks.updater.checkForUpdates.mockResolvedValue(offer("0.1.397"));
  await updater.check();
  mocks.updater.downloadUpdate.mockRejectedValueOnce(new Error("connection reset"));
  await updater.download();
  expect(updater.state()).toMatchObject({
    status: "error",
    failed: "download",
    availableVersion: "0.1.397",
  });

  mocks.updater.downloadUpdate.mockResolvedValue([]);
  await updater.download();
  expect(updater.state().status).toBe("downloading");
  // A bad signature or a downgrade, refused after the zip was handed over.
  mocks.native.emit("error", new Error("refused"));
  expect(updater.state()).toMatchObject({ status: "error", failed: "download" });

  await updater.download();
  mocks.native.emit("update-downloaded");
  expect(updater.state().status).toBe("downloaded");
  mocks.native.emit("error", new Error("staging lost"));
  expect(updater.state()).toMatchObject({ status: "error", failed: "download" });
  expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(3);
});

it("cannot update outside Applications, and never touches the updater there", async () => {
  vi.spyOn(mocks.app, "isInApplicationsFolder").mockReturnValue(false);
  const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
  updater.start(new AbortController().signal);
  expect(await updater.check()).toMatchObject({ status: "unavailable", currentVersion: "0.1.396" });
  await updater.download();
  expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
  expect(mocks.updater.listenerCount("error")).toBe(0);
});

// The gate's refusal journeys need the cause, but native messages carry URLs and paths.
it("logs a fixed failure reason and never the native message", () => {
  const log = vi.fn();
  new DesktopUpdater({ updates: { ...insider, channel: "latest" }, log });
  // electron-updater re-emits Squirrel's errors as its own.
  mocks.updater.emit(
    "error",
    Object.assign(
      new Error(
        "Code signature at URL file:///private/var/update/Opensteer.app did not pass validation",
      ),
      { code: -1, domain: "SQRLCodeSignatureErrorDomain" },
    ),
  );
  mocks.updater.emit(
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
});
