import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AccountDeploymentDirectoryEntrySchema,
  AccountDeploymentSchema,
  AdoptExistingDeploymentResponseSchema,
  ConnectProjectionResponseSchema,
  ConnectProjectionRequestSchema,
  connectLivenessLifetimeMilliseconds,
  ControlPlaneAccountIdSchema,
  DirectoryProjectionResponseSchema,
  HostOidcClientSchema,
  ProjectionGenerationSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  PublishHostAuthorityResponseSchema,
  controlPlaneOAuthScopes,
  hostOidcCallbackPath,
  adoptedHostProvisioningBundle,
  type AccountDeployment,
  type AccountDeploymentDirectoryEntry,
  type AdoptExistingDeploymentRequest,
  type AdoptExistingDeploymentResponse,
  ConsumeHostAccountAdoptionProofResponseSchema,
  type ConsumeHostAccountAdoptionProofResponse,
  type ConnectProjectionRequest,
  type ConnectProjectionInput,
  type ControlPlaneAccountId,
  type DeploymentProvisioningResult,
  type DirectoryProjectionRequest,
  type DirectoryProjectionResponse,
  type HostOidcClient,
  type HostAccountAdoptionProofId,
  type PublishHostAuthorityRequest,
  type PublishHostAuthorityResponse,
} from "@opensteer/control-plane-protocol";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  NativeOAuthClientSetSchema,
  NativeOAuthRegistrationMetadataSchema,
  PendingNativeAuthorizationSchema,
  pendingNativeAuthorizationMarker,
  sameStringSet,
  type DeploymentId,
  type HostInstanceId,
  type HostKeyFingerprint,
  type NativeOAuthClient,
  type NativeOAuthRegistrationMetadata,
} from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  hostKeyFingerprint,
  hostAuthorityIdentityMatches,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import type { HostAccountAdoptionProofVerifier } from "../adoption/adoption-verifier.js";
import {
  lockAccountDeploymentCapacity,
  requireAccountDeploymentCapacity,
} from "../account/account-deployment-capacity.js";
import { lockDeploymentIdentity, lockDeploymentOrigin } from "./advisory-locks.js";
import type { HostAccountAdoptionCompletionGrantIssuer } from "../adoption/adoption-grant-issuer.js";
import type { AdoptionOperationCipher } from "../adoption/adoption-operation-crypto.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  createHostCredential,
  createOAuthClientSecret,
  hashCredential,
} from "../auth/credentials.js";
import type {
  ControlPlaneDatabaseSchema,
  DeploymentAdoptionOperationRow,
  DeploymentConnectRow,
  DeploymentRow,
} from "./schema.js";
import { verifyPersonalHostAccessRoute } from "../account/personal-host-proof.js";

const hostOidcScopes = ["openid", "profile", "email"] as const;
const adoptionResultLifetimeMilliseconds = 24 * 60 * 60 * 1_000;

export interface HostAuthority {
  readonly deploymentId: DeploymentId;
  readonly credentialHash: string;
  readonly hostInstanceId: ReturnType<typeof HostInstanceIdSchema.parse>;
}

interface ControlPlaneStoreOptions {
  readonly managedDeploymentDomain: string;
  readonly adoptionProofVerifier?: HostAccountAdoptionProofVerifier;
  readonly adoptionCompletionGrantIssuer?: HostAccountAdoptionCompletionGrantIssuer;
  readonly adoptionOperationCipher?: AdoptionOperationCipher;
}

export class ControlPlaneStore {
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;
  readonly #issuer: string;
  readonly #managedDeploymentDomain: string;
  readonly #adoptionProofVerifier: HostAccountAdoptionProofVerifier | undefined;
  readonly #adoptionCompletionGrantIssuer: HostAccountAdoptionCompletionGrantIssuer | undefined;
  readonly #adoptionOperationCipher: AdoptionOperationCipher | undefined;

  constructor(
    database: Kysely<ControlPlaneDatabaseSchema>,
    issuer: URL,
    options: ControlPlaneStoreOptions,
  ) {
    this.#database = database;
    this.#issuer = issuer.origin;
    this.#managedDeploymentDomain = normalizedDomain(options.managedDeploymentDomain);
    this.#adoptionProofVerifier = options.adoptionProofVerifier;
    this.#adoptionCompletionGrantIssuer = options.adoptionCompletionGrantIssuer;
    this.#adoptionOperationCipher = options.adoptionOperationCipher;
  }

