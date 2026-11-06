import {
  parseMobileOpenDeepLink,
  parseMobilePairingDeepLink,
  parseMobileSetupCode,
  parseMobileThreadDeepLink,
  type MobilePairingDeepLink,
} from "@opensteer/core";

/**
 * What a link the operating system handed this app asks for.
 *
 * The link format itself — and the only parser for it — lives in
 * `@opensteer/core`, because the Account mints these links for notifications
 * and the phone reads them; one spelling, one reader. What is decided here is
 * narrower and belongs to the app: whether this phone can act on the link at
 * all, given the deployments it knows about.
 *
 * `ignore` covers every URL this app is not the destination for, including the
 * two OAuth callbacks the authorization broker takes. An unreadable link is an
 * ordinary thing for an operating system to deliver and is never an error.
 */
export type ThreadLinkOutcome =
  | { readonly kind: "ignore" }
  | {
      readonly deploymentId: string;
      readonly kind: "open";
      readonly requestId: string | null;
      readonly messageId?: string;
      readonly threadId: string;
    }
  | { readonly detail: string; readonly kind: "unknown-deployment" };

export function resolveThreadLink(
  url: string,
  knownDeploymentIds: readonly string[],
): ThreadLinkOutcome {
  const link = parseMobileThreadDeepLink(url);
  if (link === null) return { kind: "ignore" };
  if (!knownDeploymentIds.includes(link.deploymentId)) {
    return {
      detail:
        "That thread is on a deployment this phone has not been added to. Add it, then open the link again.",
      kind: "unknown-deployment",
    };
  }
  return {
    deploymentId: link.deploymentId,
    kind: "open",
    requestId: link.requestId,
    ...(link.messageId ? { messageId: link.messageId } : {}),
    threadId: link.threadId,
  };
}

/** Called before any catalog or Thread read, including before cold initialization. */
export function routeComputerLink(url: string, open: (deploymentId: string) => void): boolean {
  const destination = parseMobileOpenDeepLink(url);
  if (destination === null) return false;
  open(destination.deploymentId);
  return true;
}

/**
 * A pairing link carries a one-time code, so it only ever fills in the pairing
 * form: `offer` shows it to the person, who decides whether to connect.
 */
export function routePairingLink(
  url: string,
  offer: (link: MobilePairingDeepLink) => void,
): boolean {
  const link = parseMobilePairingDeepLink(url);
  if (link === null) return false;
  offer(link);
  return true;
}

/** A code read by the camera: a Connect code opens a computer, a pairing code is offered. */
export function routeSetupCode(
  text: string,
  portalOrigin: string | null,
  to: {
    readonly offer: (link: MobilePairingDeepLink) => void;
    readonly open: (deploymentId: string) => void;
  },
): boolean {
  const code = parseMobileSetupCode(text, portalOrigin);
  if (code === null) return false;
  if (code.kind === "open") to.open(code.deploymentId);
  else to.offer({ code: code.code, origin: code.origin });
  return true;
}
