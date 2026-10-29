import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  AccountLinkGenerationSchema,
  ActivatePersonalHostAccountLinkRequestSchema,
  ActivatePersonalHostAccountLinkResponseSchema,
  CancelPersonalHostAccountLinkOperationRequestSchema,
  CancelPersonalHostAccountLinkOperationResponseSchema,
  CompletePersonalHostAccountLinkRequestSchema,
  CompletePersonalHostAccountLinkResponseSchema,
  ControlPlaneAccountIdSchema,
  AccountHostSessionGrantClaimsSchema,
  AccountHostSessionGrantSchema,
  IssueAccountHostSessionGrantResponseSchema,
  IssuePersonalAccountHostSessionGrantRequestSchema,
  IssuePersonalHostAccountLinkChallengeRequestSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteEnvelopeSchema,
  PersonalHostAccountLinkChallengeIdSchema,
  PersonalHostAccountLinkCompletionGrantClaimsSchema,
  PersonalHostAccountLinkCompletionGrantSchema,
  UnlinkPersonalHostRequestSchema,
  UnlinkPersonalHostResponseSchema,
  accountHostSessionGrantLifetimeSeconds,
  personalHostAccessRouteEnvelopeSha256,
  type CompletePersonalHostAccountLinkRequest,
  type CompletePersonalHostAccountLinkResponse,
  type ActivatePersonalHostAccountLinkRequest,
  type ActivatePersonalHostAccountLinkResponse,
  type CancelPersonalHostAccountLinkOperationRequest,
  type ControlPlaneAccountId,
  type IssuePersonalHostAccountLinkChallengeRequest,
  type IssuePersonalHostAccountLinkChallengeResponse,
  type IssueAccountHostSessionGrantResponse,
  type IssuePersonalAccountHostSessionGrantRequest,
  type PersonalHostAccountLinkChallengeId,
  type UnlinkPersonalHostRequest,
} from "@opensteer/control-plane-protocol";
import { type Kysely, type Transaction } from "kysely";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  hostAuthorityIdentityMatches,
  hostKeyFingerprint,
  isSameHost,
  sameDiscoveryDocument,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import type { ControlPlaneAuth } from "../auth/auth.js";
import { createHostCredential, hashCredential } from "../auth/credentials.js";
import { ControlPlaneError } from "../server/errors.js";
import type {
  ControlPlaneDatabaseSchema,
  PersonalHostAccountLinkChallengeRow,
} from "../database/schema.js";
import { PersonalAccountLinkOperationCipher } from "./personal-account-link-operation-crypto.js";
import {
  personalHostAccountLinkProofSha256,
  verifyPersonalHostAccessRoute,
  verifyPersonalHostAccountLinkProof,
} from "./personal-host-proof.js";
import {
  lockAccountDeploymentCapacity,
  requireAccountDeploymentCapacity,
} from "./account-deployment-capacity.js";
import { lockConnectSession, lockDeploymentIdentity } from "../database/advisory-locks.js";

const challengeLifetimeMilliseconds = 5 * 60 * 1_000;
const resultLifetimeMilliseconds = 24 * 60 * 60 * 1_000;
const tombstoneLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const completionGrantLifetimeSeconds = 5 * 60;
const maximumClockSkewMilliseconds = 30_000;

interface PersonalAccountLinkPurgeResult {
  /** Live operations moved to `expired` because their deadline passed. */
  readonly expired: number;
  /** Tombstones deleted because no client can still reach them. */
  readonly purged: number;
}

/**
 * Account-side authority for linking an already-running Personal Host and for
 * minting short-lived, Host-consumed remote session capabilities.
 */
export class PersonalRemoteAccountService {
  readonly #auth: ControlPlaneAuth;
  readonly #cipher: PersonalAccountLinkOperationCipher;
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;
  readonly #issuer: string;

  constructor(input: {
    readonly auth: ControlPlaneAuth;
    readonly database: Kysely<ControlPlaneDatabaseSchema>;
    readonly issuer: URL;
    readonly operationCipher: PersonalAccountLinkOperationCipher;
  }) {
    this.#auth = input.auth;
    this.#database = input.database;
    this.#issuer = input.issuer.origin;
    this.#cipher = input.operationCipher;
  }

