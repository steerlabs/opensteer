import {
  PersonProfileReceiptClaimsSchema,
  PersonProfileReceiptSchema,
  personProfileReceiptAudience,
  personProfileReceiptLifetimeSeconds,
  type PersonProfileReceiptClaims,
} from "@opensteer/control-plane-protocol";
import { OpensteerError } from "@opensteer/core";
import { AccountJwksUnavailableError, RemoteAccountJwksVerifier } from "./account-jwks-verifier.js";

export interface PersonProfileReceiptVerifier {
  verify(receipt: unknown): Promise<PersonProfileReceiptClaims>;
}

/**
 * Verifies a name receipt against this Host's Account keys. Issuer and audience come from this
 * Host's configuration, never the token; which member it may rename is the caller's check.
 */
export class RemotePersonProfileReceiptVerifier implements PersonProfileReceiptVerifier {
  readonly #verifier: RemoteAccountJwksVerifier;

  constructor(options: { readonly fetch?: typeof globalThis.fetch; readonly issuer: URL }) {
    this.#verifier = new RemoteAccountJwksVerifier({
      audience: personProfileReceiptAudience,
      issuer: options.issuer,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async verify(receipt: unknown): Promise<PersonProfileReceiptClaims> {
    try {
      const token = PersonProfileReceiptSchema.parse(receipt);
      const verified = await this.#verifier.verify(
        token,
        `${personProfileReceiptLifetimeSeconds}s`,
      );
      return PersonProfileReceiptClaimsSchema.parse(verified.payload);
    } catch (error) {
      if (error instanceof AccountJwksUnavailableError)
        throw new OpensteerError({
          code: "timeout",
          retryable: true,
          message: "Account keys are unavailable",
          cause: error,
        });
      throw new OpensteerError({
        cause: error,
        code: "unauthorized",
        message: "Name receipt is invalid or expired",
      });
    }
  }
}
