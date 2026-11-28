import { readFile, rm } from "node:fs/promises";
import type { DesktopUpdateState } from "@opensteer/protocol/desktop";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { z } from "zod";
import type { ShutdownLog } from "./desktop-shutdown.js";

export const backgroundUpdateRecheckMs = 15 * 60_000;
export const hiddenRelaunchFreshMs = 5 * 60_000;

/**
 * Squirrel installs a staged update on quit, and the person rarely quits now.
 * So a staged update installs once nobody is looking at the window and
 * nothing is using this Mac. A remote update installs itself through the
 * Host's own path, and with the window open the person's Restart button
 * stays the way in.
 */
export function backgroundUpdateDue(input: {
  readonly state: Pick<DesktopUpdateState, "reservedBy" | "status">;
  readonly windowVisible: boolean;
  readonly activeWork: boolean;
  readonly stopping: boolean;
}): boolean {
  return (
    input.state.status === "downloaded" &&
    input.state.reservedBy !== "remote" &&
    !input.windowVisible &&
    !input.activeWork &&
    !input.stopping
  );
}

export interface DesktopBackgroundUpdateOptions {
  readonly updater: {
    state(): DesktopUpdateState;
    subscribe(listener: (state: DesktopUpdateState) => void): () => void;
    restart(install: () => Promise<void>): Promise<void>;
  };
  /**
   * Hands off to the updater. `stillDue` is asked once more, as late as the
   * handoff can ask it; the install goes ahead only if it answers true.
   */
  readonly install: (stillDue: () => Promise<boolean>) => Promise<void>;
  readonly windowVisible: () => boolean;
  /** True only when nothing can be using this Mac; unknown is not idle. */
  readonly idle: () => Promise<boolean>;
  readonly stopping: () => boolean;
  readonly log: ShutdownLog;
  readonly recheckMs?: number;
}

export class DesktopBackgroundUpdate {
  readonly #options: DesktopBackgroundUpdateOptions;
  #checking: Promise<void> | null = null;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: DesktopBackgroundUpdateOptions) {
    this.#options = options;
  }

  start(signal: AbortSignal): void {
    const detach = this.#options.updater.subscribe(() => this.evaluate());
    signal.addEventListener(
      "abort",
      () => {
        this.#stopped = true;
        clearTimeout(this.#timer);
        detach();
      },
      { once: true },
    );
    this.evaluate();
  }

  /** Looks again now: the window hid, work on this Mac finished, or an update staged. */
  evaluate(): void {
    if (this.#stopped) return;
    if (this.#checking) {
      this.#again = true;
      return;
    }
    this.#checking = this.#evaluate().finally(() => {
      this.#checking = null;
      if (this.#again) {
        this.#again = false;
        this.evaluate();
      }
    });
  }

  #due(idle: boolean): boolean {
    return backgroundUpdateDue({
      state: this.#options.updater.state(),
      windowVisible: this.#options.windowVisible(),
      activeWork: !idle,
      stopping: this.#options.stopping() || this.#stopped,
    });
  }

  async #idleNow(): Promise<boolean> {
    return this.#due(await this.#options.idle().catch(() => false));
  }

  async #evaluate(): Promise<void> {
    clearTimeout(this.#timer);
    if (!this.#due(true)) return;
    let installed = false;
    if (await this.#idleNow()) {
      this.#options.log("desktop.update.background-install", {});
      installed = await this.#options.updater
        .restart(() => this.#options.install(() => this.#idleNow()))
        .then(
          () => true,
          () => {
            this.#options.log("desktop.update.background-install-deferred", {});
            return false;
          },
        );
    }
    // Nothing announces that a task on a Home finished, so a staged update
    // waiting on work looks again later rather than never.
    if (!installed && this.#due(true)) {
      this.#timer = setTimeout(
        () => this.evaluate(),
        this.#options.recheckMs ?? backgroundUpdateRecheckMs,
      );
      this.#timer.unref?.();
    }
  }
}

const HiddenRelaunchSchema = z.object({ at: z.number() });

/** Written just before an update hands off, so the new version comes back as it was left. */
export async function rememberHiddenRelaunch(filePath: string, now = Date.now()): Promise<void> {
  await replacePrivateFileAtomically(filePath, `${JSON.stringify({ at: now })}\n`);
}

export async function forgetHiddenRelaunch(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

/** One use: a marker left by an install that never relaunched expires. */
export async function takeHiddenRelaunch(filePath: string, now = Date.now()): Promise<boolean> {
  const text = await readFile(filePath, "utf8").catch(() => null);
  if (text === null) return false;
  await rm(filePath, { force: true });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  const parsed = HiddenRelaunchSchema.safeParse(value);
  return parsed.success && now >= parsed.data.at && now - parsed.data.at <= hiddenRelaunchFreshMs;
}
