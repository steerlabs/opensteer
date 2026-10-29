import { browserSiteDomain, browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import { isLoopbackHostname, type BrowserSourceId } from "@opensteer/core";
import { decodeBrowserSourceInvitation } from "@opensteer/deployment-authority";
import {
  opensteerChromeExtensionId,
  type BrowserSignInProblem,
  type BrowserSourceExportProblem,
  type BrowserSourceInspection,
  type BrowserSourcePairing,
  type BrowserSourcesState,
  type BrowserSourceSummary,
} from "@opensteer/protocol/browser-sources";
import { formatRelativeTime } from "./thread-list-model.js";

/**
 * Words and small decisions every client shares for Chrome sign-ins, so the
 * web, desktop and mobile cards say the same thing about the same state.
 */

/** The public page a Chrome without Opensteer open is sent to. */
export const chromeConnectPagePath = "/connect/chrome";
/** An image the extension exposes to web pages; loading it proves the extension is installed. */
export const chromeExtensionProbeUrl = `chrome-extension://${opensteerChromeExtensionId}/icons/probe.png`;

export function chromeExtensionConnectUrl(invitation: string): string {
  return `chrome-extension://${opensteerChromeExtensionId}/connect.html#${invitation}`;
}

export function chromeConnectPageUrl(origin: string, invitation: string): string {
  return `${origin}${chromeConnectPagePath}#${invitation}`;
}

/** `github.com` for `https://github.com`. */
export function browserSiteLabel(site: string): string {
  try {
    return browserSiteDomain(site);
  } catch {
    try {
      return new URL(site).hostname;
    } catch {
      return site;
    }
  }
}

/** The site a page belongs to, or null for pages no sign-in can apply to. */
export function browserSiteForUrl(url: string): string | null {
  if (!/^https?:\/\//iu.test(url.trim())) return null;
  try {
    return browserSiteFromUrl(url);
  } catch {
    return null;
  }
}

/**
 * Which address a Chrome should connect through. Chrome on the computer running
 * a Personal Deployment reaches it on loopback; any other Chrome needs the
 * remote address, which exists only while remote access is on.
 */
export function chromeConnectOrigins(pairing: Pick<BrowserSourcePairing, "destinations">): {
  readonly here: string;
  readonly elsewhere: string | null;
} {
  const [first] = pairing.destinations;
  const remote =
    pairing.destinations.find((destination) => destination.remote)?.origin ??
    (pairing.destinations.length === 1 &&
    first &&
    !isLoopbackHostname(new URL(first.origin).hostname)
      ? first.origin
      : null);
  return { elsewhere: remote, here: first?.origin ?? remote ?? "" };
}

/** What the public connect page can read from a link before anything is sent. */
export interface ChromeConnectLink {
  readonly deploymentName: string;
  readonly expiresAt: string;
  readonly invitation: string;
}

/**
 * Throws the sentence to show when the link is damaged, expired or from
 * elsewhere. A link is only honored on a page of the Deployment it names:
 * anyone can sign an invitation for a Deployment they run, so a page that
 * forwarded a stranger's link would pair this Chrome with it in one click.
 */
export function readChromeConnectLink(value: string, pageOrigin: string): ChromeConnectLink {
  const invitation = decodeURIComponent(value.replace(/^#/u, "")).trim();
  if (!invitation) {
    throw new Error(
      "This link is missing its connection code. Go back to Opensteer and choose Connect Chrome again.",
    );
  }
  const decoded = decodeBrowserSourceInvitation(invitation);
  if (!decoded.destinations.some((destination) => sameOrigin(destination.origin, pageOrigin))) {
    throw new Error(
      "This link is for a different Opensteer. Open Opensteer and choose Connect Chrome there.",
    );
  }
  return { deploymentName: decoded.deploymentName, expiresAt: decoded.expiresAt, invitation };
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** Online, or when this Chrome was last connected. */
export function chromeProfilePresence(
  source: Pick<BrowserSourceSummary, "connected" | "lastSeenAt">,
  now = new Date(),
): string {
  if (source.connected) return "Online";
  if (!source.lastSeenAt) return "Offline";
  const ago = formatRelativeTime(source.lastSeenAt, now);
  if (!ago) return "Offline";
  if (ago === "now") return "Offline · last seen just now";
  return /\d[mhd]$/u.test(ago) ? `Offline · last seen ${ago} ago` : `Offline · last seen ${ago}`;
}

/** A Chrome profile that can finish a sign-in: now, or as soon as it opens. */
export interface ChromeSignInChoice {
  readonly name: string;
  readonly online: boolean;
  readonly sourceId: BrowserSourceId;
}

export type ChromeSignInAvailability =
  | { readonly kind: "no-chrome" }
  | { readonly choices: readonly ChromeSignInChoice[]; readonly kind: "choices" }
  | {
      readonly kind: "problem";
      readonly problem: BrowserSourceExportProblem | "chrome-offline";
      /** Null when the problem is shared by several Chrome profiles. */
      readonly sourceName: string | null;
    };

/** Problems the person clears in Chrome itself, in the order worth saying. */
const fixableInChrome: readonly BrowserSourceExportProblem[] = [
  "stopped",
  "chrome-blocked",
  "limit",
];

/**
 * Reads an inspection as the one thing to show. `offlineCounts` is true where a
 * sign-in may wait for Chrome to come back (an agent's Request, which finishes
 * when that Chrome reconnects); the browser toolbar signs in now or not at all.
 */
export function chromeSignInAvailability(
  inspection: Pick<BrowserSourceInspection, "candidates">,
  options: { readonly offlineCounts: boolean },
): ChromeSignInAvailability {
  const { candidates } = inspection;
  if (candidates.length === 0) return { kind: "no-chrome" };
  const online = candidates
    .filter((candidate) => candidate.status === "available")
    .map((candidate) => ({ name: candidate.name, online: true, sourceId: candidate.sourceId }));
  const offline = candidates
    .filter((candidate) => candidate.status === "offline")
    .map((candidate) => ({ name: candidate.name, online: false, sourceId: candidate.sourceId }));
  if (online.length > 0) return { choices: online, kind: "choices" };
  const problem = (
    wanted: readonly BrowserSourceExportProblem[],
  ): ChromeSignInAvailability | null => {
    for (const status of wanted) {
      const matching = candidates.filter((candidate) => candidate.status === status);
      if (matching.length > 0) {
        return {
          kind: "problem",
          problem: status,
          sourceName: matching.length === 1 ? (matching[0]?.name ?? null) : null,
        };
      }
    }
    return null;
  };
  // A Chrome that is on and has the site, but withholds it, is fixed right
  // now; that beats waiting for an offline Chrome that may not have it.
  const fixable = problem(fixableInChrome);
  if (fixable) return fixable;
  if (offline.length > 0 && options.offlineCounts) return { choices: offline, kind: "choices" };
  if (offline.length > 0 && candidates.every((candidate) => candidate.status === "offline")) {
    return {
      kind: "problem",
      problem: "chrome-offline",
      sourceName: offline.length === 1 ? (offline[0]?.name ?? null) : null,
    };
  }
  return (
    problem(["no-state", "too-large", "unsupported"]) ?? {
      kind: "problem",
      problem: "chrome-offline",
      sourceName: null,
    }
  );
}

/**
 * Where a sign-in problem is read: `browser` is the person's own tap in a
 * browser, which they try again; `request` is an agent's sign-in Request, which
 * stays open until Chrome can answer.
 */
export type BrowserSignInContext = "browser" | "request" | "page";

/** What is wrong, then the single action that fixes it, when there is one. */
export interface BrowserSignInProblemCopy {
  readonly fix: string | null;
  readonly title: string;
}

/**
 * The words for one problem, shared by every client. `sourceName` names the
 * Chrome profile when there is exactly one; `connectHere` is false where
 * Chrome cannot be connected from the current screen (a phone).
 */
export function browserSignInProblemCopy(
  problem: BrowserSignInProblem,
  input: {
    readonly connectHere?: boolean;
    readonly context: BrowserSignInContext;
    readonly site: string;
    readonly sourceName: string | null;
  },
): BrowserSignInProblemCopy {
  const domain = browserSiteLabel(input.site);
  const chrome = input.sourceName ?? "Chrome";
  switch (problem) {
    case "no-chrome":
      return {
        fix:
          input.connectHere === false
            ? "Connect Chrome from Opensteer on your computer."
            : "Connect Chrome to use your sign-in.",
        title: "Chrome isn’t connected yet",
      };
    case "chrome-offline":
      return { fix: "Open Chrome on that computer.", title: `${chrome} is offline` };
    case "choose-source":
      return {
        fix: "Choose one.",
        title: `More than one Chrome profile is signed in to ${domain}`,
      };
    case "session-closed":
      return input.context === "request"
        ? {
            fix: `Your agent signs in to ${domain} the next time it needs it.`,
            title: "The agent’s browser closed",
          }
        : {
            fix: "Open it again to sign in.",
            title: input.context === "page" ? "This page was closed" : "This browser closed",
          };
    case "runtime-outdated":
      return {
        fix:
          input.context === "page"
            ? "Update Opensteer on the computer it runs on, then open the page again."
            : "Update Opensteer on the computer it runs on, then open the browser again.",
        title:
          input.context === "page"
            ? "This page can’t take a Chrome sign-in yet"
            : "This browser can’t take a Chrome sign-in yet",
      };
    case "no-state":
      return input.sourceName
        ? {
            fix: `Sign in to ${domain} in that Chrome.`,
            title: `${chrome} isn’t signed in to ${domain}`,
          }
        : { fix: `Sign in to ${domain} in Chrome.`, title: `Chrome isn’t signed in to ${domain}` };
    case "stopped":
      return {
        fix: "Open the Opensteer extension in Chrome and choose Share again.",
        title: `Sharing ${domain} is stopped in ${chrome}`,
      };
    case "chrome-blocked":
      return {
        fix: "In Chrome, right-click the extension’s icon and set “This can read and change site data” to On all sites.",
        title: `Chrome doesn’t let the Opensteer extension read ${domain}`,
      };
    case "limit":
      return {
        fix: "Open the Opensteer extension in Chrome and choose Allow more today.",
        title: `${chrome} reached today’s limit of new sites`,
      };
    case "not-allowed":
      return { fix: null, title: "Opensteer can’t sign in to itself or to sites on this computer" };
    case "site-removed":
      return {
        fix:
          input.context === "request" ? "Allow it again to sign in." : "Sign in again to allow it.",
        title: `${domain} was removed from this Workspace’s sites`,
      };
    case "unsupported":
    case "too-large":
      return {
        fix:
          input.context === "request"
            ? `Sign in to ${domain} yourself in the agent’s browser instead.`
            : `Sign in to ${domain} in this ${input.context === "page" ? "page" : "browser"} instead.`,
        title:
          problem === "too-large"
            ? `${domain}’s sign-in is too large to share`
            : `${domain} can’t share its sign-in from Chrome`,
      };
  }
}

/** The problem as one line: what is wrong, then what fixes it. */
export function browserSignInProblemMessage(
  problem: BrowserSignInProblem,
  input: Parameters<typeof browserSignInProblemCopy>[1],
): string {
  const copy = browserSignInProblemCopy(problem, input);
  return copy.fix === null ? `${copy.title}.` : `${copy.title}. ${copy.fix}`;
}

/** True when the problem clears without anyone coming back to this screen. */
export function browserSignInProblemResolvesItself(problem: BrowserSignInProblem): boolean {
  return problem === "chrome-offline";
}

/**
 * True when fixing the problem in Chrome shows up in the next inspection, so an
 * allowed sign-in may finish once that Chrome reads `available`. Anything else
 * — a browser that closed or is too old, a site Chrome cannot share, a site
 * Opensteer refuses — no inspection can clear.
 */
export function browserSignInProblemClearsInChrome(problem: BrowserSignInProblem): boolean {
  return (
    problem === "no-state" ||
    problem === "stopped" ||
    problem === "chrome-blocked" ||
    problem === "limit"
  );
}

/** One Chrome in a list of choices: what it can do for this site right now. */
export function chromeCandidateDetail(
  candidate: BrowserSourceInspection["candidates"][number],
  site: string,
): string {
  const domain = browserSiteLabel(site);
  switch (candidate.status) {
    case "available":
      return `Signed in to ${domain}`;
    case "offline":
      return "Offline";
    case "no-state":
      return `Not signed in to ${domain}`;
    case "stopped":
      return `Sharing ${domain} is stopped`;
    case "chrome-blocked":
      return `Chrome is blocking ${domain}`;
    case "limit":
      return "Daily limit reached";
    case "unsupported":
    case "too-large":
      return "Can’t share this site";
  }
}

/** The Chrome a Workspace last used for a site, which a sign-in offers first. */
export function browserSitePreferredSource(
  state: Pick<BrowserSourcesState, "sites">,
  workspaceId: string,
  site: string,
): string | null {
  return (
    state.sites.find((grant) => grant.workspaceId === workspaceId && grant.site === site)
      ?.preferredSourceId ?? null
  );
}
