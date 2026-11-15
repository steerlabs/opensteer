import type { ComputerUseSessionSummary } from "@opensteer/protocol";
import { clientPublicDetail } from "../connections/operation-error.js";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { stopComputerUseSession } from "./computer-use.js";

/**
 * Where one Stop stands. The Host takes a Run's authority on a Mac back before
 * it answers, so an answer is the Stop; `failed` is a Stop that did not
 * happen, and pressing Stop again is always safe.
 */
export type ComputerUseStopPhase = "failed" | "stopped" | "stopping";

export interface ComputerUseStopTarget {
  readonly machineName: string;
  readonly runId: string;
  readonly sessionId: ComputerUseSessionSummary["sessionId"];
}

export interface ComputerUseStop extends ComputerUseStopTarget {
  /** Why a failed Stop did not happen, in words a person can act on. */
  readonly message: string | null;
  readonly phase: ComputerUseStopPhase;
  /** `performance.now()` when an answer arrived; null while stopping. */
  readonly settledAt: number | null;
}

export type ComputerUseStopClient = Pick<HostClient, "rpc" | "getSnapshot" | "subscribe">;

const retainedSettledStops = 64;
/** Longer than a Stop ever takes, so a request that went nowhere is let go. */
const stopDeadlineMs = 15_000;

function stopScope(snapshot: HostSnapshot): string | null {
  if (snapshot.session !== "authenticated" || !snapshot.user || !snapshot.deploymentId) return null;
  return JSON.stringify([snapshot.deploymentId, snapshot.user.id]);
}

/** One client-owned receipt store, shared by every screen showing the same Stop. */
export class ComputerUseStops {
  readonly #hostClient: ComputerUseStopClient;
  readonly #listeners = new Set<() => void>();
  readonly #attempts = new Map<string, number>();
  #nextAttempt = 0;
  #generation = 0;
  #scope: string | null;
  #stops: ReadonlyMap<string, ComputerUseStop> = new Map();

  constructor(hostClient: ComputerUseStopClient) {
    this.#hostClient = hostClient;
    this.#scope = stopScope(hostClient.getSnapshot());
    // HostClient can survive sign-out or deployment switches. Clear before a
    // pending RPC continuation can publish a receipt for the previous user.
    hostClient.subscribe(() => this.#syncScope());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#syncScope();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get(sessionId: string | null): ComputerUseStop | null {
    return sessionId === null ? null : (this.#stops.get(sessionId) ?? null);
  }

  /** This Run's Stop to show: one under way first, else the latest. */
  forRun(runId: string | null): ComputerUseStop | null {
    if (runId === null) return null;
    let latest: ComputerUseStop | null = null;
    for (const stop of this.#stops.values()) {
      if (stop.runId !== runId) continue;
      if (stop.phase === "stopping") return stop;
      latest = stop;
    }
    return latest;
  }

  /** Concurrent presses share one request; a confirmed Stop is not resent. */
  stop(target: ComputerUseStopTarget): void {
    this.#syncScope();
    if (this.#scope === null) return;
    const current = this.#stops.get(target.sessionId);
    if (current?.phase === "stopping" || current?.phase === "stopped") return;
    const generation = this.#generation;
    const attempt = ++this.#nextAttempt;
    this.#attempts.set(target.sessionId, attempt);
    this.#set({ ...target, message: null, phase: "stopping", settledAt: null });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), stopDeadlineMs);
    // The deadline settles the receipt even if the transport does not honour it.
    const unanswered = new Promise<never>((_, reject) =>
      deadline.signal.addEventListener("abort", () => reject(new Error("Stop timed out.")), {
        once: true,
      }),
    );
    unanswered.catch(() => undefined);
    void Promise.race([
      stopComputerUseSession(this.#hostClient, target.sessionId, deadline.signal),
      unanswered,
    ])
      .then(
        () => this.#settle(target.sessionId, generation, attempt, "stopped", null),
        (error: unknown) =>
          this.#settle(
            target.sessionId,
            generation,
            attempt,
            "failed",
            deadline.signal.aborted
              ? "Opensteer didn’t answer."
              : clientPublicDetail(error, "Opensteer couldn’t stop it."),
          ),
      )
      .finally(() => clearTimeout(timer));
  }

  dismiss(sessionId: string): void {
    this.#attempts.delete(sessionId);
    if (!this.#stops.has(sessionId)) return;
    const next = new Map(this.#stops);
    next.delete(sessionId);
    this.#stops = next;
    this.#emit();
  }

  #syncScope(): void {
    const scope = stopScope(this.#hostClient.getSnapshot());
    if (scope === this.#scope) return;
    this.#scope = scope;
    this.#generation += 1;
    this.#attempts.clear();
    if (this.#stops.size === 0) return;
    this.#stops = new Map();
    this.#emit();
  }

  #settle(
    sessionId: string,
    generation: number,
    attempt: number,
    phase: "failed" | "stopped",
    message: string | null,
  ): void {
    this.#syncScope();
    if (generation !== this.#generation || this.#attempts.get(sessionId) !== attempt) return;
    const current = this.#stops.get(sessionId);
    if (!current || current.phase !== "stopping") return;
    this.#attempts.delete(sessionId);
    this.#set({ ...current, message, phase, settledAt: performance.now() });
  }

  #set(stop: ComputerUseStop): void {
    const next = new Map(this.#stops);
    next.delete(stop.sessionId);
    next.set(stop.sessionId, stop);
    let settled = 0;
    for (const receipt of next.values()) if (receipt.phase !== "stopping") settled += 1;
    if (settled > retainedSettledStops) {
      for (const [sessionId, receipt] of next) {
        if (receipt.phase === "stopping") continue;
        next.delete(sessionId);
        settled -= 1;
        if (settled <= retainedSettledStops) break;
      }
    }
    this.#stops = next;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

const stores = new WeakMap<object, ComputerUseStops>();

export function computerUseStops(hostClient: ComputerUseStopClient): ComputerUseStops {
  let store = stores.get(hostClient);
  if (!store) {
    store = new ComputerUseStops(hostClient);
    stores.set(hostClient, store);
  }
  return store;
}

/** The words for where a Stop stands: `Stopping…`, `Stopped using Mac mini`. */
export function computerUseStopSentence(stop: ComputerUseStop): string {
  switch (stop.phase) {
    case "stopping":
      return "Stopping…";
    case "stopped":
      return `Stopped using ${stop.machineName}`;
    case "failed":
      return "Couldn’t stop";
  }
}
