import type { BrowserSessionId, BrowserSurfaceId } from "@opensteer/protocol/browser";
import { verify, type KeyObject } from "node:crypto";
import { AsyncMutex } from "./async.js";
import type { BrowserPage } from "./browser/backend.js";
import { BrowserRuntimeError } from "./errors.js";

/**
 * How long a pooled session without a channel keeps its pages in the guest runtime before the
 * runtime tears it down and closes Chromium (10 minutes). The pool agent's silent-Home stop
 * lower bound stays strictly above this plus a margin so a restarting Home's live sessions are
 * never ended early.
 */
export const pooledRuntimeSessionDeadlineMs = 10 * 60_000;

export interface BrowserPoolRuntimeOptions {
  /** The pool controller's key. The runtime holds no fence until the controller installs one. */
  readonly controllerKey: KeyObject;
  /** The loopback fixture supplies its page and engine quiescence witness. */
  readonly probePage: (page: BrowserPage, phase: "active" | "frozen") => Promise<readonly string[]>;
  /** How long an adoption may take before every session not yet adopted is lost. */
  readonly adoptionWindowMs?: number;
  /** How long a session whose Runner channel was lost waits for its Home to reattach. */
  readonly channelDeadlineMs?: number;
  /**
   * A runtime in a pool guest: the identity the guest was booted with, from outside it. Every
   * control for another slot is refused, and so is every one at or below the floor, from the
   * first control on (an old install replayed into a freshly started guest included).
   */
  readonly boot?: BrowserPoolRuntimeBoot;
}

export interface BrowserPoolRuntimeBoot {
  readonly slot: string;
  /** The (term, sequence) high-water mark the guest starts with. */
  readonly floor: { readonly term: number; readonly sequence: number };
}

export interface BrowserPoolIntent {
  readonly id: string;
  readonly sequence: number;
}

/**
 * Issued by the physical controller: instance once per start, epoch once per resume. Controls
 * are ordered by the (term, sequence) high-water this runtime keeps in memory. Known limit of
 * the loopback stand-in: a freshly restarted, empty runtime has no high-water, so a replayed
 * old install can land on it; the Home then sees a fence that is not the slot's and starts a
 * fresh guest, so it ends in a discard. With a real pool agent the high-water lives outside the
 * guest, and such a replay is refused there.
 */
export interface BrowserPoolRuntimeFence {
  readonly slot: string;
  readonly term: number;
  readonly instance: string;
  readonly epoch: number;
}

export interface BrowserPoolControl {
  readonly kind: "install" | "retire" | "release" | "seal" | "adopt" | "complete";
  readonly fence: BrowserPoolRuntimeFence;
  readonly intent?: BrowserPoolIntent;
  /** `complete`: the Home's adoption attempt; no older attempt can complete it. */
  readonly attempt?: number;
  /** Issued by the controller, growing within the slot: an applied control never applies again. */
  readonly sequence: number;
  /** The fence this control expects the runtime to hold now; null only for a first install. */
  readonly expect: BrowserPoolRuntimeFence | null;
}

export interface BrowserPoolDocument {
  readonly sessionId: BrowserSessionId;
  readonly surfaceId: BrowserSurfaceId;
  readonly documentId: string;
  readonly pageRevision: number;
  /** The page held typed text that was not sent. */
  readonly typed?: boolean;
}

export interface BrowserPoolRetirement {
  /** Every live page of every session; a page that could not be kept vetoes instead. */
  readonly documents: readonly BrowserPoolDocument[];
  readonly sessions: readonly BrowserSessionId[];
}

export interface BrowserPoolSessionOutcome {
  readonly sessionId: BrowserSessionId;
  readonly reason?: string;
}

export interface BrowserPoolAdoptionOutcome {
  readonly adopted: readonly BrowserSessionId[];
  readonly lost: readonly BrowserPoolSessionOutcome[];
  /** Pages of adopted sessions that did not thaw: each closed, and each its own loss. */
  readonly pagesLost?: readonly BrowserPoolPageLoss[];
}

export type BrowserPoolRuntimePhase =
  "uninstalled" | "running" | "retiring" | "retired" | "sealed" | "adopting";

