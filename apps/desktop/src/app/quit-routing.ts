import { quitCompletelyConfirmation, type QuitConfirmation } from "./background-mode.js";
import type { ShutdownLog } from "./desktop-shutdown.js";

export interface QuitActions {
  readonly hide: () => void;
  readonly completely: () => void;
}

/**
 * Where the app menu's Quit and Quit Completely go, from the moment Electron
 * is ready. Before the menu bar app exists, Quit only puts windows away and
 * the window that opens later stays hidden; it never reaches the full
 * shutdown. Termination macOS starts and SIGTERM never come through here.
 */
export class DesktopQuitRouting {
  readonly #shutdown: {
    readonly requested: boolean;
    readonly signal: AbortSignal;
    request(reason: string): void;
  };
  readonly #hideWindows: () => void;
  readonly #log: ShutdownLog;
  readonly #confirm: (confirmation: QuitConfirmation, signal: AbortSignal) => Promise<boolean>;
  #earlyQuestion: Promise<void> | null = null;
  #mode: { quitRequested(): void; quitCompletely(): Promise<boolean> } | null = null;
  #quitBeforeStart = false;

  constructor(options: {
    readonly shutdown: {
      readonly requested: boolean;
      readonly signal: AbortSignal;
      request(reason: string): void;
    };
    readonly hideWindows: () => void;
    readonly log: ShutdownLog;
    readonly confirm: (confirmation: QuitConfirmation, signal: AbortSignal) => Promise<boolean>;
  }) {
    this.#shutdown = options.shutdown;
    this.#hideWindows = options.hideWindows;
    this.#log = options.log;
    this.#confirm = options.confirm;
  }

  readonly actions: QuitActions = {
    hide: () => {
      if (this.#shutdown.requested) return;
      if (this.#mode) {
        this.#mode.quitRequested();
        return;
      }
      this.#quitBeforeStart = true;
      this.#hideWindows();
    },
    completely: () => {
      if (this.#shutdown.requested) return;
      if (!this.#mode) {
        const confirmation = quitCompletelyConfirmation({
          known: false,
          hostsHome: false,
          deviceHomes: [],
          lines: [],
        });
        if (confirmation && !this.#earlyQuestion)
          this.#earlyQuestion = this.#confirm(confirmation, this.#shutdown.signal)
            .then((accepted) => {
              if (accepted && !this.#shutdown.requested) this.#shutdown.request("quit-completely");
            })
            .catch(() => undefined)
            .finally(() => {
              this.#earlyQuestion = null;
            });
        return;
      }
      void this.#mode.quitCompletely().catch((error: unknown) =>
        this.#log("desktop.quit-completely.failed", {
          message: error instanceof Error ? error.message : "failed",
        }),
      );
    },
  };

  /** Cmd+Q arrived while the app was still starting: open in the menu bar. */
  get quitBeforeStart(): boolean {
    return this.#quitBeforeStart;
  }

  attach(mode: { quitRequested(): void; quitCompletely(): Promise<boolean> }): void {
    this.#mode = mode;
  }

  /** Replaces Electron's default menu, whose Quit would run the full shutdown, at ready. */
  installAtReady(
    application: { once(event: "ready", listener: () => void): unknown },
    install: (actions: QuitActions) => void,
  ): void {
    application.once("ready", () => install(this.actions));
  }
}
