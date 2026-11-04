import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: {
      get isPackaged() {
        return true;
      },
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

const insider = { owner: "steerlabs", repo: "opensteer" } as const;
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
    channel: "latest",
    allowDowngrade: false,
    allowPrerelease: false,
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
  // A failed background check keeps the last state.
  mocks.updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(desktopUpdateCheckIntervalMs);
  expect(updater.state()).toMatchObject({ status: "up-to-date", failed: null });

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
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(5);
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
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(5);
  expect(await updater.check()).toMatchObject({ status: "downloaded" });
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(5);

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
  await expect(updater.setChannel("beta")).rejects.toThrow("Restart");
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
  new DesktopUpdater({ updates: insider, log });
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

it("waits out an old check, clears its offer before saving, and never downloads it after an offline switch", async () => {
  let finish!: (value: ReturnType<typeof offer>) => void;
  const save = vi.fn(async () => {
    expect(updater.state()).toMatchObject({ availableVersion: null, failed: null });
  });
  const updater = new DesktopUpdater({
    updates: insider,
    log: vi.fn(),
    preference: { channel: "beta", save },
  });
  mocks.updater.checkForUpdates.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const checking = updater.check();
  const switching = updater.setChannel("stable");
  expect(save).not.toHaveBeenCalled();
  mocks.updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
  finish(offer("0.1.430"));
  await checking;
  await switching;
  expect(save).toHaveBeenCalledWith("stable");
  expect(updater.state()).toMatchObject({
    channel: "stable",
    status: "error",
    availableVersion: null,
    latestVersion: null,
  });
  await updater.download();
  expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
});

it("serializes rapid switches and checks each selected channel with downgrade disabled", async () => {
  const saved: string[] = [];
  const updater = new DesktopUpdater({
    updates: insider,
    log: vi.fn(),
    preference: {
      channel: "stable",
      save: async (channel) => {
        saved.push(channel);
      },
    },
  });
  mocks.updater.checkForUpdates.mockImplementation(async () => {
    expect(Reflect.get(mocks.updater, "allowDowngrade")).toBe(false);
    const beta = saved.at(-1) === "beta";
    expect(Reflect.get(mocks.updater, "channel")).toBe(beta ? "insider" : "latest");
    expect(Reflect.get(mocks.updater, "allowPrerelease")).toBe(beta);
    return current;
  });
  await Promise.all([
    updater.setChannel("beta"),
    updater.setChannel("stable"),
    updater.setChannel("beta"),
  ]);
  expect(saved).toEqual(["beta", "stable", "beta"]);
  expect(updater.state().channel).toBe("beta");
});

it("reports an older channel only after success, treats equal promotion as current, and offers newer releases", async () => {
  const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
  mocks.updater.checkForUpdates.mockResolvedValueOnce({
    isUpdateAvailable: false,
    updateInfo: { version: "0.1.390" },
  });
  expect(await updater.check()).toMatchObject({ status: "ahead", latestVersion: "0.1.390" });
  mocks.updater.checkForUpdates.mockRejectedValueOnce(new Error("HTTP 429"));
  expect(await updater.check()).toMatchObject({ status: "error", latestVersion: null });
  mocks.updater.checkForUpdates.mockResolvedValueOnce(current);
  expect(await updater.check()).toMatchObject({ status: "up-to-date", latestVersion: "0.1.396" });
  mocks.updater.checkForUpdates.mockResolvedValueOnce(offer("0.1.440"));
  expect(await updater.check()).toMatchObject({ status: "available", availableVersion: "0.1.440" });
  mocks.updater.checkForUpdates.mockResolvedValueOnce(offer("0.1.441"));
  expect(await updater.setChannel("beta")).toMatchObject({
    status: "available",
    availableVersion: "0.1.441",
    channel: "beta",
  });
});

it("reports a failed Stable check as an error without trying Beta", async () => {
  const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
  mocks.updater.checkForUpdates.mockRejectedValue(
    Object.assign(new Error("private URL"), { code: "ERR_UPDATER_INVALID_RELEASE_FEED" }),
  );
  expect(await updater.check()).toMatchObject({
    status: "error",
    failed: "check",
    channel: "stable",
  });
  expect(mocks.updater.checkForUpdates).toHaveBeenCalledOnce();
  expect(mocks.updater).toMatchObject({ channel: "latest", allowPrerelease: false });
});

it("refuses switching during download and after staging even if staging later errors", async () => {
  const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
  mocks.updater.checkForUpdates.mockResolvedValue(offer("0.1.440"));
  await updater.check();
  mocks.updater.downloadUpdate.mockResolvedValue([]);
  await updater.download();
  await expect(updater.setChannel("beta")).rejects.toThrow("Restart");
  mocks.native.emit("error", new Error("late native verification"));
  mocks.native.emit("update-downloaded");
  expect(updater.state().status).toBe("downloaded");
  await expect(updater.setChannel("beta")).rejects.toThrow("Restart");
  mocks.native.emit("error", new Error("staging lost"));
  await expect(updater.setChannel("beta")).rejects.toThrow("Restart");
});

it.each(["development", "platform", "architecture", "location", "policy"])(
  "persists selection without touching the updater when unavailable: %s",
  async (reason) => {
    if (reason === "development") vi.spyOn(mocks.app, "isPackaged", "get").mockReturnValue(false);
    if (reason === "platform") vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    if (reason === "architecture") vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    if (reason === "location") vi.spyOn(mocks.app, "isInApplicationsFolder").mockReturnValue(false);
    const save = vi.fn(async () => undefined);
    const updater = new DesktopUpdater({
      updates: reason === "policy" ? undefined : insider,
      log: vi.fn(),
      preference: { channel: "stable", save },
    });
    expect(await updater.setChannel("beta")).toMatchObject({
      status: "unavailable",
      channel: "beta",
    });
    expect(save).toHaveBeenCalledWith("beta");
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
  },
);

it("reserves the check before notifying subscribers that may request a switch", async () => {
  const save = vi.fn(async () => undefined);
  const updater = new DesktopUpdater({
    updates: insider,
    log: vi.fn(),
    preference: { channel: "stable", save },
  });
  let switched: Promise<unknown> | undefined;
  let requested = false;
  updater.subscribe((state) => {
    if (state.status === "checking" && !requested) {
      requested = true;
      switched = updater.setChannel("beta");
    }
  });
  mocks.updater.checkForUpdates.mockResolvedValue(current);
  const checking = updater.check();
  expect(save).not.toHaveBeenCalled();
  await checking;
  await switched;
  expect(save).toHaveBeenCalledWith("beta");
  expect(updater.state().channel).toBe("beta");
});

it("reserves the full remote action and waits for journal acknowledgements before staging and shutdown", async () => {
  const { DesktopUpdateExecutor } = await import("../connections/desktop-update-executor.js");
  const { withTimeout } = await import("@opensteer/shared/withTimeout");
  const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
  mocks.updater.checkForUpdates.mockResolvedValue(offer("0.1.450"));
  mocks.updater.downloadUpdate.mockResolvedValue([]);
  let receive!: (
    message: import("@opensteer/protocol/desktop-supervisor").DesktopSupervisorOutput,
  ) => void;
  const staged = Promise.withResolvers<void>();
  const installing = Promise.withResolvers<void>();
  const phases: string[] = [];
  const install = vi.fn(async () => {
    throw new Error("refused handoff");
  });
  const executor = new DesktopUpdateExecutor({
    updater,
    install,
    supervisor: {
      subscribe: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
      state: () => {},
      acknowledge: async (
        message: import("@opensteer/protocol/desktop-supervisor").DesktopUpdateProgress,
      ) => {
        phases.push(message.state);
        if (message.state === "staged") {
          expect(message.targetVersion).toBe("0.1.450");
          await withTimeout(staged.promise, 1500, {
            timeoutError: () => new Error("Test never acknowledged target persistence"),
          });
        }
        if (message.state === "installing")
          await withTimeout(installing.promise, 1500, {
            timeoutError: () => new Error("Test never acknowledged installing"),
          });
      },
    } as unknown as import("../connections/desktop-supervisor.js").DesktopSupervisor,
  });
  try {
    receive({
      type: "desktop-update.operation",
      operation: {
        id: crypto.randomUUID(),
        state: "pending",
        intent: { action: "update" },
        fromVersion: null,
        targetVersion: null,
        incarnationId: null,
        detail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    await vi.waitFor(() => expect(phases).toEqual(["running", "staged"]), { timeout: 1000 });
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
    await expect(updater.setChannel("beta")).rejects.toThrow("remote desktop update");
    await expect(updater.download()).rejects.toThrow("remote desktop update");
    await expect(updater.restart(install)).rejects.toThrow("remote desktop update");
    mocks.updater.checkForUpdates.mockResolvedValue(offer("0.1.451"));
    staged.resolve();
    await vi.waitFor(() => expect(mocks.updater.downloadUpdate).toHaveBeenCalledOnce(), {
      timeout: 1000,
    });
    expect(updater.state().availableVersion).toBe("0.1.450");
    expect(phases).toEqual(["running", "staged"]);
    mocks.native.emit("update-downloaded");
    await vi.waitFor(() => expect(phases).toEqual(["running", "staged", "installing"]), {
      timeout: 1000,
    });
    expect(install).not.toHaveBeenCalled();
    installing.resolve();
    await vi.waitFor(() => expect(phases.at(-1)).toBe("failed"), { timeout: 1000 });
    expect(install).toHaveBeenCalledOnce();
    expect(updater.state().reservedBy).toBeNull();
  } finally {
    staged.resolve();
    installing.resolve();
    executor.stop();
  }
});

it.each(["native-error", "native-deadline", "download-deadline"])(
  "settles a reserved remote update after %s",
  async (failure) => {
    vi.useFakeTimers();
    const { desktopUpdateReadinessMs } = await import("./desktop-updater.js");
    const updater = new DesktopUpdater({ updates: insider, log: vi.fn() });
    mocks.updater.checkForUpdates.mockResolvedValue(offer("0.1.450"));
    mocks.updater.downloadUpdate.mockImplementation(() =>
      failure === "download-deadline" ? new Promise(() => {}) : Promise.resolve([]),
    );
    const action = updater.remoteAction(async (reserved) => {
      await reserved.check();
      await reserved.download("0.1.450");
    });
    const failed = expect(action).rejects.toThrow("staged");
    await vi.advanceTimersByTimeAsync(0);
    if (failure === "native-error") mocks.native.emit("error", new Error("private URL"));
    else await vi.advanceTimersByTimeAsync(desktopUpdateReadinessMs);
    await failed;
    expect(updater.state()).toMatchObject({
      status: "error",
      failed: "download",
      reservedBy: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("finishes a remote channel selection without staging when the selected track is behind", async () => {
  const { DesktopUpdateExecutor } = await import("../connections/desktop-update-executor.js");
  const save = vi.fn(async () => {});
  const updater = new DesktopUpdater({
    updates: insider,
    log: vi.fn(),
    preference: { channel: "beta", save },
  });
  mocks.updater.checkForUpdates.mockResolvedValue({
    isUpdateAvailable: false,
    updateInfo: { version: "0.1.390" },
  });
  let receive!: (
    message: import("@opensteer/protocol/desktop-supervisor").DesktopSupervisorOutput,
  ) => void;
  const acknowledge = vi.fn(async () => {});
  const install = vi.fn();
  const executor = new DesktopUpdateExecutor({
    updater,
    install,
    supervisor: {
      subscribe: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
      state: () => {},
      acknowledge,
    } as unknown as import("../connections/desktop-supervisor.js").DesktopSupervisor,
  });
  try {
    receive({
      type: "desktop-update.operation",
      operation: {
        id: crypto.randomUUID(),
        state: "pending",
        intent: { action: "channel", channel: "stable" },
        fromVersion: null,
        targetVersion: null,
        incarnationId: null,
        detail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2), { timeout: 1000 });
    expect(save).toHaveBeenCalledExactlyOnceWith("stable");
    expect(acknowledge.mock.calls[1]).toEqual([
      expect.objectContaining({ state: "succeeded", detail: "ahead", targetVersion: null }),
    ]);
    expect(updater.state()).toMatchObject({ status: "ahead", channel: "stable" });
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  } finally {
    executor.stop();
  }
});
