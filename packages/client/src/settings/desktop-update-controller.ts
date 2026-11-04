import type {
  DesktopUpdateIntent,
  DesktopUpdateRequest,
  DesktopUpdateStatus,
} from "@opensteer/protocol/maintenance";
import {
  DesktopUpdatesError,
  type DesktopUpdates,
  type DesktopUpdatesFailure,
} from "../connections/desktop-updates-contract.js";
import { desktopUpdateActive } from "./desktop-update-view.js";

const reconnectDelayMs = 3_000;
const stallAfterMs = 5 * 60_000;

export interface DesktopUpdateSnapshot {
  readonly status: DesktopUpdateStatus | null;
  readonly failure: DesktopUpdatesFailure | null;
  readonly requesting: boolean;
  readonly stalled: boolean;
}
export const emptyDesktopUpdateSnapshot: DesktopUpdateSnapshot = {
  status: null,
  failure: null,
  requesting: false,
  stalled: false,
};

function failureOf(error: unknown): DesktopUpdatesFailure {
  return error instanceof DesktopUpdatesError ? error.reason : "unavailable";
}

/** The response may be lost after the Host persisted the request. */
function responseLost(failure: DesktopUpdatesFailure): boolean {
  return failure === "offline" || failure === "unavailable" || failure === "invalid-response";
}

/** One view of one computer's updates: live only while `show` holds it open. */
export class DesktopUpdateController {
  readonly #updates: DesktopUpdates;
  readonly #now: () => number;
  readonly #idempotencyKey: () => string;
  readonly #listeners = new Set<() => void>();
  #snapshot = emptyDesktopUpdateSnapshot;
  #following: AbortController | null = null;
  #reconnect: ReturnType<typeof setTimeout> | null = null;
  #lostAt: number | null = null;
  #unanswered: {
    readonly request: DesktopUpdateRequest;
    readonly previousOperationId: string | null;
  } | null = null;

  constructor(
    updates: DesktopUpdates,
    options: { readonly now?: () => number; readonly idempotencyKey?: () => string } = {},
  ) {
    this.#updates = updates;
    this.#now = options.now ?? Date.now;
    this.#idempotencyKey = options.idempotencyKey ?? (() => globalThis.crypto.randomUUID());
  }

  getSnapshot = (): DesktopUpdateSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  show = (): (() => void) => {
    this.#follow();
    return () => this.#stopFollowing();
  };

  retry = (): void => {
    this.#publish({ failure: null });
    this.#follow();
    if (this.#unanswered) void this.#send(this.#unanswered.request);
  };

  request = (intent: DesktopUpdateIntent): void => {
    const unanswered = this.#unanswered?.request;
    const request =
      unanswered && JSON.stringify(unanswered.intent) === JSON.stringify(intent)
        ? unanswered
        : { idempotencyKey: this.#idempotencyKey(), intent };
    this.#unanswered = {
      request,
      previousOperationId: this.#snapshot.status?.operation?.id ?? null,
    };
    void this.#send(request);
  };

  async #send(request: DesktopUpdateRequest): Promise<void> {
    if (this.#snapshot.requesting) return;
    this.#publish({ requesting: true, failure: null });
    try {
      const operation = await this.#updates.request(request);
      this.#unanswered = null;
      const status = this.#snapshot.status;
      // The long-poll may already have shown this operation further along than this reply.
      const observed = status?.operation?.id === operation.id;
      this.#publish({
        requesting: false,
        status: status === null || observed ? status : { ...status, operation },
      });
    } catch (error) {
      const failure = failureOf(error);
      if (!responseLost(failure)) this.#unanswered = null;
      this.#publish({ requesting: false, failure });
    }
  }

  #follow(): void {
    this.#stopFollowing();
    const following = new AbortController();
    this.#following = following;
    this.#updates.subscribeWhileVisible((status) => this.#receive(status), {
      signal: following.signal,
      onError: (error) => {
        if (this.#following === following) this.#lost(failureOf(error));
      },
    });
  }

  #stopFollowing(): void {
    if (this.#reconnect !== null) clearTimeout(this.#reconnect);
    this.#reconnect = null;
    this.#following?.abort(new Error("Updates view closed"));
    this.#following = null;
  }

  #receive(status: DesktopUpdateStatus): void {
    const operationId = status.operation?.id ?? null;
    if (
      this.#unanswered &&
      !this.#snapshot.requesting &&
      operationId !== null &&
      operationId !== this.#unanswered.previousOperationId
    )
      this.#unanswered = null;
    const silent = desktopUpdateActive(status.operation) && status.state === null;
    this.#publish({ status, failure: null, stalled: silent && this.#silentTooLong() });
    if (!silent) this.#lostAt = null;
  }

  #lost(failure: DesktopUpdatesFailure): void {
    const active = desktopUpdateActive(this.#snapshot.status?.operation);
    this.#publish({ failure, stalled: active && this.#silentTooLong() });
    if ((active || this.#unanswered) && failure !== "forbidden")
      this.#reconnect = setTimeout(() => this.#follow(), reconnectDelayMs);
  }

  #silentTooLong(): boolean {
    this.#lostAt ??= this.#now();
    return this.#now() - this.#lostAt >= stallAfterMs;
  }

  #publish(change: Partial<DesktopUpdateSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }
}
