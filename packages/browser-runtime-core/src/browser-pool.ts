import type { BrowserSessionId, BrowserSurfaceId } from "@opensteer/protocol/browser";
import { verify, type KeyObject } from "node:crypto";
import { AsyncMutex } from "./async.js";
import type { BrowserPage } from "./browser/backend.js";
import { BrowserRuntimeError } from "./errors.js";

export interface BrowserPoolRuntimeOptions {
  readonly term: number;
  readonly controllerKey: KeyObject;
  /** The loopback fixture supplies its page and engine quiescence witness. */
  readonly probePage: (page: BrowserPage, phase: "active" | "frozen") => Promise<readonly string[]>;
}

export interface BrowserPoolIntent {
  readonly id: string;
  readonly sequence: number;
}

export interface BrowserPoolRuntimeFence {
  readonly term: number;
  readonly instance: string;
  readonly epoch: number;
}

export interface BrowserPoolControl {
  readonly kind: "retire" | "release" | "seal" | "adopt" | "complete";
  readonly fence: BrowserPoolRuntimeFence;
  readonly intent: BrowserPoolIntent;
  readonly documents?: readonly BrowserPoolDocument[];
}

export interface BrowserPoolDocument {
  readonly sessionId: BrowserSessionId;
  readonly surfaceId: BrowserSurfaceId;
  readonly documentId: string;
  readonly pageRevision: number;
  readonly typed: boolean;
}

export interface BrowserPoolRetainedSet {
  readonly retained: readonly BrowserPoolDocument[];
  readonly dropped: readonly BrowserPoolDocument[];
}

export interface BrowserPoolRuntimeState {
  readonly fence: BrowserPoolRuntimeFence;
  readonly revision: number;
  readonly phase:
    "running" | "retiring" | "retired" | "releasing" | "sealed" | "adopting" | "completing";
  readonly intent: BrowserPoolIntent | null;
  readonly cancelled: boolean;
  readonly result: BrowserPoolRetainedSet | null;
  readonly blockers: readonly string[];
  readonly adoption: {
    readonly until: number;
    readonly retained: readonly BrowserPoolDocument[];
    readonly completion: readonly BrowserPoolDocument[] | null;
    readonly outcome: BrowserPoolAdoptionOutcome | null;
  } | null;
}

export interface BrowserPoolAdoptionOutcome {
  readonly adopted: readonly BrowserPoolDocument[];
  readonly lost: readonly BrowserPoolDocument[];
}

function documentKeys(documents: readonly BrowserPoolDocument[]): string[] {
  return documents
    .map(({ sessionId, surfaceId, documentId, pageRevision, typed }) =>
      JSON.stringify([sessionId, surfaceId, documentId, pageRevision, typed]),
    )
    .sort();
}

function sameDocuments(
  left: readonly BrowserPoolDocument[],
  right: readonly BrowserPoolDocument[],
) {
  return JSON.stringify(documentKeys(left)) === JSON.stringify(documentKeys(right));
}

export function browserPoolControlBytes(control: BrowserPoolControl): Buffer {
  const { kind, fence, intent } = control;
  return Buffer.from(
    JSON.stringify([
      "opensteer/browser-pool-runtime/v1",
      kind,
      fence.term,
      fence.instance,
      fence.epoch,
      intent.sequence,
      intent.id,
      control.documents ? documentKeys(control.documents) : null,
    ]),
  );
}

export class BrowserPoolRetirement {
  private readonly lane = new AsyncMutex();
  private readonly key: KeyObject;
  private readonly retire: () => Promise<BrowserPoolRetainedSet | readonly string[]>;
  private readonly release: () => Promise<void>;
  private readonly complete: (
    documents: readonly BrowserPoolDocument[],
  ) => Promise<BrowserPoolAdoptionOutcome>;
  private current: BrowserPoolRuntimeState;

  constructor(
    key: KeyObject,
    term: number,
    instance: string,
    retire: () => Promise<BrowserPoolRetainedSet | readonly string[]>,
    release: () => Promise<void>,
    complete: (documents: readonly BrowserPoolDocument[]) => Promise<BrowserPoolAdoptionOutcome>,
  ) {
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
      throw new TypeError("The browser pool controller requires an Ed25519 public key.");
    this.key = key;
    this.retire = retire;
    this.release = release;
    this.complete = complete;
    this.current = {
      fence: { term, instance, epoch: 1 },
      revision: 0,
      phase: "running",
      intent: null,
      cancelled: false,
      result: null,
      blockers: [],
      adoption: null,
    };
  }

  state(): BrowserPoolRuntimeState {
    return structuredClone(this.current);
  }

  get acceptsTraffic(): boolean {
    return this.current.phase === "running";
  }

  canAdopt(sessionId: BrowserSessionId): boolean {
    const adoption = this.current.adoption;
    return (
      this.current.phase === "adopting" &&
      adoption !== null &&
      adoption.until > Date.now() &&
      adoption.retained.some((document) => document.sessionId === sessionId)
    );
  }

  checkFence(fence: BrowserPoolRuntimeFence | undefined): void {
    const expected = this.current.fence;
    if (
      fence?.term !== expected.term ||
      fence.instance !== expected.instance ||
      fence.epoch !== expected.epoch
    )
      throw new BrowserRuntimeError("forbidden", "The pooled browser authority has changed.");
  }

