import { parseMobileThreadDeepLink } from "@opensteer/core";

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
