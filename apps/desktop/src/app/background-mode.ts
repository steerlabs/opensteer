import { readFile } from "node:fs/promises";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import type { ActivitySnapshot } from "./desktop-activity.js";
import type { ShutdownLog } from "./desktop-shutdown.js";

export const backgroundNoticeTitle = "Opensteer is still running";
export const backgroundNoticeBody =
  "Opensteer is still running in the menu bar so your agents and phone stay connected.";
/** Electron ignores a Dock hide this soon after a show. */
export const dockHideRetryMs = 1_100;

export interface QuitConfirmation {
  readonly message: string;
  readonly detail: string;
}

/** The plain sentence a full quit needs first, or null when nothing would stop that matters. */
export function quitCompletelyConfirmation(work: ActivitySnapshot): QuitConfirmation | null {
  const using = work.lines.length
    ? ` Using this Mac now: ${work.lines.slice(0, 3).join("; ")}.`
    : "";
  const unknown = work.known
    ? ""
    : " Opensteer can’t tell right now whether agents are using this Mac.";
  if (work.hostsHome)
    return {
      message: "Quit Opensteer completely?",
      detail: `This Mac is your Home. Quitting stops it: your phone and other devices can’t reach it, and agents stop until you open Opensteer again.${using}${unknown}`,
    };
  if (work.known && !work.lines.length) return null;
  if (!work.lines.length && !work.deviceHomes.length) return null;
  const homes = work.deviceHomes.length
    ? ` and disconnects this Mac from ${listed(work.deviceHomes)}`
    : "";
  return {
    message: "Quit Opensteer completely?",
    detail: `${work.lines.length ? "Agents are using this Mac." : "Agents may be using this Mac."} Quitting stops them${homes}.${using}${unknown}`,
  };
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export interface DesktopBackgroundModeOptions {
  readonly shutdown: {
    readonly requested: boolean;
    readonly signal: AbortSignal;
    request(reason: string): void;
  };
  readonly window: { hide(): void };
  /** macOS only: the app leaves the Dock and the app switcher while no window shows. */
  readonly dock?: { hide(): void; show(): Promise<void> | void; isVisible(): boolean };
  readonly notice: {
    seen(): Promise<boolean>;
    markSeen(): Promise<void>;
    show(): void;
  };
  readonly work: () => Promise<ActivitySnapshot>;
  /** Closes the question unanswered when `signal` aborts. */
  readonly confirm: (confirmation: QuitConfirmation, signal: AbortSignal) => Promise<boolean>;
  readonly log: ShutdownLog;
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
}

/**
 * Opensteer as a menu bar app: Cmd+Q, the app menu's Quit and closing the
 * window put it away and leave the Home, this Mac's Device Runners, helpers
 * and tabs running. Only Quit Opensteer Completely asks the ordered shutdown
 * to run. Termination macOS starts — logout, restart, power off — and SIGTERM
 * reach the shutdown directly and are never routed through here; one that
 * arrives while Quit Completely is getting ready to ask wins, with no question.
 */
export class DesktopBackgroundMode {
  readonly #options: DesktopBackgroundModeOptions;
  readonly #schedule: NonNullable<DesktopBackgroundModeOptions["schedule"]>;
  #confirming: Promise<boolean> | null = null;
  #explained: Promise<void> | null = null;
  #outOfSight = false;
  #cancelDockRetry: () => void = () => undefined;

  constructor(options: DesktopBackgroundModeOptions) {
    this.#options = options;
    this.#schedule =
      options.schedule ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  /** Cmd+Q, the app menu's Quit, and the window's own quit shortcut. */
  quitRequested(): void {
    if (this.#options.shutdown.requested) return;
    this.#options.window.hide();
    this.windowVisibility(false);
    this.#options.log("desktop.background.entered", {});
    if (this.#explained) return;
    this.#explained = this.#explainOnce().catch((error: unknown) => {
      this.#explained = null;
      this.#options.log("desktop.background.notice-failed", {
        message: error instanceof Error ? error.message : "failed",
      });
    });
  }

  /**
   * The one Dock path: shown, hidden, minimised and restored all come here. A
   * hide Electron ignored because it followed a show too closely is tried
   * again while the window is still out of sight.
   */
  windowVisibility(visible: boolean): void {
    const dock = this.#options.dock;
    this.#outOfSight = !visible;
    this.#cancelDockRetry();
    if (!dock || this.#options.shutdown.requested) return;
    if (visible) {
      void Promise.resolve(dock.show()).catch(() => undefined);
      return;
    }
    dock.hide();
    this.#cancelDockRetry = this.#schedule(() => {
      if (this.#outOfSight && !this.#options.shutdown.requested && dock.isVisible()) dock.hide();
    }, dockHideRetryMs);
  }

  /** Resolves true when the full shutdown was asked for. */
  quitCompletely(): Promise<boolean> {
    this.#confirming ??= this.#quitCompletely().finally(() => {
      this.#confirming = null;
    });
    return this.#confirming;
  }

  async #quitCompletely(): Promise<boolean> {
    const { shutdown } = this.#options;
    if (shutdown.requested) return true;
    const work = await this.#options.work();
    if (shutdown.requested) return true;
    const confirmation = quitCompletelyConfirmation(work);
    if (confirmation) {
      const confirmed = await this.#options.confirm(confirmation, shutdown.signal);
      if (shutdown.requested) return true;
      if (!confirmed) {
        this.#options.log("desktop.background.quit-cancelled", {});
        return false;
      }
    }
    shutdown.request("quit-completely");
    return true;
  }

  async #explainOnce(): Promise<void> {
    if (await this.#options.notice.seen()) return;
    this.#options.notice.show();
    await this.#options.notice.markSeen();
  }
}

export function backgroundNoticeFileStore(
  filePath: string,
): Pick<DesktopBackgroundModeOptions["notice"], "markSeen" | "seen"> {
  return {
    seen: async () => (await readFile(filePath, "utf8").catch(() => null)) !== null,
    markSeen: () => replacePrivateFileAtomically(filePath, `${JSON.stringify({ seen: true })}\n`),
  };
}