  /** Converges every Account on the closed first-party native-client registry. */
  async ensureOfficialNativeClients(input: {
    readonly clients: readonly NativeOAuthClient[];
  }): Promise<void> {
    const clients = NativeOAuthClientSetSchema.parse(input.clients);
    await this.#database.transaction().execute(async (transaction) => {
      await sql`
        select pg_advisory_xact_lock(hashtextextended('opensteer:official-native-client', 0))
      `.execute(transaction);
      const managed = await transaction
        .selectFrom("oauthClients")
        .select(["clientId", "id", "metadata", "redirectUris", "referenceId"])
        .where((expression) =>
          expression.or([
            expression("referenceId", "=", officialNativeReference),
            expression("referenceId", "like", `${officialNativeReference}:%`),
          ]),
        )
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      const configuredIds = clients.map((client) => client.clientId);
      const managedIds = new Set(managed.map((candidate) => candidate.id));
      const occupied = await transaction
        .selectFrom("oauthClients")
        .select(["clientId", "id"])
        .where("clientId", "in", configuredIds)
        .execute();
      for (const candidate of occupied) {
        if (!managedIds.has(candidate.id)) {
          throw new ControlPlaneError(
            "conflict",
            "The configured native OAuth client ID is already owned by another client",
          );
        }
      }
      const now = new Date();
      for (const client of clients) {
        const existing = managed.find((candidate) => candidate.clientId === client.clientId);
        const durable = officialNativeRegistration(existing?.metadata);
        // The application a client ID was registered as is a binding, not a
        // label: moving it would relabel every token the old application holds.
        if (existing && durable.application !== client.application) {
          throw new ControlPlaneError(
            "conflict",
            `The native OAuth client ID ${client.clientId} is registered to the ${durable.application} application`,
          );
        }
        const values = {
          clientSecret: null,
          disabled: false,
          skipConsent: false,
          enableEndSession: true,
          subjectType: "public",
          scopes: jsonStringArray(controlPlaneOAuthScopes),
          userId: null,
          updatedAt: now,
          name: client.displayName,
          uri: this.#issuer,
          icon: null,
          contacts: null,
          tos: null,
          policy: null,
          softwareId: client.softwareId,
          softwareVersion: null,
          softwareStatement: null,
          redirectUris: jsonStringArray(client.redirectUris),
          postLogoutRedirectUris: null,
          tokenEndpointAuthMethod: "none",
          grantTypes: jsonStringArray(["authorization_code", "refresh_token"]),
          responseTypes: jsonStringArray(["code"]),
          applicationType: "native",
          requirePkce: true,
          // Keep the one historical bare reference during this narrow
          // backport. The previous Beta binary can then restart against the
          // expanded registry during rollout or rollback; new rows use the
          // qualified form and old code leaves them alone.
          referenceId:
            existing?.referenceId === officialNativeReference
              ? officialNativeReference
              : officialNativeClientReference(client.clientId),
          metadata: {
            ...durable,
            application: client.application,
            managedBy: "opensteer-control-plane",
            kind: "official-native",
          },
        } as const;
        await transaction
          .insertInto("oauthClients")
          .values({
            id: internalId("oac"),
            clientId: client.clientId,
            createdAt: now,
            ...values,
          })
          .onConflict((conflict) => conflict.column("clientId").doUpdateSet(values))
          .executeTakeFirstOrThrow();
        // A code was issued against the callbacks the client had when it was
        // minted, so a changed set must not leave one redeemable.
        if (
          existing &&
          !sameStringSet(readJsonStringArray(existing.redirectUris), client.redirectUris)
        ) {
          await deletePendingNativeAuthorizations(transaction, client.clientId, now);
        }
      }
      const stale = managed.filter((candidate) => !configuredIds.includes(candidate.clientId));
      if (stale.length === 0) return;
      // Disabling the registration stops new authorizations; what it already
      // issued outlives it unless it is revoked here. A JWT access token has no
      // row to delete, so the revocation line on the registration is what
      // retires it, and it survives re-registering the same client ID. The
      // Account browser sessions those credentials came from are deliberately
      // untouched: the person is still signed in, the application is not.
      for (const candidate of stale) {
        await transaction
          .updateTable("oauthClients")
          .set({
            disabled: true,
            metadata: {
              ...officialNativeRegistration(candidate.metadata),
              credentialsNotBefore: now.toISOString(),
            },
            updatedAt: now,
          })
          .where("id", "=", candidate.id)
          .executeTakeFirstOrThrow();
        await deletePendingNativeAuthorizations(transaction, candidate.clientId, now);
      }
      const staleClientIds = stale.map((candidate) => candidate.clientId);
      await transaction
        .deleteFrom("oauthAccessTokens")
        .where("clientId", "in", staleClientIds)
        .execute();
      await transaction
        .updateTable("oauthRefreshToken")
        .set({ revoked: now })
        .where("clientId", "in", staleClientIds)
        .where("revoked", "is", null)
        .execute();
      await transaction
        .deleteFrom("oauthConsents")
        .where("clientId", "in", staleClientIds)
        .execute();
    });
  }

  /**
   * Seeds the first-party web portal client. It is a public client with
   * required S256 PKCE and exactly one registered redirect URI, so no client
   * secret is ever custodied for the origin a browser can reach. Consent is
   * skipped because the portal is the Account's own front door: an interstitial
   * asking the Account to authorize Opensteer to Opensteer is noise, not a
   * decision. Consent for every other client is unchanged.
   */
  async ensureOfficialPortalClient(input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
  }): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      await sql`
        select pg_advisory_xact_lock(hashtextextended('opensteer:official-portal-client', 0))
      `.execute(transaction);
      const managed = await transaction
        .selectFrom("oauthClients")
        .select("clientId")
        .where("referenceId", "=", "official-portal")
        .executeTakeFirst();
      if (managed && managed.clientId !== input.clientId) {
        throw new ControlPlaneError(
          "conflict",
          "The portal OAuth client ID does not match durable control-plane state",
        );
      }
      const occupied = await transaction
        .selectFrom("oauthClients")
        .select("referenceId")
        .where("clientId", "=", input.clientId)
        .executeTakeFirst();
      if (occupied && occupied.referenceId !== "official-portal") {
        throw new ControlPlaneError(
          "conflict",
          "The portal OAuth client ID is already owned by another client",
        );
      }
      const now = new Date();
      const values = {
        clientSecret: null,
        disabled: false,
        skipConsent: true,
        enableEndSession: true,
        subjectType: "public",
        scopes: jsonStringArray(input.scopes),
        userId: null,
        updatedAt: now,
        name: "Opensteer",
        uri: `https://${this.#managedDeploymentDomain}`,
        icon: null,
        contacts: null,
        tos: null,
        policy: null,
        softwareId: "opensteer-portal",
        softwareVersion: null,
        softwareStatement: null,
        redirectUris: jsonStringArray([input.redirectUri]),
        postLogoutRedirectUris: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: jsonStringArray(["authorization_code"]),
        responseTypes: jsonStringArray(["code"]),
        applicationType: "web",
        requirePkce: true,
        referenceId: "official-portal",
        metadata: { managedBy: "opensteer-control-plane", kind: "official-portal" },
      } as const;
      await transaction
        .insertInto("oauthClients")
        .values({
          id: internalId("oac"),
          clientId: input.clientId,
          createdAt: now,
          ...values,
        })
        .onConflict((conflict) => conflict.column("clientId").doUpdateSet(values))
        .executeTakeFirstOrThrow();
    });
  }

  async adoptExistingDeployment(
    ownerAccountId: ControlPlaneAccountId,
    input: AdoptExistingDeploymentRequest,
  ): Promise<AdoptExistingDeploymentResponse> {
    if (
      !this.#adoptionProofVerifier ||
      !this.#adoptionCompletionGrantIssuer ||
      !this.#adoptionOperationCipher
    ) {
      throw new ControlPlaneError(
        "forbidden",
        "Existing Host adoption requires a configured proof verifier",
      );
    }
    const fingerprint = adoptionRequestFingerprint(ownerAccountId, input);
    let receipt: ConsumeHostAccountAdoptionProofResponse;
    let provisioningBundle: ReturnType<typeof adoptedHostProvisioningBundle>;
    let resultExpiresAt: Date;
    const completed = await this.#completedAdoptionOperation(input.proof.proofId, fingerprint);
    if (completed) {
      ({ receipt, provisioningBundle, resultExpiresAt } = completed);
    } else {
      const result = await this.#database.transaction().execute(async (transaction) => {
        await sql`
          select pg_advisory_xact_lock(hashtextextended(${input.proof.proofId}, 2))
        `.execute(transaction);
        const operation = await transaction
          .selectFrom("deploymentAdoptionOperations")
          .selectAll()
          .where("proofId", "=", input.proof.proofId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (operation && operation.requestFingerprint !== fingerprint) {
          throw new ControlPlaneError(
            "conflict",
            "Account adoption proof was already used for a different request",
          );
        }
        if (operation) {
          return this.#readCurrentAdoptionOperation(
            transaction,
            operation,
            fingerprint,
            new Date(),
          );
        }
        await lockAccountDeploymentCapacity(transaction, ownerAccountId);
        await requireDeploymentAuthorityAvailable(transaction, input.authority);
        await requireAccount(transaction, ownerAccountId);
        await requireAccountDeploymentCapacity(transaction, ownerAccountId);
        let verifiedReceipt: ConsumeHostAccountAdoptionProofResponse;
        try {
          verifiedReceipt = await this.#adoptionProofVerifier!.verify({
            proofId: input.proof.proofId,
            proofCredential: input.proof.proofCredential,
            account: { issuer: this.#issuer, subject: ownerAccountId },
            authority: input.authority,
          });
        } catch {
          throw new ControlPlaneError("forbidden", "Host adoption proof is invalid or expired");
        }
        const response = await this.#provisionDeployment(
          ownerAccountId,
          {
            ...input.authority,
            reachability: "canonical",
            name: input.name,
          },
          transaction,
          true,
        );
        const bundle = adoptedHostProvisioningBundle(this.#issuer, input, response);
        const sealed = this.#adoptionOperationCipher!.seal(input.proof.proofId, bundle);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + adoptionResultLifetimeMilliseconds);
        await transaction
          .insertInto("deploymentAdoptionOperations")
          .values({
            acknowledgedAt: null,
            createdAt: now,
            ownerAccountId,
            proofId: input.proof.proofId,
            receipt: verifiedReceipt,
            requestFingerprint: fingerprint,
            resultExpiresAt: expiresAt,
            sealedProvisioningBundle: sealed,
            state: "completed",
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
        return {
          provisioningBundle: bundle,
          receipt: verifiedReceipt,
          resultExpiresAt: expiresAt,
        };
      });
      ({ receipt, provisioningBundle, resultExpiresAt } = result);
    }
    return AdoptExistingDeploymentResponseSchema.parse({
      completionGrant: await this.#adoptionCompletionGrantIssuer.issue(receipt),
      proofId: input.proof.proofId,
      provisioningBundle,
      resultExpiresAt: resultExpiresAt.toISOString(),
    });
  }

  async #completedAdoptionOperation(proofId: HostAccountAdoptionProofId, fingerprint: string) {
    await this.purgeExpiredAdoptionResults();
    return this.#database.transaction().execute(async (transaction) => {
      const operation = await transaction
        .selectFrom("deploymentAdoptionOperations")
        .selectAll()
        .where("proofId", "=", proofId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!operation) return undefined;
      if (operation.requestFingerprint !== fingerprint) {
        throw new ControlPlaneError(
          "conflict",
          "Account adoption proof was already used for a different request",
        );
      }
      return this.#readCurrentAdoptionOperation(transaction, operation, fingerprint, new Date());
    });
  }

  async #readCurrentAdoptionOperation(
    transaction: Transaction<ControlPlaneDatabaseSchema>,
    operation: DeploymentAdoptionOperationRow,
    fingerprint: string,
    now: Date,
  ) {
    if (operation.requestFingerprint !== fingerprint) {
      throw new ControlPlaneError(
        "conflict",
        "Account adoption proof was already used for a different request",
      );
    }
    if (operation.state === "completed" && operation.resultExpiresAt <= now) {
      throw new ControlPlaneError("conflict", "Account adoption result has expired");
    }
    const current = currentAdoptionOperation(this.#adoptionOperationCipher!, operation, now);
    const deployment = await requireOwnedDeployment(
      transaction,
      operation.ownerAccountId,
      current.provisioningBundle.deployment.deploymentId,
      true,
    );
    const authority = current.provisioningBundle.deployment;
    if (
      deployment.lifecycle !== "active" ||
      deployment.reachability !== "canonical" ||
      deployment.activeHostInstanceId !== authority.hostInstanceId ||
      deployment.canonicalOrigin !== authority.canonicalOrigin ||
      deployment.hostKeyFingerprint !== authority.hostKeyFingerprint
    ) {
      throw new ControlPlaneError("conflict", "Account adoption authority is no longer current");
    }
    const credentials = await transaction
      .selectFrom("deploymentCredentials")
      .innerJoin("deployments", "deployments.id", "deploymentCredentials.deploymentId")
      .innerJoin("oauthClients", "oauthClients.clientId", "deployments.oidcClientId")
      .select([
        "deploymentCredentials.tokenHash as hostTokenHash",
        "oauthClients.clientSecret as oidcClientSecretHash",
      ])
      .where("deploymentCredentials.deploymentId", "=", authority.deploymentId)
      .executeTakeFirstOrThrow();
    if (
      credentials.hostTokenHash !== hashCredential(current.provisioningBundle.hostCredential) ||
      credentials.oidcClientSecretHash !==
        hashCredential(current.provisioningBundle.oidcClientSecret)
    ) {
      throw new ControlPlaneError("conflict", "Account adoption credentials are no longer current");
    }
    return current;
  }

  async acknowledgeAccountAdoption(
    authority: HostAuthority,
    proofId: HostAccountAdoptionProofId,
  ): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const operation = await transaction
        .selectFrom("deploymentAdoptionOperations")
        .selectAll()
        .where("proofId", "=", proofId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!operation) {
        throw new ControlPlaneError("not_found", "Account adoption operation was not found");
      }
      await requireCurrentAuthority(transaction, authority, true);
      const receipt = ConsumeHostAccountAdoptionProofResponseSchema.parse(operation.receipt);
      if (
        receipt.authority.deploymentId !== authority.deploymentId ||
        receipt.authority.hostInstanceId !== authority.hostInstanceId
      ) {
        throw new ControlPlaneError("forbidden", "Host authority does not own this adoption");
      }
      if (operation.state === "acknowledged") return;
      const now = new Date();
      if (operation.state === "expired") {
        await transaction
          .updateTable("deploymentAdoptionOperations")
          .set({ acknowledgedAt: now, state: "acknowledged", updatedAt: now })
          .where("proofId", "=", proofId)
          .where("state", "=", "expired")
          .executeTakeFirstOrThrow();
        return;
      }
      await transaction
        .updateTable("deploymentAdoptionOperations")
        .set({
          acknowledgedAt: now,
          sealedProvisioningBundle: null,
          state: "acknowledged",
          updatedAt: now,
        })
        .where("proofId", "=", proofId)
        .where("state", "=", "completed")
        .executeTakeFirstOrThrow();
    });
  }

  async purgeExpiredAdoptionResults(now = new Date()): Promise<number> {
    const result = await this.#database
      .updateTable("deploymentAdoptionOperations")
      .set({ sealedProvisioningBundle: null, state: "expired", updatedAt: now })
      .where("state", "=", "completed")
      .where("resultExpiresAt", "<=", now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Account-owned hosting calls this only inside its durable create transaction. */
  async provisionManagedDeployment(
    ownerAccountId: ControlPlaneAccountId,
    input: {
      readonly canonicalOrigin: string;
      readonly deploymentId: DeploymentId;
      readonly hostInstanceId: HostInstanceId;
      readonly hostKeyFingerprint: HostKeyFingerprint;
      readonly reachability: "canonical";
      readonly name: string;
    },
    transaction: Transaction<ControlPlaneDatabaseSchema>,
  ): Promise<DeploymentProvisioningResult> {
    return this.#provisionDeployment(ownerAccountId, input, transaction);
  }

  async #provisionDeployment(
    ownerAccountId: ControlPlaneAccountId,
    input: {
      readonly canonicalOrigin: string;
      readonly deploymentId: DeploymentId;
      readonly hostInstanceId: ReturnType<typeof HostInstanceIdSchema.parse>;
      readonly hostKeyFingerprint: HostKeyFingerprint;
      readonly reachability: "canonical";
      readonly name: string;
    },
    existingTransaction?: Transaction<ControlPlaneDatabaseSchema>,
    capacityAlreadyChecked = false,
  ): Promise<DeploymentProvisioningResult> {
    const provision = async (transaction: Transaction<ControlPlaneDatabaseSchema>) => {
      if (!capacityAlreadyChecked) {
        await lockAccountDeploymentCapacity(transaction, ownerAccountId);
        await requireAccountDeploymentCapacity(transaction, ownerAccountId);
      }
      await requireDeploymentAuthorityAvailable(transaction, input);
      const owner = await requireAccount(transaction, ownerAccountId);
      const hostCredential = createHostCredential();
      const oidcClientSecret = createOAuthClientSecret();
      const oidc = this.#hostOidcClient(input.deploymentId, input.canonicalOrigin);
      const deployment = await this.#insertDeploymentAuthority(
        transaction,
        ownerAccountId,
        owner,
        input,
        { hostCredential, oidc, oidcClientSecret },
      );
      return {
        deployment,
        hostCredential,
        owner: accountOwnerProfile(owner),
        oidc,
        oidcClientSecret,
      };
    };
    return existingTransaction
      ? provision(existingTransaction)
      : this.#database.transaction().execute(provision);
  }

  async #insertDeploymentAuthority(
    transaction: Transaction<ControlPlaneDatabaseSchema>,
    ownerAccountId: ControlPlaneAccountId,
    owner: {
      readonly id: ControlPlaneAccountId;
      readonly displayName: string;
      readonly email: string;
      readonly emailVerified: boolean;
    },
    input: {
      readonly canonicalOrigin: string;
      readonly deploymentId: DeploymentId;
      readonly hostInstanceId: ReturnType<typeof HostInstanceIdSchema.parse>;
      readonly hostKeyFingerprint: HostKeyFingerprint;
      readonly reachability: "canonical";
      readonly name: string;
    },
    material: {
      readonly hostCredential: string;
      readonly oidc: HostOidcClient;
      readonly oidcClientSecret: string;
    },
  ): Promise<DeploymentProvisioningResult["deployment"]> {
    const now = new Date();
    await transaction
      .insertInto("oauthClients")
      .values({
        id: internalId("oac"),
        clientId: material.oidc.clientId,
        clientSecret: hashCredential(material.oidcClientSecret),
        disabled: false,
        skipConsent: true,
        enableEndSession: false,
        subjectType: "public",
        scopes: jsonStringArray(hostOidcScopes),
        userId: ownerAccountId,
        createdAt: now,
        updatedAt: now,
        name: `Opensteer Host: ${input.name}`,
        uri: input.canonicalOrigin,
        icon: null,
        contacts: null,
        tos: null,
        policy: null,
        softwareId: "opensteer-host",
        softwareVersion: null,
        softwareStatement: null,
        redirectUris: jsonStringArray([material.oidc.redirectUri]),
        postLogoutRedirectUris: null,
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: jsonStringArray(["authorization_code"]),
        responseTypes: jsonStringArray(["code"]),
        applicationType: "web",
        requirePkce: true,
        referenceId: deploymentOAuthReference(input.deploymentId),
        metadata: { managedBy: "opensteer-control-plane", deploymentId: input.deploymentId },
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deployments")
      .values({
        accountLink: null,
        id: input.deploymentId,
        ownerAccountId,
        name: input.name,
        reachability: input.reachability,
        activeHostInstanceId: input.hostInstanceId,
        hostKeyFingerprint: input.hostKeyFingerprint,
        canonicalOrigin: input.canonicalOrigin,
        lifecycle: "active",
        oidcClientId: material.oidc.clientId,
        authorityEnvelope: null,
        directoryGeneration: 1,
        createdAt: now,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deploymentCredentials")
      .values({
        deploymentId: input.deploymentId,
        tokenHash: hashCredential(material.hostCredential),
        createdAt: now,
        rotatedAt: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deploymentConnect")
      .values({
        deploymentId: input.deploymentId,
        state: "disabled",
        origin: null,
        generation: 0,
        observedAt: null,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    // Validate verified owner data before the transaction commits even though
    // the account profile is only included in the one-time provisioning result.
    accountOwnerProfile(owner);
    return { id: input.deploymentId, reachability: input.reachability };
  }

  async listDeployments(
    accountId: ControlPlaneAccountId,
  ): Promise<readonly AccountDeploymentDirectoryEntry[]> {
    return this.#database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const owned = await transaction
          .selectFrom("deployments")
          .innerJoin("deploymentConnect", "deploymentConnect.deploymentId", "deployments.id")
          .leftJoin(
            "deploymentConnectResources",
            "deploymentConnectResources.deploymentId",
            "deployments.id",
          )
          .select(deploymentSelection)
          .where("deployments.ownerAccountId", "=", accountId)
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom("deploymentDirectoryVisibility")
                  .select("deploymentDirectoryVisibility.deploymentId")
                  .whereRef("deploymentDirectoryVisibility.deploymentId", "=", "deployments.id")
                  .where("deploymentDirectoryVisibility.accountId", "=", accountId),
              ),
            ),
          )
          .where("deployments.authorityEnvelope", "is not", null)
          .execute();
        const member = await transaction
          .selectFrom("deploymentDirectoryEntries")
          .innerJoin("deployments", "deployments.id", "deploymentDirectoryEntries.deploymentId")
          .innerJoin("deploymentConnect", "deploymentConnect.deploymentId", "deployments.id")
          .leftJoin(
            "deploymentConnectResources",
            "deploymentConnectResources.deploymentId",
            "deployments.id",
          )
          .select(deploymentSelection)
          .where("deploymentDirectoryEntries.accountId", "=", accountId)
          .where("deploymentDirectoryEntries.present", "=", true)
          .where("deployments.ownerAccountId", "!=", accountId)
          .where("deployments.authorityEnvelope", "is not", null)
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom("deploymentDirectoryVisibility")
                  .select("deploymentDirectoryVisibility.deploymentId")
                  .whereRef("deploymentDirectoryVisibility.deploymentId", "=", "deployments.id")
                  .where("deploymentDirectoryVisibility.accountId", "=", accountId),
              ),
            ),
          )
          .execute();
        return [
          ...owned.map((row) => accountDeploymentDirectoryEntry(row, "owner")),
          ...member.map((row) => accountDeploymentDirectoryEntry(row, "member")),
        ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      });
  }

  /**
   * Hides one shared directory row for this Account without changing Host or
   * membership authority. Hiding is a member's preference only: an owner's
   * row exists because the owner linked, adopted or created the Deployment,
   * and it leaves the directory through that same operation, never through a
   * marker that nothing else knows to clear.
   */
  async removeDeploymentFromDirectory(
    accountId: ControlPlaneAccountId,
    deploymentId: DeploymentId,
  ): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const access = await transaction
        .selectFrom("deployments")
        .leftJoin("deploymentDirectoryEntries", (join) =>
          join
            .onRef("deploymentDirectoryEntries.deploymentId", "=", "deployments.id")
            .on("deploymentDirectoryEntries.accountId", "=", accountId),
        )
        .select([
          "deployments.ownerAccountId as ownerAccountId",
          "deploymentDirectoryEntries.present as memberPresent",
        ])
        .where("deployments.id", "=", deploymentId)
        .executeTakeFirst();
      if (access?.ownerAccountId === accountId) {
        throw new ControlPlaneError(
          "conflict",
          "You own this deployment. Remove it from the computer that runs it.",
        );
      }
      if (!access || access.memberPresent !== true) {
        throw new ControlPlaneError("not_found", "Deployment was not found");
      }
      await transaction
        .insertInto("deploymentDirectoryVisibility")
        .values({ accountId, deploymentId, hiddenAt: new Date() })
        .onConflict((conflict) => conflict.columns(["deploymentId", "accountId"]).doNothing())
        .execute();
    });
  }

  /** Reads one exact current-protocol Deployment after proving Account access. */
  async deploymentForAccount(
    accountId: ControlPlaneAccountId,
    deploymentId: DeploymentId,
  ): Promise<AccountDeployment | null> {
    return this.#database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const deployment = await transaction
          .selectFrom("deployments")
          .leftJoin("deploymentDirectoryEntries", (join) =>
            join
              .onRef("deploymentDirectoryEntries.deploymentId", "=", "deployments.id")
              .on("deploymentDirectoryEntries.accountId", "=", accountId),
          )
          .select([
            "deployments.ownerAccountId as ownerAccountId",
            "deployments.authorityEnvelope as authorityEnvelope",
            "deploymentDirectoryEntries.present as memberPresent",
          ])
          .where("deployments.id", "=", deploymentId)
          .executeTakeFirst();
        if (!deployment || deployment.authorityEnvelope === null) return null;
        const access =
          deployment.ownerAccountId === accountId
            ? "owner"
            : deployment.memberPresent === true
              ? "member"
              : null;
        return access ? this.#deploymentForAccount(transaction, deploymentId, access) : null;
      });
  }

  async isDeploymentPresentForAccount(
    accountId: ControlPlaneAccountId,
    deploymentId: DeploymentId,
  ): Promise<boolean> {
    const entry = await this.#database
      .selectFrom("deploymentDirectoryEntries")
      .select("present")
      .where("accountId", "=", ControlPlaneAccountIdSchema.parse(accountId))
      .where("deploymentId", "=", DeploymentIdSchema.parse(deploymentId))
      .where("present", "=", true)
      .executeTakeFirst();
    return Boolean(entry);
  }

  async hasActiveDeploymentOrigin(canonicalOrigin: string): Promise<boolean> {
    const deployment = await this.#database
      .selectFrom("deployments")
      .select("id")
      .where("canonicalOrigin", "=", canonicalOrigin)
      .where("lifecycle", "=", "active")
      .executeTakeFirst();
    return Boolean(deployment);
  }

  async rotateHostCredential(
    ownerAccountId: ControlPlaneAccountId,
    deploymentId: DeploymentId,
  ): Promise<{ readonly hostCredential: string; readonly oidcClientSecret: string }> {
    const hostCredential = createHostCredential();
    const oidcClientSecret = createOAuthClientSecret();
    await this.#database.transaction().execute(async (transaction) => {
      const deployment = await requireOwnedDeployment(
        transaction,
        ownerAccountId,
        deploymentId,
        true,
      );
      if (!deployment.oidcClientId) {
        throw new ControlPlaneError(
          "forbidden",
          "Personal loopback Hosts do not use an OIDC client credential",
        );
      }
      const now = new Date();
      await transaction
        .updateTable("deploymentCredentials")
        .set({ tokenHash: hashCredential(hostCredential), rotatedAt: now })
        .where("deploymentId", "=", deploymentId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("oauthClients")
        .set({ clientSecret: hashCredential(oidcClientSecret), updatedAt: now })
        .where("clientId", "=", deployment.oidcClientId)
        .executeTakeFirstOrThrow();
    });
    return { hostCredential, oidcClientSecret };
  }

  async authenticateHostCredential(authorization: string | undefined): Promise<HostAuthority> {
    const row = await this.#hostCredentialRow(authorization);
    if (row.lifecycle !== "active") {
      throw new ControlPlaneError("unauthorized", "Host credential is not active");
    }
    return hostAuthorityFromCredentialRow(row);
  }

  async #hostCredentialRow(authorization: string | undefined) {
    if (!authorization?.startsWith("Bearer osc_")) {
      throw new ControlPlaneError("unauthorized", "A Host credential is required");
    }
    const raw = authorization.slice("Bearer ".length);
    if (!/^osc_[A-Za-z0-9_-]{43}$/u.test(raw)) {
      throw new ControlPlaneError("unauthorized", "Host credential is invalid");
    }
    const row = await this.#database
      .selectFrom("deploymentCredentials")
      .innerJoin("deployments", "deployments.id", "deploymentCredentials.deploymentId")
      .select([
        "deployments.id as deploymentId",
        "deployments.activeHostInstanceId as hostInstanceId",
        "deployments.accountLink as accountLink",
        "deployments.canonicalOrigin as canonicalOrigin",
        "deployments.hostKeyFingerprint as hostKeyFingerprint",
        "deployments.reachability as reachability",
        "deployments.lifecycle as lifecycle",
      ])
      .where("deploymentCredentials.tokenHash", "=", hashCredential(raw))
      .executeTakeFirst();
    if (!row) throw new ControlPlaneError("unauthorized", "Host credential is invalid");
    return { ...row, credentialHash: hashCredential(raw) };
  }

  async renamePersonalDeployment(
    ownerAccountId: ControlPlaneAccountId,
    deploymentId: DeploymentId,
    name: string,
  ): Promise<AccountDeployment> {
    return this.#database.transaction().execute(async (transaction) => {
      const deployment = await requireOwnedDeployment(
        transaction,
        ownerAccountId,
        DeploymentIdSchema.parse(deploymentId),
        true,
      );
      if (deployment.reachability !== "routed" || deployment.lifecycle !== "active") {
        throw new ControlPlaneError("conflict", "Only an active Personal Host can be renamed here");
      }
      await transaction
        .updateTable("deployments")
        .set({
          directoryGeneration: sql<string>`directory_generation + 1`,
          name,
          updatedAt: new Date(),
        })
        .where("id", "=", deployment.id)
        .executeTakeFirstOrThrow();
      return this.#deploymentForAccount(transaction, deployment.id, "owner");
    });
  }

  /**
   * Replaces the Account's copy of a Host's signed discovery document.
   *
   * Every Desktop verifies this copy before it lists the Deployment, and the
   * Host is the only party that can sign a current one, so the Host re-asserts
   * it on every start. The identity tuple is fixed: a different Deployment,
   * Host instance, origin or signing key is a different Host and is refused
   * rather than absorbed. Only the document's form may change.
   */
  async publishHostAuthority(
    authority: HostAuthority,
    input: PublishHostAuthorityRequest,
  ): Promise<PublishHostAuthorityResponse> {
    const authorityEnvelope = HostDiscoveryEnvelopeSchema.parse(input.authorityEnvelope);
    const signedAuthority = verifyHostDiscoveryEnvelope(authorityEnvelope);
    const signedFingerprint = hostKeyFingerprint(authorityEnvelope.publicKey.spki);
    if (
      signedAuthority.deploymentId !== authority.deploymentId ||
      signedAuthority.hostInstanceId !== authority.hostInstanceId
    ) {
      throw new ControlPlaneError(
        "conflict",
        "Signed Host authority does not match the Host credential",
      );
    }
    await this.#database.transaction().execute(async (transaction) => {
      await requireCurrentAuthority(transaction, authority, true);
      const current = await transaction
        .selectFrom("deployments")
        .select(["authorityEnvelope", "canonicalOrigin", "hostKeyFingerprint"])
        .where("id", "=", authority.deploymentId)
        .executeTakeFirstOrThrow();
      if (
        !hostAuthorityIdentityMatches(signedAuthority, signedFingerprint, {
          canonicalOrigin: current.canonicalOrigin,
          deploymentId: authority.deploymentId,
          hostInstanceId: authority.hostInstanceId,
          hostKeyFingerprint: current.hostKeyFingerprint,
        })
      ) {
        throw new ControlPlaneError(
          "conflict",
          "Signed Host authority does not match current Host authority",
        );
      }
      // Startup republication is the common case and usually changes nothing;
      // a row that did not change keeps its timestamp so the directory order
      // other devices see is not shuffled by every Host restart.
      if (isDeepStrictEqual(current.authorityEnvelope, authorityEnvelope)) return;
      await transaction
        .updateTable("deployments")
        .set({ authorityEnvelope, updatedAt: new Date() })
        .where("id", "=", authority.deploymentId)
        .executeTakeFirstOrThrow();
    });
    return PublishHostAuthorityResponseSchema.parse({
      deploymentId: authority.deploymentId,
      published: true,
    });
  }

  async projectDirectoryEntry(
    authority: HostAuthority,
    accountId: ControlPlaneAccountId,
    input: DirectoryProjectionRequest,
  ): Promise<DirectoryProjectionResponse> {
    assertFence(authority, input.hostInstanceId);
    return this.#database.transaction().execute(async (transaction) => {
      if (input.present) await lockAccountDeploymentCapacity(transaction, accountId);
      await requireAccount(transaction, accountId);
      await requireCurrentAuthority(transaction, authority);
      const currentDeployment = await transaction
        .selectFrom("deployments")
        .select("authorityEnvelope")
        .where("id", "=", authority.deploymentId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      // Membership is only listable against a published identity, and the
      // Host publishes that identity on start before its projections run.
      if (currentDeployment.authorityEnvelope === null) {
        throw new ControlPlaneError("conflict", "Host authority is not published");
      }
      await transaction
        .updateTable("deployments")
        .set({ directoryGeneration: input.generation, updatedAt: new Date() })
        .where("id", "=", authority.deploymentId)
        .where("directoryGeneration", "<=", String(input.generation))
        .execute();
      if (input.present) {
        const current = await transaction
          .selectFrom("deploymentDirectoryEntries")
          .select("present")
          .where("deploymentId", "=", authority.deploymentId)
          .where("accountId", "=", accountId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!current?.present) {
          const deployment = await transaction
            .selectFrom("deployments")
            .select("ownerAccountId")
            .where("id", "=", authority.deploymentId)
            .executeTakeFirstOrThrow();
          if (deployment.ownerAccountId !== accountId) {
            await requireAccountDeploymentCapacity(transaction, accountId);
          }
        }
      }
      const observedAt = new Date(input.observedAt);
      const applied = await transaction
        .insertInto("deploymentDirectoryEntries")
        .values({
          deploymentId: authority.deploymentId,
          accountId,
          generation: input.generation,
          present: input.present,
          observedAt,
          updatedAt: new Date(),
        })
        .onConflict((conflict) =>
          conflict
            .columns(["deploymentId", "accountId"])
            .doUpdateSet({
              generation: input.generation,
              present: input.present,
              observedAt,
              updatedAt: new Date(),
            })
            .where("deploymentDirectoryEntries.generation", "<", input.generation),
        )
        .returningAll()
        .executeTakeFirst();
      if (!applied) {
        const current = await transaction
          .selectFrom("deploymentDirectoryEntries")
          .selectAll()
          .where("deploymentId", "=", authority.deploymentId)
          .where("accountId", "=", accountId)
          .executeTakeFirstOrThrow();
        const comparison = compareBigInt(BigInt(input.generation), BigInt(current.generation));
        if (comparison < 0) throw staleProjection();
        if (
          current.present !== input.present ||
          current.observedAt.toISOString() !== observedAt.toISOString()
        ) {
          throw new ControlPlaneError(
            "conflict",
            "Projection generation was reused with different content",
          );
        }
      }
      return DirectoryProjectionResponseSchema.parse({
        accountId,
        generation: input.generation,
        present: input.present,
      });
    });
  }

  async projectConnect(
    authority: HostAuthority,
    inputInput: ConnectProjectionInput,
  ): Promise<ReturnType<typeof ConnectProjectionResponseSchema.parse>> {
    const input: ConnectProjectionRequest = ConnectProjectionRequestSchema.parse(inputInput);
    assertFence(authority, input.hostInstanceId);
    return this.#database.transaction().execute(async (transaction) => {
      await requireCurrentAuthority(transaction, authority);
      const deployment = await transaction
        .selectFrom("deployments")
        .select(["activeHostInstanceId", "canonicalOrigin", "hostKeyFingerprint", "reachability"])
        .where("id", "=", authority.deploymentId)
        .forShare()
        .executeTakeFirstOrThrow();
      if (deployment.reachability === "canonical") {
        throw new ControlPlaneError(
          "forbidden",
          "Opensteer Connect is unavailable for independently self-hosted deployments",
        );
      }
      if (deployment.reachability === "routed") {
        const active = input.state === "ready" || input.state === "offline";
        if (active !== (input.accessRoute !== null)) {
          throw new ControlPlaneError(
            "conflict",
            active
              ? "A Personal Connect projection requires its signed access route"
              : "An inactive Personal Connect projection cannot retain an access route",
          );
        }
        if (input.accessRoute) {
          const envelope = verifyPersonalHostAccessRoute(input.accessRoute);
          const route = envelope.document;
          if (
            route.route.kind !== "connect" ||
            route.route.origin !== input.origin ||
            route.route.generation !== input.generation ||
            !hostAuthorityIdentityMatches(
              route.authority,
              hostKeyFingerprint(envelope.publicKey.spki),
              {
                canonicalOrigin: deployment.canonicalOrigin,
                deploymentId: authority.deploymentId,
                hostInstanceId: deployment.activeHostInstanceId,
                hostKeyFingerprint: deployment.hostKeyFingerprint,
              },
            )
          ) {
            throw new ControlPlaneError(
              "conflict",
              "Signed Personal Connect route does not match current Host authority",
            );
          }
        }
        const resource = await transaction
          .selectFrom("deploymentConnectResources")
          .select(["hostname", "state"])
          .where("deploymentId", "=", authority.deploymentId)
          .forShare()
          .executeTakeFirst();
        if (
          active &&
          (resource?.state !== "ready" || `https://${resource.hostname}` !== input.origin)
        ) {
          throw new ControlPlaneError(
            "conflict",
            "Signed Connect route does not match the current managed resource",
          );
        }
        if (
          (input.state === "revoked" || input.state === "disabled") &&
          resource &&
          resource.state !== "revoked"
        ) {
          throw new ControlPlaneError(
            "conflict",
            "Managed Connect resource must be revoked before disabling the route",
          );
        }
      } else {
        if (input.accessRoute !== null) {
          throw new ControlPlaneError(
            "conflict",
            "Only a Personal Host can publish a Personal access route",
          );
        }
        if (input.origin !== null && input.origin !== deployment.canonicalOrigin) {
          throw new ControlPlaneError(
            "conflict",
            "Connect origin must match the Deployment canonical origin",
          );
        }
      }
      const current = await transaction
        .selectFrom("deploymentConnect")
        .selectAll()
        .where("deploymentId", "=", authority.deploymentId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const comparison = compareBigInt(BigInt(input.generation), BigInt(current.generation));
      if (comparison < 0) throw staleProjection();
      const now = new Date();
      const observedAt = input.state === "ready" ? now : null;
      if (comparison === 0) {
        const currentAccessRoute =
          current.accessRoute === null
            ? null
            : PersonalHostAccessRouteEnvelopeSchema.parse(current.accessRoute);
        const sameRouteAuthority =
          current.origin === input.origin &&
          isDeepStrictEqual(currentAccessRoute, input.accessRoute);
        const sameState = current.state === input.state;
        const livenessTransition =
          (current.state === "ready" || current.state === "offline") &&
          (input.state === "ready" || input.state === "offline");
        if (!sameRouteAuthority || (!sameState && !livenessTransition)) {
          throw new ControlPlaneError(
            "conflict",
            "Connect route generation was reused for different route authority",
          );
        }
        const refreshed = await transaction
          .updateTable("deploymentConnect")
          .set({ state: input.state, observedAt, updatedAt: now })
          .where("deploymentId", "=", authority.deploymentId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return connectProjection(refreshed);
      }
      const row = await transaction
        .updateTable("deploymentConnect")
        .set({
          state: input.state,
          origin: input.origin,
          accessRoute: input.accessRoute,
          generation: input.generation,
          observedAt,
          updatedAt: now,
        })
        .where("deploymentId", "=", authority.deploymentId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return connectProjection(row);
    });
  }

  async revokeAccountSessions(accountId: ControlPlaneAccountId): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      await requireAccount(transaction, accountId);
      // Revoke even offline tokens and tokens without a session binding.
      await transaction.deleteFrom("oauthAccessTokens").where("userId", "=", accountId).execute();
      await transaction.deleteFrom("oauthRefreshToken").where("userId", "=", accountId).execute();
      await transaction
        .selectFrom("authSessions")
        .select("id")
        .where("userId", "=", accountId)
        .orderBy("id", "asc")
        // FOR UPDATE: session revocation deletes these rows.
        .forUpdate()
        .execute();
      await transaction.deleteFrom("authSessions").where("userId", "=", accountId).execute();
      // Signing every session out has to reach the phones too: a push
      // registration outliving the credential that made it is the same failure
      // as a token that outlives its session, and the person cannot see it.
      await transaction
        .updateTable("notificationDevices")
        .set({ disabledAt: new Date(), updatedAt: new Date() })
        .where("accountId", "=", accountId)
        .where("disabledAt", "is", null)
        .execute();
    });
  }

  /**
   * Revokes exactly one Account session and everything issued against it. The
   * portal signs out this way: it holds no Account cookie of its own, and one
   * sign-out has to end the Account session that proved the portal session.
   * Direct database deletes bypass Better Auth hooks.
   */
  async revokeAccountSession(
    accountId: ControlPlaneAccountId,
    sessionId: string,
  ): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("authSessions")
        .select("id")
        .where("id", "=", sessionId)
        .where("userId", "=", ControlPlaneAccountIdSchema.parse(accountId))
        // FOR UPDATE: Revoke deletes this Account session.
        .forUpdate()
        .executeTakeFirst();
      if (!session) return false;
      await transaction
        .deleteFrom("oauthAccessTokens")
        .where("sessionId", "=", sessionId)
        .execute();
      await transaction
        .deleteFrom("oauthRefreshToken")
        .where("sessionId", "=", sessionId)
        .execute();
      await transaction.deleteFrom("authSessions").where("id", "=", sessionId).execute();
      return true;
    });
  }

  async deleteAccount(accountId: ControlPlaneAccountId): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const account = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", accountId)
        // FOR UPDATE: Delete this Account user and its dependent rows.
        .forUpdate()
        .executeTakeFirst();
      if (!account) throw new ControlPlaneError("not_found", "Account was not found");
      const owned = await transaction
        .selectFrom("deployments")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("ownerAccountId", "=", accountId)
        .executeTakeFirstOrThrow();
      if (BigInt(owned.count) !== 0n) {
        throw new ControlPlaneError(
          "owned_deployments_exist",
          "Unregister owned deployments before deleting the account",
        );
      }
      await transaction.deleteFrom("oauthAccessTokens").where("userId", "=", accountId).execute();
      await transaction.deleteFrom("oauthRefreshToken").where("userId", "=", accountId).execute();
      await transaction.deleteFrom("oauthConsents").where("userId", "=", accountId).execute();
      await transaction
        .selectFrom("authSessions")
        .select("id")
        .where("userId", "=", accountId)
        .orderBy("id", "asc")
        // FOR UPDATE: Account deletion revokes its sessions before removing the User.
        .forUpdate()
        .execute();
      await transaction.deleteFrom("authSessions").where("userId", "=", accountId).execute();
      await transaction.deleteFrom("authAccounts").where("userId", "=", accountId).execute();
      const deleted = await transaction
        .deleteFrom("users")
        .where("id", "=", accountId)
        .executeTakeFirst();
      if (deleted.numDeletedRows !== 1n) throw new Error("Locked account was not deleted");
      // Host databases are deliberately outside this transaction and are not
      // contacted. Their owners can retain, transfer, or remove that data.
    });
  }

  #hostOidcClient(deploymentId: DeploymentId, canonicalOrigin: string): HostOidcClient {
    return HostOidcClientSchema.parse({
      clientId: deploymentOAuthClientId(deploymentId),
      issuer: this.#issuer,
      redirectUri: new URL(hostOidcCallbackPath, canonicalOrigin).toString(),
      scopes: [...hostOidcScopes],
      tokenEndpointAuthMethod: "client_secret_basic",
      requirePkce: true,
    });
  }

  async #deploymentForAccount(
    database: Kysely<ControlPlaneDatabaseSchema> | Transaction<ControlPlaneDatabaseSchema>,
    deploymentId: DeploymentId,
    access: "owner" | "member",
  ): Promise<AccountDeployment> {
    const row = await database
      .selectFrom("deployments")
      .innerJoin("deploymentConnect", "deploymentConnect.deploymentId", "deployments.id")
      .leftJoin(
        "deploymentConnectResources",
        "deploymentConnectResources.deploymentId",
        "deployments.id",
      )
      .select(deploymentSelection)
      .where("deployments.id", "=", deploymentId)
      .executeTakeFirstOrThrow();
    return accountDeployment(row, access);
  }
}