  async issueLinkChallenge(
    ownerAccountIdInput: ControlPlaneAccountId,
    requestInput: IssuePersonalHostAccountLinkChallengeRequest,
  ): Promise<IssuePersonalHostAccountLinkChallengeResponse> {
    const ownerAccountId = ControlPlaneAccountIdSchema.parse(ownerAccountIdInput);
    const request = IssuePersonalHostAccountLinkChallengeRequestSchema.parse(requestInput);
    const authorityEnvelope = request.authorityEnvelope;
    const authority = PersonalHostAccessAuthoritySchema.parse(
      verifyHostDiscoveryEnvelope(authorityEnvelope),
    );
    const authorityFingerprint = hostKeyFingerprint(authorityEnvelope.publicKey.spki);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + challengeLifetimeMilliseconds);
    const challengeId = PersonalHostAccountLinkChallengeIdSchema.parse(
      `phc_${crypto.randomUUID()}`,
    );
    const challengeCredential = `olc_${randomBytes(32).toString("base64url")}` as const;
    const response = IssuePersonalHostAccountLinkChallengeResponseSchema.parse({
      account: { issuer: this.#issuer, subject: ownerAccountId },
      authorityEnvelope,
      challengeCredential,
      challengeId,
      expiresAt: expiresAt.toISOString(),
    });
    let issued = response;
    try {
      issued = await this.#database.transaction().execute(async (transaction) => {
        await lockAccountDeploymentCapacity(transaction, ownerAccountId);
        await requireAccount(transaction, ownerAccountId);
        const staleAuthorityReservations = await transaction
          .selectFrom("personalHostAccountLinkChallenges")
          .selectAll()
          .where("state", "in", ["pending", "reserved"])
          .where((builder) =>
            builder.or([
              builder("reservedDeploymentId", "=", authority.deploymentId),
              builder("reservedHostInstanceId", "=", authority.hostInstanceId),
              builder("reservedHostKeyFingerprint", "=", authorityFingerprint),
            ]),
          )
          // Deterministic row order so two concurrent issues that sweep the
          // same authority aliases queue instead of deadlocking.
          .orderBy("challengeId")
          .forNoKeyUpdate()
          .execute();
        for (const stale of staleAuthorityReservations) {
          if (
            (stale.state === "pending" && stale.challengeExpiresAt <= now) ||
            (stale.state === "reserved" &&
              stale.resultExpiresAt !== null &&
              stale.resultExpiresAt <= now)
          ) {
            await this.#expireChallenge(transaction, stale, now);
          }
        }
        const existing = await transaction
          .selectFrom("personalHostAccountLinkChallenges")
          .selectAll()
          .where("ownerAccountId", "=", ownerAccountId)
          .where("operationId", "=", request.operationId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (existing) {
          const storedAuthority = HostDiscoveryEnvelopeSchema.parse(existing.authority);
          const sameRequest =
            existing.name === request.name &&
            isSameHost(storedAuthority, authorityEnvelope) &&
            sameDiscoveryDocument(storedAuthority.document, authorityEnvelope.document);
          // An operation ID is minted per attempt, so the only legitimate reuse
          // is one client retrying the exact issue whose response it lost.
          if (
            !sameRequest ||
            existing.state !== "pending" ||
            existing.challengeExpiresAt <= now ||
            !existing.sealedIssue
          ) {
            throw new ControlPlaneError("conflict", "Account-link operation ID was already used");
          }
          return this.#cipher.openIssue(request.operationId, existing.sealedIssue);
        }
        await requirePersonalDeploymentAvailable(transaction, authority, authorityFingerprint);
        // The Account may already hold this Host's authority under a different
        // operation, because its client lost the journal that names that
        // operation. The Account supersedes its own stale attempt instead of
        // locking itself out until the challenge expires. Another Account's
        // live attempt still wins.
        const live = await liveAuthorityChallenges(transaction, authority, authorityFingerprint);
        if (live.some((stale) => stale.ownerAccountId !== ownerAccountId)) {
          throw new ControlPlaneError("conflict", "Personal Host already has an active challenge", {
            reason: "personal-host-already-linked",
          });
        }
        for (const stale of live) {
          await transaction
            .updateTable("personalHostAccountLinkChallenges")
            .set({ sealedIssue: null, sealedResult: null, state: "cancelled", updatedAt: now })
            .where("challengeId", "=", stale.challengeId)
            .where("state", "in", ["pending", "reserved"])
            .executeTakeFirstOrThrow();
        }
        // Counted after the supersede so the slot the stale attempt held is
        // already free for the attempt that replaces it.
        await requireAccountDeploymentCapacity(transaction, ownerAccountId, { now });
        await transaction
          .insertInto("personalHostAccountLinkChallenges")
          .values({
            activatedAt: null,
            authority: authorityEnvelope,
            challengeExpiresAt: expiresAt,
            challengeId,
            createdAt: now,
            credentialHash: hashCredential(challengeCredential),
            hostCredentialHash: null,
            linkGeneration: null,
            name: request.name,
            ownerAccountId,
            operationId: request.operationId,
            proofFingerprint: null,
            reservedDeploymentId: authority.deploymentId,
            reservedHostInstanceId: authority.hostInstanceId,
            reservedHostKeyFingerprint: authorityFingerprint,
            resultExpiresAt: null,
            sealedResult: null,
            sealedIssue: this.#cipher.sealIssue(request.operationId, response),
            state: "pending",
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
        return response;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ControlPlaneError("conflict", "Personal Host already has an active challenge", {
          reason: "personal-host-already-linked",
        });
      }
      throw error;
    }
    return issued;
  }

  async completeLink(
    ownerAccountIdInput: ControlPlaneAccountId,
    requestInput: CompletePersonalHostAccountLinkRequest,
  ): Promise<CompletePersonalHostAccountLinkResponse> {
    const ownerAccountId = ControlPlaneAccountIdSchema.parse(ownerAccountIdInput);
    const request = CompletePersonalHostAccountLinkRequestSchema.parse(requestInput);
    const challengeId = request.proof.document.challenge.id;
    const requestFingerprint = personalHostAccountLinkProofSha256(request.proof);
    return this.#database.transaction().execute(async (transaction) => {
      await lockAccountDeploymentCapacity(transaction, ownerAccountId);
      await requireAccount(transaction, ownerAccountId);
      const challenge = await transaction
        .selectFrom("personalHostAccountLinkChallenges")
        .selectAll()
        .where("challengeId", "=", challengeId)
        .where("ownerAccountId", "=", ownerAccountId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!challenge) throw new ControlPlaneError("not_found", "Account-link challenge not found");
      requireChallengeCredential(challenge, request.challengeCredential);
      if (challenge.state === "reserved") {
        if (challenge.proofFingerprint !== requestFingerprint || !challenge.sealedResult) {
          throw new ControlPlaneError(
            "conflict",
            "Account-link challenge was already used with a different proof",
          );
        }
        if (!challenge.resultExpiresAt || challenge.resultExpiresAt <= new Date()) {
          throw new ControlPlaneError("conflict", "Account-link result has expired", {
            reason: "personal-account-link-reservation-expired",
          });
        }
        const stored = this.#cipher.open(challengeId, challenge.sealedResult);
        const authorityEnvelope = HostDiscoveryEnvelopeSchema.parse(challenge.authority);
        const authority = PersonalHostAccessAuthoritySchema.parse(
          verifyHostDiscoveryEnvelope(authorityEnvelope),
        );
        const refreshed = CompletePersonalHostAccountLinkResponseSchema.parse({
          ...stored,
          completionGrant: await this.#issueCompletionGrant(
            ownerAccountId,
            challengeId,
            authority,
            stored.linkGeneration,
            new Date(),
          ),
        });
        await transaction
          .updateTable("personalHostAccountLinkChallenges")
          .set({ sealedResult: this.#cipher.seal(challengeId, refreshed), updatedAt: new Date() })
          .where("challengeId", "=", challengeId)
          .where("state", "=", "reserved")
          .executeTakeFirstOrThrow();
        return refreshed;
      }
      if (challenge.state !== "pending") {
        throw new ControlPlaneError("conflict", "Account-link challenge is no longer usable");
      }
      const now = new Date();
      if (challenge.challengeExpiresAt <= now) {
        throw new ControlPlaneError("conflict", "Account-link challenge has expired", {
          reason: "personal-account-link-challenge-expired",
        });
      }
      const authorityEnvelope = HostDiscoveryEnvelopeSchema.parse(challenge.authority);
      const authority = PersonalHostAccessAuthoritySchema.parse(
        verifyHostDiscoveryEnvelope(authorityEnvelope),
      );
      const proof = verifyPersonalHostAccountLinkProof(request.proof);
      assertLinkProof({
        authority,
        challenge,
        credential: request.challengeCredential,
        issuer: this.#issuer,
        now,
        ownerAccountId,
        proof,
      });
      await requireAccountDeploymentCapacity(transaction, ownerAccountId, {
        excludingPersonalChallengeId: challengeId,
        now,
      });
      await requirePersonalAuthorityAvailable(
        transaction,
        authority,
        hostKeyFingerprint(authorityEnvelope.publicKey.spki),
        challengeId,
      );

      const hostCredential = createHostCredential();
      const linkGeneration = AccountLinkGenerationSchema.parse(
        randomBytes(32).toString("base64url"),
      );
      const resultExpiresAt = new Date(now.getTime() + resultLifetimeMilliseconds);
      const completionGrant = await this.#issueCompletionGrant(
        ownerAccountId,
        challengeId,
        authority,
        linkGeneration,
        now,
      );
      const response = CompletePersonalHostAccountLinkResponseSchema.parse({
        completionGrant,
        hostCredential,
        linkGeneration,
        resultExpiresAt: resultExpiresAt.toISOString(),
      });
      await transaction
        .updateTable("personalHostAccountLinkChallenges")
        .set({
          proofFingerprint: requestFingerprint,
          hostCredentialHash: hashCredential(hostCredential),
          linkGeneration,
          resultExpiresAt,
          sealedResult: this.#cipher.seal(challengeId, response),
          sealedIssue: null,
          state: "reserved",
          updatedAt: now,
        })
        .where("challengeId", "=", challengeId)
        .where("state", "=", "pending")
        .executeTakeFirstOrThrow();
      return response;
    });
  }

