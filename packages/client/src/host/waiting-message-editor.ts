import type { ContentPart, MessageEdit } from "@opensteer/core";
import type { HostApiCommandInput, HostApiCommandOutput } from "@opensteer/protocol";
import { HostClientRequestError, type WaitingMessageEditor } from "./client.js";

/**
 * A lease lapses two minutes after its last renewal. Typing renews it at most
 * this often, so an editor that is in use never lapses and an idle one costs
 * nothing on the wire.
 */
export const editLeaseRenewMs = 30_000;

/**
 * The refusals that settle an input mutation: the Host looked and would not,
 * so nothing was recorded and the next attempt is a new one. Anything else, a
 * timeout, an unreachable Runner, a transport failure, leaves open whether the
 * mutation landed.
 */
const settledInputMutationCodes: ReadonlySet<string> = new Set([
  "bad_request",
  "canonical_surface_required",
  "conflict",
  "forbidden",
  "not_found",
  "unauthorized",
]);

export function isSettledInputMutationError(error: unknown): boolean {
  return error instanceof HostClientRequestError && settledInputMutationCodes.has(error.code);
}

export interface WaitingMessageEditorPort {
  dispatch(command: HostApiCommandInput): Promise<HostApiCommandOutput>;
  /**
   * The leases this device holds. An editor adds its own before the take is
   * sent, so the Host's report of that take never reads as another device's.
   */
  readonly leases: Set<string>;
  /** Settles once the client holds the message at `revision`, the version the person edits. */
  holdsRevision(threadId: string, messageId: string, revision: number): Promise<void>;
  now(): number;
}

/**
 * Takes the edit lease on one waiting message and returns the editor that
 * holds it. Shared by the session and mock clients, so renewal, retry and
 * release behave the same against either.
 */
export async function openWaitingMessageEditor(
  port: WaitingMessageEditorPort,
  threadId: string,
  messageId: string,
  takeOver: boolean,
): Promise<WaitingMessageEditor> {
  // Client-named, so a take whose answer was lost is the same lease when retried.
  const leaseId = globalThis.crypto.randomUUID().replaceAll("-", "");
  port.leases.add(leaseId);
  let revision: number;
  try {
    const taken = await port.dispatch({
      leaseId,
      messageId,
      takeOver,
      threadId,
      type: "thread.input.lease.take",
    });
    if (taken.type !== "thread.input.lease.take") throw new Error("Edit lease command mismatch.");
    revision = taken.revision;
    await port.holdsRevision(threadId, messageId, revision);
  } catch (error) {
    // A take that may have landed must not hold the queue for an editor that never opened.
    if (!isSettledInputMutationError(error))
      await port
        .dispatch({ leaseId, messageId, threadId, type: "thread.input.lease.release" })
        .catch(() => undefined);
    port.leases.delete(leaseId);
    throw error;
  }

  let ended = false;
  let renewing = false;
  let renewedAt = port.now();
  // One key per attempted content until the Host answers it: a lost answer is
  // retried as the same edit, and changed words are a new edit.
  let attempt: { readonly content: string; readonly key: string } | null = null;

  return {
    leaseId,
    revision,
    touch() {
      if (ended || renewing || port.now() - renewedAt < editLeaseRenewMs) return;
      renewing = true;
      renewedAt = port.now();
      // A renewal that fails is not an error: the lease lapses, and a save
      // finds out whether that cost anything.
      void port
        .dispatch({ leaseId, messageId, threadId, type: "thread.input.lease.renew" })
        .catch(() => undefined)
        .finally(() => {
          renewing = false;
        });
    },
    async save(content: readonly ContentPart[]): Promise<MessageEdit> {
      if (ended) throw new Error("This edit has already ended.");
      const fingerprint = JSON.stringify(content);
      if (attempt?.content !== fingerprint)
        attempt = { content: fingerprint, key: `input-edit:${globalThis.crypto.randomUUID()}` };
      try {
        const result = await port.dispatch({
          content: [...content],
          expectedRevision: revision,
          idempotencyKey: attempt.key,
          leaseId,
          messageId,
          threadId,
          type: "thread.input.edit",
        });
        if (result.type !== "thread.input.edit") throw new Error("Edit command mismatch.");
        // The client has already dropped the lease from its queue; only now is it no longer ours.
        ended = true;
        port.leases.delete(leaseId);
        return result.edit;
      } catch (error) {
        if (isSettledInputMutationError(error)) attempt = null;
        throw error;
      }
    },
    async cancel(): Promise<void> {
      if (ended) return;
      ended = true;
      // Nothing to report: a lease this could not end lapses on its own, and
      // until then it is this device's, as other devices see it too.
      await port
        .dispatch({ leaseId, messageId, threadId, type: "thread.input.lease.release" })
        .catch(() => undefined);
      port.leases.delete(leaseId);
    },
  };
}