function hostAuthorityFromCredentialRow(row: {
  readonly credentialHash: string;
  readonly deploymentId: string;
  readonly hostInstanceId: string;
}): HostAuthority {
  return {
    credentialHash: row.credentialHash,
    deploymentId: DeploymentIdSchema.parse(row.deploymentId),
    hostInstanceId: HostInstanceIdSchema.parse(row.hostInstanceId),
  };
}

const deploymentSelection = [
  "deployments.id as id",
  "deployments.activeHostInstanceId as activeHostInstanceId",
  "deployments.hostKeyFingerprint as hostKeyFingerprint",
  "deployments.name as name",
  "deployments.reachability as reachability",
  "deployments.lifecycle as lifecycle",
  "deployments.canonicalOrigin as canonicalOrigin",
  "deployments.updatedAt as updatedAt",
  "deployments.authorityEnvelope as authorityEnvelope",
  "deployments.directoryGeneration as directoryGeneration",
  "deployments.accountLink as accountLink",
  "deploymentConnect.state as connectState",
  "deploymentConnect.origin as connectOrigin",
  "deploymentConnect.generation as connectGeneration",
  "deploymentConnect.observedAt as connectObservedAt",
  "deploymentConnect.accessRoute as connectAccessRoute",
  "deploymentConnectResources.state as connectResourceState",
] as const;

