import {
  DeploymentIdSchema,
  MessageIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
  type DeploymentId,
  type MessageId,
  type RequestId,
  type ThreadId,
} from "./ids.js";

/**
 * The private-use scheme the phone's bundle claims. It is the same reverse-DNS
 * scheme the mobile native OAuth registration owns, so the operating system
 * hands both the authorization callback and a notification tap to exactly one
 * installed application.
 */
export const mobileDeepLinkScheme = "com.opensteer.mobile";

/**
 * Everything a notification tap may say. Identifiers only: a link names a
 * Thread inside a Deployment the phone already has a catalog entry for, and
 * never a Host URL, a credential, or a decision. The Request id is a
 * destination, not an authority — the app still reads current state and
 * authenticates before it shows anything.
 */
export interface MobileThreadDeepLink {
  readonly deploymentId: DeploymentId;
  readonly messageId?: MessageId | null;
  readonly requestId: RequestId | null;
  readonly threadId: ThreadId;
}

export function buildMobileThreadDeepLink(link: MobileThreadDeepLink): string {
  const deploymentId = DeploymentIdSchema.parse(link.deploymentId);
  const threadId = ThreadIdSchema.parse(link.threadId);
  const path = `/deployments/${deploymentId}/threads/${threadId}`;
  if (link.messageId) {
    if (link.requestId !== null)
      throw new TypeError("A deep link cannot target a Message and Request together");
    return `${mobileDeepLinkScheme}:${path}?messageId=${MessageIdSchema.parse(link.messageId)}`;
  }
  if (link.requestId === null) return `${mobileDeepLinkScheme}:${path}`;
  const requestId = RequestIdSchema.parse(link.requestId);
  return `${mobileDeepLinkScheme}:${path}?requestId=${requestId}`;
}

/**
 * The one reader of an incoming link. It answers `null` rather than throwing,
 * because an unparseable link is an ordinary thing for an operating system to
 * hand an application — a stale build's URL, a hand-typed scheme, another
 * app's guess — and the only correct reaction is to ignore it.
 */
export function parseMobileThreadDeepLink(value: string): MobileThreadDeepLink | null {
  const separator = value.indexOf(":");
  if (separator !== mobileDeepLinkScheme.length || !value.startsWith(`${mobileDeepLinkScheme}:`)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.host || url.username || url.password || url.port || url.hash) return null;
  const segments = url.pathname.split("/");
  if (segments.length !== 5 || segments[0] !== "" || segments[1] !== "deployments") return null;
  if (segments[3] !== "threads") return null;
  const deploymentId = DeploymentIdSchema.safeParse(segments[2]);
  const threadId = ThreadIdSchema.safeParse(segments[4]);
  if (!deploymentId.success || !threadId.success) return null;
  const parameters = [...url.searchParams.keys()];
  if (
    parameters.some((name) => name !== "requestId" && name !== "messageId") ||
    parameters.length > 1
  )
    return null;
  const rawMessageId = url.searchParams.get("messageId");
  if (rawMessageId !== null) {
    const messageId = MessageIdSchema.safeParse(rawMessageId);
    if (!messageId.success) return null;
    return {
      deploymentId: deploymentId.data,
      messageId: messageId.data,
      requestId: null,
      threadId: threadId.data,
    };
  }
  const rawRequestId = url.searchParams.get("requestId");
  if (rawRequestId === null) {
    return { deploymentId: deploymentId.data, requestId: null, threadId: threadId.data };
  }
  const requestId = RequestIdSchema.safeParse(rawRequestId);
  if (!requestId.success) return null;
  return { deploymentId: deploymentId.data, requestId: requestId.data, threadId: threadId.data };
}