  async cancelLinkOperation(
    ownerAccountIdInput: ControlPlaneAccountId,
    requestInput: CancelPersonalHostAccountLinkOperationRequest,
  ) {
    const ownerAccountId = ControlPlaneAccountIdSchema.parse(ownerAccountIdInput);
    const request = CancelPersonalHostAccountLinkOperationRequestSchema.parse(requestInput);
    return this.#database.transaction().execute(async (transaction) => {
      await lockAccountDeploymentCapacity(transaction, ownerAccountId);
      await requireAccount(transaction, ownerAccountId);
      const operation = await transaction
        .selectFrom("personalHostAccountLinkChallenges")
        .selectAll()
        .where("ownerAccountId", "=", ownerAccountId)
        .where("operationId", "=", request.operationId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!operation) {
        throw new ControlPlaneError("not_found", "Account-link operation was not found", {
          reason: "personal-account-link-not-found",
        });
      }
      if (operation.state === "activated") {
        throw new ControlPlaneError(
          "conflict",
          "An active Personal Host link must be removed by the Host",
          { reason: "personal-account-link-already-active" },
        );
      }
      if (!["cancelled", "unlinked"].includes(operation.state)) {
        await transaction
          .updateTable("personalHostAccountLinkChallenges")
          .set({
            sealedIssue: null,
            sealedResult: null,
            state: "cancelled",
            updatedAt: new Date(),
          })
          .where("challengeId", "=", operation.challengeId)
          .where("state", "in", ["pending", "reserved", "expired"])
          .executeTakeFirstOrThrow();
      }
      return CancelPersonalHostAccountLinkOperationResponseSchema.parse({
        cancelled: true,
        operationId: request.operationId,
      });
    });
  }

  async activateLink(
    authorization: string | undefined,
    requestInput: ActivatePersonalHostAccountLinkRequest,
  ): Promise<ActivatePersonalHostAccountLinkResponse> {
    const request = ActivatePersonalHostAccountLinkRequestSchema.parse(requestInput);
    try {
      return await this.#activateLink(authorization, request);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ControlPlaneError("conflict", "Personal Host authority is already registered", {
          reason: "personal-host-already-linked",
        });
      }
      throw error;
    }
  }

  async #activateLink(
    authorization: string | undefined,
    request: ActivatePersonalHostAccountLinkRequest,
  ): Promise<ActivatePersonalHostAccountLinkResponse> {
    return this.#database.transaction().execute(async (transaction) => {
      const credentialHash = requireHostCredentialHash(authorization);
      // Unlocked read of two immutable columns, used only to derive the lock
      // keys in the global order below. Everything is re-read under those locks.
      const candidate = await transaction
        .selectFrom("personalHostAccountLinkChallenges")
        .select(["ownerAccountId", "reservedDeploymentId"])
        .where("challengeId", "=", request.challengeId)
        .executeTakeFirst();
      if (!candidate) throw personalLinkNotFound();
      await lockAccountDeploymentCapacity(transaction, candidate.ownerAccountId);
      // Adoption and managed registration take this same key before claiming a
      // Deployment identity, so activation cannot interleave with either.
      await lockDeploymentIdentity(transaction, candidate.reservedDeploymentId);
      const challenge = await transaction
        .selectFrom("personalHostAccountLinkChallenges")
        .selectAll()
        .where("challengeId", "=", request.challengeId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !challenge ||
        !credentialHashMatches(challenge.hostCredentialHash, credentialHash) ||
        challenge.linkGeneration !== request.linkGeneration
      ) {
        throw personalLinkNotFound();
      }
      const authorityEnvelope = HostDiscoveryEnvelopeSchema.parse(challenge.authority);
      const authority = PersonalHostAccessAuthoritySchema.parse(
        verifyHostDiscoveryEnvelope(authorityEnvelope),
      );
      if (challenge.state === "activated") {
        const deployment = await transaction
          .selectFrom("deployments")
          .innerJoin(
            "deploymentCredentials",
            "deploymentCredentials.deploymentId",
            "deployments.id",
          )
          .select(["deployments.lifecycle", "deploymentCredentials.tokenHash"])
          .where("deployments.id", "=", authority.deploymentId)
          .executeTakeFirst();
        if (deployment?.lifecycle !== "active" || deployment.tokenHash !== credentialHash) {
          throw new ControlPlaneError("conflict", "Account-link activation state is inconsistent");
        }
        return ActivatePersonalHostAccountLinkResponseSchema.parse({
          activated: true,
          deploymentId: authority.deploymentId,
          linkGeneration: request.linkGeneration,
        });
      }
      if (challenge.state === "cancelled" || challenge.state === "unlinked") {
        throw new ControlPlaneError(
          "conflict",
          challenge.state === "unlinked"
            ? "Account-link was already removed by this Host"
            : "Account-link reservation was cancelled",
          { reason: "personal-account-link-cancelled" },
        );
      }
      if (
        challenge.state !== "reserved" ||
        !challenge.resultExpiresAt ||
        challenge.resultExpiresAt <= new Date()
      ) {
        throw new ControlPlaneError("conflict", "Account-link reservation has expired", {
          reason: "personal-account-link-reservation-expired",
        });
      }
      const now = new Date();
      await requireAccountDeploymentCapacity(transaction, challenge.ownerAccountId, {
        excludingPersonalChallengeId: challenge.challengeId,
        now,
      });
      const authorityFingerprint = hostKeyFingerprint(authorityEnvelope.publicKey.spki);
      await requirePersonalAuthorityAvailable(
        transaction,
        authority,
        authorityFingerprint,
        challenge.challengeId,
      );
      await transaction
        .insertInto("deployments")
        .values({
          activeHostInstanceId: authority.hostInstanceId,
          accountLink: {
            generation: request.linkGeneration,
            issuer: this.#issuer,
            subject: challenge.ownerAccountId,
          },
          authorityEnvelope,
          canonicalOrigin: authority.canonicalOrigin,
          createdAt: now,
          directoryGeneration: 1,
          hostKeyFingerprint: authorityFingerprint,
          reachability: "routed",
          id: authority.deploymentId,
          lifecycle: "active",
          name: challenge.name,
          oidcClientId: null,
          ownerAccountId: challenge.ownerAccountId,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("deploymentCredentials")
        .values({
          createdAt: now,
          deploymentId: authority.deploymentId,
          rotatedAt: now,
          tokenHash: credentialHash,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("deploymentConnect")
        .values({
          accessRoute: null,
          deploymentId: authority.deploymentId,
          generation: 0,
          observedAt: null,
          origin: null,
          state: "disabled",
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("deploymentDirectoryEntries")
        .values({
          accountId: challenge.ownerAccountId,
          deploymentId: authority.deploymentId,
          generation: 1,
          observedAt: now,
          present: true,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("personalHostAccountLinkChallenges")
        .set({
          activatedAt: now,
          sealedResult: null,
          state: "activated",
          updatedAt: now,
        })
        .where("challengeId", "=", challenge.challengeId)
        .where("state", "=", "reserved")
        .executeTakeFirstOrThrow();
      return ActivatePersonalHostAccountLinkResponseSchema.parse({
        activated: true,
        deploymentId: authority.deploymentId,
        linkGeneration: request.linkGeneration,
      });
    });
  }

  async unlinkPersonalHost(
    authorization: string | undefined,
    requestInput: UnlinkPersonalHostRequest,
  ) {
    const request = UnlinkPersonalHostRequestSchema.parse(requestInput);
    const credentialHash = requireHostCredentialHash(authorization);
    return this.#database.transaction().execute(async (transaction) => {
      // Unlocked read of one immutable column, used only to derive the Connect
      // session key. Connect provisioning commits its resource row while
      // holding that lock across the Cloudflare call, so taking it before any
      // row lock is what makes "no live tunnel" a fact rather than a guess —
      // and it keeps this transaction from ever waiting on an advisory lock
      // while already holding a row lock.
      const reserved = await transaction
        .selectFrom("personalHostAccountLinkChallenges")
        .select("reservedDeploymentId")
        .where("challengeId", "=", request.challengeId)
        .executeTakeFirst();
      if (!reserved) throw personalLinkNotFound();
      await lockConnectSession(transaction, reserved.reservedDeploymentId);
      const challenge = await transaction
        .selectFrom("personalHostAccountLinkChallenges")
        .selectAll()
        .where("challengeId", "=", request.challengeId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !challenge ||
        !credentialHashMatches(challenge.hostCredentialHash, credentialHash) ||
        challenge.linkGeneration !== request.linkGeneration
      ) {
        throw personalLinkNotFound();
      }
      // Only `pending` rows carry a null Host credential, and those already
      // failed the fence above. Every remaining state is removable here.
      if (challenge.state === "activated") {
        const deployment = await transaction
          .selectFrom("deployments")
          .innerJoin(
            "deploymentCredentials",
            "deploymentCredentials.deploymentId",
            "deployments.id",
          )
          .select([
            "deployments.reachability",
            "deployments.lifecycle",
            "deploymentCredentials.tokenHash",
          ])
          .where("deployments.id", "=", challenge.reservedDeploymentId)
          // FOR UPDATE: Unlink deletes this deployment.
          .forUpdate("deployments")
          .executeTakeFirst();
        if (
          !deployment ||
          deployment.reachability !== "routed" ||
          deployment.lifecycle !== "active" ||
          deployment.tokenHash !== credentialHash
        ) {
          throw new ControlPlaneError("forbidden", "Personal Host authority fence is stale");
        }
        const connectResource = await transaction
          .selectFrom("deploymentConnectResources")
          .select("state")
          .where("deploymentId", "=", challenge.reservedDeploymentId)
          // FOR UPDATE: Deleting the deployment cascades to this Connect resource.
          .forUpdate()
          .executeTakeFirst();
        if (connectResource && connectResource.state !== "revoked") {
          throw new ControlPlaneError("conflict", "Revoke the Connect resource before unlinking", {
            reason: "connect-resource-active",
          });
        }
        await transaction
          .deleteFrom("deployments")
          .where("id", "=", challenge.reservedDeploymentId)
          .executeTakeFirstOrThrow();
      }
      const now = new Date();
      if (challenge.state !== "cancelled" && challenge.state !== "unlinked") {
        await transaction
          .updateTable("personalHostAccountLinkChallenges")
          .set({
            sealedIssue: null,
            sealedResult: null,
            // A Host that removes its own live link leaves a distinct
            // tombstone from an Account-side cancellation of a reservation.
            state: challenge.state === "activated" ? "unlinked" : "cancelled",
            updatedAt: now,
          })
          .where("challengeId", "=", challenge.challengeId)
          .executeTakeFirstOrThrow();
      }
      return UnlinkPersonalHostResponseSchema.parse({
        deploymentId: challenge.reservedDeploymentId,
        unlinked: true,
      });
    });
  }

  async issueSessionGrant(
    ownerAccountIdInput: ControlPlaneAccountId,
    deploymentIdInput: DeploymentId,
    requestInput: IssuePersonalAccountHostSessionGrantRequest,
  ): Promise<IssueAccountHostSessionGrantResponse> {
    const ownerAccountId = ControlPlaneAccountIdSchema.parse(ownerAccountIdInput);
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const request = IssuePersonalAccountHostSessionGrantRequestSchema.parse(requestInput);
    const expectedRoute = verifyPersonalHostAccessRoute(request.expectedRoute);
    if (!sameDiscoveryDocument(request.expectedAuthority, expectedRoute.document.authority)) {
      throw new ControlPlaneError("conflict", "Expected authority does not match the route");
    }
    const current = await this.#database
      .selectFrom("deployments")
      .innerJoin("deploymentConnect", "deploymentConnect.deploymentId", "deployments.id")
      .innerJoin(
        "deploymentDirectoryEntries",
        "deploymentDirectoryEntries.deploymentId",
        "deployments.id",
      )
      .select([
        "deployments.id as id",
        "deployments.ownerAccountId as ownerAccountId",
        "deployments.reachability as reachability",
        "deployments.lifecycle as lifecycle",
        "deployments.activeHostInstanceId as hostInstanceId",
        "deployments.canonicalOrigin as canonicalOrigin",
        "deployments.hostKeyFingerprint as hostKeyFingerprint",
        "deploymentConnect.state as connectState",
        "deploymentConnect.origin as connectOrigin",
        "deploymentConnect.generation as connectGeneration",
        "deploymentConnect.accessRoute as accessRoute",
        "deploymentDirectoryEntries.accountId as directoryAccountId",
        "deploymentDirectoryEntries.present as directoryPresent",
      ])
      .where("deployments.id", "=", request.expectedAuthority.deploymentId)
      .where("deployments.id", "=", deploymentId)
      .where("deployments.ownerAccountId", "=", ownerAccountId)
      .where("deploymentDirectoryEntries.accountId", "=", ownerAccountId)
      .executeTakeFirst();
    if (!current) throw new ControlPlaneError("not_found", "Personal Host was not found");
    if (
      current.reachability !== "routed" ||
      current.lifecycle !== "active" ||
      !current.directoryPresent
    ) {
      throw new ControlPlaneError("forbidden", "Personal Host remote access is unavailable");
    }
    assertStoredAuthority(
      current,
      request.expectedAuthority,
      hostKeyFingerprint(expectedRoute.publicKey.spki),
    );
    if (!current.accessRoute || !["ready", "offline"].includes(current.connectState)) {
      throw new ControlPlaneError("conflict", "Opensteer Connect is not enabled");
    }
    const storedRoute = PersonalHostAccessRouteEnvelopeSchema.parse(current.accessRoute);
    verifyPersonalHostAccessRoute(storedRoute);
    if (
      personalHostAccessRouteEnvelopeSha256(storedRoute) !==
        personalHostAccessRouteEnvelopeSha256(expectedRoute) ||
      current.connectOrigin !== expectedRoute.document.route.origin ||
      Number(current.connectGeneration) !== expectedRoute.document.route.generation
    ) {
      throw new ControlPlaneError("conflict", "Opensteer Connect route is stale");
    }
    const issuedAt = Math.floor(Date.now() / 1_000);
    const expiresAt = issuedAt + accountHostSessionGrantLifetimeSeconds;
    const claims = AccountHostSessionGrantClaimsSchema.parse({
      account: { issuer: this.#issuer, subject: ownerAccountId },
      aud: request.expectedAuthority.canonicalOrigin,
      authority: request.expectedAuthority,
      clientSurface: request.clientSurface,
      deploymentId,
      exp: expiresAt,
      iat: issuedAt,
      iss: this.#issuer,
      jti: `ahs_${crypto.randomUUID()}`,
      personalHostAccessRouteEnvelopeSha256: personalHostAccessRouteEnvelopeSha256(expectedRoute),
      ...(request.portalOrigin ? { portalOrigin: request.portalOrigin } : {}),
      route: expectedRoute.document,
      routeGeneration: expectedRoute.document.route.generation,
      sub: ownerAccountId,
      targetKind: "personal-connect",
      tokenUse: "opensteer-account-host-session",
    });
    const { token } = await this.#auth.api.signJWT({ body: { payload: claims } });
    return IssueAccountHostSessionGrantResponseSchema.parse({
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
      grant: AccountHostSessionGrantSchema.parse(token),
    });
  }

  /**
   * Expires abandoned operations, then removes tombstones no client can still
   * reach. The two counts stay separate: they answer different questions and
   * summing them hid both.
   */
  async purgeExpired(now = new Date()): Promise<PersonalAccountLinkPurgeResult> {
    return this.#database.transaction().execute(async (transaction) => {
      const expired = await this.#expireChallenges(transaction, now);
      const cutoff = new Date(now.getTime() - tombstoneLifetimeMilliseconds);
      const deleted = await transaction
        .deleteFrom("personalHostAccountLinkChallenges")
        .where("state", "in", ["cancelled", "expired", "unlinked"])
        .where("updatedAt", "<=", cutoff)
        .executeTakeFirst();
      return { expired, purged: Number(deleted.numDeletedRows) };
    });
  }

  async #expireChallenges(
    transaction: Transaction<ControlPlaneDatabaseSchema>,
    now: Date,
  ): Promise<number> {
    const challenges = await transaction
      .selectFrom("personalHostAccountLinkChallenges")
      .selectAll()
      .where((builder) =>
        builder.or([
          builder.and([builder("state", "=", "pending"), builder("challengeExpiresAt", "<=", now)]),
          builder.and([builder("state", "=", "reserved"), builder("resultExpiresAt", "<=", now)]),
        ]),
      )
      .limit(500)
      .forNoKeyUpdate()
      .execute();
    for (const challenge of challenges) {
      await this.#expireChallenge(transaction, challenge, now);
    }
    return challenges.length;
  }

  async #expireChallenge(
    transaction: Transaction<ControlPlaneDatabaseSchema>,
    challenge: PersonalHostAccountLinkChallengeRow,
    now: Date,
  ): Promise<void> {
    await transaction
      .updateTable("personalHostAccountLinkChallenges")
      .set({ sealedIssue: null, sealedResult: null, state: "expired", updatedAt: now })
      .where("challengeId", "=", challenge.challengeId)
      .where("state", "=", challenge.state)
      .executeTakeFirstOrThrow();
  }

  async #issueCompletionGrant(
    ownerAccountId: ControlPlaneAccountId,
    challengeId: PersonalHostAccountLinkChallengeId,
    authority: ReturnType<typeof PersonalHostAccessAuthoritySchema.parse>,
    linkGeneration: ReturnType<typeof AccountLinkGenerationSchema.parse>,
    now: Date,
  ) {
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const claims = PersonalHostAccountLinkCompletionGrantClaimsSchema.parse({
      account: { issuer: this.#issuer, subject: ownerAccountId },
      aud: authority.canonicalOrigin,
      authority,
      challengeId,
      exp: issuedAt + completionGrantLifetimeSeconds,
      iat: issuedAt,
      iss: this.#issuer,
      jti: `phg_${challengeId.slice("phc_".length)}`,
      linkGeneration,
      sub: ownerAccountId,
      tokenUse: "opensteer-personal-host-account-link",
    });
    const { token } = await this.#auth.api.signJWT({ body: { payload: claims } });
    return PersonalHostAccountLinkCompletionGrantSchema.parse(token);
  }
}

