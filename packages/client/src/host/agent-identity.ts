import type { AgentConnectionIdentityAtConsent } from "@opensteer/control-plane-protocol";
import type { AgentConnectionIdentityPresentation } from "@opensteer/protocol";
import { workSentence, workText, workWords } from "./agent-work-copy.js";
import { plainSentence, siteOrigin, type SentencePart } from "./sentence-parts.js";

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
  /** The verified origin, the redirect origin, or "an app on this computer", as plain text. */
  readonly detail: string;
  /** `detail` as parts: each origin an address, each name someone else gave a name. */
  readonly detailParts: readonly SentencePart[];
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
 * A client-chosen name shown on one line, as a labelled claim: the Home cleaned it where it
 * entered (`outsideName`), so all that is left here is the cut for a claim's short space.
 */
export function agentClaim(name: string, maxLength = agentClaimMaxLength): string {
  const chars = Array.from(name.trim());
  if (!chars.length) return workWords("who.unnamed");
  return chars.length > maxLength
    ? `${chars
        .slice(0, maxLength - 1)
        .join("")
        .trimEnd()}…`
    : name.trim();
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
    // The line under the heading, from what the Home recorded, each value by what it is.
    const named = (role: "embedder" | "platform") =>
      presented.origins.find((origin) => origin.role === role);
    const embedder = named("embedder");
    const platform = named("platform");
    const detailParts: readonly SentencePart[] = local
      ? [workWords("who.local")]
      : embedder && platform
        ? workSentence("who.pairDetail", {
            embedder: { name: embedder.label },
            platform: { name: platform.label },
          })
        : originParts(platform?.origin ?? input.redirect);
    return {
      heading: claim ?? presented.heading,
      detail: plainSentence(detailParts),
      detailParts,
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
        ? workText("who.pair", {
            embedder: recorded.embedderName,
            platform: recorded.platformName,
          })
        : recorded.platformName,
      detail: plainSentence(originParts(recorded.platformOrigin)),
      detailParts: originParts(recorded.platformOrigin),
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
  const redirectOrigin = local || input.redirect === null ? null : siteOrigin(input.redirect);
  const detailParts: readonly SentencePart[] =
    local || input.redirect === null ? [workWords("who.local")] : originParts(input.redirect);
  return {
    heading: claim,
    detail: plainSentence(detailParts),
    detailParts,
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
  readonly claimParts: readonly SentencePart[] | null;
} {
  if (who.verified) return { title: who.heading, mark: true, claim: null, claimParts: null };
  const claimParts = who.claim ? workSentence("who.claim", { name: { name: who.claim } }) : null;
  return {
    title: workWords("who.consentHeading"),
    mark: false,
    claim: claimParts ? plainSentence(claimParts) : null,
    claimParts,
  };
}

export function agentWhoOriginLine(origin: AgentWhoOrigin): string {
  return plainSentence(agentWhoOriginParts(origin));
}

/**
 * The same line as parts: the Home's verified name a name, the origin an address. An origin that
 * does not parse as one is never drawn as an address: it stands as text from outside, a name.
 */
export function agentWhoOriginParts(origin: AgentWhoOrigin): readonly SentencePart[] {
  const parsed = siteOrigin(origin.origin);
  const address = parsed === null ? { name: origin.origin } : { address: parsed };
  return origin.name
    ? workSentence(
        "who.namedOrigin",
        { name: { name: origin.name }, origin: address },
        { role: origin.roleLabel },
      )
    : workSentence("who.redirectOrigin", { origin: address }, { role: origin.roleLabel });
}

/**
 * The agent's name as parts: `Verified: “Claude”`, `Says it is “Grok”`, or the plain name of an
 * app on this computer or one whose verification was withdrawn.
 */
export function agentWhoNameParts(who: AgentWho): readonly SentencePart[] {
  if (who.verified) return workSentence("who.verifiedAs", { name: { name: who.heading } });
  if (who.selfAsserted) return workSentence("who.saysItIs", { name: { name: who.heading } });
  return [{ name: who.heading }];
}

/**
 * The agent's name as every surface says it: "Verified: “Claude”", "Says it is “Grok”", or the
 * plain name of an app on this computer or one whose verification was withdrawn.
 */
export function agentWhoName(who: AgentWho): string {
  if (who.verified || who.selfAsserted) return plainSentence(agentWhoNameParts(who));
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

/** An origin as an address, from URL parsing (`siteOrigin`); nothing for one that does not parse. */
function originParts(value: string | null): readonly SentencePart[] {
  const origin = value === null ? null : siteOrigin(value);
  return origin === null ? [] : [{ address: origin }];
}
