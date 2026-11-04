import { statSync } from "node:fs";

/**
 * Whether this app's OS login session owns the console. Every login on a
 * computer shares its loopback ports, so anything received on one is only this
 * person's while their session is the active one. Read from the console rather
 * than remembered: an app can start, or still be running, in a session that has
 * been switched away from. Only macOS reports this; elsewhere it stays false.
 */
export class DesktopLoginSession {
  readonly #listeners = new Set<(active: boolean) => void>();
  readonly #dispose: (() => void)[] = [];
  readonly #consoleOwner: () => number;
  readonly #platform: NodeJS.Platform;
  readonly #user: number | undefined;

  constructor(
    power: NodeJS.EventEmitter,
    platform: NodeJS.Platform,
    facts: { readonly consoleOwner: () => number; readonly user: number | undefined } = {
      consoleOwner: () => statSync("/dev/console").uid,
      user: process.getuid?.(),
    },
  ) {
    this.#consoleOwner = facts.consoleOwner;
    this.#platform = platform;
    this.#user = facts.user;
    if (platform !== "darwin") return;
    for (const [event, active] of [
      ["user-did-resign-active", false],
      ["user-did-become-active", true],
    ] as const) {
      const changed = () => {
        for (const listener of this.#listeners) listener(active);
      };
      power.on(event, changed);
      this.#dispose.push(() => power.off(event, changed));
    }
  }

  active(): boolean {
    if (this.#platform !== "darwin") return false;
    try {
      return this.#consoleOwner() === this.#user;
    } catch {
      return false;
    }
  }

  subscribe(listener: (active: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const dispose of this.#dispose.splice(0)) dispose();
    this.#listeners.clear();
  }
}
