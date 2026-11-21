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
  readonly kind: "retire" | "release";
  readonly fence: BrowserPoolRuntimeFence;
  readonly intent: BrowserPoolIntent;
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
  readonly phase: "running" | "retiring" | "retired" | "releasing";
  readonly intent: BrowserPoolIntent | null;
  readonly cancelled: boolean;
  readonly result: BrowserPoolRetainedSet | null;
  readonly blockers: readonly string[];
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
    ]),
  );
}

export class BrowserPoolRetirement {
  private readonly lane = new AsyncMutex();
  private readonly key: KeyObject;
  private readonly retire: () => Promise<BrowserPoolRetainedSet | readonly string[]>;
  private readonly release: () => Promise<void>;
  private current: BrowserPoolRuntimeState;

  constructor(
    key: KeyObject,
    term: number,
    instance: string,
    retire: () => Promise<BrowserPoolRetainedSet | readonly string[]>,
    release: () => Promise<void>,
  ) {
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
      throw new TypeError("The browser pool controller requires an Ed25519 public key.");
    this.key = key;
    this.retire = retire;
    this.release = release;
    this.current = {
      fence: { term, instance, epoch: 1 },
      revision: 0,
      phase: "running",
      intent: null,
      cancelled: false,
      result: null,
      blockers: [],
    };
  }

  state(): BrowserPoolRuntimeState {
    return structuredClone(this.current);
  }

  get acceptsTraffic(): boolean {
    return this.current.phase === "running";
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
      if (
        current.intent?.id === intent.id &&
        current.intent.sequence === intent.sequence &&
        current.fence.term === request.fence.term &&
        current.fence.instance === request.fence.instance &&
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
        this.write({ intent, phase: "retiring", cancelled: false, result: null, blockers: [] });
        const outcome = await this.retire();
        if ("retained" in outcome) this.write({ phase: "retired", result: outcome });
        else this.write({ phase: "running", blockers: outcome });
      } else {
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
          blockers: [],
        });
      }
      return this.state();
    });
  }

  private write(next: Partial<BrowserPoolRuntimeState>): void {
    this.current = { ...this.current, ...next, revision: this.current.revision + 1 };
  }
}
