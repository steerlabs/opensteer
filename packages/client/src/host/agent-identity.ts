import type { AgentConnectionIdentityAtConsent } from "@opensteer/control-plane-protocol";
import type { AgentConnectionIdentityPresentation } from "@opensteer/protocol";
import { workWords } from "./agent-work-copy.js";
import { plainSentence, sentenceWith, siteOrigin, type SentencePart } from "./sentence-parts.js";

/**
 * Who a connected agent is, as far as the Home could prove at consent. The Home's own
 * presentation decides the words; without one (an older Home), the agent is only the name
 * it gave itself and where it returns to. A logo is shown only for a platform the Home
 * verified, never guessed from a domain.
 */
export interface AgentWho {
  /**
   * "Errand via AgentPay", a verified platform's name, or the self-given name made safe to
   * show on one line. Beside a mark only when `verified`; otherwise only inside a claim.
   */
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
  /**
   * The name the client gave itself, on one line with no formatting or direction controls,
   * shown only as a labelled claim ("Says it is …"); null when the Home verified who it is.
   */
  readonly claim: string | null;
  /** Each origin the Home recorded, labelled by what it is: both, for a verified pairing. */
  readonly origins: readonly AgentWhoOrigin[];
}

/** One origin the Home recorded for this agent. */
export interface AgentWhoOrigin {
  readonly role: "embedder" | "platform" | "redirect";
  /** The Home's verified name for it; null for a redirect, whose only name is the claim. */
  readonly name: string | null;
  readonly origin: string;
  /** What this origin is: "Asked for this", "Holds the access", "Returns to". */
  readonly roleLabel: string;
}

/** The longest claim shown; past it the name is cut with an ellipsis. */
export const agentClaimMaxLength = 40;

/**
 * A client-chosen name as text that can only read as itself: control, format (including
 * bidirectional overrides and zero-width joiners) and line or paragraph separators removed,
 * whitespace collapsed to single spaces, and long names cut. Check marks and look-alike
 * words stay as plain characters; the claim's label and styling say what they are.
 */
export function agentClaim(name: string, maxLength = agentClaimMaxLength): string {
  const flat = name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(flat);
  if (!chars.length) return workWords("who.unnamed");
  return chars.length > maxLength
    ? `${chars
        .slice(0, maxLength - 1)
        .join("")
        .trimEnd()}…`
    : flat;
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
    // An unverified heading is the client's own name: only ever a claim, made safe to show.
    const claim = presented.verified ? null : agentClaim(input.clientName);
    return {
      heading: claim ?? presented.heading,
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
      claim,
      origins: presented.origins.map((origin) => ({
        role: origin.role,
        name: origin.role === "redirect" ? null : origin.label,
        origin: origin.origin,
        roleLabel: workWords(`who.origin.${origin.role}`),
      })),
    };
  }
  if (recorded && recorded.kind !== "unverified") {
    const pair = recorded.kind === "platform-and-embedder";
    const origins: AgentWhoOrigin[] = [
      {
        role: "platform",
        name: recorded.platformName,
        origin: recorded.platformOrigin,
        roleLabel: workWords("who.origin.platform"),
      },
    ];
    if (pair)
      origins.unshift({
        role: "embedder",
        name: recorded.embedderName,
        origin: recorded.embedderOrigin,
        roleLabel: workWords("who.origin.embedder"),
      });
    return {
      heading: pair
        ? workWords("who.pair", {
            embedder: recorded.embedderName,
            platform: recorded.platformName,
          })
        : recorded.platformName,
      detail: recorded.platformOrigin,
      verified: withdrawnSince === null,
      selfAsserted: false,
      providerId:
        withdrawnSince === null ? (platformLogos[recorded.platformDirectoryId] ?? null) : null,
      local,
      withdrawnSince,
      warning: workWords("who.consentWarning"),
      claim: null,
      origins,
    };
  }
  const claim = agentClaim(input.clientName);
  const redirectOrigin = local ? null : originOf(input.redirect);
  return {
    heading: claim,
    detail: local ? workWords("who.local") : (originOf(input.redirect) ?? workWords("who.local")),
    verified: false,
    selfAsserted: true,
    providerId: null,
    local,
    withdrawnSince: null,
    warning: workWords("who.consentWarning"),
    claim,
    origins: redirectOrigin
      ? [
          {
            role: "redirect",
            name: null,
            origin: redirectOrigin,
            roleLabel: workWords("who.origin.redirect"),
          },
        ]
      : [],
  };
}

/**
 * The top of a consent screen. Verified: the Home's verified name beside the mark, and
 * nothing the client supplied. Not verified: a neutral heading with no mark, and the
 * client's name only in the labelled claim below it.
 */
export function agentConsentHeading(who: AgentWho): {
  readonly title: string;
  readonly mark: boolean;
  readonly claim: string | null;
} {
  return who.verified
    ? { title: who.heading, mark: true, claim: null }
    : {
        title: workWords("who.consentHeading"),
        mark: false,
        claim: who.claim && workWords("who.claim", { name: who.claim }),
      };
}

export function agentWhoOriginLine(origin: AgentWhoOrigin): string {
  return plainSentence(agentWhoOriginParts(origin));
}

/** The same line as parts: the Home's verified name a name, the origin an address. */
export function agentWhoOriginParts(origin: AgentWhoOrigin): readonly SentencePart[] {
  const address = { address: siteOrigin(origin.origin) ?? origin.origin };
  return origin.name
    ? sentenceWith(
        (slot) =>
          workWords("who.namedOrigin", {
            role: origin.roleLabel,
            name: slot("name"),
            origin: slot("origin"),
          }),
        { name: { name: origin.name }, origin: address },
      )
    : sentenceWith(
        (slot) =>
          workWords("who.redirectOrigin", { role: origin.roleLabel, origin: slot("origin") }),
        { origin: address },
      );
}

/**
 * The agent's name as every surface says it: "Verified: Claude", "Says it is Grok", or the
 * plain name of an app on this computer or one whose verification was withdrawn.
 */
export function agentWhoName(who: AgentWho): string {
  if (who.verified) return workWords("who.verifiedAs", { name: who.heading });
  if (who.selfAsserted) return workWords("who.saysItIs", { name: who.heading });
  return who.heading;
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