  apply(control: BrowserPoolControl, signature: Uint8Array): Promise<BrowserPoolRuntimeState> {
    const request = structuredClone(control);
    if (!verify(null, browserPoolControlBytes(request), this.key, signature))
      return Promise.reject(
        new BrowserRuntimeError("forbidden", "The browser pool controller is not authorized."),
      );
    return this.lane.run(async () => {
      const { intent, kind } = request;
      const current = this.current;
      const sameIntent =
        current.intent?.id === intent.id &&
        current.intent.sequence === intent.sequence &&
        current.fence.term === request.fence.term &&
        current.fence.instance === request.fence.instance;
      if (
        sameIntent &&
        kind === "adopt" &&
        current.adoption &&
        request.fence.epoch + 1 === current.fence.epoch &&
        request.documents &&
        sameDocuments(request.documents, current.adoption.retained)
      )
        return this.state();
      if (
        sameIntent &&
        kind === "release" &&
        current.cancelled &&
        (request.fence.epoch === current.fence.epoch ||
          request.fence.epoch + 1 === current.fence.epoch)
      ) {
        return this.state();
      }
      this.checkFence(request.fence);
      if (!Number.isSafeInteger(intent.sequence) || intent.sequence < 1 || !intent.id)
        throw new BrowserRuntimeError("bad_message", "The browser park intent is invalid.");
      const previous = current.intent;
      if (
        previous &&
        (intent.sequence < previous.sequence ||
          (intent.sequence === previous.sequence && intent.id !== previous.id))
      )
        throw new BrowserRuntimeError("conflict", "The browser park intent was superseded.");
      const same = previous?.sequence === intent.sequence;
      if (!same && current.phase !== "running")
        throw new BrowserRuntimeError("conflict", "Another browser park intent is unresolved.");
      if (kind === "retire") {
        if (same) {
          if (current.cancelled)
            throw new BrowserRuntimeError("conflict", "The browser park intent was cancelled.");
          return this.state();
        }
        this.write({
          intent,
          phase: "retiring",
          cancelled: false,
          result: null,
          blockers: [],
          adoption: null,
        });
        const outcome = await this.retire();
        if ("retained" in outcome) this.write({ phase: "retired", result: outcome });
        else this.write({ phase: "running", blockers: outcome });
      } else if (kind === "release") {
        if (
          current.phase === "sealed" ||
          current.phase === "adopting" ||
          (same && current.adoption)
        )
          throw new BrowserRuntimeError("conflict", "The browser park was committed.");
        if (same && current.phase !== "running") {
          this.write({ phase: "releasing" });
          await this.release();
        }
        // This also records cancellation when release arrived ahead of retire.
        const fence =
          same && current.phase !== "running"
            ? { ...current.fence, epoch: current.fence.epoch + 1 }
            : current.fence;
        this.write({
          fence,
          intent,
          phase: "running",
          cancelled: true,
          result: same ? current.result : null,
          blockers: same ? current.blockers : [],
          adoption: null,
        });
      } else {
        if (!same || !current.result || current.cancelled)
          throw new BrowserRuntimeError("conflict", "The browser park intent is unresolved.");
        if (kind === "seal" && (current.phase === "retired" || current.phase === "sealed")) {
          if (current.phase === "retired") this.write({ phase: "sealed" });
        } else if (
          kind === "adopt" &&
          current.phase === "sealed" &&
          request.documents &&
          sameDocuments(request.documents, current.result.retained)
        ) {
          this.write({
            fence: { ...current.fence, epoch: current.fence.epoch + 1 },
            phase: "adopting",
            adoption: {
              until: Date.now() + 30_000,
              retained: current.result.retained,
              completion: null,
              outcome: null,
            },
          });
        } else if (kind === "complete" && current.adoption && request.documents) {
          const allowed = new Set(documentKeys(current.adoption.retained));
          const expected = documentKeys(request.documents);
          if (
            expected.some((document) => !allowed.has(document)) ||
            new Set(expected).size !== expected.length
          )
            throw new BrowserRuntimeError("conflict", "The browser adoption set has changed.");
          if (current.adoption.completion) {
            if (!sameDocuments(current.adoption.completion, request.documents))
              throw new BrowserRuntimeError(
                "conflict",
                "The browser adoption has already completed.",
              );
            if (current.adoption.outcome) return this.state();
          } else {
            if (current.adoption.until <= Date.now())
              throw new BrowserRuntimeError("conflict", "The browser adoption window expired.");
            this.write({
              phase: "completing",
              adoption: { ...current.adoption, completion: request.documents },
            });
          }
          const outcome = await this.complete(request.documents);
          this.write({
            phase: "running",
            adoption: { ...current.adoption, completion: request.documents, outcome },
          });
        } else {
          throw new BrowserRuntimeError("conflict", "The browser adoption is not ready.");
        }
      }
      return this.state();
    });
  }

  private write(next: Partial<BrowserPoolRuntimeState>): void {
    this.current = { ...this.current, ...next, revision: this.current.revision + 1 };
  }
}
