import type { PasskeyCreationOptions, PasskeyRequestOptions, PasskeyTransport } from "./options.js";

/** Errors an authenticator can report without depending on DOMException. */
export type PasskeyAuthenticatorError =
  | "NotAllowedError"
  | "InvalidStateError"
  | "NotSupportedError"
  | "SecurityError"
  | "AbortError"
  | "ConstraintError"
  | "UnknownError";

/**
 * Origin and RP ID have already been checked by the bridge. Options are copied,
 * normalized JSON input. signal belongs to this ceremony, never a shared lease.
 *
 * clientDataJSON is optional: a software/provider adapter may use the bridge's
 * serialization; a system adapter may build its own from origin and challenge.
 * Successful outcomes MUST carry the bytes actually attested/signed, verbatim.
 * In particular, never replace a system API's rawClientDataJSON with our copy.
 */
export type PasskeyAuthenticatorInput = {
  /** Browser-owned context; relays refuse a ceremony without this binding. */
  targetId?: string | undefined;
  documentId?: string | null;
  deadline?: number;
  origin: string;
  rpId: string;
  signal: AbortSignal;
  clientDataJSON?: Uint8Array;
} & (
  { op: "create"; options: PasskeyCreationOptions } | { op: "get"; options: PasskeyRequestOptions }
);

/** How the page can reach this credential again, as the authenticator reported it. */
export type PasskeyAuthenticatorAttachment = "platform" | "cross-platform" | null;

export type PasskeyCreatedOutcome = {
  kind: "created";
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  attestationObject: Uint8Array;
  /** SPKI DER, or null when this client cannot express the algorithm's key. */
  publicKey: Uint8Array | null;
  publicKeyAlgorithm: number;
  authenticatorAttachment: PasskeyAuthenticatorAttachment;
  transports: readonly PasskeyTransport[];
  /** Whether the credential is discoverable, or null when the authenticator didn't say. */
  discoverable: boolean | null;
};

export type PasskeyAssertedOutcome = {
  kind: "asserted";
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  userHandle: Uint8Array | null;
  authenticatorAttachment: PasskeyAuthenticatorAttachment;
};

export type PasskeyAuthenticatorOutcome =
  | PasskeyCreatedOutcome
  | PasskeyAssertedOutcome
  | { kind: "refused"; error: PasskeyAuthenticatorError };

/** One page-bound ceremony; implementations own their verification and keys. */
export interface PasskeyAuthenticator {
  ceremony(input: PasskeyAuthenticatorInput): Promise<PasskeyAuthenticatorOutcome>;
}
