import { app, autoUpdater } from "electron";
import type { ShutdownLog } from "./desktop-shutdown.js";

/** Squirrel owns download and install-on-quit; this service only schedules checks. */
export function startDesktopUpdater(options: {
  readonly feedUrl: string | undefined;
  readonly signal: AbortSignal;
  readonly log: ShutdownLog;
  readonly downloaded: () => void;
}): void {
  if (
    !app.isPackaged ||
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    !options.feedUrl ||
    !app.isInApplicationsFolder() ||
    options.signal.aborted
  )
    return;
  const feedUrl = options.feedUrl;
  let checking = false;
  let downloaded = false;
  // Native errors can contain signed download URLs or private mirror credentials.
  const failed = () => {
    checking = false;
    options.log("desktop.update.failed", {});
  };
  const ready = () => {
    checking = false;
    downloaded = true;
    options.log("desktop.update.downloaded", {});
    if (!options.signal.aborted) options.downloaded();
  };
  const unavailable = () => {
    checking = false;
    options.log("desktop.update.not-available", {});
  };
  autoUpdater.on("error", failed);
  autoUpdater.on("update-downloaded", ready);
  autoUpdater.on("update-not-available", unavailable);
  let configured = false;
  const check = () => {
    if (options.signal.aborted || checking || downloaded) return;
    try {
      checking = true;
      if (!configured) {
        autoUpdater.setFeedURL({ url: feedUrl, serverType: "json" });
        configured = true;
      }
      options.log("desktop.update.checking", {});
      autoUpdater.checkForUpdates();
    } catch {
      failed();
    }
  };
  const initial = setTimeout(check, 30_000);
  const interval = setInterval(check, 4 * 60 * 60 * 1000);
  options.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(initial);
      clearInterval(interval);
      // Retain the error listener for an in-flight native operation during quit.
      autoUpdater.off("update-downloaded", ready);
      autoUpdater.off("update-not-available", unavailable);
    },
    { once: true },
  );
}
