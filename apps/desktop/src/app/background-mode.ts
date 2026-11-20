import { readFile } from "node:fs/promises";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import type { ShutdownLog } from "./desktop-shutdown.js";

export const backgroundNoticeTitle = "Opensteer is still running";
export const backgroundNoticeBody =
  "Opensteer is still running in the menu bar so your agents and phone stay connected.";

export interface QuitWork {
  readonly hostsHome: boolean;
  /** Homes this Mac is a Device of, by name. */
  readonly deviceHomes: readonly string[];
  /** What is using this Mac right now, one line each. */
  readonly activity: readonly string[];
}

export interface QuitConfirmation {
  readonly message: string;
  readonly detail: string;
}

/** The plain sentence a full quit needs first, or null when nothing would stop that matters. */
export function quitCompletelyConfirmation(work: QuitWork): QuitConfirmation | null {
  const running = work.activity.length
    ? ` Using this Mac now: ${work.activity.slice(0, 3).join("; ")}.`
    : "";
  if (work.hostsHome)
    return {
      message: "Quit Opensteer completely?",
      detail: `This Mac is your Home. Quitting stops it: your phone and other devices can’t reach it, and agents stop until you open Opensteer again.${running}`,
    };
  if (!work.activity.length) return null;
  const homes = work.deviceHomes.length
    ? ` and disconnects this Mac from ${listed(work.deviceHomes)}`
    : "";
  return {
    message: "Quit Opensteer completely?",
    detail: `Agents are using this Mac. Quitting stops them${homes}.${running}`,
  };
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export interface DesktopBackgroundModeOptions {
  readonly shutdown: { readonly requested: boolean; request(reason: string): void };
  readonly window: { hide(): void };
  /** macOS only: the app leaves the Dock and the app switcher while no window shows. */
  readonly dock?: { hide(): void; show(): Promise<void> | void };
  readonly notice: {
    seen(): Promise<boolean>;
    markSeen(): Promise<void>;
    show(): void;
  };
  readonly work: () => Promise<QuitWork>;
  readonly confirm: (confirmation: QuitConfirmation) => Promise<boolean>;
  readonly log: ShutdownLog;
}

/**
 * Opensteer as a menu bar app: Cmd+Q, the app menu's Quit and closing the
 * window put it away and leave the Home, this Mac's Device Runners, helpers
 * and tabs running. Only Quit Opensteer Completely asks the ordered shutdown
 * to run. Termination macOS starts — logout, restart, power off — and SIGTERM
 * reach the shutdown directly and are never routed through here, so they are
 * never delayed by a question.
 */
export class DesktopBackgroundMode {
  readonly #options: DesktopBackgroundModeOptions;
  #confirming: Promise<boolean> | null = null;
  #explained: Promise<void> | null = null;

  constructor(options: DesktopBackgroundModeOptions) {
    this.#options = options;
  }

  /** Cmd+Q, the app menu's Quit, and the window's own quit shortcut. */
  quitRequested(): void {
    if (this.#options.shutdown.requested) return;
    this.#options.window.hide();
    this.windowHidden();
    this.#options.log("desktop.background.entered", {});
    if (this.#explained) return;
    this.#explained = this.#explainOnce().catch((error: unknown) => {
      this.#explained = null;
      this.#options.log("desktop.background.notice-failed", {
        message: error instanceof Error ? error.message : "failed",
      });
    });
  }

  windowShown(): void {
    if (this.#options.shutdown.requested) return;
    void Promise.resolve(this.#options.dock?.show()).catch(() => undefined);
  }

  windowHidden(): void {
    if (this.#options.shutdown.requested) return;
    this.#options.dock?.hide();
  }

  /** Resolves true when the full shutdown was asked for. */
  quitCompletely(): Promise<boolean> {
    this.#confirming ??= this.#quitCompletely().finally(() => {
      this.#confirming = null;
    });
    return this.#confirming;
  }

  async #quitCompletely(): Promise<boolean> {
    if (this.#options.shutdown.requested) return true;
    const confirmation = quitCompletelyConfirmation(await this.#options.work());
    if (confirmation && !(await this.#options.confirm(confirmation))) {
      this.#options.log("desktop.background.quit-cancelled", {});
      return false;
    }
    this.#options.shutdown.request("quit-completely");
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
