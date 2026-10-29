import type { PowerMonitor, SystemPreferences } from "electron";

/** Native facts about this viewer; they never suspend a Runner or browser host. */
export class DesktopLocalVisibility {
  readonly #listeners = new Set<(visible: boolean) => void>();
  readonly #dispose: (() => void)[] = [];
  #locked: boolean;
  #suspended = false;
  #screenAwake = true;
  #sessionActive = true;

  constructor(
    power: PowerMonitor,
    preferences: Pick<
      SystemPreferences,
      "subscribeWorkspaceNotification" | "unsubscribeWorkspaceNotification"
    >,
    platform: NodeJS.Platform,
  ) {
    this.#locked = power.getSystemIdleState(1) === "locked";
    const events: NodeJS.EventEmitter = power;
    const observe = (
      event:
        | "lock-screen"
        | "unlock-screen"
        | "suspend"
        | "resume"
        | "user-did-become-active"
        | "user-did-resign-active",
      update: () => void,
    ) => {
      const changed = () => {
        const before = this.getSnapshot();
        update();
        if (before !== this.getSnapshot())
          for (const listener of this.#listeners) listener(this.getSnapshot());
      };
      events.on(event, changed);
      this.#dispose.push(() => {
        events.off(event, changed);
      });
    };
    observe("lock-screen", () => {
      this.#locked = true;
    });
    observe("unlock-screen", () => {
      this.#locked = false;
    });
    observe("suspend", () => {
      this.#suspended = true;
    });
    observe("resume", () => {
      this.#suspended = false;
      this.#locked ||= power.getSystemIdleState(1) === "locked";
    });
    if (platform === "darwin") {
      observe("user-did-resign-active", () => {
        this.#sessionActive = false;
      });
      observe("user-did-become-active", () => {
        this.#sessionActive = true;
      });
      // Display sleep does not suspend the computer, so powerMonitor's suspend
      // event alone would leave a locally visible document consuming pictures.
      for (const [notification, awake] of [
        ["NSWorkspaceScreensDidSleepNotification", false],
        ["NSWorkspaceScreensDidWakeNotification", true],
      ] as const) {
        const id = preferences.subscribeWorkspaceNotification(notification, () => {
          const before = this.getSnapshot();
          this.#screenAwake = awake;
          if (before !== this.getSnapshot())
            for (const listener of this.#listeners) listener(this.getSnapshot());
        });
        this.#dispose.push(() => preferences.unsubscribeWorkspaceNotification(id));
      }
    }
  }

  getSnapshot = (): boolean =>
    !this.#locked && !this.#suspended && this.#screenAwake && this.#sessionActive;

  subscribe = (listener: (visible: boolean) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  dispose(): void {
    for (const dispose of this.#dispose.splice(0)) dispose();
    this.#listeners.clear();
  }
}