interface DeploymentSelection {
  readonly id: DeploymentId;
  readonly activeHostInstanceId: DeploymentRow["activeHostInstanceId"];
  readonly hostKeyFingerprint: DeploymentRow["hostKeyFingerprint"];
  readonly name: string;
  readonly reachability: DeploymentRow["reachability"];
  readonly lifecycle: DeploymentRow["lifecycle"];
  readonly canonicalOrigin: string;
  readonly updatedAt: Date;
  readonly authorityEnvelope: unknown | null;
  readonly directoryGeneration: string;
  readonly accountLink: unknown | null;
  readonly connectState: DeploymentConnectRow["state"];
  readonly connectOrigin: string | null;
  readonly connectGeneration: string;
  readonly connectObservedAt: Date | null;
  readonly connectAccessRoute: unknown | null;
  readonly connectResourceState: import("./schema.js").ConnectResourceState | null;
}

function accountDeployment(
  row: DeploymentSelection,
  access: "owner" | "member",
): AccountDeployment {
  if (row.authorityEnvelope === null) throw new Error("Host authority is not published");
  const authorityEnvelope = HostDiscoveryEnvelopeSchema.parse(row.authorityEnvelope);
  verifyHostDiscoveryEnvelope(authorityEnvelope);
  const connectRoute =
    row.connectAccessRoute === null
      ? null
      : PersonalHostAccessRouteEnvelopeSchema.parse(row.connectAccessRoute);
  const observedAt = row.connectObservedAt?.toISOString() ?? null;
  return AccountDeploymentSchema.parse({
    authorityEnvelope,
    generation: Number(row.directoryGeneration),
    id: row.id,
    name: row.name,
    lifecycle: "active",
    access,
    ...(row.reachability === "routed"
      ? {
          accountLink: row.accountLink,
          connectResourceState: directoryConnectResourceState(row.connectResourceState),
          connectRoute,
          lastSeenAt:
            connectRoute && observedAt
              ? {
                  observedAt,
                  expiresAt: new Date(
                    row.connectObservedAt!.getTime() + connectLivenessLifetimeMilliseconds,
                  ).toISOString(),
                }
              : null,
          reachability: "routed" as const,
        }
      : { canonicalOrigin: row.canonicalOrigin, reachability: "canonical" as const }),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function accountDeploymentDirectoryEntry(
  row: DeploymentSelection,
  access: "owner" | "member",
): AccountDeploymentDirectoryEntry {
  if (row.authorityEnvelope === null) throw new Error("Host authority is not published");
  const connectRoute = row.connectAccessRoute;
  const observedAt = row.connectObservedAt?.toISOString() ?? null;
  return AccountDeploymentDirectoryEntrySchema.parse({
    access,
    authority: {
      canonicalOrigin: row.canonicalOrigin,
      deploymentId: row.id,
      hostInstanceId: row.activeHostInstanceId,
      hostKeyFingerprint: row.hostKeyFingerprint,
    },
    authorityEnvelope: row.authorityEnvelope,
    generation: Number(row.directoryGeneration),
    id: row.id,
    name: row.name,
    lifecycle: "active",
    ...(row.reachability === "routed"
      ? {
          accountLink: row.accountLink,
          connectResourceState: directoryConnectResourceState(row.connectResourceState),
          connectRoute,
          lastSeenAt:
            connectRoute && observedAt
              ? {
                  observedAt,
                  expiresAt: new Date(
                    row.connectObservedAt!.getTime() + connectLivenessLifetimeMilliseconds,
                  ).toISOString(),
                }
              : null,
          reachability: "routed" as const,
        }
      : { canonicalOrigin: row.canonicalOrigin, reachability: "canonical" as const }),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function directoryConnectResourceState(
  state: import("./schema.js").ConnectResourceState | null,
): "disabled" | "provisioning" | "ready" | "rotating" | "revoking" | "error" {
  switch (state) {
    case "provisioning":
    case "ready":
    case "rotating":
    case "error":
      return state;
    case "deleting":
      return "revoking";
    case "revoked":
    case null:
      return "disabled";
  }
}

function connectProjection(row: DeploymentConnectRow) {
  return ConnectProjectionResponseSchema.parse({
    accessRoute:
      row.accessRoute === null
        ? null
        : PersonalHostAccessRouteEnvelopeSchema.parse(row.accessRoute),
    state: row.state,
    origin: row.origin,
    generation: ProjectionGenerationSchema.parse(Number(row.generation)),
    lastSeenAt: row.observedAt?.toISOString() ?? null,
  });
}

async function requireAccount(
  database: Transaction<ControlPlaneDatabaseSchema>,
  accountId: ControlPlaneAccountId,
): Promise<{
  readonly id: ControlPlaneAccountId;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
}> {
  const account = await database
    .selectFrom("users")
    .select(["id", "displayName", "email", "emailVerified"])
    .where("id", "=", ControlPlaneAccountIdSchema.parse(accountId))
    .forShare()
    .executeTakeFirst();
  if (!account) throw new ControlPlaneError("not_found", "Account was not found");
  return account;
}

export async function requireCurrentAuthority(
  database: Transaction<ControlPlaneDatabaseSchema>,
  authority: HostAuthority,
  lock = false,
): Promise<void> {
  await database
    .selectFrom("deployments")
    .select("id")
    .where("id", "=", authority.deploymentId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  let query = database
    .selectFrom("deployments")
    .innerJoin("deploymentCredentials", "deploymentCredentials.deploymentId", "deployments.id")
    .select([
      "deployments.activeHostInstanceId as activeHostInstanceId",
      "deploymentCredentials.tokenHash as tokenHash",
    ])
    .where("id", "=", authority.deploymentId)
    .$call((builder) => (lock ? builder.forNoKeyUpdate("deployments") : builder.forShare()));
  const deployment = await query.executeTakeFirst();
  if (
    !deployment ||
    deployment.activeHostInstanceId !== authority.hostInstanceId ||
    deployment.tokenHash !== authority.credentialHash
  ) {
    throw new ControlPlaneError("forbidden", "Host authority fence is stale");
  }
}

async function requireOwnedDeployment(
  database: Transaction<ControlPlaneDatabaseSchema>,
  accountId: ControlPlaneAccountId,
  deploymentId: DeploymentId,
  lock: boolean,
): Promise<DeploymentRow> {
  let query = database
    .selectFrom("deployments")
    .selectAll()
    .where("id", "=", deploymentId)
    .where("ownerAccountId", "=", accountId);
  if (lock) query = query.forNoKeyUpdate();
  const deployment = await query.executeTakeFirst();
  if (!deployment) throw new ControlPlaneError("not_found", "Deployment was not found");
  return deployment;
}

export function assertFence(
  authority: HostAuthority,
  hostInstanceId: HostAuthority["hostInstanceId"],
): void {
  if (authority.hostInstanceId !== hostInstanceId) {
    throw new ControlPlaneError("forbidden", "Host authority fence does not match");
  }
}

function staleProjection(): ControlPlaneError {
  return new ControlPlaneError("stale_projection", "Projection generation is stale");
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deploymentOAuthClientId(deploymentId: DeploymentId): string {
  return `osh_${deploymentId.slice("dep_".length)}`;
}

function deploymentOAuthReference(deploymentId: DeploymentId): string {
  return `deployment:${deploymentId}`;
}

function internalId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizedDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/u, "");
  let url: URL;
  try {
    url = new URL(`https://${domain}`);
  } catch {
    throw new TypeError("Managed Deployment domain is invalid");
  }
  if (
    !domain ||
    domain.length > 253 ||
    url.hostname !== domain ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new TypeError("Managed Deployment domain is invalid");
  }
  return domain;
}

function accountOwnerProfile(account: {
  readonly id: ControlPlaneAccountId;
  readonly displayName: string;
  readonly email: string;
  readonly emailVerified: boolean;
}) {
  if (!account.emailVerified) {
    throw new ControlPlaneError("forbidden", "A verified Account email is required");
  }
  return {
    subject: account.id,
    email: account.email,
    displayName: account.displayName,
  };
}

const officialNativeReference = "official-native";
const officialNativeClientReference = (clientId: string) =>
  `${officialNativeReference}:${clientId}`;

/** Whether a registration row is one the Account's native allowlist manages. */
export function isOfficialNativeReference(referenceId: string | null): boolean {
  return (
    referenceId === officialNativeReference ||
    referenceId?.startsWith(`${officialNativeReference}:`) === true
  );
}

/**
 * Reads what a managed native registration durably remembers about itself. The
 * single registration that predates the allowlist carries no binding, and it
 * was the desktop client: nothing else existed to be registered.
 */
function officialNativeRegistration(metadata: unknown): NativeOAuthRegistrationMetadata {
  const parsed = NativeOAuthRegistrationMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : { application: "desktop" };
}

function readJsonStringArray(value: unknown): readonly string[] {
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * Drops the authorization codes a client has outstanding, in the verification
 * table the OAuth provider shares with every other short-lived token. A code
 * outlives the registration that minted it by up to its own lifetime, so
 * retiring a client — or changing where its codes may be delivered — has to
 * take the outstanding ones with it.
 */
async function deletePendingNativeAuthorizations(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  clientId: string,
  now: Date,
): Promise<void> {
  const pending = await transaction
    .selectFrom("authVerifications")
    .select(["id", "value"])
    .where("expiresAt", ">", now)
    .where("value", "like", `%${pendingNativeAuthorizationMarker}%`)
    .execute();
  const stale = pending
    .filter((candidate) => {
      let value: unknown;
      try {
        value = JSON.parse(candidate.value);
      } catch {
        return false;
      }
      const parsed = PendingNativeAuthorizationSchema.safeParse(value);
      return parsed.success && parsed.data.query.client_id === clientId;
    })
    .map((candidate) => candidate.id);
  if (stale.length === 0) return;
  await transaction.deleteFrom("authVerifications").where("id", "in", stale).execute();
}

function jsonStringArray(values: readonly string[]): string {
  return JSON.stringify(values);
}

async function requireDeploymentAuthorityAvailable(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  input: {
    readonly canonicalOrigin: string;
    readonly deploymentId: DeploymentId;
    readonly hostInstanceId: HostInstanceId;
    readonly hostKeyFingerprint: HostKeyFingerprint;
  },
): Promise<void> {
  await lockDeploymentIdentity(transaction, input.deploymentId);
  await lockDeploymentOrigin(transaction, input.canonicalOrigin);
  const existing = await transaction
    .selectFrom("deployments")
    .select("id")
    .where("id", "=", input.deploymentId)
    .executeTakeFirst();
  if (existing) {
    throw new ControlPlaneError("conflict", "Deployment is already registered");
  }
  const existingOrigin = await transaction
    .selectFrom("deployments")
    .select("id")
    .where("canonicalOrigin", "=", input.canonicalOrigin)
    .executeTakeFirst();
  if (existingOrigin) {
    throw new ControlPlaneError("conflict", "Deployment origin is already registered");
  }
  // A live Personal link reservation owns its Host identities before any
  // Deployment row exists. Adoption and registration must see that claim, or
  // two paths would materialize the same Host under different Accounts.
  const now = new Date();
  const reserved = await transaction
    .selectFrom("personalHostAccountLinkChallenges")
    .select("challengeId")
    .where((builder) =>
      builder.or([
        builder("reservedDeploymentId", "=", input.deploymentId),
        builder("reservedHostInstanceId", "=", input.hostInstanceId),
        builder("reservedHostKeyFingerprint", "=", input.hostKeyFingerprint),
      ]),
    )
    .where((builder) =>
      builder.or([
        builder.and([builder("state", "=", "pending"), builder("challengeExpiresAt", ">", now)]),
        builder.and([builder("state", "=", "reserved"), builder("resultExpiresAt", ">", now)]),
      ]),
    )
    .executeTakeFirst();
  if (reserved) {
    throw new ControlPlaneError(
      "conflict",
      "Personal Host authority is reserved by a live Account link",
      { reason: "personal-host-already-linked" },
    );
  }
}

function adoptionRequestFingerprint(
  ownerAccountId: ControlPlaneAccountId,
  input: AdoptExistingDeploymentRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        authority: {
          canonicalOrigin: input.authority.canonicalOrigin,
          deploymentId: input.authority.deploymentId,
          hostInstanceId: input.authority.hostInstanceId,
          hostKeyFingerprint: input.authority.hostKeyFingerprint,
        },
        reachability: input.reachability,
        name: input.name,
        ownerAccountId,
        proofCredentialHash: hashCredential(input.proof.proofCredential),
        proofId: input.proof.proofId,
      }),
    )
    .digest("base64url");
}

function currentAdoptionOperation(
  cipher: AdoptionOperationCipher,
  operation: {
    readonly proofId: string;
    readonly receipt: unknown;
    readonly resultExpiresAt: Date;
    readonly sealedProvisioningBundle: string | null;
    readonly state: "completed" | "acknowledged" | "expired";
  },
  now: Date,
): {
  readonly provisioningBundle: ReturnType<typeof adoptedHostProvisioningBundle>;
  readonly receipt: ConsumeHostAccountAdoptionProofResponse;
  readonly resultExpiresAt: Date;
} {
  if (operation.state === "acknowledged") {
    throw new ControlPlaneError("conflict", "Account adoption is already complete");
  }
  if (operation.state === "expired" || operation.resultExpiresAt <= now) {
    throw new ControlPlaneError("conflict", "Account adoption result has expired");
  }
  if (!operation.sealedProvisioningBundle) {
    throw new Error("Completed adoption operation has no result");
  }
  const receipt = ConsumeHostAccountAdoptionProofResponseSchema.parse(operation.receipt);
  const provisioningBundle = cipher.open(operation.proofId, operation.sealedProvisioningBundle);
  if (provisioningBundle.provisioningMode !== "adoption") {
    throw new Error("Completed adoption operation contains a bootstrap bundle");
  }
  return { provisioningBundle, receipt, resultExpiresAt: operation.resultExpiresAt };
}
