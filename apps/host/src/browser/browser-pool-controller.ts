import type { BrowserPoolControl, BrowserPoolIntent } from "@opensteer/browser-runtime-core";
import {
  listOpenBrowserPoolControllerCalls,
  recordBrowserPoolControllerCall,
  settleBrowserPoolControllerCall,
  type DatabaseSchema,
} from "@opensteer/database";
import type { RunnerId } from "@opensteer/core";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { withTimeout } from "@opensteer/shared/withTimeout";

/** A guest's saved live state: consumed by exactly one resume, discarded at `discardAt`. */
export interface BrowserPoolSavedState {
  readonly id: string;
  readonly discardAt: string;
}

/** What the physical controller observes of one slot. Reading it never changes it. */
export interface BrowserPoolPhysicalStatus {
  readonly slotId: string;
  readonly term: number;
  /** One per start of the guest, issued here; null before the first start. */
  readonly instance: string | null;
  /** One per resume of that instance, issued here. */
  readonly epoch: number | null;
  readonly phase: "running" | "paused" | "stopped";
  readonly savedState: BrowserPoolSavedState | null;
}

export type BrowserPoolPhysicalKind = "start" | "pause" | "resume" | "stop" | "sign";

export interface BrowserPoolPhysicalExpectation {
  readonly instance: string | null;
  readonly epoch: number | null;
  readonly phase: BrowserPoolPhysicalStatus["phase"];
  readonly savedStateId: string | null;
}

/** One call. Its id makes it idempotent; slot, term and predecessor fence it. */
export interface BrowserPoolControllerCall {
  readonly id: string;
  readonly slotId: string;
  readonly term: number;
  readonly kind: BrowserPoolPhysicalKind;
  readonly expect: BrowserPoolPhysicalExpectation;
  /** `sign`: the runtime control to sign; the controller numbers it and names the fence. */
  readonly control?: Omit<BrowserPoolControl, "sequence" | "expect">;
  /** `resume`: the park intent the adoption control is bound to. */
  readonly intent?: BrowserPoolIntent;
}

export interface BrowserPoolControllerResult {
  readonly id: string;
  /** False is a definite refusal: nothing happened, and a repeat returns the same refusal. */
  readonly applied: boolean;
  readonly reason?: string;
  readonly status: BrowserPoolPhysicalStatus;
  readonly savedState?: BrowserPoolSavedState;
  /** `start`: the install of the new instance; `resume`: the adoption of the next epoch. */
  readonly control?: BrowserPoolControl;
  /** Base64 Ed25519 signature of the control by the controller's key. */
  readonly signature?: string;
}

/**
 * The narrow port a pool agent implements. The Home never holds the controller's key: the
 * runtime accepts only controls the controller signed for the fence it issued.
 */
export interface BrowserPoolPhysicalController {
  status(slotId: string, term: number): Promise<BrowserPoolPhysicalStatus>;
  /** The stored result of a call, or null if the controller never applied it. */
  result(slotId: string, term: number, id: string): Promise<BrowserPoolControllerResult | null>;
  apply(call: BrowserPoolControllerCall): Promise<BrowserPoolControllerResult>;
}

export function expectationOf(status: BrowserPoolPhysicalStatus): BrowserPoolPhysicalExpectation {
  return {
    instance: status.instance,
    epoch: status.epoch,
    phase: status.phase,
    savedStateId: status.savedState?.id ?? null,
  };
}

/**
 * Rule I: every call that changes the guest carries its expected predecessor and has its own
 * journal row, written before it is sent and settled with the stored result. A lost request and a
 * lost reply are told apart by asking for the stored result; an open row is delivered again with
 * the same id, never with a new one. Status and result reads carry no predecessor and get no
 * journal row: they change nothing (the lead's exception to rule I).
 */
export class BrowserPoolControllerJournal {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #controller: BrowserPoolPhysicalController;
  readonly #runnerId: RunnerId;

  readonly #timeoutMs: number;

  constructor(
    database: Kysely<DatabaseSchema>,
    controller: BrowserPoolPhysicalController,
    runnerId: RunnerId,
    timeoutMs = 10_000,
    settle?: (id: string, result: Readonly<Record<string, unknown>>) => Promise<void>,
  ) {
    this.#database = database;
    this.#controller = controller;
    this.#runnerId = runnerId;
    this.#timeoutMs = timeoutMs;
    this.#settle =
      settle ?? ((id, result) => settleBrowserPoolControllerCall(database, id, result));
  }

  readonly #settle: (id: string, result: Readonly<Record<string, unknown>>) => Promise<void>;

  /** A read of the slot: it changes nothing, so it carries no journal row. */
  status(slotId: string, term: number) {
    return withTimeout(this.#controller.status(slotId, term), this.#timeoutMs, {
      timeoutError: () => new Error("The pool controller did not answer in time."),
    });
  }

  /**
   * Journals the call, then sends it. `closeOpen` is the status the caller read before a call
   * that replaces the guest (a discard, a restart, a removal): every open row is closed with it
   * in the same write.
   */
  async call(
    input: Omit<BrowserPoolControllerCall, "id">,
    intentId: string | null,
    closeOpen?: BrowserPoolPhysicalStatus,
  ): Promise<BrowserPoolControllerResult> {
    const call: BrowserPoolControllerCall = { id: randomUUID(), ...input };
    await recordBrowserPoolControllerCall(
      this.#database,
      {
        id: call.id,
        runnerId: this.#runnerId,
        slotId: call.slotId,
        term: call.term,
        intentId,
        kind: call.kind,
        request: call as unknown as Record<string, unknown>,
      },
      closeOpen as unknown as Record<string, unknown> | undefined,
    );
    return this.#deliver(call);
  }

  /** Delivers every call the journal still has open, oldest first. */
  async settleOpen(): Promise<readonly BrowserPoolControllerResult[]> {
    const settled: BrowserPoolControllerResult[] = [];
    for (const row of await listOpenBrowserPoolControllerCalls(this.#database, this.#runnerId))
      settled.push(await this.#deliver(row.request as unknown as BrowserPoolControllerCall));
    return settled;
  }

  async #deliver(call: BrowserPoolControllerCall): Promise<BrowserPoolControllerResult> {
    // Every call has a deadline. Past it the outcome is unknown and is read by the call's id.
    const bounded = <T>(work: Promise<T>) =>
      withTimeout(work, this.#timeoutMs, {
        timeoutError: () => new Error("The pool controller did not answer in time."),
      });
    let result: BrowserPoolControllerResult | null;
    try {
      result = await bounded(this.#controller.apply(call));
    } catch (error) {
      // A lost reply has a stored result; a lost request has none and is sent again. A lookup
      // that failed is not knowing, never absence: the call fails and is settled later by id.
      try {
        result = await bounded(this.#controller.result(call.slotId, call.term, call.id));
      } catch {
        throw error;
      }
      if (!result) {
        try {
          result = await bounded(this.#controller.apply(call));
        } catch {
          throw error;
        }
      }
    }
    if (result.id !== call.id) throw new Error("The pool controller answered another call.");
    await this.#settle(call.id, result as unknown as Record<string, unknown>);
    return result;
  }
}
