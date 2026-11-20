import {
  EmbedderAssertionClaimsSchema,
  EmbedderAssertionTokenSchema,
  embedderAssertionAlgorithms,
  embedderAssertionJwtTyp,
  embedderAssertionMaxLifetimeSeconds,
  maximumEmbedderAssertionLength,
  type AgentConnectionIdentityAtConsent,
  type AgentDirectoryDocument,
  type AgentDirectoryEntry,
  type AgentDirectoryPublicJwk,
  type EmbedderAssertionAlgorithm,
  type EmbedderAssertionClaims,
} from "@opensteer/control-plane-protocol";
import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  type JWK,
} from "jose";
import { z } from "zod";
import { extractRedirectOrigin, isLoopbackRedirect, matchPlatform } from "./agent-directory.js";

export const defaultEmbedderClockToleranceSeconds = 10;
export const consentSelfStartWarning = "Only approve if you started this yourself.";

export interface JtiReplayStore {
  /** Records `key` until `expiresAtMs` if unseen and unexpired; returns `true` when accepted, `false` on replay. */
  consume(key: string, expiresAtMs: number, nowMs: number): boolean | Promise<boolean>;
}

/** In-memory replay guard bounded by assertion lifetime and entry cap. */
export class InMemoryJtiReplayStore implements JtiReplayStore {
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;

  constructor(options: { readonly maxEntries?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 10_000;
    if (this.#maxEntries < 1) throw new RangeError("maxEntries must be positive");
  }

  consume(key: string, expiresAtMs: number, nowMs: number): boolean {
    for (const [existingKey, expiry] of this.#entries) {
      if (expiry <= nowMs) this.#entries.delete(existingKey);
    }
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing > nowMs) return false;
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, expiresAtMs);
    return true;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}

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
  | "replayed-jti";

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
  readonly assertion: string;
  readonly request: EmbedderAssertionRequestBinding;
  readonly now?: number;
  readonly clockToleranceSeconds?: number;
  readonly seenJti: JtiReplayStore;
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

function jwkMatchesAlgorithm(
  jwk: AgentDirectoryPublicJwk,
  alg: EmbedderAssertionAlgorithm,
): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (alg === "EdDSA") return jwk.kty === "OKP" && jwk.crv === "Ed25519";
  return jwk.kty === "EC" && jwk.crv === "P-256";
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
 * An assertion that is present but fails any check is always refused, never treated as absent.
 */
export async function verifyEmbedderAssertion(
  input: VerifyEmbedderAssertionInput,
): Promise<VerifyEmbedderAssertionResult> {
  const { directory, platformEntry, assertion, request, seenJti } = input;
  const nowMs = input.now ?? Date.now();
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
  const alg = header.alg as EmbedderAssertionAlgorithm;

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

  const entryKeys = embedderEntry.keys?.keys ?? [];
  const headerKid =
    typeof header.kid === "string" && header.kid.length > 0 ? header.kid : undefined;
  const candidateKeys = entryKeys.filter(
    (key) => jwkMatchesAlgorithm(key, alg) && (headerKid === undefined || key.kid === headerKid),
  );
  if (candidateKeys.length === 0) {
    return fail("unknown-key", "No matching signing key was found in the embedder directory entry");
  }

  let verifiedPayloadBytes: Uint8Array | undefined;
  let matchedKey: AgentDirectoryPublicJwk | undefined;
  for (const key of candidateKeys) {
    try {
      const cryptoKey = await importJWK(key as JWK, alg);
      const { payload } = await compactVerify(parsedToken.data, cryptoKey, { algorithms: [alg] });
      verifiedPayloadBytes = payload;
      matchedKey = key;
      break;
    } catch {
      continue;
    }
  }
  if (!verifiedPayloadBytes || !matchedKey) {
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

  // Distinguish lifetime violations from general malformed payloads for clear refusal codes.
  const timingPeek = z
    .object({ iat: z.number().int().nonnegative(), exp: z.number().int().positive() })
    .safeParse(verifiedJson);
  if (
    timingPeek.success &&
    (timingPeek.data.exp <= timingPeek.data.iat ||
      timingPeek.data.exp - timingPeek.data.iat > embedderAssertionMaxLifetimeSeconds)
  ) {
    return fail("invalid-lifetime", "Embedder assertion lifetime exceeds two minutes");
  }

  const parsedClaims = EmbedderAssertionClaimsSchema.safeParse(verifiedJson);
  if (!parsedClaims.success) {
    return fail("malformed", "Embedder assertion claims are invalid");
  }
  const claims = parsedClaims.data;

  const nowSec = Math.floor(nowMs / 1_000);
  if (claims.iat > nowSec + clockToleranceSeconds) {
    return fail("issued-in-future", "Embedder assertion was issued in the future");
  }
  if (nowSec > claims.exp + clockToleranceSeconds) {
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

  const jtiKey = `${claims.iss}\0${claims.jti}`;
  const jtiExpiresAtMs = (claims.exp + clockToleranceSeconds) * 1_000;
  const fresh = await seenJti.consume(jtiKey, jtiExpiresAtMs, nowMs);
  if (!fresh) {
    return fail("replayed-jti", "Embedder assertion has already been used");
  }

  const keyThumbprint = await calculateJwkThumbprint(matchedKey as JWK, "sha256");
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
  readonly assertion: string | undefined;
  readonly request: EmbedderAssertionRequestBinding;
  readonly now?: number;
  readonly clockToleranceSeconds?: number;
  readonly seenJti: JtiReplayStore;
}

export type ResolveConsentIdentityResult =
  | { readonly ok: true; readonly identity: AgentConnectionIdentityAtConsent }
  | {
      readonly ok: false;
      readonly reason: EmbedderAssertionRefusalReason;
      readonly message: string;
    };

/**
 * Resolves the consent identity evidence for an authorization request.
 * If `assertion` is present, it must verify or the request is refused.
 */
export async function resolveConsentIdentity(
  input: ResolveConsentIdentityInput,
): Promise<ResolveConsentIdentityResult> {
  const nowMs = input.now ?? Date.now();
  const platformEntry = matchPlatform(input.directory, input.request.redirectUri);

  if (input.assertion !== undefined) {
    const verified = await verifyEmbedderAssertion({
      directory: input.directory,
      platformEntry,
      assertion: input.assertion,
      request: input.request,
      now: nowMs,
      ...(input.clockToleranceSeconds !== undefined
        ? { clockToleranceSeconds: input.clockToleranceSeconds }
        : {}),
      seenJti: input.seenJti,
    });
    if (!verified.ok) return verified;
    return { ok: true, identity: verified.evidence };
  }

  const recordedAt = new Date(nowMs).toISOString();
  if (platformEntry && input.directory) {
    const platformOrigin = extractRedirectOrigin(input.request.redirectUri);
    if (platformOrigin && platformEntry.origins.includes(platformOrigin)) {
      return {
        ok: true,
        identity: {
          kind: "platform",
          platformOrigin,
          platformDirectoryId: platformEntry.id,
          platformName: platformEntry.displayName,
          directoryRevision: input.directory.revision,
          recordedAt,
        },
      };
    }
  }

  const isLoopback = isLoopbackRedirect(input.request.redirectUri);
  return {
    ok: true,
    identity: {
      kind: "unverified",
      redirectOrigin: extractRedirectOrigin(input.request.redirectUri),
      isLoopback,
      clientName: input.clientName,
      directoryRevision: input.directory?.revision ?? null,
      recordedAt,
    },
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
