import { createPublicHttpsFetch } from "@opensteer/access/host";
import {
  ConsumeHostAccountAdoptionProofRequestSchema,
  ConsumeHostAccountAdoptionProofResponseSchema,
  type ConsumeHostAccountAdoptionProofResponse,
  type HostAccountAdoptionAuthority,
  type HostAccountAdoptionProofCredential,
  type HostAccountAdoptionProofId,
  type HostAccountIdentity,
} from "@opensteer/control-plane-protocol";

export interface HostAccountAdoptionProofVerification {
  readonly proofId: HostAccountAdoptionProofId;
  readonly proofCredential: HostAccountAdoptionProofCredential;
  readonly account: HostAccountIdentity;
  readonly authority: HostAccountAdoptionAuthority;
}

export interface HostAccountAdoptionProofVerifier {
  verify(
    input: HostAccountAdoptionProofVerification,
  ): Promise<ConsumeHostAccountAdoptionProofResponse>;
}

interface HttpHostAccountAdoptionProofVerifierOptions {
  readonly fetch?: typeof globalThis.fetch;
}

/** Consumes a Host-admin-issued proof at the exact canonical Host origin. */
export class HttpHostAccountAdoptionProofVerifier implements HostAccountAdoptionProofVerifier {
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpHostAccountAdoptionProofVerifierOptions = {}) {
    this.#fetch =
      options.fetch ?? createPublicHttpsFetch({ maxResponseBytes: 64 * 1_024, timeoutMs: 10_000 });
  }

  async verify(
    input: HostAccountAdoptionProofVerification,
  ): Promise<ConsumeHostAccountAdoptionProofResponse> {
    const origin = new URL(input.authority.canonicalOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("Host adoption requires a public HTTPS canonical origin");
    }
    const requestBody = ConsumeHostAccountAdoptionProofRequestSchema.parse({
      proofCredential: input.proofCredential,
      expectedAccount: input.account,
      expectedAuthority: input.authority,
    });
    const endpoint = new URL(
      `/v1/auth/account-adoption/proofs/${encodeURIComponent(input.proofId)}/consume`,
      origin,
    );
    const response = await this.#fetch(endpoint, {
      body: JSON.stringify(requestBody),
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "manual",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok || response.status !== 200) {
      throw new Error("Host adoption proof was rejected");
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      throw new Error("Host adoption proof response must be application/json");
    }
    const receipt = ConsumeHostAccountAdoptionProofResponseSchema.parse(await response.json());
    if (
      receipt.proofId !== input.proofId ||
      receipt.account.issuer !== input.account.issuer ||
      receipt.account.subject !== input.account.subject ||
      receipt.authority.deploymentId !== input.authority.deploymentId ||
      receipt.authority.hostInstanceId !== input.authority.hostInstanceId ||
      receipt.authority.canonicalOrigin !== input.authority.canonicalOrigin ||
      receipt.authority.hostKeyFingerprint !== input.authority.hostKeyFingerprint
    ) {
      throw new Error("Host adoption proof receipt does not match the requested authority");
    }
    return receipt;
  }
}