export interface BrowserPoolRuntimeState {
  readonly fence: BrowserPoolRuntimeFence | null;
  readonly revision: number;
  readonly phase: BrowserPoolRuntimePhase;
  readonly intent: BrowserPoolIntent | null;
  /** The intent was released: a late retire or seal of it is refused. */
  readonly cancelled: boolean;
  readonly retired: BrowserPoolRetirement | null;
  readonly blockers: readonly string[];
  /** Pages ended while sessions were suspended for this park: the park must not commit. */
  readonly dropped?: number;
  /** Pages a vetoed retire could not thaw: each was closed and is its own loss. */
  readonly unthawed?: readonly BrowserPoolPageLoss[];
  readonly adoption: {
    readonly cause: "resume" | "release";
    readonly until: number;
    readonly sessions: readonly BrowserSessionId[];
    readonly outcome: BrowserPoolAdoptionOutcome | null;
  } | null;
}

export interface BrowserPoolRuntimeHooks {
  retire(): Promise<BrowserPoolRetirement | readonly string[]>;
  /** The adoption ended: keep the adopted sessions, end every other retained one, thaw. */
  finishAdoption(
    sessions: readonly BrowserSessionId[],
    attempt: number | null,
    reason: string,
  ): Promise<BrowserPoolAdoptionOutcome>;
  /** A newly started guest: nothing of the previous instance survives. */
  discard(): Promise<void>;
  /** The highest adoption attempt any retained session was reattached with. */
  highestAttempt(sessions: readonly BrowserSessionId[]): number;
  /** Sessions a retire detached from their channel, even one that then failed. */
  detached(): readonly BrowserSessionId[];
  /** Pages a suspended session opened and that were ended, since the last retire began. */
  dropped(): number;
  /** Pages a vetoed retire froze and could not thaw, since the last retire began. */
  unthawed(): readonly BrowserPoolPageLoss[];
}

/** One page lost on its own: its session is kept. */
export interface BrowserPoolPageLoss {
  readonly sessionId: BrowserSessionId;
  readonly surfaceId: BrowserSurfaceId;
  readonly reason: string;
}

export function browserPoolControlBytes(control: BrowserPoolControl): Buffer {
  const { kind, fence, intent } = control;
  return Buffer.from(
    JSON.stringify([
      "opensteer/browser-pool-runtime/v2",
      kind,
      fence.slot,
      fence.term,
      fence.instance,
      fence.epoch,
      intent?.sequence ?? null,
      intent?.id ?? null,
      control.attempt ?? null,
      control.sequence,
      control.expect
        ? [control.expect.slot, control.expect.term, control.expect.instance, control.expect.epoch]
        : null,
    ]),
  );
}

function sameFence(a: BrowserPoolRuntimeFence | null, b: BrowserPoolRuntimeFence | undefined) {
  return (
    !!a &&
    !!b &&
    a.slot === b.slot &&
    a.term === b.term &&
    a.instance === b.instance &&
    a.epoch === b.epoch
  );
}

function sameIntent(a: BrowserPoolIntent | null, b: BrowserPoolIntent | undefined) {
  return !!a && !!b && a.id === b.id && a.sequence === b.sequence;
}

/**
 * The runtime half of a park. Every transition is signed by the controller and serialized. A
 * control already applied, or an older one, is superseded; a step of the same intent signed
 * again returns the state it reached; a late control of a released intent is refused. No phase
 * depends on the Home coming back: an adoption ends by itself at its window.
 */
export class BrowserPoolRuntimeControl {
  private readonly lane = new AsyncMutex();
  private readonly key: KeyObject;
  private readonly hooks: BrowserPoolRuntimeHooks;
  private readonly windowMs: number;
  private current: BrowserPoolRuntimeState = {
    fence: null,
    revision: 0,
    phase: "uninstalled",
    intent: null,
    cancelled: false,
    retired: null,
    blockers: [],
    adoption: null,
  };
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private high: { readonly term: number; readonly sequence: number } | null = null;
  private readonly slot: string | undefined;

  constructor(
    key: KeyObject,
    hooks: BrowserPoolRuntimeHooks,
    windowMs = 30_000,
    boot?: BrowserPoolRuntimeBoot,
  ) {
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
      throw new TypeError("The browser pool controller requires an Ed25519 public key.");
    this.key = key;
    this.hooks = hooks;
    this.windowMs = windowMs;
    if (boot) {
      const { term, sequence } = boot.floor;
      if (
        !boot.slot ||
        !Number.isSafeInteger(term) ||
        term < 1 ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0
      )
        throw new TypeError("The browser pool boot identity is invalid.");
      this.slot = boot.slot;
      this.high = { term, sequence };
    }
  }

