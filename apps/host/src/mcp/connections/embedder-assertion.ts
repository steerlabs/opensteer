import {
  agentDirectoryKeyThumbprint,
  EmbedderAssertionClaimsSchema,
  EmbedderAssertionTokenSchema,
  embedderAssertionAlgorithms,
  embedderAssertionJwtTyp,
  maximumEmbedderAssertionLength,
  type AgentConnectionIdentityAtConsent,
  type AgentDirectoryDocument,
  type AgentDirectoryEntry,
  type EmbedderAssertionClaims,
} from "@opensteer/control-plane-protocol";
import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import { z } from "zod";
import { extractRedirectOrigin, isLoopbackRedirect, matchPlatform } from "./agent-directory.js";

export const defaultEmbedderClockToleranceSeconds = 10;
export const consentSelfStartWarning = "Only approve if you started this yourself.";

export type ClaimEmbedderAssertion = (
  issuer: string,
  statementId: string,
  expiresAt: Date,
) => Promise<boolean>;

export type EmbedderAssertionRefusalReason =
  | "directory-unavailable"
  | "platform-not-verified"
  | "malformed"
  | "disallowed-algorithm"
  | "invalid-typ"
  | "unknown-embedder"
  | "unpaired-embedder"
  | "unknown-key"
  | "invalid-signature"
  | "invalid-lifetime"
  | "expired"
  | "issued-in-future"
  | "request-mismatch"
  | "replayed-jti"
  | "replay-store-unavailable";

export interface EmbedderAssertionRequestBinding {
  readonly clientId: string;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
}

export interface VerifyEmbedderAssertionInput {
  readonly directory: AgentDirectoryDocument | null;
  readonly platformEntry: AgentDirectoryEntry | null;
  readonly assertion: unknown;
  readonly request: EmbedderAssertionRequestBinding;
  readonly now?: number | (() => number);
  readonly clockToleranceSeconds?: number;
  readonly claim: ClaimEmbedderAssertion;
}

export type VerifyEmbedderAssertionResult =
  | {
      readonly ok: true;
      readonly evidence: Extract<
        AgentConnectionIdentityAtConsent,
        { readonly kind: "platform-and-embedder" }
      >;
      readonly embedderEntry: AgentDirectoryEntry;
      readonly claims: EmbedderAssertionClaims;
      readonly keyThumbprint: string;
    }
  | {
      readonly ok: false;
      readonly reason: EmbedderAssertionRefusalReason;
      readonly message: string;
    };

const allowedAlgorithms = new Set<string>(embedderAssertionAlgorithms);
const unverifiedIssuerSchema = z.object({ iss: z.string().min(1).max(256) });

function fail(
  reason: EmbedderAssertionRefusalReason,
  message: string,
): Extract<VerifyEmbedderAssertionResult, { readonly ok: false }> {
  return { ok: false, reason, message };
}

