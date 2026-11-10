import { utf8Size } from "./bytes.js";

export interface AttachTicketClaims {
  readonly runtimeId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}
export class AttachTicketPolicyError extends Error {
  readonly code = "forbidden";
}
export function validateAttachTicketHeader(
  value: unknown,
  typ = "opensteer-browser-attach+jwt",
): { kid: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("header");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "alg" ||
    keys[1] !== "kid" ||
    keys[2] !== "typ" ||
    record.alg !== "EdDSA" ||
    record.typ !== typ ||
    typeof record.kid !== "string" ||
    record.kid.length < 1 ||
    record.kid.length > 255
  )
    throw invalid("header");
  return { kid: record.kid };
}
export function validateAttachTicketClaims(
  claims: AttachTicketClaims,
  runtimeId: string,
  now: number,
  clockSkewMs = 5_000,
  maxTicketLifetimeMs = 5 * 60_000,
): void {
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(now))
    throw invalid("claims");
  if (claims.runtimeId !== runtimeId)
    throw new AttachTicketPolicyError("The browser attach ticket targets another runtime.");
  if (issuedAt > now + clockSkewMs)
    throw new AttachTicketPolicyError("The browser attach ticket is not active yet.");
  if (expiresAt <= now) throw new AttachTicketPolicyError("The browser attach ticket has expired.");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxTicketLifetimeMs)
    throw new AttachTicketPolicyError("The browser attach ticket lifetime is invalid.");
}
export interface AttachTicketPorts<Claims extends AttachTicketClaims> {
  readonly decodeBase64Url: (segment: string) => Uint8Array;
  readonly parseClaims: (value: unknown) => Claims;
  readonly verify: (keyId: string, signed: Uint8Array, signature: Uint8Array) => Promise<boolean>;
  readonly claim: (nonce: string, expiresAt: number, now: number) => Promise<void>;
}
export async function verifyAttachTicket<Claims extends AttachTicketClaims>(
  token: string,
  expectation: { runtimeId: string; now: number },
  ports: AttachTicketPorts<Claims>,
  limits: { maxTicketBytes?: number; clockSkewMs?: number; maxTicketLifetimeMs?: number } = {},
): Promise<Claims> {
  if (
    utf8Size(token) > (limits.maxTicketBytes ?? 16_384) ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    throw invalid("malformed");
  const [protectedSegment, payloadSegment, signatureSegment] = token.split(".") as [
    string,
    string,
    string,
  ];
  const decode = (segment: string): Uint8Array => {
    try {
      return ports.decodeBase64Url(segment);
    } catch {
      throw invalid("malformed");
    }
  };
  const json = (segment: string): unknown => {
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(decode(segment)),
      ) as unknown;
    } catch {
      throw invalid("malformed");
    }
  };
  const header = validateAttachTicketHeader(json(protectedSegment));
  const signature = decode(signatureSegment);
  if (
    signature.byteLength !== 64 ||
    !(await ports.verify(
      header.kid,
      new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`),
      signature,
    ))
  )
    throw new AttachTicketPolicyError("The browser attach ticket signature is invalid.");
  let claims: Claims;
  try {
    claims = ports.parseClaims(json(payloadSegment));
  } catch {
    throw invalid("claims");
  }
  validateAttachTicketClaims(
    claims,
    expectation.runtimeId,
    expectation.now,
    limits.clockSkewMs,
    limits.maxTicketLifetimeMs,
  );
  await ports.claim(claims.nonce, Date.parse(claims.expiresAt), expectation.now);
  return claims;
}
function invalid(part: string): AttachTicketPolicyError {
  return new AttachTicketPolicyError(
    part === "malformed"
      ? "The browser attach ticket is malformed."
      : `The browser attach ticket ${part} is invalid.`,
  );
}

export interface ReplayLedgerState {
  readonly version: 1;
  readonly highWaterAt: number;
  readonly entries: readonly { readonly nonce: string; readonly expiresAt: number }[];
}
export class AttachTicketReplayLedgerError extends Error {
  readonly code: "already-used" | "full" | "unavailable";
  constructor(code: AttachTicketReplayLedgerError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AttachTicketReplayLedgerError";
    this.code = code;
  }
}
export function transitionReplayLedger(
  state: ReplayLedgerState,
  nonce: string,
  expiresAt: number,
  now: number,
  maxEntries: number,
): ReplayLedgerState {
  if (
    !/^[\s\S]{16,255}$/u.test(nonce) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    now < state.highWaterAt
  )
    throw new AttachTicketReplayLedgerError("unavailable", "Replay expiry or clock is invalid");
  const active = state.entries.filter((entry) => entry.expiresAt > now);
  if (active.some((entry) => entry.nonce === nonce))
    throw new AttachTicketReplayLedgerError(
      "already-used",
      "Attach ticket nonce was already consumed",
    );
  if (active.length >= maxEntries)
    throw new AttachTicketReplayLedgerError("full", "Attach ticket replay ledger is full");
  return { version: 1, highWaterAt: now, entries: [...active, { nonce, expiresAt }] };
}
