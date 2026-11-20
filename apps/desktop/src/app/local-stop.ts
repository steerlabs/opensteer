import { readFile } from "node:fs/promises";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { z } from "zod";
import type { ShutdownLog } from "./desktop-shutdown.js";

export interface LocalStopPart {
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
}

export interface LocalStopStore {
  load(): Promise<boolean>;
  save(stopped: boolean): Promise<void>;
}

/**
 * The menu bar's Stop: agent activity on this Mac ends here, without asking
 * any Home, and stays ended — across relaunches too — until the person
 * resumes. Tabs and apps go first because they act on what the person sees;
 * the Device Runners' stop waits on their workers exiting.
 */
export class DesktopLocalStop {
  readonly #parts: Readonly<Record<"browser" | "computer-use" | "runners", LocalStopPart>>;
  readonly #store: LocalStopStore;
  readonly #log: ShutdownLog;
  readonly #listeners = new Set<() => void>();
  #stopped = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly browser: LocalStopPart;
    readonly computerUse: LocalStopPart;
    readonly runners: LocalStopPart;
    readonly store: LocalStopStore;
    readonly log: ShutdownLog;
  }) {
    this.#parts = {
      browser: options.browser,
      "computer-use": options.computerUse,
      runners: options.runners,
    };
    this.#store = options.store;
    this.#log = options.log;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Re-applies a Stop the person left in place, before any Runner starts. */
  restore(): Promise<void> {
    return this.#serial(async () => {
      if (!(await this.#store.load().catch(() => false))) return;
      await this.#apply(true);
    });
  }

  stop(): Promise<void> {
    return this.#serial(async () => {
      if (this.#stopped) return;
      await this.#apply(true);
      await this.#save(true);
    });
  }

  resume(): Promise<void> {
    return this.#serial(async () => {
      if (!this.#stopped) return;
      await this.#apply(false);
      await this.#save(false);
    });
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #apply(stopped: boolean): Promise<void> {
    this.#stopped = stopped;
    this.#emit();
    const parts = Object.entries(this.#parts);
    const results = await Promise.allSettled(
      parts.map(([, part]) =>
        Promise.resolve().then(() => (stopped ? part.pause() : part.resume())),
      ),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected")
        this.#log("desktop.local-stop.part-failed", {
          part: parts[index]?.[0] ?? "unknown",
          stopped,
          message: result.reason instanceof Error ? result.reason.message : "failed",
        });
    });
    this.#log(stopped ? "desktop.local-stop.stopped" : "desktop.local-stop.resumed", {});
    this.#emit();
  }

  async #save(stopped: boolean): Promise<void> {
    await this.#store.save(stopped).catch((error: unknown) =>
      this.#log("desktop.local-stop.save-failed", {
        message: error instanceof Error ? error.message : "failed",
      }),
    );
  }

  #serial(run: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const StoredStopSchema = z.object({ stopped: z.boolean() });

export function localStopFileStore(filePath: string): LocalStopStore {
  return {
    load: async () => {
      const text = await readFile(filePath, "utf8").catch(() => null);
      if (text === null) return false;
      const parsed = StoredStopSchema.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.stopped;
    },
    save: (stopped) => replacePrivateFileAtomically(filePath, `${JSON.stringify({ stopped })}\n`),
  };
}
