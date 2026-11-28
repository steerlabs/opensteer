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
const unconfirmedStop = menuBarWords("menubar.stop.unconfirmed");
const defaultConfirmOverdueMs = 30_000;

interface DesktopLocalStopOptions {
  readonly restart: () => Promise<void>;
  /**
   * Keeps looking for the hosted Home's Stop proof after local containment
   * finishes. Resolves `true` once proved or when this Mac hosts no Home,
   * `false` if looking stopped without proof (abort or shutdown), and rejects
   * only on a permanent Home refusal.
   */
  readonly confirm?: (stoppedSince: string, signal: AbortSignal) => Promise<boolean>;
  readonly confirmOverdueMs?: number;
  readonly store: LocalStopStore;
  readonly log: ShutdownLog;
  readonly now?: () => Date;
}

export class DesktopLocalStop {
  readonly #options: DesktopLocalStopOptions;
  readonly #confirmOverdueMs: number;
  readonly #listeners = new Set<() => void>();
  #problem: string | null = null;
  #phase: MenuBarStopPhase = "stopping";
  #mode: string | null = null;
  #locallyContained = false;
  #confirmedAt: string | null = null;
  #confirming = false;
  #confirmOverdue = false;
  #lookGeneration = 0;
  #lookAbort: AbortController | null = null;
  #overdueTimer: NodeJS.Timeout | undefined;
  #transaction: Promise<void> = Promise.resolve();

  constructor(options: DesktopLocalStopOptions) {
    this.#options = options;
    this.#confirmOverdueMs = options.confirmOverdueMs ?? defaultConfirmOverdueMs;
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

  get confirming(): boolean {
    return (
      this.#phase === "stopped" &&
      this.#confirming &&
      this.#confirmedAt === null &&
      this.#problem === null
    );
  }

  get confirmOverdue(): boolean {
    return this.confirming && this.#confirmOverdue;
  }

  dispose(): void {
    this.#cancelLook();
  }

  async restore(): Promise<void> {
    this.#cancelLook();
    this.#confirmedAt = null;
    this.#locallyContained = false;
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

  noteContainedBoot(mode: string): void {
    if (
      mode !== this.#mode ||
      this.#phase !== "stopped" ||
      this.#problem !== null ||
      this.#locallyContained
    )
      return;
    this.#locallyContained = true;
    if (this.#options.confirm) this.#startHomeProofLook(mode);
    else this.#confirmedAt = mode;
    this.#emit();
  }

  noteUncontainedBoot(mode: string): void {
    if (mode !== this.#mode) return;
    this.#locallyContained = false;
    this.#cancelLook();
    this.#confirmedAt = null;
    if (this.#problem?.includes(unconfirmedStop)) return;
    this.#problem = this.#problem ? `${this.#problem} ${unconfirmedStop}` : unconfirmedStop;
    this.#emit();
  }

  whileModeStable<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#transaction.then(operation);
    this.#transaction = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
    return this.whileModeStable(async () => {
      if (at === null && !this.stopped) return;
      this.#cancelLook();
      this.#phase = "stopping";
      this.#problem = null;
      this.#confirmedAt = null;
      this.#locallyContained = false;
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
      const saveProblem = this.#problem;
      try {
        await this.#options.restart();
        if (at !== null && this.#problem === saveProblem) {
          this.#locallyContained = true;
          if (this.#options.confirm) this.#startHomeProofLook(at);
          else this.#confirmedAt = at;
        }
      } catch (error) {
        this.#locallyContained = false;
        const failure = messageOf(error);
        if (at !== null && !this.#problem?.includes(unconfirmedStop))
          this.#problem = this.#problem ? `${this.#problem} ${unconfirmedStop}` : unconfirmedStop;
        if (!this.#problem?.includes(failure))
          this.#problem = this.#problem ? `${this.#problem} ${failure}` : failure;
      }
      this.#phase = at === null ? "running" : "stopped";
      this.#options.log("desktop.local-stop.restarted", {
        stopped: at !== null,
        confirmed: this.#confirmedAt !== null || (at === null && this.#problem === null),
        confirming: this.confirming,
        elapsedMs: performance.now() - started,
      });
      this.#emit();
    });
  }

  #clearOverdueTimer(): void {
    if (this.#overdueTimer) {
      clearTimeout(this.#overdueTimer);
      this.#overdueTimer = undefined;
    }
    this.#confirmOverdue = false;
  }

  #cancelLook(): void {
    this.#lookGeneration += 1;
    this.#lookAbort?.abort();
    this.#lookAbort = null;
    this.#confirming = false;
    this.#clearOverdueTimer();
  }

  #startHomeProofLook(at: string): void {
    const confirm = this.#options.confirm;
    if (!confirm || !this.#locallyContained || this.#mode !== at) return;
    this.#cancelLook();
    const generation = this.#lookGeneration;
    const controller = new AbortController();
    this.#lookAbort = controller;
    this.#confirming = true;
    this.#overdueTimer = setTimeout(() => {
      this.#overdueTimer = undefined;
      if (
        controller.signal.aborted ||
        generation !== this.#lookGeneration ||
        this.#mode !== at ||
        !this.#confirming ||
        this.#confirmedAt !== null ||
        this.#problem !== null
      )
        return;
      this.#confirmOverdue = true;
      this.#emit();
    }, this.#confirmOverdueMs);
    this.#overdueTimer.unref();
    void confirm(at, controller.signal).then(
      (confirmed) => {
        if (
          controller.signal.aborted ||
          generation !== this.#lookGeneration ||
          this.#mode !== at ||
          !this.#locallyContained
        )
          return;
        this.#lookAbort = null;
        this.#confirming = false;
        this.#clearOverdueTimer();
        if (!confirmed) {
          this.#emit();
          return;
        }
        this.#confirmedAt = at;
        this.#options.log("desktop.local-stop.home-confirmed", { stoppedAt: at });
        this.#emit();
      },
      (error: unknown) => {
        if (controller.signal.aborted || generation !== this.#lookGeneration || this.#mode !== at)
          return;
        this.#lookAbort = null;
        this.#confirming = false;
        this.#clearOverdueTimer();
        const failure = messageOf(error);
        if (!this.#problem?.includes(unconfirmedStop))
          this.#problem = this.#problem ? `${this.#problem} ${unconfirmedStop}` : unconfirmedStop;
        if (!this.#problem?.includes(failure))
          this.#problem = this.#problem ? `${this.#problem} ${failure}` : failure;
        this.#options.log("desktop.local-stop.home-proof-failed", {
          stoppedAt: at,
          message: failure,
        });
        this.#emit();
      },
    );
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
