import {
  parseMobileThreadDeepLink,
  type DeploymentId,
  type RequestId,
  type ThreadId,
} from "@opensteer/core";
import { z } from "zod";

/**
 * The only field of a push payload this app reads. Everything else the Account
 * sends — `deploymentId`, `threadId`, `requestId`, `kind` — is ignored rather
 * than cross-checked, because a second source of truth about where to go is a
 * second thing that can disagree.
 */
const NotificationPayloadSchema = z.looseObject({ deepLink: z.string().min(1).max(2_048) });

/**
 * Where a notification points, read from the one field that may say so.
 *
 * A push payload carries `deploymentId`, `threadId`, `requestId` and `kind`
 * beside the link, and none of them is consulted here. The link is the whole
 * destination and it is parsed by the same reader the operating system's own
 * deep links go through, so a notification cannot address a screen a typed URL
 * could not. It is a destination and never an authority: the app still attaches
 * to the Deployment, authenticates, and reads current state before it shows
 * anything, and nothing here approves, denies or answers a Request.
 */
export interface NotificationDestination {
  readonly deepLink: string;
  readonly deploymentId: DeploymentId;
  readonly requestId: RequestId | null;
  readonly messageId?: string;
  readonly threadId: ThreadId;
}

/** The notification payload, as much of it as this app will look at. */
export interface NotificationData {
  readonly data?: unknown;
}

export function notificationDestination(payload: NotificationData): NotificationDestination | null {
  const parsed = NotificationPayloadSchema.safeParse(payload.data);
  if (!parsed.success) return null;
  const { deepLink } = parsed.data;
  const link = parseMobileThreadDeepLink(deepLink);
  if (link === null) return null;
  return {
    deepLink,
    deploymentId: link.deploymentId,
    requestId: link.requestId,
    ...(link.messageId ? { messageId: link.messageId } : {}),
    threadId: link.threadId,
  };
}

/** The Thread the person is looking at right now, or none. */
export interface VisibleThread {
  readonly deploymentId: string;
  readonly threadId: string;
}

/**
 * Whether an incoming notification is worth interrupting with.
 *
 * Telling somebody about the thing they are watching arrive is noise, so it is
 * delivered silently and left in the list. That takes both facts: the Thread is
 * on screen *and* the screen is showing its latest activity — somebody reading
 * back through older messages did not see this one. Anything the destination
 * cannot be read from is presented, because suppressing a notification this app
 * failed to understand would hide it for no reason anybody could discover.
 */
export function shouldPresentNotification(
  payload: NotificationData,
  visible: VisibleThread | null,
  atLatest: boolean,
): boolean {
  if (visible === null || !atLatest) return true;
  const destination = notificationDestination(payload);
  if (destination === null) return true;
  return !(
    destination.deploymentId === visible.deploymentId && destination.threadId === visible.threadId
  );
}

/** A notification the system is currently showing, as this app reads it. */
export interface PresentedNotification {
  readonly identifier: string;
  readonly payload: NotificationData;
}

/**
 * Clears what the system is still showing for one Thread.
 *
 * Opening a Thread answers every alert about it, and leaving them on the lock
 * screen would ask the person to dismiss the same news twice. Only this
 * Thread's are cleared: another Thread's alert is still unread work.
 */
export async function dismissThreadNotifications(input: {
  readonly dismiss: (identifier: string) => Promise<void>;
  readonly presented: () => Promise<readonly PresentedNotification[]>;
  readonly visible: VisibleThread;
}): Promise<void> {
  for (const notification of await input.presented()) {
    const destination = notificationDestination(notification.payload);
    if (destination === null) continue;
    if (
      destination.deploymentId !== input.visible.deploymentId ||
      destination.threadId !== input.visible.threadId
    ) {
      continue;
    }
    await input.dismiss(notification.identifier);
  }
}
