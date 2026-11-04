import { app, autoUpdater as nativeUpdater } from "electron";
import { autoUpdater } from "electron-updater";
import {
  DesktopUpdateChannelSchema,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
} from "@opensteer/protocol/desktop";
import type { DesktopUpdates } from "../config.js";
import type { ShutdownLog } from "./desktop-shutdown.js";
import { z } from "zod";

export const desktopUpdateReadinessMs = 5 * 60_000;
export interface DesktopUpdateAction {
  check(): Promise<DesktopUpdateState>;
  setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateState>;
  download(targetVersion: string): Promise<void>;
  restart(install: () => Promise<void>): Promise<void>;
}

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
  #reservation: { owner: "local" | "remote"; done: Promise<void>; release(): void } | null = null;
  #readiness: Promise<void> | null = null;
  #staged = false;
  readonly #preference: {
    channel: DesktopUpdateChannel;
    save(channel: DesktopUpdateChannel): Promise<void>;
  };

  constructor(options: {
    readonly updates: Pick<DesktopUpdates, "owner" | "repo" | "host"> | undefined;
    readonly preference?: {
      channel: DesktopUpdateChannel;
      save(channel: DesktopUpdateChannel): Promise<void>;
    };
    readonly log: ShutdownLog;
  }) {
    this.#log = options.log;
    this.#preference = options.preference ?? { channel: "stable", save: async () => undefined };
    this.#enabled =
      app.isPackaged &&
      process.platform === "darwin" &&
      process.arch === "arm64" &&
      options.updates !== undefined &&
      app.isInApplicationsFolder();
    this.#state = {
      status: this.#enabled ? "idle" : "unavailable",
      channel: this.#preference.channel,
      latestVersion: null,
      currentVersion: app.getVersion(),
      availableVersion: null,
      downloadPercent: null,
      failed: null,
    };
    if (!this.#enabled || !options.updates) return;
    // The provider and cache name come from the staged app-update.yml.
    // Suppress library logs: they include URLs, local paths and staging identifiers.
    autoUpdater.logger = null;
    this.#applyChannel();
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
      this.#staged = true;
      this.#log("desktop.update.downloaded", {});
      this.#set({ status: "downloaded", downloadPercent: null, failed: null });
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

  /** Background checks omit `checking`, and a failed one keeps the last state. */
  start(signal: AbortSignal): void {
    if (!this.#enabled || signal.aborted) return;
    const tick = () => {
      if (this.#reservation || this.#operation || !this.#checkable()) return;
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
  async #requestedCheck(): Promise<DesktopUpdateState> {
    while (this.#operation) await this.#operation;
    if (this.#enabled && this.#checkable()) await this.#check(true);
    return this.#state;
  }

  /** Downloads the version on offer, or retries its failed download. */
  async #download(): Promise<void> {
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

  /** Wait out an active check before changing the provider or its saved offer. */
  async #setChannel(value: DesktopUpdateChannel): Promise<DesktopUpdateState> {
    const channel = DesktopUpdateChannelSchema.parse(value);
    const assertSwitchable = () => {
      if (this.#state.status === "downloading" || this.#staged)
        throw new Error("Restart before changing update channel.");
      if (this.#stopped) throw new Error("The app is shutting down.");
    };
    assertSwitchable();
    while (this.#operation) await this.#operation;
    assertSwitchable();
    await this.#exclusive(async () => {
      this.#set({
        status: this.#enabled ? "checking" : "unavailable",
        availableVersion: null,
        latestVersion: null,
        downloadPercent: null,
        failed: null,
      });
      try {
        await this.#preference.save(channel);
      } catch {
        this.#set({ status: this.#enabled ? "error" : "unavailable", failed: "check" });
        throw new Error("Couldn't save update channel.");
      }
      this.#set({ channel });
      if (this.#enabled) await this.#performCheck(true);
    });
    return this.#state;
  }

  check(): Promise<DesktopUpdateState> {
    return this.#reserve("local", () => this.#requestedCheck());
  }

  setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateState> {
    if (this.#state.status === "downloading" || this.#staged)
      return Promise.reject(new Error("Restart before changing update channel."));
    return this.#reserve("local", () => this.#setChannel(channel));
  }

  async download(): Promise<void> {
    await this.#reserve(
      "local",
      async () => {
        if (!this.#state.availableVersion) return;
        const ready = this.#nativeReadiness();
        this.#readiness = ready.settled;
        // Local Download returns after transfer; keep its reservation through native verification.
        void ready.settled.catch(() => {});
        await this.#download();
        ready.startDeadline();
      },
      true,
    );
  }

  restart(install: () => Promise<void>): Promise<void> {
    return this.#reserve("local", () => this.#restart(install));
  }

  remoteAction<T>(run: (action: DesktopUpdateAction) => Promise<T>): Promise<T> {
    return this.#reserve("remote", () =>
      run({
        check: () => this.#requestedCheck(),
        setChannel: (channel) => this.#setChannel(channel),
        download: async (target) => {
          if (this.#state.availableVersion !== target)
            throw new Error("The desktop update offer changed.");
          if (this.#state.status === "downloaded") return;
          const ready = this.#nativeReadiness();
          void ready.settled.catch(() => {});
          await this.#download();
          ready.startDeadline();
          await ready.settled;
        },
        restart: (install) => this.#restart(install),
      }),
    );
  }

  async #restart(install: () => Promise<void>): Promise<void> {
    if (this.#state.status !== "downloaded")
      throw new Error("The desktop update is no longer ready.");
    await install();
  }

  #reservedRemotely(): boolean {
    return this.#reservation?.owner === "remote";
  }

  async #reserve<T>(
    owner: "local" | "remote",
    run: () => Promise<T>,
    holdReadiness = false,
  ): Promise<T> {
    if (this.#reservedRemotely()) throw new Error("A remote desktop update is in progress.");
    while (this.#reservation) {
      if (owner === "remote") throw new Error("A local desktop update action is in progress.");
      await this.#reservation.done;
      if (this.#reservedRemotely()) throw new Error("A remote desktop update is in progress.");
    }
    let release!: () => void;
    const reservation = {
      owner,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
    this.#reservation = reservation;
    // Local checks retain their existing progress notifications.
    if (owner === "remote") this.#set({ reservedBy: owner });
    try {
      return await run();
    } finally {
      const finish = () => {
        if (this.#reservation !== reservation) return;
        this.#reservation = null;
        if (owner === "remote") this.#set({ reservedBy: null });
        reservation.release();
      };
      if (holdReadiness && this.#readiness) {
        void this.#readiness.then(finish, finish);
        this.#readiness = null;
      } else finish();
    }
  }

  /** The deadline covers Squirrel's verification only: transfer time depends on the link. */
  #nativeReadiness(): { settled: Promise<void>; startDeadline(): void } {
    if (this.#state.status === "downloaded")
      return { settled: Promise.resolve(), startDeadline: () => {} };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const settled = new Promise<void>((resolve, reject) => {
      const finish = (failed: boolean) => {
        done = true;
        clearTimeout(timer);
        unsubscribe();
        if (failed) reject(new Error("The desktop update could not be staged."));
        else resolve();
      };
      const unsubscribe = this.subscribe((state) => {
        if (state.status === "downloaded") finish(false);
        else if (state.status === "error") finish(true);
      });
    });
    return {
      settled,
      startDeadline: () => {
        if (done) return;
        timer = setTimeout(() => this.#failDownload(), desktopUpdateReadinessMs);
        timer.unref?.();
      },
    };
  }

  #applyChannel(): void {
    autoUpdater.channel = this.#state.channel === "stable" ? "latest" : "insider";
    autoUpdater.allowPrerelease = this.#state.channel === "beta";
    // The channel setter enables downgrades; this must come last.
    autoUpdater.allowDowngrade = false;
  }

  #checkable(): boolean {
    return (
      !this.#stopped && !this.#staged && !["downloading", "downloaded"].includes(this.#state.status)
    );
  }

  async #check(manual: boolean): Promise<void> {
    await this.#exclusive(() => this.#performCheck(manual));
  }

  async #performCheck(manual: boolean): Promise<void> {
    if (manual)
      this.#set({ status: "checking", availableVersion: null, latestVersion: null, failed: null });
    this.#log("desktop.update.checking", {});
    this.#applyChannel();
    try {
      const result = await autoUpdater.checkForUpdates();
      const latestVersion = result?.updateInfo.version ?? null;
      if (result?.isUpdateAvailable) {
        this.#log("desktop.update.available", {});
        this.#set({
          status: "available",
          availableVersion: latestVersion,
          latestVersion,
          failed: null,
        });
      } else {
        this.#log("desktop.update.not-available", {});
        this.#set({
          // With downgrades disabled, an unavailable unequal version is older.
          status:
            latestVersion && latestVersion !== this.#state.currentVersion ? "ahead" : "up-to-date",
          availableVersion: null,
          latestVersion,
          failed: null,
        });
      }
    } catch {
      if (manual) {
        // A background failure keeps what the person last saw.
        this.#set({
          status: "error",
          availableVersion: null,
          latestVersion: null,
          failed: "check",
        });
      }
    }
  }

  async #exclusive(run: () => Promise<void>): Promise<void> {
    let release!: () => void;
    // Reserve before publishing state: a subscriber may request another action.
    this.#operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await run();
    } finally {
      this.#operation = null;
      release();
    }
  }

  #failDownload(): void {
    this.#set({ status: "error", downloadPercent: null, failed: "download" });
  }

  #set(change: Partial<DesktopUpdateState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) listener(this.#state);
  }
}
