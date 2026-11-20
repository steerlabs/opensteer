import type { AgentConnectionIdentityAtConsent } from "@opensteer/control-plane-protocol";
import type { AgentConnectionIdentityPresentation } from "@opensteer/protocol";
import { workWords } from "./agent-work-copy.js";

/**
 * Who a connected agent is, as far as the Home could prove at consent. The Home's own
 * presentation decides the words; without one (an older Home), the agent is only the name
 * it gave itself and where it returns to. A logo is shown only for a platform the Home
 * verified, never guessed from a domain.
 */
export interface AgentWho {
  /** "Errand via AgentPay", a verified platform's name, or the self-given name. */
  readonly heading: string;
  /** The verified origin, the redirect origin, or "an app on this computer". */
  readonly detail: string;
  readonly verified: boolean;
  /** The heading is only what the client calls itself. */
  readonly selfAsserted: boolean;
  /** A logo key for a verified platform; null otherwise. */
  readonly providerId: string | null;
  /** The redirect returns to this computer. */
  readonly local: boolean;
  /** When the Home stopped vouching for a verified identity; null while it still does. */
  readonly withdrawnSince: string | null;
  readonly warning: string;
}

/** Logos the apps draw, keyed by the verified directory's own platform id. */
const platformLogos: Readonly<Record<string, string>> = {
  chatgpt: "openai",
  claude: "anthropic",
};

const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function agentWho(input: {
  readonly clientName: string;
  /** The consented redirect, as a URI or an origin. */
  readonly redirect: string | null;
  readonly identity?: AgentConnectionIdentityPresentation | undefined;
  readonly identityAtConsent?: AgentConnectionIdentityAtConsent | null | undefined;
  readonly withdrawnAt?: string | null | undefined;
}): AgentWho {
  const host = hostOf(input.redirect);
  const recorded = input.identityAtConsent ?? null;
  const local =
    recorded?.kind === "unverified" ? recorded.isLoopback : host !== null && loopback.has(host);
  const withdrawnSince = input.withdrawnAt ?? null;
  const presented = input.identity;
  if (presented) {
    const verified = presented.verified && withdrawnSince === null;
    return {
      heading: presented.heading,
      detail:
        presented.detail || (local ? workWords("who.local") : (originOf(input.redirect) ?? "")),
      verified,
      selfAsserted: presented.selfAsserted,
      providerId:
        verified && recorded && recorded.kind !== "unverified"
          ? (platformLogos[recorded.platformDirectoryId] ?? null)
          : null,
      local,
      withdrawnSince: presented.verified ? withdrawnSince : null,
      warning: presented.warning || workWords("who.consentWarning"),
    };
  }
  return {
    heading: input.clientName,
    detail: local ? workWords("who.local") : (originOf(input.redirect) ?? workWords("who.local")),
    verified: false,
    selfAsserted: true,
    providerId: null,
    local,
    withdrawnSince: null,
    warning: workWords("who.consentWarning"),
  };
}

/** "No longer verified since Nov 20, 2026", or null while it is. */
export function agentWithdrawnLine(who: AgentWho, locale?: string): string | null {
  if (!who.withdrawnSince) return null;
  const date = new Date(who.withdrawnSince).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return workWords("who.withdrawn", { date });
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}
