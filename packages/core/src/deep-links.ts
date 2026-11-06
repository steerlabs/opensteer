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
 * never a Host URL, a credential, or a decision. (The pairing link below is
 * the one exception, and it is never applied without the person.) The Request id is a
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

/**
 * A computer offering itself over a private network: its HTTPS address and a
 * one-time pairing code that expires in minutes. Unlike every other link this
 * one carries a credential, so the phone never pairs from it on its own: it
 * fills in the address and code and the person confirms the computer.
 */
export interface MobilePairingDeepLink {
  readonly code: string;
  readonly origin: string;
}

const pairingCodePattern = /^osp_[A-Za-z0-9_-]{43}$/u;

export function buildMobilePairingDeepLink(link: MobilePairingDeepLink): string {
  const origin = pairingOrigin(link.origin);
  if (!origin || !pairingCodePattern.test(link.code)) {
    throw new TypeError("A pairing link needs an HTTPS origin and a pairing code");
  }
  const query = new URLSearchParams({ o: origin, c: link.code });
  return `${mobileDeepLinkScheme}:/pair?${query.toString()}`;
}

export function parseMobilePairingDeepLink(value: string): MobilePairingDeepLink | null {
  if (!value.startsWith(`${mobileDeepLinkScheme}:/pair?`) || value.includes("#")) return null;
  try {
    const url = new URL(value);
    if (url.host || url.username || url.password || url.pathname !== "/pair") return null;
    const keys = [...url.searchParams.keys()].sort();
    if (keys.length !== 2 || keys[0] !== "c" || keys[1] !== "o") return null;
    const code = url.searchParams.get("c") ?? "";
    const origin = pairingOrigin(url.searchParams.get("o") ?? "");
    return origin && pairingCodePattern.test(code) ? { code, origin } : null;
  } catch {
    return null;
  }
}

/** An HTTPS origin and nothing else: no path, query, fragment or user. */
function pairingOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * What a code shown by Opensteer on a computer says, read from a camera. The
 * Connect code is the portal's `/open` page with the computer in its fragment;
 * the private-network code is the pairing link above. Anything else is not an
 * Opensteer code, and only the portal this build trusts can name a computer.
 */
export type MobileSetupCode =
  | { readonly kind: "open"; readonly deploymentId: DeploymentId }
  | ({ readonly kind: "pair" } & MobilePairingDeepLink);

export function parseMobileSetupCode(
  value: string,
  portalOrigin: string | null,
): MobileSetupCode | null {
  const text = value.trim();
  const pairing = parseMobilePairingDeepLink(text);
  if (pairing) return { kind: "pair", ...pairing };
  const opened = parseMobileOpenDeepLink(text);
  if (opened) return { kind: "open", ...opened };
  if (!portalOrigin) return null;
  try {
    const url = new URL(text);
    if (url.origin !== new URL(portalOrigin).origin || url.pathname !== "/open") return null;
    if (url.search || url.username || url.password) return null;
    const match = /^#d=([^&]+)$/u.exec(url.hash);
    const id = match ? DeploymentIdSchema.safeParse(decodeURIComponent(match[1]!)) : null;
    return id?.success ? { kind: "open", deploymentId: id.data } : null;
  } catch {
    return null;
  }
}

/** A first-run destination supplies no route or authority. */
export function parseMobileOpenDeepLink(
  value: string,
): { readonly deploymentId: DeploymentId } | null {
  if (!value.startsWith(`${mobileDeepLinkScheme}:/open?`) || value.includes("#")) return null;
  try {
    const url = new URL(value);
    if (url.host || url.username || url.password || url.pathname !== "/open") return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== "d") return null;
    const id = DeploymentIdSchema.safeParse(url.searchParams.get("d"));
    return id.success ? { deploymentId: id.data } : null;
  } catch {
    return null;
  }
}
