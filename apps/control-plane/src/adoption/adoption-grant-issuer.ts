import {
  HostAccountAdoptionCompletionGrantClaimsSchema,
  HostAccountAdoptionCompletionGrantSchema,
  type ConsumeHostAccountAdoptionProofResponse,
  type HostAccountAdoptionCompletionGrant,
} from "@opensteer/control-plane-protocol";
import type { ControlPlaneAuth } from "../auth/auth.js";

const completionGrantLifetimeSeconds = 5 * 60;

export interface HostAccountAdoptionCompletionGrantIssuer {
  issue(
    receipt: ConsumeHostAccountAdoptionProofResponse,
  ): Promise<HostAccountAdoptionCompletionGrant>;
}

/** Signs one exact Host receipt with the rotating Better Auth Account key. */
export class BetterAuthAccountAdoptionCompletionGrantIssuer implements HostAccountAdoptionCompletionGrantIssuer {
  readonly #auth: ControlPlaneAuth;
  readonly #issuer: string;

  constructor(auth: ControlPlaneAuth, issuer: URL) {
    this.#auth = auth;
    this.#issuer = issuer.origin;
  }

  async issue(
    receipt: ConsumeHostAccountAdoptionProofResponse,
  ): Promise<HostAccountAdoptionCompletionGrant> {
    if (receipt.account.issuer !== this.#issuer) {
      throw new Error("Host adoption receipt belongs to a different Account issuer");
    }
    const issuedAt = Math.floor(Date.now() / 1_000);
    const claims = HostAccountAdoptionCompletionGrantClaimsSchema.parse({
      account: receipt.account,
      aud: receipt.authority.canonicalOrigin,
      authority: receipt.authority,
      exp: issuedAt + completionGrantLifetimeSeconds,
      iat: issuedAt,
      iss: this.#issuer,
      jti: `hag_${crypto.randomUUID()}`,
      proof: {
        authorizedBy: receipt.authorizedBy,
        consumedAt: receipt.consumedAt,
        id: receipt.proofId,
      },
      sub: receipt.account.subject,
      tokenUse: "opensteer-host-account-adoption",
    });
    const { token } = await this.#auth.api.signJWT({ body: { payload: claims } });
    return HostAccountAdoptionCompletionGrantSchema.parse(token);
  }
}
