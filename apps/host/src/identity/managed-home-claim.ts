import { createHash, sign } from "node:crypto";
import {
  ManagedHomeClaimReceiptDocumentSchema,
  ManagedHomeClaimReceiptSchema,
  ManagedHomeClaimRequestSchema,
  managedHomeClaimPath,
  managedHomeClaimReceiptSigningBytes,
  type ManagedHomeClaimReceipt,
} from "@opensteer/control-plane-protocol";
import { OpensteerError, type HostInstanceId, type HostKeyFingerprint } from "@opensteer/core";
import type { IdentityService } from "@opensteer/identity";
import type { FastifyInstance } from "fastify";
import type { PersonalAccountGrantVerifier } from "../access/personal-account-grant-verifier.js";
import { unversionedRoute } from "../server/unversioned-route.js";
import { anonymousClientAddress } from "./anonymous-client-address.js";
import type { HostKeyPair } from "./host-keys.js";

/**
 * The Account-bound claim of an Opensteer Cloud Computer's Home: the setup code
 * the Account sealed at checkout, an Account-signed assertion naming the owner,
 * and the Account link credential the assertion pins. Every binding is this
 * Home's own: its deployment identity, canonical origin and claim generation.
 */
interface ManagedClaimTarget {
  readonly cloudComputerId: string;
  readonly generation: number;
}

export class ManagedHomeClaimService {
  readonly #identity: Pick<IdentityService, "claimManagedOwner">;
  readonly #verifier: Pick<PersonalAccountGrantVerifier, "issuer" | "verifyManagedHomeClaim">;
  readonly #managed: ManagedClaimTarget;
  readonly #authority: {
    readonly canonicalOrigin: string;
    readonly deploymentId: string;
    readonly hostInstanceId: HostInstanceId;
    readonly hostKeyFingerprint: HostKeyFingerprint;
  };
  readonly #keys: Pick<HostKeyPair, "privateKey" | "publicKey">;
  readonly #now: () => Date;

  constructor(options: {
    readonly identity: Pick<IdentityService, "claimManagedOwner">;
    readonly verifier: Pick<PersonalAccountGrantVerifier, "issuer" | "verifyManagedHomeClaim">;
    readonly managed: ManagedClaimTarget;
    readonly authority: {
      readonly canonicalOrigin: string;
      readonly deploymentId: string;
      readonly hostInstanceId: HostInstanceId;
      readonly hostKeyFingerprint: HostKeyFingerprint;
    };
    readonly keys: Pick<HostKeyPair, "privateKey" | "publicKey">;
    readonly now?: () => Date;
  }) {
    this.#identity = options.identity;
    this.#verifier = options.verifier;
    this.#managed = options.managed;
    this.#authority = options.authority;
    this.#keys = options.keys;
    this.#now = options.now ?? (() => new Date());
  }

  async claim(input: unknown): Promise<ManagedHomeClaimReceipt> {
    const request = ManagedHomeClaimRequestSchema.parse(input);
    const claims = await this.#verifier.verifyManagedHomeClaim(request.assertion);
    const authority = this.#authority;
    if (
      claims.authority.deploymentId !== authority.deploymentId ||
      claims.authority.hostInstanceId !== authority.hostInstanceId ||
      claims.authority.hostKeyFingerprint !== authority.hostKeyFingerprint ||
      claims.authority.canonicalOrigin !== authority.canonicalOrigin
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "This claim is for a different Home",
        reason: "managed-home-identity-mismatch",
      });
    if (
      claims.claim.cloudComputerId !== this.#managed.cloudComputerId ||
      claims.claim.generation !== this.#managed.generation
    )
      throw new OpensteerError({
        code: "conflict",
        message: "This claim is for another generation of this Cloud Computer",
        reason: "managed-home-generation-stale",
      });
    const credentialDigest = sha256(request.hostCredential);
    if (claims.link.hostCredentialSha256 !== credentialDigest)
      throw new OpensteerError({
        code: "forbidden",
        message: "The Account link credential does not match this claim",
        reason: "managed-home-link-mismatch",
      });
    const document = ManagedHomeClaimReceiptDocumentSchema.parse({
      purpose: "opensteer-managed-home-claim-receipt",
      documentVersion: 1,
      account: { issuer: this.#verifier.issuer, subject: claims.sub },
      authority,
      claim: claims.claim,
      linkGeneration: claims.link.generation,
      hostCredentialSha256: credentialDigest,
      claimedAt: this.#now().toISOString(),
    });
    const receipt = ManagedHomeClaimReceiptSchema.parse({
      document,
      publicKey: {
        algorithm: "Ed25519",
        spki: this.#keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      },
      signature: sign(
        null,
        managedHomeClaimReceiptSigningBytes(document),
        this.#keys.privateKey,
      ).toString("base64url"),
    });
    const result = await this.#identity.claimManagedOwner({
      claimKey: `${claims.claim.cloudComputerId}:${claims.claim.generation}:${claims.sub}`,
      cloudComputerId: claims.claim.cloudComputerId,
      issuer: this.#verifier.issuer,
      // The Home's Account link commits with its owner: push and the hosted
      // OAuth broker speak for this Home from the moment it is claimed.
      commit: async (transaction, existing) => {
        const now = this.#now();
        const generation = {
          grantId: claims.jti,
          hostCredential: request.hostCredential,
          linkGeneration: claims.link.generation,
          updatedAt: now,
        };
        if (existing) {
          await transaction
            .updateTable("personalRemoteAccountLink")
            .set(generation)
            .where("singletonKey", "=", "opensteer-account")
            .executeTakeFirstOrThrow();
          return;
        }
        await transaction
          .insertInto("personalRemoteAccountLink")
          .values({
            challengeId: claims.claim.cloudComputerId,
            ...generation,
            issuer: this.#verifier.issuer,
            linkedAt: now,
            singletonKey: "opensteer-account",
            state: "active",
            subject: claims.sub,
          })
          .executeTakeFirstOrThrow();
      },
      owner: claims.owner,
      receipt,
      setupCode: request.setupCode,
      subject: claims.sub,
    });
    const committed = ManagedHomeClaimReceiptSchema.parse(result.receipt);
    // The same claim again answers its first receipt only with the credential it installed.
    if (result.replayed && committed.document.hostCredentialSha256 !== credentialDigest)
      throw new OpensteerError({
        code: "conflict",
        message: "This Home was claimed with a different Account link credential",
        reason: "managed-home-link-mismatch",
      });
    return committed;
  }
}

export function registerManagedHomeClaimRoute(
  app: FastifyInstance,
  service: Pick<ManagedHomeClaimService, "claim">,
  admit: (address: string) => Promise<boolean>,
): void {
  // The Account calls this server to server; it states no Opensteer API version.
  app.post(
    managedHomeClaimPath,
    { bodyLimit: 32 * 1_024, config: unversionedRoute },
    async (request, reply) => {
      if (!(await admit(anonymousClientAddress(request))))
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Too many claim attempts; try again shortly",
          retryable: true,
        });
      return reply.header("cache-control", "no-store").send(await service.claim(request.body));
    },
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}
