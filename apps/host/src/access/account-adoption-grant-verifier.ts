import {
  DeploymentOriginSchema,
  HostAccountAdoptionCompletionGrantClaimsSchema,
  HostAccountAdoptionCompletionGrantSchema,
} from "@opensteer/control-plane-protocol";
import { OpensteerError } from "@opensteer/core";
import type {
  AccountAdoptionGrantVerifier,
  VerifiedAccountAdoptionGrant,
} from "@opensteer/identity";
import { RemoteAccountJwksVerifier } from "./account-jwks-verifier.js";

interface RemoteAccountAdoptionGrantVerifierOptions {
  readonly audience: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer: URL;
}

/**
 * Verifies Account adoption grants without trusting the provisioning bundle.
 * The default transport resolves DNS itself, rejects non-public addresses,
 * pins the connection to the checked address, refuses redirects, and bounds
 * both time and response bytes.
 */
export class RemoteAccountAdoptionGrantVerifier implements AccountAdoptionGrantVerifier {
  readonly #audience: string;
  readonly #issuer: string;
  readonly #verifier: RemoteAccountJwksVerifier;

  constructor(options: RemoteAccountAdoptionGrantVerifierOptions) {
    this.#issuer = publicHttpsOrigin(options.issuer).origin;
    this.#audience = DeploymentOriginSchema.parse(options.audience);
    this.#verifier = new RemoteAccountJwksVerifier({
      audience: this.#audience,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      issuer: new URL(this.#issuer),
    });
  }

  async verify(grant: unknown): Promise<VerifiedAccountAdoptionGrant> {
    try {
      const token = HostAccountAdoptionCompletionGrantSchema.parse(grant);
      const verified = await this.#verifier.verify(token, "5m");
      const claims = HostAccountAdoptionCompletionGrantClaimsSchema.parse(verified.payload);
      return {
        account: claims.account,
        authorizedBy: claims.proof.authorizedBy,
        consumedAt: new Date(claims.proof.consumedAt),
        deployment: claims.authority,
        expiresAt: new Date(claims.exp * 1_000),
        grantId: claims.jti,
        issuedAt: new Date(claims.iat * 1_000),
        proofId: claims.proof.id,
      };
    } catch (error) {
      throw new OpensteerError({
        cause: error,
        code: "forbidden",
        message: "Account attachment grant is invalid or expired",
      });
    }
  }
}

function publicHttpsOrigin(input: URL): URL {
  const url = new URL(input.toString());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Opensteer Account adoption requires a bare public HTTPS issuer");
  }
  return url;
}
