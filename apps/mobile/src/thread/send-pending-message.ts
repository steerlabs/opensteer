import type { PushRegistration } from "../notifications/push-registration.js";
import type { HostClient } from "@opensteer/client/host";
import type { PendingCommand, ThreadDraftStore } from "../client/thread-drafts.js";

// A task may have two mounted routes, and a new task can hand its first
// message to a route while the starting pane still waits for the Host. Only
// one copy should dispatch a given durable command at a time.
const activeDeliveries = new WeakMap<ThreadDraftStore, Set<string>>();

export function beginPendingDelivery(
  drafts: ThreadDraftStore,
  deploymentId: string,
  userId: string,
  command: PendingCommand,
): (() => void) | null {
  if (
    drafts.readPending(deploymentId, userId, command.threadId)?.idempotencyKey !==
    command.idempotencyKey
  )
    return null;
  const key = `${deploymentId}:${userId}:${command.threadId}`;
  let active = activeDeliveries.get(drafts);
  if (active === undefined) {
    active = new Set();
    activeDeliveries.set(drafts, active);
  }
  if (active.has(key)) return null;
  active.add(key);
  return () => active?.delete(key);
}

/**
 * Hands the Host a message this phone owes it, exactly as it was claimed: the
 * same page, words, files, quote and idempotency key, so a repeat is the same
 * message rather than a second one.
 */
export async function sendPendingMessage(
  hostClient: HostClient,
  command: PendingCommand,
  registration?: Pick<PushRegistration, "afterSuccessfulSend">,
): Promise<void> {
  await hostClient.dispatch({
    // The words, the page they are about, then the files in the order they
    // were added, as the web sends them; a message of files alone has no text
    // part.
    content: [
      ...(command.text ? [{ text: command.text, type: "text" as const }] : []),
      ...(command.browserPage === undefined ? [] : [command.browserPage]),
      ...(command.attachments ?? []),
    ],
    delivery: command.delivery,
    idempotencyKey: command.idempotencyKey,
    // Only the source id: the Host resolves the quoted message under this
    // reader's authority rather than trusting the phone's excerpt.
    ...(command.quotedMessageId === undefined ? {} : { quotedMessageId: command.quotedMessageId }),
    threadId: command.threadId,
    type: "thread.sendMessage",
  });
  void registration?.afterSuccessfulSend();
}
