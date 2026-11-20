import { readFile } from "node:fs/promises";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { z } from "zod";
import type { AgentAdmission } from "./agent-admission.js";
import type { ShutdownLog } from "./desktop-shutdown.js";

/** What already let an agent in, ended. Admission refuses anything new on its own. */
export interface LocalStopPart {
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
}

export interface LocalStopStore {
  /** Throws when the saved choice cannot be read; a missing file is not stopped. */
  load(): Promise<boolean>;
  save(stopped: boolean): Promise<void>;
}

const unsavedStop =
  "Agents are stopped now, but Opensteer couldn’t save that, so they could start again after Opensteer restarts. Press Stop to try again.";
const unreadStop =
  "Opensteer couldn’t read whether you stopped agents on this Mac, so they stay stopped. Press Resume to let them use this Mac again.";
const unsavedResume = "Opensteer couldn’t save Resume, so agents stay stopped. Try again.";

/**
 * The menu bar's Stop. Stopping closes admission at once, so nothing new acts
 * on this Mac, and saves that before waiting on anything already running to
 * end. Resume opens admission only once the resumed state is saved. A failure
 * stays visible until a retry succeeds; it is never reported as done.
 */
export class DesktopLocalStop {
  readonly #admission: AgentAdmission;
  readonly #parts: Readonly<Record<"computer-use" | "runners", LocalStopPart>>;
  readonly #store: LocalStopStore;
  readonly #log: ShutdownLog;
  readonly #listeners = new Set<() => void>();
  #problem: string | null = null;
  #intent = 0;
  #writes: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly admission: AgentAdmission;
    readonly computerUse: LocalStopPart;
    readonly runners: LocalStopPart;
    readonly store: LocalStopStore;
    readonly log: ShutdownLog;
  }) {
    this.#admission = options.admission;
    this.#parts = {
      "computer-use": options.computerUse,
      runners: options.runners,
    };
    this.#store = options.store;
    this.#log = options.log;
  }

  get stopped(): boolean {
    return !this.#admission.open;
  }

  get problem(): string | null {
    return this.#problem;
  }

  /** Opens admission unless the person left a Stop in place, before anything can act. */
  async restore(): Promise<void> {
    let stopped: boolean;
    try {
      stopped = await this.#store.load();
    } catch (error) {
      this.#log("desktop.local-stop.read-failed", { message: messageOf(error) });
      this.#setProblem(unreadStop);
      return;
    }
    if (!stopped && this.#intent === 0) this.#admission.reopen();
  }

  async stop(): Promise<void> {
    this.#intent += 1;
    this.#admission.close();
    this.#setProblem(null);
    const saved = this.#write(true);
    const ended = this.#each((part) => part.pause());
    const failures: string[] = [];
    try {
      await saved;
    } catch (error) {
      this.#log("desktop.local-stop.save-failed", { message: messageOf(error) });
      failures.push(unsavedStop);
    }
    const parts = await ended;
    if (parts.length)
      failures.push(
        `Some agent work on this Mac didn’t stop (${parts.join(", ")}). Press Stop to try again.`,
      );
    this.#log("desktop.local-stop.stopped", { failures: failures.length });
    if (failures.length) this.#fail(failures.join(" "));
  }

  async resume(): Promise<void> {
    if (this.#admission.open) return;
    const intent = ++this.#intent;
    this.#setProblem(null);
    try {
      await this.#write(false);
    } catch (error) {
      this.#log("desktop.local-stop.save-failed", { message: messageOf(error) });
      this.#fail(unsavedResume);
    }
    // A Stop pressed while this saved wins: it wrote after this did.
    if (intent !== this.#intent) return;
    this.#admission.reopen();
    const parts = await this.#each((part) => part.resume());
    this.#log("desktop.local-stop.resumed", { failures: parts.length });
    if (parts.length)
      this.#fail(`Agents may use this Mac again, but ${parts.join(", ")} didn’t come back yet.`);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Writes in the order they were asked for, so the last choice is the saved one. */
  #write(stopped: boolean): Promise<void> {
    const write = this.#writes.then(() => this.#store.save(stopped));
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #each(run: (part: LocalStopPart) => Promise<void> | void): Promise<string[]> {
    const parts = Object.entries(this.#parts);
    const results = await Promise.allSettled(
      parts.map(([, part]) => Promise.resolve().then(() => run(part))),
    );
    return results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const name = parts[index]?.[0] ?? "unknown";
      this.#log("desktop.local-stop.part-failed", {
        part: name,
        message: messageOf(result.reason),
      });
      return [partLabel[name] ?? name];
    });
  }

  #fail(problem: string): never {
    this.#setProblem(problem);
    throw new Error(problem);
  }

  #setProblem(problem: string | null): void {
    this.#problem = problem;
    for (const listener of this.#listeners) listener();
  }
}

const partLabel: Readonly<Record<string, string>> = {
  "computer-use": "apps",
  runners: "Device connections",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}

const StoredStopSchema = z.object({ stopped: z.boolean() });

export function localStopFileStore(filePath: string): LocalStopStore {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(filePath, "utf8");
      } catch (error) {
        if (nodeErrorCode(error) === "ENOENT") return false;
        throw error;
      }
      return StoredStopSchema.parse(JSON.parse(text)).stopped;
    },
    save: (stopped) => replacePrivateFileAtomically(filePath, `${JSON.stringify({ stopped })}\n`),
  };
}