  state(): BrowserPoolRuntimeState {
    const unthawed = this.hooks.unthawed();
    return {
      ...structuredClone(this.current),
      dropped: this.hooks.dropped(),
      ...(unthawed.length ? { unthawed: structuredClone(unthawed) } : {}),
    };
  }

  get acceptsTraffic(): boolean {
    return this.current.phase === "running";
  }

  /** A reattach of a retained session is admitted while its adoption is open. */
  canAdopt(sessionId: BrowserSessionId): boolean {
    const adoption = this.current.adoption;
    return (
      this.current.phase === "adopting" &&
      adoption !== null &&
      adoption.outcome === null &&
      adoption.sessions.includes(sessionId)
    );
  }

  checkFence(fence: BrowserPoolRuntimeFence | undefined) {
    if (!sameFence(this.current.fence, fence))
      throw new BrowserRuntimeError("forbidden", "The pooled browser authority has changed.");
  }

  apply(control: BrowserPoolControl, signature: Uint8Array): Promise<BrowserPoolRuntimeState> {
    const request = structuredClone(control);
    if (!verify(null, browserPoolControlBytes(request), this.key, signature))
      return Promise.reject(
        new BrowserRuntimeError("forbidden", "The browser pool controller is not authorized."),
      );
    return this.lane.run(() => this.transition(request));
  }

  private async transition(request: BrowserPoolControl): Promise<BrowserPoolRuntimeState> {
    const current = this.current;
    const { fence } = request;
    // A pool guest serves its own slot only, whatever the key signed.
    if (this.slot !== undefined && fence.slot !== this.slot)
      throw new BrowserRuntimeError("conflict", "The browser pool control names another slot.");
    // Ordered by (term, sequence): a control already applied, or an older one, never applies.
    const high = this.high;
    if (
      !Number.isSafeInteger(request.sequence) ||
      request.sequence < 1 ||
      (high &&
        (fence.term < high.term || (fence.term === high.term && request.sequence <= high.sequence)))
    )
      throw new BrowserRuntimeError("conflict", "The browser pool control was superseded.");
    // A control names the fence it replaces: the current one, or none before the first install.
    if (
      request.expect === null ? current.fence !== null : !sameFence(current.fence, request.expect)
    )
      throw new BrowserRuntimeError("conflict", "The browser pool fence is not the expected one.");
    // Every check comes before the mark moves: a refused control never supersedes an earlier
    // one that would apply.
    const step = this.admit(request);
    this.high = { term: fence.term, sequence: request.sequence };
    return step();
  }