function decodePayloadObject(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/**
 * Verifies a per-request `opensteer_embedder_assertion` JWS against the cached directory and OAuth request.
 */
export async function verifyEmbedderAssertion(
  input: VerifyEmbedderAssertionInput,
): Promise<VerifyEmbedderAssertionResult> {
  const { directory, platformEntry, assertion, request, claim } = input;
  const clockToleranceSeconds = input.clockToleranceSeconds ?? defaultEmbedderClockToleranceSeconds;

  if (!directory) {
    return fail("directory-unavailable", "Verified agent directory is unavailable");
  }
  if (!platformEntry) {
    return fail("platform-not-verified", "Platform is not in the verified agent directory");
  }

  if (
    typeof assertion !== "string" ||
    assertion.length === 0 ||
    assertion.length > maximumEmbedderAssertionLength
  ) {
    return fail("malformed", "Embedder assertion is not a valid compact JWS");
  }

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(assertion);
  } catch {
    return fail("malformed", "Embedder assertion header could not be decoded");
  }

  if (typeof header.alg !== "string" || !allowedAlgorithms.has(header.alg)) {
    return fail("disallowed-algorithm", "Embedder assertion uses a disallowed signing algorithm");
  }

  if (header.typ !== embedderAssertionJwtTyp) {
    return fail("invalid-typ", "Embedder assertion has an unexpected typ header");
  }

  const parsedToken = EmbedderAssertionTokenSchema.safeParse(assertion);
  if (!parsedToken.success) {
    return fail("malformed", "Embedder assertion is not a valid compact JWS");
  }

  const rawPayload = decodePayloadObject(parsedToken.data);
  const issuerPeek = unverifiedIssuerSchema.safeParse(rawPayload);
  if (!issuerPeek.success) {
    return fail("malformed", "Embedder assertion payload is missing a valid issuer");
  }

  const embedderEntry = directory.entries.find((entry) =>
    entry.origins.includes(issuerPeek.data.iss),
  );
  if (!embedderEntry) {
    return fail("unknown-embedder", "Embedder origin is not in the verified agent directory");
  }

  if (!embedderEntry.embedsVia?.includes(platformEntry.id)) {
    return fail("unpaired-embedder", "Directory does not pair this embedder with this platform");
  }

  const key = embedderEntry.keys?.keys.find(
    (entry) => typeof header.kid === "string" && entry.kid === header.kid,
  );
  if (!key) {
    return fail("unknown-key", "No matching signing key was found in the embedder directory entry");
  }
  const alg = key.kty === "OKP" ? "EdDSA" : "ES256";
  const jwk = {
    kty: key.kty,
    crv: key.crv,
    x: key.x,
    ...(key.kty === "EC" ? { y: key.y } : {}),
  };
  let verifiedPayloadBytes: Uint8Array;
  try {
    const cryptoKey = await importJWK(jwk, alg);
    const { payload } = await compactVerify(parsedToken.data, cryptoKey, { algorithms: [alg] });
    verifiedPayloadBytes = payload;
  } catch {
    return fail("invalid-signature", "Embedder assertion signature verification failed");
  }

  let verifiedJson: unknown;
  try {
    verifiedJson = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(verifiedPayloadBytes),
    );
  } catch {
    return fail("malformed", "Embedder assertion payload is not valid UTF-8 JSON");
  }

  const parsedClaims = EmbedderAssertionClaimsSchema.safeParse(verifiedJson);
  if (!parsedClaims.success) {
    if (
      parsedClaims.error.issues.some((issue) => issue.code === "custom" && issue.path[0] === "exp")
    ) {
      return fail("invalid-lifetime", "Embedder assertion lifetime exceeds two minutes");
    }
    return fail("malformed", "Embedder assertion claims are invalid");
  }
  const claims = parsedClaims.data;

  const nowMs = typeof input.now === "function" ? input.now() : (input.now ?? Date.now());
  if (claims.iat * 1_000 > nowMs + clockToleranceSeconds * 1_000) {
    return fail("issued-in-future", "Embedder assertion was issued in the future");
  }
  const deadline = (claims.exp + clockToleranceSeconds) * 1_000;
  if (nowMs >= deadline) {
    return fail("expired", "Embedder assertion has expired");
  }

  if (
    claims.sub !== request.clientId ||
    claims.aud !== request.issuer ||
    claims.redirect_uri !== request.redirectUri ||
    claims.code_challenge !== request.codeChallenge ||
    request.state === undefined ||
    claims.state !== request.state
  ) {
    return fail("request-mismatch", "Embedder assertion does not match this authorization request");
  }

  const platformOrigin = extractRedirectOrigin(request.redirectUri);
  if (!platformOrigin || !platformEntry.origins.includes(platformOrigin)) {
    return fail("platform-not-verified", "Redirect origin does not match the verified platform");
  }

  let fresh: boolean;
  let keyThumbprint: string;
  try {
    keyThumbprint = await agentDirectoryKeyThumbprint(key);
    fresh = await claim(claims.iss, claims.jti, new Date(deadline));
  } catch {
    return fail("replay-store-unavailable", "Could not record the embedder statement");
  }
  if (!fresh) {
    return fail("replayed-jti", "Embedder assertion has already been used");
  }

  const evidence: Extract<
    AgentConnectionIdentityAtConsent,
    { readonly kind: "platform-and-embedder" }
  > = {
    kind: "platform-and-embedder",
    platformOrigin,
    platformDirectoryId: platformEntry.id,
    platformName: platformEntry.displayName,
    embedderOrigin: claims.iss,
    embedderDirectoryId: embedderEntry.id,
    embedderName: embedderEntry.displayName,
    keyThumbprint,
    directoryRevision: directory.revision,
    recordedAt: new Date(nowMs).toISOString(),
  };

  return { ok: true, evidence, embedderEntry, claims, keyThumbprint };
}

export interface ResolveConsentIdentityInput {
  readonly directory: AgentDirectoryDocument | null;
  readonly clientName: string;
  readonly assertion: unknown;
  readonly request: EmbedderAssertionRequestBinding;
  readonly now?: number | (() => number);
  readonly clockToleranceSeconds?: number;
  readonly claim: ClaimEmbedderAssertion;
}

export async function resolveConsentIdentity(
  input: ResolveConsentIdentityInput,
): Promise<AgentConnectionIdentityAtConsent> {
  const platformEntry = matchPlatform(input.directory, input.request.redirectUri);

  if (input.assertion !== undefined) {
    const verified = await verifyEmbedderAssertion({
      directory: input.directory,
      platformEntry,
      assertion: input.assertion,
      request: input.request,
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.clockToleranceSeconds !== undefined
        ? { clockToleranceSeconds: input.clockToleranceSeconds }
        : {}),
      claim: input.claim,
    });
    if (verified.ok) return verified.evidence;
  }

  const nowMs = typeof input.now === "function" ? input.now() : (input.now ?? Date.now());
  const recordedAt = new Date(nowMs).toISOString();
  if (input.assertion === undefined && platformEntry && input.directory) {
    const platformOrigin = extractRedirectOrigin(input.request.redirectUri);
    if (platformOrigin && platformEntry.origins.includes(platformOrigin)) {
      return {
        kind: "platform",
        platformOrigin,
        platformDirectoryId: platformEntry.id,
        platformName: platformEntry.displayName,
        directoryRevision: input.directory.revision,
        recordedAt,
      };
    }
  }

  return unverifiedConsentIdentity(
    input.request.redirectUri,
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
  readonly role: "embedder" | "platform" | "redirect";
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
    case "platform-and-embedder":
      return {
        evidenceKind: "platform-and-embedder",
        verified: true,
        selfAsserted: false,
        heading: `${identity.embedderName} via ${identity.platformName}`,
        detail: `${identity.embedderName} asked for this. ${identity.platformName} will hold the access.`,
        origins: [
          { role: "embedder", label: identity.embedderName, origin: identity.embedderOrigin },
          { role: "platform", label: identity.platformName, origin: identity.platformOrigin },
        ],
        warning: consentSelfStartWarning,
      };
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
