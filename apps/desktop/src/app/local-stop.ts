import { readFile } from "node:fs/promises";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { menuBarWords, type MenuBarStopPhase } from "@opensteer/client/computers";
import { z } from "zod";
import type { AgentAdmission } from "./agent-admission.js";
import type { ShutdownLog } from "./desktop-shutdown.js";

/** What already let an agent in, ended. Admission refuses anything new on its own. */
export interface LocalStopPart {
  /** Settles only once that work is confirmed ended; throws when it is not. */
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
}

export type LocalStopPartName = "computer-use" | "runners" | "browser" | "home";

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

/**
 * The menu bar's Stop, one transaction at a time. Stopping closes admission at
 * once, so nothing new is created on this Mac, then saves the Stop, and only
 * then ends what is already running: a Stop that never reached the disk never
 * tore anything down either. It says `stopping` until every part confirms its
 * end, then `stopped`, or `failed` with what did not stop and Stop everything
 * offered again. Resume runs strictly after the Stop before it has settled, and
 * opens admission only once the resumed state is saved.
 */
export class DesktopLocalStop {
  readonly #admission: AgentAdmission;
  readonly #parts: readonly (readonly [LocalStopPartName, LocalStopPart])[];
  readonly #store: LocalStopStore;
  readonly #log: ShutdownLog;
  readonly #listeners = new Set<() => void>();
  #problem: string | null = null;
  #phase: MenuBarStopPhase = "stopping";
  #intent = 0;
  #stoppedAt: string | null = null;
  readonly #now: () => Date;
  #writes: Promise<void> = Promise.resolve();
  #transaction: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly admission: AgentAdmission;
    readonly computerUse: LocalStopPart;
    readonly runners: LocalStopPart;
    /** Agent browser attachments, closed while the person's own tabs stay. */
    readonly browser?: LocalStopPart;
    /** This Mac's own Home's agent work, interrupted through that Home's Stop. */
    readonly home?: LocalStopPart;
    readonly store: LocalStopStore;
    readonly log: ShutdownLog;
    readonly now?: () => Date;
  }) {
    this.#now = options.now ?? (() => new Date());
    this.#admission = options.admission;
    const parts: [LocalStopPartName, LocalStopPart][] = [
      ["computer-use", options.computerUse],
      ["runners", options.runners],
    ];
    if (options.browser) parts.push(["browser", options.browser]);
    if (options.home) parts.push(["home", options.home]);
    this.#parts = parts;
    this.#store = options.store;
    this.#log = options.log;
  }

  /**
   * Whether the person has agents stopped here. It follows the person's Stop,
   * not admission alone: an update may close admission briefly to fence its
   * last look at what is running, and that is not the person's Stop.
   */
  get stopped(): boolean {
    return this.#phase !== "running";
  }

  get phase(): MenuBarStopPhase {
    return this.#phase;
  }

  get problem(): string | null {
    return this.#problem;
  }

  /** When everything was confirmed stopped; null otherwise. */
  get stoppedAt(): string | null {
    return this.phase === "stopped" ? this.#stoppedAt : null;
  }

  /** Opens admission unless the person left a Stop in place, before anything can act. */
  async restore(): Promise<void> {
    let stopped: boolean;
    try {
      const saved = await this.#store.load();
      stopped = saved.stopped;
      if (saved.stopped && this.#intent === 0) {
        this.#stoppedAt = saved.at;
        this.#phase = "stopped";
      }
    } catch (error) {
      this.#log("desktop.local-stop.read-failed", { message: messageOf(error) });
      if (this.#intent === 0) this.#phase = "failed";
      this.#setProblem(unreadStop);
      return;
    }
    if (!stopped && this.#intent === 0) {
      this.#phase = "running";
      this.#admission.reopen();
    }
    this.#emit();
  }

  /** Stops everything; pressed again after a failure, it retries what did not stop. */
  stop(): Promise<void> {
    this.#intent += 1;
    const at = this.#now().toISOString();
    this.#admission.close();
    this.#phase = "stopping";
    this.#setProblem(null);
    return this.#serially(() => this.#stop(at));
  }

  resume(): Promise<void> {
    if (this.#phase === "running") return Promise.resolve();
    const intent = ++this.#intent;
    return this.#serially(async () => {
      // A Stop pressed after this one was asked for wins.
      if (intent !== this.#intent) return;
      this.#setProblem(null);
      try {
        await this.#write({ stopped: false, at: null });
      } catch (error) {
        this.#log("desktop.local-stop.save-failed", { message: messageOf(error) });
        this.#fail(unsavedResume, this.#phase);
      }
      if (intent !== this.#intent) return;
      this.#phase = "running";
      this.#admission.reopen();
      this.#emit();
      const parts = await this.#each((part) => part.resume());
      this.#log("desktop.local-stop.resumed", { failures: parts.length });
      if (parts.length)
        this.#fail(menuBarWords("menubar.resume.partial", { parts: parts.join(", ") }), "running");
    });
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #stop(at: string): Promise<void> {
    const failures: string[] = [];
    // Saved before anything is torn down, so a crash in between leaves
    // nothing claimed and nothing ended that a relaunch would not hold.
    try {
      await this.#write({ stopped: true, at });
    } catch (error) {
      this.#log("desktop.local-stop.save-failed", { message: messageOf(error) });
      failures.push(unsavedStop);
    }
    const parts = await this.#each((part) => part.pause());
    if (parts.length)
      failures.push(menuBarWords("menubar.stop.partial", { parts: parts.join(", ") }));
    this.#log("desktop.local-stop.stopped", { failures: failures.length });
    if (failures.length) this.#fail(failures.join(" "), "failed");
    this.#stoppedAt = at;
    this.#phase = "stopped";
    this.#emit();
  }

  /** One Stop or Resume at a time, each after the one before it settled. */
  #serially(run: () => Promise<void>): Promise<void> {
    const next = this.#transaction.then(run);
    this.#transaction = next.catch(() => undefined);
    return next;
  }

  /** Writes in the order they were asked for, so the last choice is the saved one. */
  #write(state: StoredStop): Promise<void> {
    const write = this.#writes.then(() => this.#store.save(state));
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #each(run: (part: LocalStopPart) => Promise<void> | void): Promise<string[]> {
    const results = await Promise.allSettled(
      this.#parts.map(([, part]) => Promise.resolve().then(() => run(part))),
    );
    return results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const name = this.#parts[index]?.[0] ?? "computer-use";
      this.#log("desktop.local-stop.part-failed", {
        part: name,
        message: messageOf(result.reason),
      });
      return [partLabel[name]];
    });
  }

  #fail(problem: string, phase: MenuBarStopPhase): never {
    this.#phase = phase === "running" ? this.#phase : phase;
    this.#setProblem(problem);
    throw new Error(problem);
  }

  #setProblem(problem: string | null): void {
    this.#problem = problem;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const partLabel: Readonly<Record<LocalStopPartName, string>> = {
  "computer-use": "apps",
  runners: "Device connections",
  browser: "browser tabs",
  home: "tasks on this Mac’s Home",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}

const StoredStopSchema = z.object({
  stopped: z.boolean(),
  at: z.iso.datetime().nullable().catch(null).default(null),
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