function assertLinkProof(input: {
  readonly authority: ReturnType<typeof PersonalHostAccessAuthoritySchema.parse>;
  readonly challenge: PersonalHostAccountLinkChallengeRow;
  readonly credential: string;
  readonly issuer: string;
  readonly now: Date;
  readonly ownerAccountId: ControlPlaneAccountId;
  readonly proof: ReturnType<typeof verifyPersonalHostAccountLinkProof>;
}): void {
  const document = input.proof.document;
  if (
    document.challenge.id !== input.challenge.challengeId ||
    document.challenge.credentialSha256 !== hashCredential(input.credential) ||
    document.account.issuer !== input.issuer ||
    document.account.subject !== input.ownerAccountId ||
    hostKeyFingerprint(input.proof.publicKey.spki) !== input.challenge.reservedHostKeyFingerprint ||
    !sameDiscoveryDocument(document.authority, input.authority)
  ) {
    throw new ControlPlaneError("forbidden", "Account-link proof does not match the challenge");
  }
  const issuedAt = new Date(document.issuedAt);
  const expiresAt = new Date(document.expiresAt);
  if (
    issuedAt.getTime() > input.now.getTime() + maximumClockSkewMilliseconds ||
    expiresAt <= input.now ||
    expiresAt > input.challenge.challengeExpiresAt
  ) {
    throw new ControlPlaneError("forbidden", "Account-link proof is invalid or expired");
  }
}

