import { readFile } from "node:fs/promises";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { menuBarWords, type MenuBarStopPhase } from "@opensteer/client/computers";
import { z } from "zod";
import type { ShutdownLog } from "./desktop-shutdown.js";

export interface StoredStop {
  readonly stopped: boolean;
  /** When the person stopped everything, as an ISO time; null when not stopped. */
  readonly at: string | null;
}

export interface LocalStopStore {
  /** Throws when the saved choice cannot be read; a missing file is not stopped. */
  load(): Promise<StoredStop>;
  save(state: StoredStop): Promise<void>;
}

const unsavedStop = menuBarWords("menubar.stop.unsaved");
const unreadStop = menuBarWords("menubar.stop.unread");
const unsavedResume = menuBarWords("menubar.resume.unsaved");

interface DesktopLocalStopOptions {
  readonly restart: () => Promise<void>;
  readonly store: LocalStopStore;
  readonly log: ShutdownLog;
  readonly now?: () => Date;
}

export class DesktopLocalStop {
  readonly #options: DesktopLocalStopOptions;
  readonly #listeners = new Set<() => void>();
  #problem: string | null = null;
  #phase: MenuBarStopPhase = "stopping";
  #mode: string | null = null;
  #confirmedAt: string | null = null;
  #transaction: Promise<void> = Promise.resolve();

  constructor(options: DesktopLocalStopOptions) {
    this.#options = options;
  }

  get stopped(): boolean {
    return this.#mode !== null;
  }

  get agentsStoppedSince(): string | null {
    return this.#mode;
  }

  get phase(): MenuBarStopPhase {
    return this.#phase;
  }

  get problem(): string | null {
    return this.#problem;
  }

  get stoppedAt(): string | null {
    return this.#phase === "stopped" ? this.#confirmedAt : null;
  }

  async restore(): Promise<void> {
    try {
      const saved = await this.#options.store.load();
      this.#mode = saved.stopped ? (saved.at ?? this.#now()) : null;
    } catch (error) {
      this.#mode = this.#now();
      this.#problem = unreadStop;
      this.#options.log("desktop.local-stop.read-failed", { message: messageOf(error) });
    }
    this.#phase = this.stopped ? "stopped" : "running";
    this.#emit();
  }

  stop(): Promise<void> {
    return this.#choose(this.#now());
  }

  resume(): Promise<void> {
    return this.#choose(null);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #choose(at: string | null): Promise<void> {
    const next = this.#transaction.then(async () => {
      if (at === null && !this.stopped) return;
      this.#phase = "stopping";
      this.#problem = null;
      this.#confirmedAt = null;
      this.#emit();
      try {
        await this.#options.store.save({ stopped: at !== null, at });
      } catch (error) {
        this.#options.log("desktop.local-stop.save-failed", { message: messageOf(error) });
        this.#problem = at === null ? unsavedResume : unsavedStop;
        if (at === null) {
          this.#phase = "stopped";
          this.#emit();
          return;
        }
      }
      this.#mode = at;
      const started = performance.now();
      try {
        await this.#options.restart();
        this.#confirmedAt = at;
      } catch (error) {
        const failure = messageOf(error);
        this.#problem = this.#problem ? `${this.#problem} ${failure}` : failure;
      }
      this.#phase = at === null ? "running" : "stopped";
      this.#options.log("desktop.local-stop.restarted", {
        stopped: at !== null,
        confirmed: this.#confirmedAt !== null || (at === null && this.#problem === null),
        elapsedMs: performance.now() - started,
      });
      this.#emit();
    });
    this.#transaction = next.catch(() => undefined);
    return next;
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Couldn't confirm that everything stopped.";
}

const StoredStopSchema = z.object({
  stopped: z.boolean(),
  at: z.iso.datetime().nullable().default(null),
});

export function localStopFileStore(filePath: string): LocalStopStore {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(filePath, "utf8");
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") return { stopped: false, at: null };
        throw error;
      }
      return StoredStopSchema.parse(JSON.parse(text));
    },
    save: (state) => replacePrivateFileAtomically(filePath, `${JSON.stringify(state)}\n`),
  };
}
