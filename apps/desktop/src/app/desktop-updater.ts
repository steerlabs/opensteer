import { app, autoUpdater as nativeUpdater } from "electron";
import { autoUpdater } from "electron-updater";
import type { DesktopUpdates } from "../config.js";
import type { ShutdownLog } from "./desktop-shutdown.js";

/** Squirrel owns staging; electron-updater's earlier download event is insufficient. */
export function startDesktopUpdater(options: {
  readonly updates: DesktopUpdates | undefined;
  readonly signal: AbortSignal;
  readonly log: ShutdownLog;
  readonly readinessChanged: (ready: boolean) => void;
}): void {
  if (
    !app.isPackaged ||
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    !options.updates ||
    !app.isInApplicationsFolder() ||
    options.signal.aborted
  )
    return;
  // The provider and cache name come from the staged app-update.yml.
  // Suppress library logs: they include URLs, local paths and staging identifiers.
  autoUpdater.logger = null;
  autoUpdater.channel = options.updates.channel;
  autoUpdater.allowPrerelease = options.updates.channel !== "latest";
  // The channel setter enables downgrades, so this assignment must follow it.
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let checking = false;
  let downloaded = false;
  const failed = () => {
    checking = false;
    downloaded = false;
    options.log("desktop.update.failed", {});
    options.readinessChanged(false);
  };
  const ready = () => {
    checking = false;
    downloaded = true;
    options.log("desktop.update.downloaded", {});
    if (!options.signal.aborted) options.readinessChanged(true);
  };
  const unavailable = () => {
    checking = false;
    options.log("desktop.update.not-available", {});
  };
  autoUpdater.on("error", failed);
  nativeUpdater.on("error", failed);
  nativeUpdater.on("update-downloaded", ready);
  autoUpdater.on("update-not-available", unavailable);
  const check = async () => {
    if (options.signal.aborted || checking || downloaded) return;
    checking = true;
    options.log("desktop.update.checking", {});
    try {
      const result = await autoUpdater.checkForUpdates();
      await result?.downloadPromise;
    } catch {
      failed();
    } finally {
      checking = false;
    }
  };
  const initial = setTimeout(() => void check(), 30_000);
  const interval = setInterval(() => void check(), 4 * 60 * 60 * 1000);
  options.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(initial);
      clearInterval(interval);
      // Retain error listeners for in-flight operations during quit.
      nativeUpdater.off("update-downloaded", ready);
      autoUpdater.off("update-not-available", unavailable);
    },
    { once: true },
  );
}