function assertStoredAuthority(
  row: {
    readonly id: string;
    readonly hostInstanceId: string;
    readonly canonicalOrigin: string;
    readonly hostKeyFingerprint: string;
  },
  authority: ReturnType<typeof PersonalHostAccessAuthoritySchema.parse>,
  authorityFingerprint: string,
): void {
  if (
    !hostAuthorityIdentityMatches(authority, authorityFingerprint, {
      canonicalOrigin: row.canonicalOrigin,
      deploymentId: row.id,
      hostInstanceId: row.hostInstanceId,
      hostKeyFingerprint: row.hostKeyFingerprint,
    })
  ) {
    throw new ControlPlaneError("conflict", "Personal Host authority is stale");
  }
}

async function requireAccount(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  ownerAccountId: ControlPlaneAccountId,
): Promise<void> {
  const account = await transaction
    .selectFrom("users")
    .select("id")
    .where("id", "=", ownerAccountId)
    .forShare()
    .executeTakeFirst();
  if (!account) throw new ControlPlaneError("not_found", "Account was not found");
}

/** Refuses when any Deployment already holds one of this Host's identities. */
async function requirePersonalDeploymentAvailable(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  authority: ReturnType<typeof PersonalHostAccessAuthoritySchema.parse>,
  authorityFingerprint: string,
): Promise<void> {
  const deployment = await transaction
    .selectFrom("deployments")
    .select("id")
    .where((builder) =>
      builder.or([
        builder("id", "=", authority.deploymentId),
        builder("activeHostInstanceId", "=", authority.hostInstanceId),
        builder("hostKeyFingerprint", "=", authorityFingerprint),
      ]),
    )
    .executeTakeFirst();
  if (deployment) {
    throw new ControlPlaneError("conflict", "Personal Host is already linked", {
      reason: "personal-host-already-linked",
    });
  }
}

