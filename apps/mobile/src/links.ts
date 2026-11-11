import {
  DeploymentIdSchema,
  mobileDeepLinkScheme,
  opensteerMobileClient,
  parseTeamPageAppLink,
  TeamNoticeIdSchema,
  TeamOriginSchema,
  teamPageUrl,
  parseMobileOpenDeepLink,
  parseMobilePairingDeepLink,
  parseMobileSetupCode,
  parseMobileThreadDeepLink,
  type MobilePairingDeepLink,
} from "@opensteer/core";
import { parseAgentConnectionDeepLink } from "@opensteer/protocol";

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
 *
 * `authorize-agent` opens an agent's connection request for review. The link
 * carries no authority: the Host decides whether this phone's session may
 * answer it, and the person still chooses Allow or Deny.
 *
 * `team` is a team page a team's "Open in Opensteer" handed over: an invite
 * (its verifier stays in the page URL's fragment), a channel or a message. It
 * is opened only after the team itself says the reader may see it. `team-notice`
 * opens that team's notices.
 */
export type ApplicationLinkOutcome =
  | { readonly kind: "ignore" }
  | {
      readonly deploymentId: string;
      readonly kind: "authorize-agent";
      readonly requestId: string;
    }
  | {
      readonly deploymentId: string;
      readonly kind: "open";
      readonly requestId: string | null;
      readonly messageId?: string;
      readonly threadId: string;
    }
  | { readonly kind: "team"; readonly page: string; readonly origin: string }
  | {
      readonly kind: "team-notice";
      readonly origin: string;
      readonly teamId: string;
      readonly noticeId: string;
    }
  | { readonly detail: string; readonly kind: "unknown-deployment" };

export function resolveApplicationLink(
  url: string,
  knownDeploymentIds: readonly string[],
): ApplicationLinkOutcome {
  const team = parseTeamPageAppLink(url, mobileDeepLinkScheme);
  if (team !== null) return { kind: "team", origin: team.origin, page: teamPageUrl(team) };
  const notice = parseTeamNoticeLink(url);
  if (notice !== null) return { kind: "team-notice", ...notice };
  const agent = parseAgentConnectionDeepLink(url, opensteerMobileClient.applicationId);
  if (agent !== null)
    return knownDeploymentIds.includes(agent.deploymentId)
      ? { deploymentId: agent.deploymentId, kind: "authorize-agent", requestId: agent.requestId }
      : {
          detail:
            "That agent wants to connect to a deployment this phone has not been added to. Add it, then start again from the agent.",
          kind: "unknown-deployment",
        };
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

/**
 * A team notice's link, as the team's push publication spells it:
 * `com.opensteer.mobile:/team-notice?origin=…&teamId=…&noticeId=…`.
 */
export function parseTeamNoticeLink(
  value: string,
): { readonly origin: string; readonly teamId: string; readonly noticeId: string } | null {
  if (!value.startsWith(`${mobileDeepLinkScheme}:/team-notice?`) || value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.host || url.pathname !== "/team-notice" || url.searchParams.size !== 3) return null;
  const origin = TeamOriginSchema.safeParse(url.searchParams.get("origin"));
  const teamId = DeploymentIdSchema.safeParse(url.searchParams.get("teamId"));
  const noticeId = TeamNoticeIdSchema.safeParse(url.searchParams.get("noticeId"));
  if (!origin.success || !teamId.success || !noticeId.success) return null;
  return { origin: origin.data, teamId: teamId.data, noticeId: noticeId.data };
}

/**
 * Which computer a team link should be shown on. The team is reached directly,
 * so its chat works whichever computer is in front; the drawer it belongs to is
 * that of a computer that is in it. Stays on the computer in front when it is
 * in the team or none is known to be; otherwise moves to one that is.
 */
export function computerForTeam(input: {
  readonly shown: string | null;
  readonly computersInTeam: readonly string[];
}): string | null {
  if (input.computersInTeam.length === 0) return null;
  if (input.shown !== null && input.computersInTeam.includes(input.shown)) return null;
  return input.computersInTeam[0] ?? null;
}
