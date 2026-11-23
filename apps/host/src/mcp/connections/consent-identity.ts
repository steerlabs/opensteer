import type {
  AgentConnectionIdentityAtConsent,
  AgentDirectoryDocument,
} from "@opensteer/control-plane-protocol";
import { extractRedirectOrigin, isLoopbackRedirect, matchPlatform } from "./agent-directory.js";

export const consentSelfStartWarning = "Only allow this if you started it yourself.";

/**
 * Who asked for a connection, as the Home can prove it at consent: verified when the redirect
 * address the person consents to has exactly the origin of an entry in the signed agent directory,
 * unverified otherwise (then the agent's own name is shown as its claim).
 */
export function resolveConsentIdentity(input: {
  readonly directory: AgentDirectoryDocument | null;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly now?: number | (() => number);
}): AgentConnectionIdentityAtConsent {
  const nowMs = typeof input.now === "function" ? input.now() : (input.now ?? Date.now());
  const recordedAt = new Date(nowMs).toISOString();
  const platformEntry = matchPlatform(input.directory, input.redirectUri);
  const platformOrigin = extractRedirectOrigin(input.redirectUri);
  if (
    platformEntry &&
    input.directory &&
    platformOrigin &&
    platformEntry.origins.includes(platformOrigin)
  )
    return {
      kind: "platform",
      platformOrigin,
      platformDirectoryId: platformEntry.id,
      platformName: platformEntry.displayName,
      directoryRevision: input.directory.revision,
      recordedAt,
    };
  return unverifiedConsentIdentity(
    input.redirectUri,
    input.clientName,
    input.directory,
    recordedAt,
  );
}

export function unverifiedConsentIdentity(
  redirectUri: string,
  clientName: string,
  directory: AgentDirectoryDocument | null,
  recordedAt: string,
): AgentConnectionIdentityAtConsent {
  return {
    kind: "unverified",
    redirectOrigin: extractRedirectOrigin(redirectUri),
    isLoopback: isLoopbackRedirect(redirectUri),
    clientName,
    directoryRevision: directory?.revision ?? null,
    recordedAt,
  };
}

export interface IdentityOriginPresentation {
  readonly role: "platform" | "redirect";
  readonly label: string;
  readonly origin: string;
}

export interface IdentityPresentation {
  readonly evidenceKind: AgentConnectionIdentityAtConsent["kind"];
  readonly verified: boolean;
  readonly selfAsserted: boolean;
  readonly heading: string;
  readonly detail: string;
  readonly origins: readonly IdentityOriginPresentation[];
  readonly warning: typeof consentSelfStartWarning;
}

/** Projects recorded consent identity evidence into the exact consent presentation view model. */
export function describeIdentity(identity: AgentConnectionIdentityAtConsent): IdentityPresentation {
  switch (identity.kind) {
    case "platform":
      return {
        evidenceKind: "platform",
        verified: true,
        selfAsserted: false,
        heading: identity.platformName,
        detail: identity.platformOrigin,
        origins: [
          { role: "platform", label: identity.platformName, origin: identity.platformOrigin },
        ],
        warning: consentSelfStartWarning,
      };
    case "unverified":
      return {
        evidenceKind: "unverified",
        verified: false,
        selfAsserted: true,
        heading: identity.clientName,
        detail: identity.isLoopback
          ? "an app on this computer"
          : (identity.redirectOrigin ?? "an app on this computer"),
        origins:
          identity.isLoopback || !identity.redirectOrigin
            ? []
            : [{ role: "redirect", label: identity.clientName, origin: identity.redirectOrigin }],
        warning: consentSelfStartWarning,
      };
  }
}
