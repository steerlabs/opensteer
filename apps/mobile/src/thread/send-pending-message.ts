import type { PushRegistration } from "../notifications/push-registration.js";
import type { HostClient } from "@opensteer/client/host";
import { useCallback, useSyncExternalStore } from "react";
import type { PendingCommand, ThreadDraftStore } from "../client/thread-drafts.js";

/** Where a message this phone owes stands: being handed over, or last refused by the wire. */
export type PendingDeliveryPhase = "sending" | "failed";

// A task may have two mounted routes, and a new task can hand its first
// message to a route while the starting pane still waits for the Host. Only
// one copy should dispatch a given durable command at a time. The phase is
// read by whatever draws the owed message, which is not the composer sending it.
const deliveries = new WeakMap<ThreadDraftStore, Map<string, PendingDeliveryPhase>>();
const listeners = new Set<() => void>();

function phasesOf(drafts: ThreadDraftStore): Map<string, PendingDeliveryPhase> {
  let phases = deliveries.get(drafts);
  if (phases === undefined) {
    phases = new Map();
    deliveries.set(drafts, phases);
  }
  return phases;
}

function deliveryKey(deploymentId: string, userId: string, threadId: string): string {
  return `${deploymentId}:${userId}:${threadId}`;
}

function setPhase(drafts: ThreadDraftStore, key: string, phase: PendingDeliveryPhase | null): void {
  const phases = phasesOf(drafts);
  if ((phases.get(key) ?? null) === phase) return;
  if (phase === null) phases.delete(key);
  else phases.set(key, phase);
  for (const listener of listeners) listener();
}

/**
 * Claims the one dispatch of `command`, or null while another copy holds it.
 * The answer settles it: `failed` keeps the message owed and says so until the
 * next attempt; anything else clears the phase.
 */
export function beginPendingDelivery(
  drafts: ThreadDraftStore,
  deploymentId: string,
  userId: string,
  command: PendingCommand,
): ((outcome?: "failed") => void) | null {
  if (
    drafts.readPending(deploymentId, userId, command.threadId)?.idempotencyKey !==
    command.idempotencyKey
  )
    return null;
  const key = deliveryKey(deploymentId, userId, command.threadId);
  if (phasesOf(drafts).get(key) === "sending") return null;
  setPhase(drafts, key, "sending");
  return (outcome) => setPhase(drafts, key, outcome ?? null);
}

/** The phase of the message this Thread owes, as it changes. */
export function usePendingDeliveryPhase(
  drafts: ThreadDraftStore,
  deploymentId: string,
  userId: string | null,
  threadId: string,
): PendingDeliveryPhase | null {
  const read = useCallback(
    () =>
      userId === null
        ? null
        : (phasesOf(drafts).get(deliveryKey(deploymentId, userId, threadId)) ?? null),
    [deploymentId, drafts, threadId, userId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hands the Host a message this phone owes it, exactly as it was claimed: the
 * same page, words, files, quote and idempotency key, so a repeat is the same
 * message rather than a second one.
 */
export async function sendPendingMessage(
  hostClient: HostClient,
  command: PendingCommand,
  authorize: () => Promise<boolean>,
  registration?: Pick<PushRegistration, "afterSuccessfulSend">,
): Promise<boolean> {
  if (!(await authorize())) return false;
  await hostClient.dispatch({
    // The words, the page they are about, then the files in the order they
    // were added, as the web sends them; a message of files alone has no text
    // part.
    content: [
      ...(command.text ? [{ text: command.text, type: "text" as const }] : []),
      ...(command.browserPage === undefined ? [] : [command.browserPage]),
      ...(command.attachments ?? []),
    ],
    ...(command.compaction ? { compaction: command.compaction } : {}),
    delivery: command.delivery,
    idempotencyKey: command.idempotencyKey,
    // Only the source id: the Host resolves the quoted message under this
    // reader's authority rather than trusting the phone's excerpt.
    ...(command.quotedMessageId === undefined ? {} : { quotedMessageId: command.quotedMessageId }),
    threadId: command.threadId,
    type: "thread.sendMessage",
  });
  void registration?.afterSuccessfulSend();
  return true;
}
