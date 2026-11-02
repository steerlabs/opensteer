import { app, autoUpdater as nativeUpdater } from "electron";
import { autoUpdater } from "electron-updater";
import type { DesktopUpdateState } from "@opensteer/protocol/desktop";
import type { DesktopUpdates } from "../config.js";
import type { ShutdownLog } from "./desktop-shutdown.js";
import { z } from "zod";

export const desktopUpdateFirstCheckMs = 15_000;
export const desktopUpdateCheckIntervalMs = 4 * 60_000;

const NativeUpdateErrorSchema = z.object({
  domain: z.string().optional(),
  message: z.string().optional(),
});

/** A fixed cause for the log; native messages carry URLs and local paths. */
function updateFailureReason(error: unknown): "downgrade" | "other" | "signature" {
  const parsed = NativeUpdateErrorSchema.safeParse(error);
  if (!parsed.success) return "other";
  // Squirrel.Mac's designated-requirement check for the downloaded bundle.
  if (parsed.data.domain === "SQRLCodeSignatureErrorDomain") return "signature";
  const message = parsed.data.message ?? "";
  // Squirrel.Mac's ElectronSquirrelPreventDowngrades refusal for an older bundle.
  if (
    message.includes("ElectronSquirrelPreventDowngrades") &&
    message.includes("appears to be a downgrade")
  )
    return "downgrade";
  return "other";
}

/**
 * Checks on its own; downloads and restarts only when the person asks.
 * `downloaded` waits for Squirrel to stage and verify the bundle, and ends
 * checking until the restart: the next release is found right after it.
 */
export class DesktopUpdater {
  readonly #enabled: boolean;
  readonly #log: ShutdownLog;
  readonly #listeners = new Set<(state: DesktopUpdateState) => void>();
  #state: DesktopUpdateState;
  #operation: Promise<void> | null = null;
  #stopped = false;

  constructor(options: {
    readonly updates: DesktopUpdates | undefined;
    readonly log: ShutdownLog;
  }) {
    this.#log = options.log;
    this.#enabled =
      app.isPackaged &&
      process.platform === "darwin" &&
      process.arch === "arm64" &&
      options.updates !== undefined &&
      app.isInApplicationsFolder();
    this.#state = {
      status: this.#enabled ? "idle" : "unavailable",
      currentVersion: app.getVersion(),
      availableVersion: null,
      downloadPercent: null,
      failed: null,
    };
    if (!this.#enabled || !options.updates) return;
    // The provider and cache name come from the staged app-update.yml.
    // Suppress library logs: they include URLs, local paths and staging identifiers.
    autoUpdater.logger = null;
    autoUpdater.channel = options.updates.channel;
    autoUpdater.allowPrerelease = options.updates.channel !== "latest";
    // The channel setter enables downgrades, so this assignment must follow it.
    autoUpdater.allowDowngrade = false;
    autoUpdater.autoDownload = false;
    // On macOS this hands each finished download to Squirrel at once, which
    // verifies and stages it; it also installs a staged bundle on quit.
    autoUpdater.autoInstallOnAppQuit = true;
    // Every check, download and native failure passes through here exactly once.
    autoUpdater.on("error", (error: unknown) =>
      this.#log("desktop.update.failed", { reason: updateFailureReason(error) }),
    );
    autoUpdater.on("download-progress", (progress: { readonly percent: number }) => {
      if (this.#state.status !== "downloading") return;
      const percent = Math.min(100, Math.max(0, Math.floor(progress.percent)));
      if (percent !== this.#state.downloadPercent) this.#set({ downloadPercent: percent });
    });
    nativeUpdater.on("update-downloaded", () => {
      if (this.#state.status !== "downloading") return;
      this.#log("desktop.update.downloaded", {});
      this.#set({ status: "downloaded", downloadPercent: null });
    });
    // Squirrel refuses a bad signature or a downgrade after the download
    // resolved; a failure after staging leaves nothing safe to install.
    nativeUpdater.on("error", () => {
      if (this.#state.status === "downloading" || this.#state.status === "downloaded")
        this.#failDownload();
    });
  }

  state(): DesktopUpdateState {
    return this.#state;
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Background checks until the signal aborts; they never show `checking` or a failed check. */
  start(signal: AbortSignal): void {
    if (!this.#enabled || signal.aborted) return;
    const tick = () => {
      if (this.#operation || !this.#checkable()) return;
      void this.#check(false);
    };
    const first = setTimeout(tick, desktopUpdateFirstCheckMs);
    const interval = setInterval(tick, desktopUpdateCheckIntervalMs);
    signal.addEventListener(
      "abort",
      () => {
        this.#stopped = true;
        clearTimeout(first);
        clearInterval(interval);
      },
      { once: true },
    );
  }

  /** The person's check: always a fresh one, after any background check finishes. */
  async check(): Promise<DesktopUpdateState> {
    while (this.#operation) await this.#operation;
    if (this.#enabled && this.#checkable()) await this.#check(true);
    return this.#state;
  }

  /** Downloads the version on offer, or retries its failed download. */
  async download(): Promise<void> {
    // A check in flight may replace the offer.
    while (this.#operation) await this.#operation;
    const { status, failed } = this.#state;
    if (this.#stopped || !(status === "available" || (status === "error" && failed === "download")))
      return;
    this.#log("desktop.update.downloading", {});
    this.#set({ status: "downloading", downloadPercent: 0, failed: null });
    await this.#exclusive(async () => {
      try {
        await autoUpdater.downloadUpdate();
      } catch {
        if (this.#state.status === "downloading") this.#failDownload();
      }
    });
  }

  #checkable(): boolean {
    return !this.#stopped && !["downloading", "downloaded"].includes(this.#state.status);
  }

  async #check(manual: boolean): Promise<void> {
    if (manual) this.#set({ status: "checking", availableVersion: null, failed: null });
    this.#log("desktop.update.checking", {});
    await this.#exclusive(async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        if (result?.isUpdateAvailable) {
          this.#log("desktop.update.available", {});
          this.#set({
            status: "available",
            availableVersion: result.updateInfo.version,
            failed: null,
          });
        } else {
          this.#log("desktop.update.not-available", {});
          this.#set({ status: "up-to-date", availableVersion: null, failed: null });
        }
      } catch {
        // A background failure keeps what the person last saw, including an offer.
        if (manual) this.#set({ status: "error", failed: "check" });
      }
    });
  }

  async #exclusive(run: () => Promise<void>): Promise<void> {
    const operation = run().finally(() => {
      this.#operation = null;
    });
    this.#operation = operation;
    await operation;
  }

  #failDownload(): void {
    this.#set({ status: "error", downloadPercent: null, failed: "download" });
  }

  #set(change: Partial<DesktopUpdateState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) listener(this.#state);
  }
}
