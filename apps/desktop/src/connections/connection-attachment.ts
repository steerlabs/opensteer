import { presentActionFailure } from "@opensteer/client/feedback";
import type { DeploymentAccessFailure } from "@opensteer/protocol/desktop";
import { classifyClientFailure } from "@opensteer/client/connections";
import type { HostSessionObservation } from "@opensteer/client/auth";

/**
 * What this Desktop's own attachment to one Deployment is doing right now.
 * This is never a judgement about the Deployment itself — a place can be
 * perfectly healthy while this app is simply `idle` and not attached to it.
 */
export type ConnectionAttachmentStatus =
  | "authorizing"
  | "connected"
  | "connecting"
  | "idle"
  | "needs-remote-access"
  | "needs-sign-in"
  | "offline";

export interface ConnectionAttachmentSnapshot {
  readonly failure: DeploymentAccessFailure | null;
  readonly status: ConnectionAttachmentStatus;
}

/**
 * The outcome of the attachment this attempt is currently living inside.
 * `null` is the whole of "not attached and not trying": there is no stored
 * idle status and no stored failure to go stale, so nothing a past attempt
 * learned can outlive the attempt and leave a row permanently dead.
 */
interface AttachmentObservation {
  readonly failure: DeploymentAccessFailure | null;
  readonly status: "authorizing" | "connected" | "connecting" | "needs-sign-in" | "offline";
}

/**
 * Owns the attached Deployment's attachment: when to try, when to stop, and
 * what the attempt learned. Exactly one exists, for the selected Deployment;
 * every other row's status is a pure function of its attachment key, so a
 * an in-flight establishment and a rotated key are all
 * fenced by this one object's lifetime.
 */
export class ConnectionAttachment {
  readonly #close: () => Promise<void>;
  readonly #deploymentId: string;
  readonly #establish: (deploymentId: string) => Promise<HostSessionObservation>;
  readonly #listeners = new Set<(snapshot: ConnectionAttachmentSnapshot) => void>();
  #attachment: AttachmentObservation | null = null;
  #attachmentKey: string | null;
  #operationId = 0;

  constructor(options: {
    readonly attachmentKey: string | null;
    readonly close?: () => Promise<void>;
    readonly deploymentId: string;
    readonly establish: (deploymentId: string) => Promise<HostSessionObservation>;
  }) {
    this.#attachmentKey = options.attachmentKey;
    this.#close = options.close ?? (() => Promise.resolve());
    this.#deploymentId = options.deploymentId;
    this.#establish = options.establish;
  }

  get deploymentId(): string {
    return this.#deploymentId;
  }

  snapshot(): ConnectionAttachmentSnapshot {
    if (this.#attachment) return this.#attachment;
    return { failure: null, status: detachedAttachmentStatus(this.#attachmentKey) };
  }

  /**
   * Whether stopping is something a person can actually ask for right now.
   * A browser authorization counts: the wait is theirs to end, and ending it
   * is what drops the flow that would otherwise still be open behind them.
   */
  canCancel(): boolean {
    return this.#attachment !== null && this.#attachment.status !== "connected";
  }

  /**
   * Whether trying again could do anything. Every state a person is left
   * looking at — cancelled, refused, unreachable, waiting to sign in, or
   * watching a browser tab that never came back — says yes, because
   * establishing again is the one move that resolves all of them. Only a
   * machine-wait says no, because there is nothing there for a person to fix.
   */
  canRetry(): boolean {
    if (this.#attachmentKey === null) return false;
    const { status } = this.snapshot();
    return status !== "connected" && status !== "connecting";
  }

  subscribe(listener: (snapshot: ConnectionAttachmentSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Begin — or begin again — the one attachment this Desktop holds. */
  attach(): void {
    if (this.#attachmentKey === null) {
      this.#publish();
      return;
    }
    this.#run(++this.#operationId, false);
  }

  /** A person stopped waiting: the attempt is abandoned and the row goes idle. */
  cancel(): void {
    this.#detach();
  }

  /** This Deployment is no longer the selected one. */
  deactivate(): void {
    this.#detach();
  }

  dispose(): void {
    this.#detach();
    this.#listeners.clear();
  }

  reconfigure(options: { readonly attachmentKey: string | null }): void {
    if (this.#attachmentKey === options.attachmentKey) return;
    const wasAttached = this.#attachment !== null;
    this.#operationId += 1;
    this.#attachmentKey = options.attachmentKey;
    // A rotated route or a restarted Host changes the attachment key without
    // changing which Deployment this is. An attachment that was live is closed
    // and verified against the new identity rather than parked on a key that
    // nobody will ever answer for.
    if (wasAttached && options.attachmentKey !== null) {
      this.#run(this.#operationId, true);
      return;
    }
    this.#attachment = null;
    this.#publish();
  }

  observe(observation: HostSessionObservation): void {
    if (
      this.#attachment === null ||
      observation.deploymentId !== this.#deploymentId ||
      observation.attachmentKey !== this.#attachmentKey
    ) {
      return;
    }
    this.#applyObservation(observation);
  }

  #detach(): void {
    this.#operationId += 1;
    if (this.#attachment === null) return;
    this.#attachment = null;
    this.#publish();
  }

  #run(operationId: number, closeFirst: boolean): void {
    this.#attachment = { failure: null, status: "connecting" };
    this.#publish();
    void (
      closeFirst
        ? this.#close().then(() => this.#establish(this.#deploymentId))
        : this.#establish(this.#deploymentId)
    ).then(
      (observation) => {
        if (
          operationId !== this.#operationId ||
          observation.attachmentKey !== this.#attachmentKey
        ) {
          return;
        }
        this.#applyObservation(observation);
      },
      (error: unknown) => {
        if (operationId !== this.#operationId) return;
        const classified = classifyClientFailure(error);
        const failure: DeploymentAccessFailure = {
          code: failureCode(classified.reason),
          detail: presentActionFailure(error, "This deployment is temporarily unavailable."),
          retryable: classified.classification === "transient",
        };
        this.#attachment = { failure, status: "offline" };
        this.#publish();
      },
    );
  }

  #applyObservation(observation: HostSessionObservation): void {
    this.#attachment = attachmentFromObservation(observation);
    this.#publish();
  }

  #publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function attachmentFromObservation(observation: HostSessionObservation): AttachmentObservation {
  if (observation.outcome === "ready") return { failure: null, status: "connected" };
  // Waiting on a person's browser is not waiting on a machine: nothing here
  // will finish it, so it is published as its own state rather than hidden
  // behind the spinner a connecting row shows.
  if (observation.outcome === "authorizing") return { failure: null, status: "authorizing" };
  if (observation.outcome === "needs-sign-in") {
    // Establishing again is what opens this Host's own sign-in, so waiting to
    // sign in is a retryable state and never a dead end with nothing to press.
    return {
      failure: {
        code: "host-sign-in-required",
        detail: observation.detail ?? "Sign in to this server to continue.",
        retryable: true,
      },
      status: "needs-sign-in",
    };
  }
  return {
    failure: {
      code: "host-access-blocked",
      detail: observation.detail ?? "This connection was refused.",
      retryable: false,
    },
    status: "offline",
  };
}

/**
 * A Deployment with no usable route cannot be attached to from here at all;
 * that is a fact about the route, so it holds while detached too. Every
 * unattached row in the catalog reads exactly this.
 */
export function detachedAttachmentStatus(attachmentKey: string | null): ConnectionAttachmentStatus {
  return attachmentKey === null ? "needs-remote-access" : "idle";
}

function failureCode(reason: string): string {
  return (
    reason
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "connection-failed"
  );
}