  /** The checks of one control, with nothing changed; then what it does. */
  private admit(
    request: BrowserPoolControl,
  ): () => BrowserPoolRuntimeState | Promise<BrowserPoolRuntimeState> {
    const current = this.current;
    const { kind, fence, intent } = request;
    if (kind === "install") {
      // A start is a new instance: its fence moves forward, never back and never in place.
      if (
        current.fence &&
        (fence.slot !== current.fence.slot ||
          fence.term < current.fence.term ||
          sameFence(current.fence, fence))
      )
        throw new BrowserRuntimeError("conflict", "The browser pool fence moved backwards.");
      return async () => {
        // A fresh instance is a newly started guest: discard every live page first.
        if (current.fence) await this.hooks.discard();
        this.stopExpiry();
        this.write({
          fence,
          phase: "running",
          intent: null,
          cancelled: false,
          retired: null,
          blockers: [],
          adoption: null,
        });
        return this.state();
      };
    }
    if (kind === "adopt") {
      // The controller issues the next epoch on resume; adoption installs it.
      if (
        current.phase !== "sealed" ||
        !current.fence ||
        !sameIntent(current.intent, intent) ||
        fence.slot !== current.fence.slot ||
        fence.instance !== current.fence.instance ||
        fence.term < current.fence.term ||
        fence.epoch <= current.fence.epoch
      )
        throw new BrowserRuntimeError("conflict", "The browser adoption is not ready.");
      return () => {
        this.write({ fence, ...this.openAdoption("resume") });
        return this.state();
      };
    }
    this.checkFence(fence);
    if (!intent || !Number.isSafeInteger(intent.sequence) || intent.sequence < 1 || !intent.id)
      throw new BrowserRuntimeError("bad_message", "The browser park intent is invalid.");
    const previous = current.intent;
    if (
      previous &&
      (intent.sequence < previous.sequence ||
        (intent.sequence === previous.sequence && intent.id !== previous.id))
    )
      throw new BrowserRuntimeError("conflict", "The browser park intent was superseded.");
    const same = sameIntent(previous, intent);
    if (!same && current.phase !== "running")
      throw new BrowserRuntimeError("conflict", "Another browser park intent is unresolved.");
    // A step of the same intent, signed again, returns the state it already reached.
    switch (kind) {
      case "retire":
        if (same && current.cancelled)
          throw new BrowserRuntimeError("conflict", "The browser park intent was cancelled.");
        return same ? () => this.state() : () => this.retire(intent);
      case "release":
        if (current.phase === "sealed" || (same && current.adoption?.cause === "resume"))
          throw new BrowserRuntimeError("conflict", "The browser park was committed.");
        if (same && current.phase === "adopting") return () => this.state();
        return () => {
          if (same && (current.phase === "retiring" || current.phase === "retired"))
            // Make every retained page reachable again: the Home reattaches, then completes.
            this.write({ cancelled: true, ...this.openAdoption("release") });
          // Records cancellation even when the retire has not arrived.
          else
            this.write({
              intent,
              phase: "running",
              cancelled: true,
              ...(same ? {} : { retired: null, blockers: [], adoption: null }),
            });
          return this.state();
        };
      case "seal":
        if (!same || current.cancelled)
          throw new BrowserRuntimeError("conflict", "The browser park intent is unresolved.");
        if (current.phase === "sealed") return () => this.state();
        if (current.phase !== "retired")
          throw new BrowserRuntimeError("conflict", "The browser is not retired.");
        return () => {
          this.write({ phase: "sealed" });
          return this.state();
        };
      case "complete": {
        const adoption = current.adoption;
        if (!same || !adoption)
          throw new BrowserRuntimeError("conflict", "The browser adoption is not active.");
        if (adoption.outcome) return () => this.state();
        const attempt = request.attempt;
        if (!Number.isSafeInteger(attempt) || attempt! < 1)
          throw new BrowserRuntimeError("bad_message", "The adoption attempt is invalid.");
        if (attempt! < this.hooks.highestAttempt(adoption.sessions))
          throw new BrowserRuntimeError("conflict", "A newer adoption attempt exists.");
        return async () => {
          await this.finish(attempt!, "not-reattached");
          return this.state();
        };
      }
    }
    throw new BrowserRuntimeError("bad_message", "Unknown browser pool control.");
  }

  private async retire(intent: BrowserPoolIntent): Promise<BrowserPoolRuntimeState> {
    this.write({
      intent,
      phase: "retiring",
      cancelled: false,
      retired: null,
      blockers: [],
      adoption: null,
    });
    let outcome: BrowserPoolRetirement | readonly string[];
    try {
      outcome = await this.hooks.retire();
    } catch {
      // Some sessions may already be detached: the only way back is an adoption.
      outcome = ["retire-failed"];
      if (this.current.phase === "retiring") {
        this.write({ blockers: outcome });
        return this.state();
      }
    }
    if ("documents" in outcome) this.write({ phase: "retired", retired: outcome });
    else this.write({ phase: "running", blockers: outcome });
    return this.state();
  }

  private openAdoption(cause: "resume" | "release"): Partial<BrowserPoolRuntimeState> {
    this.stopExpiry();
    const until = Date.now() + this.windowMs;
    this.expiry = setTimeout(() => {
      void this.lane
        .run(async () => {
          if (this.current.phase === "adopting" && this.current.adoption?.until === until)
            await this.finish(null, "adoption-window-expired");
        })
        .catch(() => undefined);
    }, this.windowMs);
    this.expiry.unref?.();
    return {
      phase: "adopting",
      adoption: {
        cause,
        until,
        sessions:
          cause === "resume"
            ? (this.current.retired?.sessions ?? [])
            : [...new Set([...(this.current.retired?.sessions ?? []), ...this.hooks.detached()])],
        outcome: null,
      },
    };
  }

  private async finish(attempt: number | null, reason: string): Promise<void> {
    this.stopExpiry();
    const adoption = this.current.adoption!;
    // Each session's outcome is its own; ending one lost session never touches another.
    const outcome = await this.hooks.finishAdoption(adoption.sessions, attempt, reason);
    this.write({ phase: "running", adoption: { ...adoption, outcome } });
  }

  private stopExpiry(): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
  }

  close(): void {
    this.stopExpiry();
  }

  private write(next: Partial<BrowserPoolRuntimeState>): void {
    this.current = { ...this.current, ...next, revision: this.current.revision + 1 };
  }
}