/**
 * Every live challenge holding any of this Host's identities, locked so the
 * caller can supersede them in the same transaction. The alias match is a SQL
 * predicate: loading every live challenge to filter in JavaScript scanned rows
 * this Account can neither see nor conflict with.
 */
async function liveAuthorityChallenges(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  authority: ReturnType<typeof PersonalHostAccessAuthoritySchema.parse>,
  authorityFingerprint: string,
  excludingChallengeId?: PersonalHostAccountLinkChallengeId,
): Promise<readonly PersonalHostAccountLinkChallengeRow[]> {
  const now = new Date();
  let query = transaction
    .selectFrom("personalHostAccountLinkChallenges")
    .selectAll()
    .where((builder) =>
      builder.or([
        builder("reservedDeploymentId", "=", authority.deploymentId),
        builder("reservedHostInstanceId", "=", authority.hostInstanceId),
        builder("reservedHostKeyFingerprint", "=", authorityFingerprint),
      ]),
    )
    .where((builder) =>
      builder.or([
        builder.and([builder("state", "=", "pending"), builder("challengeExpiresAt", ">", now)]),
        builder.and([builder("state", "=", "reserved"), builder("resultExpiresAt", ">", now)]),
      ]),
    );
  if (excludingChallengeId) query = query.where("challengeId", "!=", excludingChallengeId);
  // Deterministic row order keeps two concurrent claimants of the same aliases
  // queueing behind one another instead of deadlocking.
  return query.orderBy("challengeId").forNoKeyUpdate().execute();
}

