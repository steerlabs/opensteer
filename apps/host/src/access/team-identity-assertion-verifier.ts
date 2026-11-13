import {
  TeamIdentityAssertionClaimsSchema,
  TeamIdentityAssertionSchema,
  teamIdentityGrantLifetimeSeconds,
  type TeamIdentityAssertionClaims,
} from "@opensteer/control-plane-protocol";
import { OpensteerError } from "@opensteer/core";
import type { TeamIdentityAssertionVerifier } from "@opensteer/identity";
import { RemoteAccountJwksVerifier } from "./account-jwks-verifier.js";

/**
 * Verifies an Account team identity assertion against Account's published keys. The issuer is
 * this Host's Account configuration and the audience its own canonical origin, never values read
 * from the token.
 */
export class RemoteTeamIdentityAssertionVerifier implements TeamIdentityAssertionVerifier {
  readonly #verifier: RemoteAccountJwksVerifier;

  constructor(options: {
    readonly audience: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly issuer: URL;
  }) {
    this.#verifier = new RemoteAccountJwksVerifier(options);
  }

  async verify(assertion: unknown): Promise<TeamIdentityAssertionClaims> {
    try {
      const token = TeamIdentityAssertionSchema.parse(assertion);
      const verified = await this.#verifier.verify(token, `${teamIdentityGrantLifetimeSeconds}s`);
      return TeamIdentityAssertionClaimsSchema.parse(verified.payload);
    } catch (error) {
      throw new OpensteerError({
        cause: error,
        code: "unauthorized",
        message: "Account identity assertion is invalid or expired",
        reason: "assertion-invalid",
      });
    }
  }
}