async function requirePersonalAuthorityAvailable(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  authority: ReturnType<typeof PersonalHostAccessAuthoritySchema.parse>,
  authorityFingerprint: string,
  completingChallengeId?: PersonalHostAccountLinkChallengeId,
): Promise<void> {
  await requirePersonalDeploymentAvailable(transaction, authority, authorityFingerprint);
  const live = await liveAuthorityChallenges(
    transaction,
    authority,
    authorityFingerprint,
    completingChallengeId,
  );
  if (live.length > 0) {
    throw new ControlPlaneError("conflict", "Personal Host already has an active challenge", {
      reason: "personal-host-already-linked",
    });
  }
}

function requireChallengeCredential(
  challenge: PersonalHostAccountLinkChallengeRow,
  credential: string,
): void {
  if (!credentialHashMatches(challenge.credentialHash, hashCredential(credential))) {
    throw new ControlPlaneError("forbidden", "Account-link challenge credential is invalid");
  }
}

/** One comparison for every stored credential hash, so none of them leaks timing. */
function credentialHashMatches(stored: string | null, presented: string): boolean {
  if (stored === null) return false;
  const expected = Buffer.from(stored, "utf8");
  const candidate = Buffer.from(presented, "utf8");
  return expected.byteLength === candidate.byteLength && timingSafeEqual(expected, candidate);
}

/**
 * Row-missing and credential-mismatch answer alike. Both keys are high-entropy
 * secrets, so there is nothing to enumerate and nothing to distinguish.
 */
function personalLinkNotFound(): ControlPlaneError {
  return new ControlPlaneError("not_found", "Account-link was not found for this Host", {
    reason: "personal-account-link-not-found",
  });
}

function requireHostCredentialHash(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer osc_")) {
    throw new ControlPlaneError("unauthorized", "A Personal Host credential is required");
  }
  const credential = authorization.slice("Bearer ".length);
  if (!/^osc_[A-Za-z0-9_-]{43}$/u.test(credential)) {
    throw new ControlPlaneError("unauthorized", "Personal Host credential is invalid");
  }
  return hashCredential(credential);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}
