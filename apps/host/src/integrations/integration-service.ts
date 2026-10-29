import {
  IntegrationAccountBindingSchema,
  validateIntegrationAccountBinding,
  type IntegrationAccountBinding,
} from "./integration-account-binding.js";
import { inspectGitHubRepositoryAccess } from "./github-repository-access.js";
import {
  ConnectIntegrationApiKeySchema,
  IntegrationDashboardSchema,
  IntegrationOAuthAttemptIdSchema,
  IntegrationProviderApplicationIdSchema,
  IntegrationProviderApplicationSchema,
  IntegrationProviderAuthorizationSchema,
  IntegrationProviderManifestSchema,
  IntegrationProviderSchema,
  SaveIntegrationProviderApplicationSchema,
  createIntegrationId,
  integrationApplicationSourcePinnedAndAvailable,
  integrationApplicationSourceUnavailableDetail,
  integrationCredentialRejectedDetail,
  integrationProviderIdentityAlreadyConnectedDetail,
  integrationDefinitionsToProviderManifests,
  sameIntegrationOAuthApplicationSource,
  type AuthMethod,
  type ConnectIntegrationApiKey,
  type IntegrationAdapter,
  type IntegrationAdapterKind,
  type IntegrationAuthorizationSurface,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationDefinition,
  type IntegrationDeploymentPosture,
  type IntegrationOAuthApplicationSource,
  type IntegrationProvider,
  type IntegrationProviderAuthorization,
  type IntegrationProviderApplication,
  type IntegrationProviderApplicationId,
  type IntegrationProviderManifest,
  type SaveIntegrationProviderApplication,
} from "@opensteer/integration-core";
import {
  type IntegrationAuthAttemptSurface,
  type IntegrationAuthAttemptFailureReason,
  type IntegrationConnectionSecretRecord,
  type IntegrationProviderApplicationRecord,
  type IntegrationRepository,
  type IntegrationSecretContext,
  type IntegrationSecretVault,
} from "@opensteer/integration-core/ports";
import { authorizationDigest } from "@opensteer/integration-core/digest";
import {
  OAuth2Error,
  buildDeclarativeAuthorizationUrl,
  exchangeDeclarativeAuthorization,
  extractDeclarativeCredential,
  generateOAuthBrokerEphemeralKeyPair,
  missingRequiredScopes,
  oauthFailureKind,
  oauthAuthorizationFailure,
  oauthUserDeniedAuthorization,
  openOAuthBrokerPayload,
  refreshDeclarativeCredential,
  revokeDeclarativeCredential,
  sealOAuthBrokerPayload,
  shouldRefreshToken,
  validateOAuthAuthorizationResponse,
} from "@opensteer/integration-auth";
import {
  HostedOAuthAttemptIdSchema,
  HostedOAuthProviderErrorSchema,
  HostedOAuthSafeFailureCodeSchema,
  HostedOAuthRefreshTransactionIdSchema,
  HostedOAuthRevocationTransactionIdSchema,
  OAuthBrokerRevocationContextSchema,
  OAuthBrokerAuthorizationContextSchema,
  OAuthBrokerAuthorizationCodeBundleSchema,
  OAuthBrokerCallbackRelayContextSchema,
  OAuthBrokerRefreshContextSchema,
  OAuthBrokerTokenBundleSchema,
} from "@opensteer/control-plane-protocol";
import { graphqlAdapter, mcpAdapter, openApiAdapter } from "@opensteer/integration-adapters";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import { OpensteerError, type UserId } from "@opensteer/core";
import { z } from "zod";
import type { IntegrationAuthAttemptLifecycle } from "./integration-auth-attempt-service.js";
import { integrationAuthAttemptLifetimeMilliseconds } from "./integration-auth-attempt-service.js";
import type { HostedOAuthBrokerClient } from "../access/hosted-oauth-broker-client.js";
import {
  canonicalAuthorizationRepair,
  canonicalAuthorizationRequired,
  type HostSessionSurface,
} from "../identity/auth.js";

const ProviderOAuthAttemptBaseSchema = {
  authMethodId: z.string().min(1).max(64),
  authorizationDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  definitionId: z.string().min(1).max(64),
  provider: IntegrationProviderSchema,
  returnPath: z.string().min(1).max(8_192),
} as const;
const ProviderOAuthAttemptPayloadSchema = z.discriminatedUnion("applicationSource", [
  z.strictObject({
    ...ProviderOAuthAttemptBaseSchema,
    applicationSource: z.literal("deployment-oauth"),
    codeVerifier: z.string().min(43).max(256).nullable(),
    callbackRelay: z
      .strictObject({
        accountIssuer: z.url(),
        accountLinkGeneration: IntegrationAccountBindingSchema.shape.linkGeneration,
        accountSubject: z.string().min(1).max(160),
        brokerAttemptId: HostedOAuthAttemptIdSchema,
        brokerExpiresAt: z.iso.datetime({ offset: true }),
        deploymentAuthorityDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        hostPrivateKey: z.string().min(1).max(512),
        redirectUrl: z.url(),
      })
      .optional(),
    providerApplicationId: IntegrationProviderApplicationIdSchema,
    providerApplicationRevision: z.number().int().positive(),
    requestedScopes: z.array(z.string().min(1).max(256)).max(512),
  }),
  z.strictObject({
    ...ProviderOAuthAttemptBaseSchema,
    accountIssuer: z.url(),
    accountLinkGeneration: IntegrationAccountBindingSchema.shape.linkGeneration,
    accountSubject: z.string().min(1).max(160),
    applicationSource: z.literal("hosted-oauth"),
    brokerAttemptId: HostedOAuthAttemptIdSchema,
    brokerExpiresAt: z.iso.datetime({ offset: true }),
    deploymentAuthorityDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    hostPrivateKey: z.string().min(1).max(512),
    providerApplicationRevision: z.number().int().positive(),
  }),
]);

/**
 * Reads back a definition that exists only as an installation — an administrator-approved proposal
 * was never in the static catalog, yet its accounts connect through the same paths.
 */
export type InstalledIntegrationDefinitionLookup = (
  definitionId: string,
  options?: { readonly allowUnavailable: boolean },
) => Promise<IntegrationDefinition | null>;

/**
 * What actually happened to the provider's copy of the credential. `notice` is
 * present exactly when the token outlived the disconnect, and is the sentence
 * the person who disconnected has to read to finish the job themselves.
 */
export interface IntegrationDisconnectOutcome {
  readonly notice: string | null;
  readonly revokedUpstream: boolean;
}

/**
 * Fires once a connection holds usable authority: after every OAuth completion
 * (deployment callback or hosted broker pull) and every API-key connection. It
 * is the single signal the platform reacts to, whichever surface finished the
 * flow, so it must not reject: the reaction reports its own failures.
 */
export type IntegrationConnectionConnected = (input: {
  readonly connectionId: IntegrationConnectionId;
  readonly ownerUserId: UserId;
}) => Promise<void>;

const authorizationChangedDetail =
  "Opensteer changed how this service connects. Reconnect this account to keep using it.";
const invalidTokenExpiryDetail = "The provider token expiry is invalid; reconnect this account.";

interface HostedOAuthOptions {
  readonly accountSubject: (ownerUserId: UserId) => Promise<IntegrationAccountBinding | null>;
  readonly broker: HostedOAuthBrokerClient;
  readonly deploymentAuthorityDigest: string;
}

export class IntegrationService {
  readonly #adapters: ReadonlyMap<IntegrationAdapterKind, IntegrationAdapter>;
  readonly #authorizationFlights = new Map<
    import("@opensteer/integration-core").IntegrationOAuthAttemptId,
    Promise<void>
  >();
  readonly #attempts: IntegrationAuthAttemptLifecycle;
  readonly #definitions: readonly IntegrationDefinition[];
  readonly #deploymentPosture: () => Promise<IntegrationDeploymentPosture>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #hostedOAuth: HostedOAuthOptions | undefined;
  readonly #installedDefinition: InstalledIntegrationDefinitionLookup | undefined;
  readonly #now: () => Date;
  readonly #onConnectionConnected: IntegrationConnectionConnected;
  readonly #providerManifests: readonly IntegrationProviderManifest[];
  readonly #publicUrl: URL;
  readonly #repository: IntegrationRepository;
  readonly #refreshFlights = new Map<
    IntegrationConnectionId,
    Promise<Readonly<Record<string, string>>>
  >();
  readonly #vault: IntegrationSecretVault;

  constructor(options: {
    readonly adapters?: readonly IntegrationAdapter[];
    readonly attempts: IntegrationAuthAttemptLifecycle;
    readonly definitions?: readonly IntegrationDefinition[];
    readonly deploymentPosture: () => Promise<IntegrationDeploymentPosture>;
    readonly fetch?: typeof globalThis.fetch;
    readonly hostedOAuth?: HostedOAuthOptions;
    readonly installedDefinition?: InstalledIntegrationDefinitionLookup;
    readonly now?: () => Date;
    readonly onConnectionConnected: IntegrationConnectionConnected;
    readonly publicUrl: URL;
    readonly repository: IntegrationRepository;
    readonly vault: IntegrationSecretVault;
  }) {
    const adapters = options.adapters ?? [graphqlAdapter, mcpAdapter, openApiAdapter];
    this.#adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
    this.#attempts = options.attempts;
    this.#definitions = options.definitions ?? integrationDefinitions;
    this.#deploymentPosture = options.deploymentPosture;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#hostedOAuth = options.hostedOAuth;
    this.#installedDefinition = options.installedDefinition;
    this.#now = options.now ?? (() => new Date());
    this.#onConnectionConnected = options.onConnectionConnected;
    this.#providerManifests = IntegrationProviderManifestSchema.array()
      .max(32)
      .parse(integrationDefinitionsToProviderManifests(this.#definitions));
    if (new Set(this.#definitions.map(({ id }) => id)).size !== this.#definitions.length) {
      throw new Error("Integration definitions must have unique ids");
    }
    for (const manifest of this.#providerManifests) {
      const revisions = new Set(
        this.#definitions
          .filter(({ provider, hostedOAuth }) => provider === manifest.provider && hostedOAuth)
          .map(({ hostedOAuth }) => hostedOAuth!.providerApplicationRevision),
      );
      if (revisions.size > 1) {
        throw new Error(
          `Hosted OAuth definitions for ${manifest.provider} must share one provider application revision`,
        );
      }
    }
    this.#publicUrl = options.publicUrl;
    this.#repository = options.repository;
    this.#vault = options.vault;
  }

  async dashboard(
    ownerUserId: UserId,
    isAdministrator: boolean,
    authorizationSurface: IntegrationAuthorizationSurface,
  ) {
    const [applications, connections, savedSourceDefaults, posture, hostedMetadata] =
      await Promise.all([
        this.#repository.listProviderApplications(ownerUserId),
        this.#repository.listConnections(ownerUserId),
        this.#repository.listApplicationSourceDefaults(),
        this.#deploymentPosture(),
        this.#hostedOAuth
          ? this.#hostedOAuth.broker
              .metadata()
              .then((metadata) => ({ ...metadata, availability: "available" as const }))
              .catch(() => ({
                availability: "temporarily-unavailable" as const,
                callbackRelayProviders: [],
                providerRevisions: {},
              }))
          : Promise.resolve({
              availability: "unsupported" as const,
              callbackRelayProviders: [],
              providerRevisions: {},
            }),
      ]);
    const canonicalProviderAuthorizations = this.#resolveProviderAuthorizations({
      applications,
      callbackRelayProviders: hostedMetadata.callbackRelayProviders,
      hostedProviderRevisions: hostedMetadata.providerRevisions,
      hostedOAuthStatus: hostedMetadata.availability,
      posture,
      savedSourceDefaults,
    });
    const providerAuthorizations = projectProviderAuthorizationsForSurface(
      canonicalProviderAuthorizations,
      authorizationSurface,
    );
    return IntegrationDashboardSchema.parse({
      applications: applications.map((application) =>
        publicApplication(
          application,
          this.#customApplicationCallbackUrl(
            application.provider,
            hostedMetadata.callbackRelayProviders,
          ) ?? this.callbackUrl(application.provider),
          this.#providerManifest(application.provider),
          ownerUserId,
          isAdministrator,
        ),
      ),
      authorizationSurface,
      callbackUrls: Object.fromEntries(
        this.#providerManifests.flatMap(({ provider }) => {
          const callbackUrl = this.#customApplicationCallbackUrl(
            provider,
            hostedMetadata.callbackRelayProviders,
          );
          return callbackUrl ? [[provider, callbackUrl]] : [];
        }),
      ),
      connections: connections.map((connection) =>
        projectConnectionAuthorizationHealth(
          connection,
          canonicalProviderAuthorizations,
          applications,
        ),
      ),
      hostedOAuthDisclosure:
        "Opensteer briefly brokers managed authorization credentials during connection and refresh. This deployment stores the account tokens, and provider data goes directly between this deployment and the provider. With your own app, this deployment handles token exchange and refresh; some local connections still use Opensteer to receive the authorization callback.",
      isAdministrator,
      providerAuthorizations,
      providers: this.#providerManifests,
    });
  }

  async providerAuthorizations(
    ownerUserId: UserId,
  ): Promise<Readonly<Record<string, IntegrationProviderAuthorization>>> {
    const [applications, savedSourceDefaults, posture, hostedMetadata] = await Promise.all([
      this.#repository.listProviderApplications(ownerUserId),
      this.#repository.listApplicationSourceDefaults(),
      this.#deploymentPosture(),
      this.#hostedOAuth
        ? this.#hostedOAuth.broker
            .metadata()
            .then((metadata) => ({ ...metadata, availability: "available" as const }))
            .catch(() => ({
              availability: "temporarily-unavailable" as const,
              callbackRelayProviders: [],
              providerRevisions: {},
            }))
        : Promise.resolve({
            availability: "unsupported" as const,
            callbackRelayProviders: [],
            providerRevisions: {},
          }),
    ]);
    return this.#resolveProviderAuthorizations({
      applications,
      callbackRelayProviders: hostedMetadata.callbackRelayProviders,
      hostedProviderRevisions: hostedMetadata.providerRevisions,
      hostedOAuthStatus: hostedMetadata.availability,
      posture,
      savedSourceDefaults,
    });
  }

  async configureProviderApplication(
    raw: SaveIntegrationProviderApplication,
    actor: {
      readonly isAdministrator: boolean;
      readonly requestId: string;
      readonly userId: UserId;
    },
  ) {
    const input = SaveIntegrationProviderApplicationSchema.parse(raw);
    const manifest = this.#providerManifest(input.provider);
    const unknownFields = Object.keys(input.secrets).filter(
      (field) => !manifest.secretFields.includes(field as never),
    );
    if (unknownFields.length > 0) {
      throw new OpensteerError({
        code: "bad_request",
        message: `${manifest.label} does not accept ${unknownFields[0]}`,
      });
    }
    const requestedAvailability = input.availability ?? "deployment";
    if (requestedAvailability === "deployment" && !actor.isAdministrator) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Only an administrator can manage a deployment OAuth application",
      });
    }
    const current = input.applicationId
      ? await this.#repository.getProviderApplication(input.applicationId)
      : requestedAvailability === "deployment"
        ? await this.#repository.getSharedProviderApplication(input.provider)
        : null;
    if (input.applicationId && !current) {
      throw new OpensteerError({
        code: "not_found",
        message: "Provider application not found",
      });
    }
    if (
      current &&
      (current.provider !== input.provider ||
        (current.ownerUserId === null
          ? requestedAvailability !== "deployment" || !actor.isAdministrator
          : requestedAvailability !== "personal" || current.ownerUserId !== actor.userId))
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "This provider application belongs to another owner",
      });
    }
    if ((current?.revision ?? null) !== input.expectedRevision) {
      throw new OpensteerError({
        code: "conflict",
        message: "Provider application changed; reload before saving",
      });
    }
    const id = current?.id ?? createIntegrationId("providerApplication");
    const existingSecrets = current
      ? await this.#vault.open(
          current.encryptedSecrets,
          providerApplicationSecretContext(id, input.provider, current.ownerUserId),
        )
      : {};
    const secrets = { ...existingSecrets, ...input.secrets };
    const missingField = manifest.secretFields.find((field) => !secrets[field]);
    if (missingField) {
      throw new OpensteerError({
        code: "bad_request",
        message: `${manifest.label} requires ${humanizeField(missingField)}`,
      });
    }
    const installationUrl =
      input.installationUrl === undefined
        ? (current?.installationUrl ?? null)
        : input.installationUrl;
    if (
      input.provider === "github" &&
      (!installationUrl ||
        !/^https:\/\/github\.com\/apps\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/installations\/new$/u.test(
          installationUrl,
        ))
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "GitHub requires this app's installation URL: https://github.com/apps/<app-slug>/installations/new",
      });
    }
    const sealed = await this.#vault.seal(
      secrets,
      providerApplicationSecretContext(
        id,
        input.provider,
        requestedAvailability === "personal" ? actor.userId : null,
      ),
    );
    const saved = await this.#repository.saveProviderApplication({
      application: {
        clientId: input.clientId,
        installationUrl,
        displayName: input.displayName,
        id,
        ownerUserId: requestedAvailability === "personal" ? actor.userId : null,
        provider: input.provider,
        status: "active",
      },
      actorUserId: actor.userId,
      expectedRevision: input.expectedRevision,
      requestId: actor.requestId,
      secrets: sealed,
    });
    return publicApplication(
      saved,
      this.callbackUrl(saved.provider),
      this.#providerManifest(saved.provider),
      actor.userId,
      actor.isAdministrator,
    );
  }

  async beginAuthorization(input: {
    readonly applicationSource?: "deployment-oauth" | "hosted-oauth";
    readonly exactApplicationSource?: IntegrationOAuthApplicationSource;
    readonly definitionId: string;
    readonly ownerUserId: UserId;
    readonly requestSurface: HostSessionSurface;
    readonly returnPath: string;
    readonly surface: IntegrationAuthAttemptSurface;
  }): Promise<{
    readonly attemptId: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
    readonly expiresAt: Date;
    readonly launchTicket: string;
  }> {
    const definition = await this.#definition(input.definitionId);
    const method = oauthMethod(definition);
    const authorization = (await this.providerAuthorizations(input.ownerUserId))[
      definition.provider
    ];
    if (!authorization) {
      throw new OpensteerError({
        code: "conflict",
        message: `${definition.name} authorization is unavailable`,
      });
    }
    const matchingLegacySources = input.applicationSource
      ? authorization.availableSources.filter(({ kind }) => kind === input.applicationSource)
      : [];
    if (input.applicationSource && matchingLegacySources.length > 1) {
      throw new OpensteerError({
        code: "conflict",
        message: "Choose the exact OAuth application to connect",
      });
    }
    const applicationSource = input.exactApplicationSource
      ? (authorization.availableSources.find((source) =>
          sameIntegrationOAuthApplicationSource(source, input.exactApplicationSource!),
        ) ?? null)
      : input.applicationSource
        ? (matchingLegacySources[0] ?? null)
        : authorization.selectedSource;
    if (!applicationSource) {
      throw new OpensteerError({ code: "conflict", message: authorization.detail });
    }
    if (input.requestSurface === "personal-remote") throw canonicalAuthorizationRequired();
    if (applicationSource.kind === "hosted-oauth") {
      return this.#beginHostedAuthorization(input, definition, method);
    }
    const application = await this.#repository.getProviderApplication(
      applicationSource.providerApplicationId,
    );
    if (
      !application ||
      application.status !== "active" ||
      (application.ownerUserId !== null && application.ownerUserId !== input.ownerUserId) ||
      application.id !== applicationSource.providerApplicationId ||
      application.revision !== applicationSource.providerApplicationRevision
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "The selected provider application changed; reload before connecting",
      });
    }
    const attemptId = createIntegrationId("oauthAttempt");
    const localCallbackUrl = this.callbackUrl(application.provider).toString();
    const usesCallbackRelay = applicationSource.callbackUrl !== localCallbackUrl;
    const hosted = usesCallbackRelay ? this.#hostedOAuth : undefined;
    const account = hosted
      ? validateIntegrationAccountBinding(await hosted.accountSubject(input.ownerUserId))
      : null;
    if (usesCallbackRelay && (!hosted || !account)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Link Opensteer Account to use this provider's HTTPS callback",
      });
    }
    const brokerAttemptId = HostedOAuthAttemptIdSchema.parse(
      `hoa_${attemptId.slice("ioa_".length)}`,
    );
    const hostKeyPair = usesCallbackRelay ? generateOAuthBrokerEphemeralKeyPair() : null;
    const brokerExpiresAt = new Date(
      this.#now().getTime() + integrationAuthAttemptLifetimeMilliseconds,
    );
    const digest = authorizationDigest(definition);
    const started = await this.#attempts.begin({
      flow: "provider-oauth",
      id: attemptId,
      ownerUserId: input.ownerUserId,
      payload: async (state) => {
        const authorization = await buildDeclarativeAuthorizationUrl({
          clientId: application.clientId,
          config: method.oauth,
          redirectUrl: applicationSource.callbackUrl,
          state,
        });
        const relayed =
          hosted && account && hostKeyPair
            ? await hosted.broker.createCallbackRelay({
                accountSubject: { issuer: account.issuer, subject: account.subject },
                attemptId: brokerAttemptId,
                authorizationDigest: digest,
                authorizationUrl: authorization.authorizationUrl,
                clientId: application.clientId,
                clientSurface: input.surface,
                definitionId: definition.id,
                deploymentAuthorityDigest: hosted.deploymentAuthorityDigest,
                expiresAt: brokerExpiresAt.toISOString(),
                hostPublicKey: hostKeyPair.publicKey,
                provider: definition.provider,
                providerApplicationId: application.id,
                providerApplicationRevision: application.revision,
                returnPath: input.returnPath,
              })
            : null;
        return {
          authorizationUrl: relayed?.launchUrl ?? authorization.authorizationUrl,
          payload: serializeProviderAttempt({
            applicationSource: "deployment-oauth",
            authMethodId: method.id,
            authorizationDigest: digest,
            ...(relayed && hosted && account && hostKeyPair
              ? {
                  callbackRelay: {
                    accountIssuer: account.issuer,
                    accountLinkGeneration: account.linkGeneration,
                    accountSubject: account.subject,
                    brokerAttemptId,
                    brokerExpiresAt: relayed.expiresAt,
                    deploymentAuthorityDigest: hosted.deploymentAuthorityDigest,
                    hostPrivateKey: hostKeyPair.privateKey,
                    redirectUrl: applicationSource.callbackUrl,
                  },
                }
              : {}),
            codeVerifier: authorization.codeVerifier ?? null,
            definitionId: definition.id,
            provider: definition.provider,
            providerApplicationId: application.id,
            providerApplicationRevision: application.revision,
            requestedScopes: [...authorization.scopes],
            returnPath: input.returnPath,
          }),
        };
      },
      surface: input.surface,
    });
    return {
      attemptId,
      expiresAt: started.expiresAt,
      launchTicket: started.launchTicket,
    };
  }

  async #beginHostedAuthorization(
    input: {
      readonly definitionId: string;
      readonly ownerUserId: UserId;
      readonly returnPath: string;
      readonly surface: IntegrationAuthAttemptSurface;
    },
    definition: IntegrationDefinition,
    method: Extract<AuthMethod, { kind: "oauth" }>,
  ) {
    const hosted = this.#hostedOAuth;
    const revision = definition.hostedOAuth?.providerApplicationRevision;
    if (!hosted || !revision) {
      throw new OpensteerError({
        code: "conflict",
        message: "Link Opensteer Account or Use your own OAuth app",
      });
    }
    const account = validateIntegrationAccountBinding(
      await hosted.accountSubject(input.ownerUserId),
    );
    if (!account || new URL(account.issuer).origin !== hosted.broker.issuer) {
      throw new OpensteerError({
        code: "conflict",
        message: "Link Opensteer Account or Use your own OAuth app",
      });
    }
    const digest = authorizationDigest(definition);
    const attemptId = createIntegrationId("oauthAttempt");
    const brokerAttemptId = HostedOAuthAttemptIdSchema.parse(
      `hoa_${attemptId.slice("ioa_".length)}`,
    );
    const hostKeyPair = generateOAuthBrokerEphemeralKeyPair();
    const brokerExpiresAt = new Date(
      this.#now().getTime() + integrationAuthAttemptLifetimeMilliseconds,
    );
    const started = await this.#attempts.begin({
      flow: "provider-oauth",
      id: attemptId,
      ownerUserId: input.ownerUserId,
      payload: async () => {
        const created = await hosted.broker.createAttempt({
          accountSubject: { issuer: account.issuer, subject: account.subject },
          attemptId: brokerAttemptId,
          authorizationDigest: digest,
          clientSurface: input.surface,
          definitionId: definition.id,
          deploymentAuthorityDigest: hosted.deploymentAuthorityDigest,
          expiresAt: brokerExpiresAt.toISOString(),
          hostPublicKey: hostKeyPair.publicKey,
          provider: definition.provider,
          providerApplicationRevision: revision,
          returnPath: input.returnPath,
        });
        return {
          authorizationUrl: created.launchUrl,
          payload: serializeProviderAttempt({
            accountIssuer: account.issuer,
            accountLinkGeneration: account.linkGeneration,
            accountSubject: account.subject,
            applicationSource: "hosted-oauth",
            authMethodId: method.id,
            authorizationDigest: digest,
            brokerAttemptId,
            brokerExpiresAt: created.expiresAt,
            definitionId: definition.id,
            deploymentAuthorityDigest: hosted.deploymentAuthorityDigest,
            hostPrivateKey: hostKeyPair.privateKey,
            provider: definition.provider,
            providerApplicationRevision: revision,
            returnPath: input.returnPath,
          }),
        };
      },
      surface: input.surface,
    });
    return { attemptId, expiresAt: started.expiresAt, launchTicket: started.launchTicket };
  }

  async authorizationStatus(input: {
    readonly attemptId: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
    readonly ownerUserId: UserId;
  }) {
    const local = await this.#attempts.status({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    if (!local) return null;
    const rawPayload = await this.#attempts.inspect?.({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    if (!rawPayload) return local;
    const payload = deserializeProviderAttempt(rawPayload);
    if (payload.applicationSource === "deployment-oauth") {
      if (!payload.callbackRelay) return local;
      return this.#callbackRelayAuthorizationStatus(input, local, payload);
    }
    const hosted = this.#hostedOAuth;
    if (local.status === "completed") {
      if (hosted) await hosted.broker.acknowledge(payload.brokerAttemptId).catch(() => undefined);
      return local;
    }
    if (!hosted) {
      await this.#attempts.fail(input.attemptId, "exchange-failed");
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    const account = validateIntegrationAccountBinding(
      await hosted.accountSubject(input.ownerUserId),
    );
    if (
      !account ||
      account.issuer !== payload.accountIssuer ||
      account.subject !== payload.accountSubject ||
      account.linkGeneration !== payload.accountLinkGeneration
    ) {
      await this.#attempts.fail(input.attemptId, "account-link-mismatch");
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    if (local.status !== "launched") return local;
    let remote: Awaited<ReturnType<HostedOAuthBrokerClient["status"]>>;
    try {
      remote = await hosted.broker.status(payload.brokerAttemptId);
    } catch {
      return local;
    }
    if (remote.status === "denied") {
      await this.#attempts.fail(input.attemptId, "denied");
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    if (remote.status === "failed" || remote.status === "expired") {
      await this.#attempts.fail(
        input.attemptId,
        remote.status === "expired" ? "expired" : (remote.failureCode ?? "exchange-failed"),
      );
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    if (remote.status !== "sealed") return local;
    const current = this.#authorizationFlights.get(input.attemptId);
    if (current) {
      await current;
    } else {
      const completion = this.#completeHostedAuthorization(input, payload);
      this.#authorizationFlights.set(input.attemptId, completion);
      try {
        await completion;
      } finally {
        if (this.#authorizationFlights.get(input.attemptId) === completion) {
          this.#authorizationFlights.delete(input.attemptId);
        }
      }
    }
    const completed = await this.#attempts.status({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    return completed;
  }

  async #callbackRelayAuthorizationStatus(
    input: {
      readonly attemptId: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
      readonly ownerUserId: UserId;
    },
    local: {
      readonly connectionId: IntegrationConnectionId | null;
      readonly expiresAt: Date;
      readonly failureCode?: string | null;
      readonly status:
        "pending" | "launched" | "completed" | "denied" | "failed" | "cancelled" | "expired";
    },
    payload: Extract<
      z.infer<typeof ProviderOAuthAttemptPayloadSchema>,
      { applicationSource: "deployment-oauth" }
    >,
  ) {
    const relay = payload.callbackRelay;
    const hosted = this.#hostedOAuth;
    if (!relay) throw invalidProviderAttempt();
    if (local.status === "completed") {
      if (hosted) await hosted.broker.acknowledge(relay.brokerAttemptId).catch(() => undefined);
      return local;
    }
    if (!hosted) {
      await this.#attempts.fail(input.attemptId, "exchange-failed");
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    const account = validateIntegrationAccountBinding(
      await hosted.accountSubject(input.ownerUserId),
    );
    if (
      !account ||
      account.issuer !== relay.accountIssuer ||
      account.subject !== relay.accountSubject ||
      account.linkGeneration !== relay.accountLinkGeneration
    ) {
      await this.#attempts.fail(input.attemptId, "account-link-mismatch");
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    if (local.status !== "launched") return local;
    const remote = await hosted.broker.status(relay.brokerAttemptId).catch(() => null);
    if (!remote) return local;
    if (remote.status === "denied") {
      await this.#attempts.fail(input.attemptId, "denied");
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    if (remote.status === "failed" || remote.status === "expired") {
      await this.#attempts.fail(
        input.attemptId,
        remote.status === "expired" ? "expired" : (remote.failureCode ?? "exchange-failed"),
      );
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    if (remote.status !== "sealed") return local;
    const current = this.#authorizationFlights.get(input.attemptId);
    if (current) await current;
    else {
      const completion = this.#completeCallbackRelayAuthorization(input, payload);
      this.#authorizationFlights.set(input.attemptId, completion);
      try {
        await completion;
      } finally {
        if (this.#authorizationFlights.get(input.attemptId) === completion) {
          this.#authorizationFlights.delete(input.attemptId);
        }
      }
    }
    const completed = await this.#attempts.status({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    return completed;
  }

  async #completeCallbackRelayAuthorization(
    input: {
      readonly attemptId: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
      readonly ownerUserId: UserId;
    },
    expected: Extract<
      z.infer<typeof ProviderOAuthAttemptPayloadSchema>,
      { applicationSource: "deployment-oauth" }
    >,
  ): Promise<void> {
    const hosted = this.#hostedOAuth;
    const relay = expected.callbackRelay;
    if (!hosted || !relay) throw new Error("OAuth callback relay is unavailable");
    const claimed = await this.#attempts.claimHosted?.({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    if (!claimed) throw invalidProviderAttempt();
    const payload = deserializeProviderAttempt(claimed.payload);
    if (
      payload.applicationSource !== "deployment-oauth" ||
      payload.callbackRelay?.brokerAttemptId !== relay.brokerAttemptId
    ) {
      throw invalidProviderAttempt();
    }
    const pulled = await hosted.broker.pull(relay.brokerAttemptId);
    let connection: IntegrationConnectionSummary;
    try {
      if (pulled.status !== "sealed" || !pulled.sealedResult) {
        throw new OpensteerError({
          code: "conflict",
          reason:
            pulled.status === "expired"
              ? "expired"
              : (pulled.failureCode ?? "provider-exchange-failed"),
          message: hostedOAuthFailureMessage(pulled.failureCode, "authorization"),
        });
      }
      const context = OAuthBrokerCallbackRelayContextSchema.parse({
        accountSubject: { issuer: relay.accountIssuer, subject: relay.accountSubject },
        attemptId: relay.brokerAttemptId,
        authorizationDigest: payload.authorizationDigest,
        definitionId: payload.definitionId,
        deploymentAuthorityDigest: relay.deploymentAuthorityDigest,
        expiresAt: relay.brokerExpiresAt,
        providerApplicationId: payload.providerApplicationId,
        providerApplicationRevision: payload.providerApplicationRevision,
        redirectUrl: relay.redirectUrl,
        schemaVersion: 1,
      });
      const { code } = OAuthBrokerAuthorizationCodeBundleSchema.parse(
        openOAuthBrokerPayload(pulled.sealedResult, relay.hostPrivateKey, context),
      );
      const application = await this.#repository.getProviderApplication(
        payload.providerApplicationId,
      );
      if (
        !application ||
        application.status !== "active" ||
        application.revision !== payload.providerApplicationRevision ||
        (application.ownerUserId !== null && application.ownerUserId !== claimed.ownerUserId)
      ) {
        throw new OpensteerError({
          code: "conflict",
          reason: "stale-provider-application",
          message: "The selected provider application changed; start the connection again",
        });
      }
      const definition = await this.#definition(payload.definitionId);
      const method = requiredAuthMethod(definition, payload.authMethodId, "oauth");
      if (authorizationDigest(definition) !== payload.authorizationDigest) {
        throw new OpensteerError({
          code: "conflict",
          reason: "catalog-version-skew",
          message: "Integration authorization changed; start the connection again",
        });
      }
      const applicationSecrets = await this.#vault.open(
        application.encryptedSecrets,
        providerApplicationSecretContext(
          application.id,
          application.provider,
          application.ownerUserId,
        ),
      );
      const credential = await exchangeDeclarativeAuthorization({
        clientId: application.clientId,
        ...(applicationSecrets.clientSecret
          ? { clientSecret: applicationSecrets.clientSecret }
          : {}),
        code,
        ...(payload.codeVerifier ? { codeVerifier: payload.codeVerifier } : {}),
        config: method.oauth,
        fetch: this.#fetch,
        now: this.#now().getTime(),
        redirectUrl: relay.redirectUrl,
      });
      const withheld = missingRequiredScopes({
        config: method.oauth,
        grantedScopes: credential.grantedScopes,
        requiredScopes: payload.requestedScopes,
      });
      if (withheld.length > 0) {
        throw new OpensteerError({
          code: "conflict",
          reason: "scope-escalation",
          message: missingOAuthScopesDetail(withheld, "authorize"),
        });
      }
      const connectionId =
        (await this.#repository.findReusableConnectionId({
          definitionId: definition.id,
          externalIdentityId: credential.externalIdentityId,
          externalTenantId: credential.externalTenantId ?? null,
          ownerUserId: claimed.ownerUserId,
          provider: payload.provider,
        })) ?? createIntegrationId("connection");
      const sealed = await this.#vault.seal(
        credentialSecrets(credential),
        connectionSecretContext(connectionId, claimed.ownerUserId, payload.provider),
      );
      connection = await this.#repository.completeOAuthAttempt({
        attemptId: input.attemptId,
        connection: {
          accountIdentifier: credential.accountIdentifier ?? null,
          applicationSource: {
            callbackUrl: relay.redirectUrl,
            kind: "deployment-oauth",
            providerApplicationId: application.id,
            providerApplicationRevision: application.revision,
          },
          authMethodId: method.id,
          authorizationDigest: payload.authorizationDigest,
          computer: null,
          connectionMethod: "managed-oauth",
          definitionId: definition.id,
          displayName: credential.displayName ?? credential.externalIdentityId,
          externalIdentityId: credential.externalIdentityId,
          externalTenantId: credential.externalTenantId ?? null,
          grantedScopes: [...credential.grantedScopes],
          id: connectionId,
          provider: payload.provider,
          providerApplicationId: application.id,
          status: definition.provider === "github" ? "needs-attention" : "connected",
          statusDetail:
            definition.provider === "github"
              ? "Check repository access to finish connecting GitHub."
              : null,
          statusReason: definition.provider === "github" ? "permissions" : null,
        },
        credential: sealed,
        credentialProvider: `integration:${payload.provider}`,
        ownerUserId: claimed.ownerUserId,
      });
    } catch (error) {
      await this.#attempts
        .fail(input.attemptId, authorizationFailureReason(error))
        .catch(() => undefined);
      throw error;
    }
    // Acknowledgement only releases the broker's temporary copy; the Host has committed.
    await hosted.broker.acknowledge(relay.brokerAttemptId).catch(() => undefined);
    if (connection.provider !== "github")
      await this.#onConnectionConnected({
        connectionId: connection.id,
        ownerUserId: claimed.ownerUserId,
      });
  }

  async #completeHostedAuthorization(
    input: {
      readonly attemptId: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
      readonly ownerUserId: UserId;
    },
    expected: Extract<
      z.infer<typeof ProviderOAuthAttemptPayloadSchema>,
      { applicationSource: "hosted-oauth" }
    >,
  ): Promise<void> {
    const hosted = this.#hostedOAuth;
    if (!hosted) throw new Error("Hosted OAuth is unavailable");
    const claimed = await this.#attempts.claimHosted?.({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    if (!claimed) throw invalidProviderAttempt();
    const payload = deserializeProviderAttempt(claimed.payload);
    if (
      payload.applicationSource !== "hosted-oauth" ||
      payload.brokerAttemptId !== expected.brokerAttemptId
    ) {
      throw invalidProviderAttempt();
    }
    // A sealed result remains pullable until its broker expiry. Keep the
    // claimed local attempt resumable if this call loses its response.
    const pulled = await hosted.broker.pull(payload.brokerAttemptId);
    let connected: IntegrationConnectionId;
    try {
      if (pulled.status !== "sealed" || !pulled.sealedResult) {
        throw new OpensteerError({
          code: "conflict",
          reason:
            pulled.status === "expired"
              ? "expired"
              : (pulled.failureCode ?? "provider-exchange-failed"),
          message: hostedOAuthFailureMessage(pulled.failureCode, "authorization"),
        });
      }
      const context = OAuthBrokerAuthorizationContextSchema.parse({
        accountSubject: { issuer: payload.accountIssuer, subject: payload.accountSubject },
        attemptId: payload.brokerAttemptId,
        authorizationDigest: payload.authorizationDigest,
        definitionId: payload.definitionId,
        deploymentAuthorityDigest: payload.deploymentAuthorityDigest,
        expiresAt: payload.brokerExpiresAt,
        providerApplicationRevision: payload.providerApplicationRevision,
        schemaVersion: 1,
      });
      const bundle = OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(pulled.sealedResult, payload.hostPrivateKey, context),
      );
      const definition = await this.#definition(payload.definitionId);
      const method = requiredAuthMethod(definition, payload.authMethodId, "oauth");
      if (authorizationDigest(definition) !== payload.authorizationDigest) {
        throw new OpensteerError({
          code: "conflict",
          reason: "catalog-version-skew",
          message: "Integration authorization changed; start the connection again",
        });
      }
      if (method.oauth.identity.source === "token-response" && !bundle.tokenResponseIdentity) {
        throw new OpensteerError({
          code: "conflict",
          reason: "invalid-provider-response",
          message: "The authorization result is missing its provider account identity",
        });
      }
      const credential = await extractDeclarativeCredential({
        config: method.oauth,
        ...(bundle.tokenResponseIdentity
          ? { tokenResponseIdentity: bundle.tokenResponseIdentity }
          : {}),
        fetch: this.#fetch,
        now: this.#now().getTime(),
        tokenResponse: {
          access_token: bundle.accessToken,
          ...(bundle.expiresAt === undefined
            ? {}
            : {
                expires_in: Math.max(
                  0,
                  Math.floor((bundle.expiresAt - this.#now().getTime()) / 1_000),
                ),
              }),
          ...(bundle.idToken ? { id_token: bundle.idToken } : {}),
          ...(bundle.refreshToken ? { refresh_token: bundle.refreshToken } : {}),
          scope: bundle.grantedScopes.join(method.oauth.scopeSeparator),
          token_type: bundle.tokenType,
        },
      });
      const withheld = missingRequiredScopes({
        config: method.oauth,
        grantedScopes: bundle.grantedScopes,
        requiredScopes: method.oauth.scopes,
      });
      if (withheld.length > 0) {
        throw new OpensteerError({
          code: "conflict",
          reason: "scope-escalation",
          message: missingOAuthScopesDetail(withheld, "authorize"),
        });
      }
      const connectionId =
        (await this.#repository.findReusableConnectionId({
          definitionId: definition.id,
          externalIdentityId: credential.externalIdentityId,
          externalTenantId: credential.externalTenantId ?? null,
          ownerUserId: claimed.ownerUserId,
          provider: payload.provider,
        })) ?? createIntegrationId("connection");
      const sealed = await this.#vault.seal(
        credentialSecrets({
          accessToken: credential.accessToken,
          ...(bundle.expiresAt === undefined ? {} : { expiresAt: bundle.expiresAt }),
          ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
          tokenType: bundle.tokenType,
        }),
        connectionSecretContext(connectionId, claimed.ownerUserId, payload.provider),
      );
      await this.#repository.completeOAuthAttempt({
        attemptId: input.attemptId,
        connection: {
          accountIdentifier: credential.accountIdentifier ?? null,
          applicationSource: {
            brokerIssuer: hosted.broker.issuer,
            kind: "hosted-oauth",
            providerApplicationRevision: payload.providerApplicationRevision,
          },
          authMethodId: method.id,
          authorizationDigest: payload.authorizationDigest,
          computer: null,
          connectionMethod: "managed-oauth",
          definitionId: definition.id,
          displayName: credential.displayName ?? credential.externalIdentityId,
          externalIdentityId: credential.externalIdentityId,
          externalTenantId: credential.externalTenantId ?? null,
          grantedScopes: [...bundle.grantedScopes],
          id: connectionId,
          provider: payload.provider,
          providerApplicationId: null,
          status: definition.provider === "github" ? "needs-attention" : "connected",
          statusDetail:
            definition.provider === "github"
              ? "Check repository access to finish connecting GitHub."
              : null,
          statusReason: definition.provider === "github" ? "permissions" : null,
        },
        credential: sealed,
        credentialProvider: `integration:${payload.provider}`,
        ownerUserId: claimed.ownerUserId,
      });
      connected = connectionId;
    } catch (error) {
      await this.#attempts
        .fail(input.attemptId, authorizationFailureReason(error))
        .catch(() => undefined);
      throw error;
    }
    await hosted.broker.acknowledge(payload.brokerAttemptId).catch(() => undefined);
    if (payload.provider !== "github")
      await this.#onConnectionConnected({
        connectionId: connected,
        ownerUserId: claimed.ownerUserId,
      });
  }

  async handleAuthorizationCallback(input: {
    readonly attemptId: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
    readonly browserBinding: string;
    readonly parameters: URLSearchParams;
    readonly provider: IntegrationProvider;
    readonly state: string;
  }): Promise<
    | {
        readonly attemptId: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
        readonly returnPath: string;
        readonly status: "denied" | "failed";
        readonly failureReason?: IntegrationAuthAttemptFailureReason;
        readonly surface: IntegrationAuthAttemptSurface;
      }
    | {
        readonly connection: IntegrationConnectionSummary;
        readonly ownerUserId: UserId;
        readonly returnPath: string;
        readonly status: "completed";
        readonly surface: IntegrationAuthAttemptSurface;
      }
  > {
    const attempt = await this.#claimProviderAttempt(input);
    let completed: IntegrationConnectionSummary;
    try {
      const definition = await this.#definition(attempt.definitionId);
      const method = requiredAuthMethod(definition, attempt.authMethodId, "oauth");
      if (authorizationDigest(definition) !== attempt.authorizationDigest) {
        throw new OpensteerError({
          code: "conflict",
          reason: "catalog-version-skew",
          message: "Integration authorization changed; start the connection again",
        });
      }
      const authorizationResponse = validateOAuthAuthorizationResponse({
        clientId: attempt.providerApplication.clientId,
        issuer: method.oauth.issuer ?? null,
        parameters: input.parameters,
      });
      if (authorizationResponse.kind === "error") {
        if (!oauthUserDeniedAuthorization(authorizationResponse.error)) {
          throw new OAuth2Error("The provider rejected authorization", {
            error: authorizationResponse.error,
            failureKind: "provider-error",
          });
        }
        await this.#attempts.fail(attempt.id, "denied");
        return {
          attemptId: attempt.id,
          returnPath: attempt.returnPath,
          status: "denied",
          surface: attempt.surface,
        };
      }
      const applicationSecrets = await this.#vault.open(
        attempt.providerApplication.encryptedSecrets,
        providerApplicationSecretContext(
          attempt.providerApplication.id,
          input.provider,
          attempt.providerApplication.ownerUserId,
        ),
      );
      const credential = await exchangeDeclarativeAuthorization({
        clientId: attempt.providerApplication.clientId,
        ...(applicationSecrets.clientSecret
          ? { clientSecret: applicationSecrets.clientSecret }
          : {}),
        code: authorizationResponse.code,
        ...(attempt.codeVerifier ? { codeVerifier: attempt.codeVerifier } : {}),
        config: method.oauth,
        fetch: this.#fetch,
        now: this.#now().getTime(),
        redirectUrl: this.callbackUrl(attempt.providerApplication.provider).toString(),
      });
      const withheld = missingRequiredScopes({
        config: method.oauth,
        grantedScopes: credential.grantedScopes,
        requiredScopes: attempt.requestedScopes,
      });
      if (withheld.length > 0) {
        throw new OpensteerError({
          code: "conflict",
          reason: "scope-escalation",
          message: missingOAuthScopesDetail(withheld, "authorize"),
        });
      }
      const connectionId =
        (await this.#repository.findReusableConnectionId({
          definitionId: definition.id,
          externalIdentityId: credential.externalIdentityId,
          externalTenantId: credential.externalTenantId ?? null,
          ownerUserId: attempt.ownerUserId,
          provider: input.provider,
        })) ?? createIntegrationId("connection");
      const sealed = await this.#vault.seal(
        credentialSecrets(credential),
        connectionSecretContext(connectionId, attempt.ownerUserId, input.provider),
      );
      const connection = await this.#repository.completeOAuthAttempt({
        attemptId: attempt.id,
        connection: {
          accountIdentifier: credential.accountIdentifier ?? null,
          applicationSource: {
            callbackUrl: this.callbackUrl(attempt.providerApplication.provider).toString(),
            kind: "deployment-oauth",
            providerApplicationId: attempt.providerApplication.id,
            providerApplicationRevision: attempt.providerApplication.revision,
          },
          authMethodId: method.id,
          authorizationDigest: attempt.authorizationDigest,
          computer: null,
          connectionMethod: "managed-oauth",
          definitionId: definition.id,
          displayName: credential.displayName ?? credential.externalIdentityId,
          externalIdentityId: credential.externalIdentityId,
          externalTenantId: credential.externalTenantId ?? null,
          grantedScopes: [...credential.grantedScopes],
          id: connectionId,
          provider: input.provider,
          providerApplicationId: attempt.providerApplication.id,
          status: definition.provider === "github" ? "needs-attention" : "connected",
          statusDetail:
            definition.provider === "github"
              ? "Check repository access to finish connecting GitHub."
              : null,
          statusReason: definition.provider === "github" ? "permissions" : null,
        },
        credential: sealed,
        credentialProvider: `integration:${input.provider}`,
        ownerUserId: attempt.ownerUserId,
      });
      completed = connection;
    } catch (error) {
      const failureReason = authorizationFailureReason(error);
      await this.#attempts.fail(attempt.id, failureReason);
      return {
        attemptId: attempt.id,
        failureReason,
        returnPath: attempt.returnPath,
        status: "failed",
        surface: attempt.surface,
      };
    }
    if (completed.provider !== "github")
      await this.#onConnectionConnected({
        connectionId: completed.id,
        ownerUserId: attempt.ownerUserId,
      });
    return {
      connection: completed,
      ownerUserId: attempt.ownerUserId,
      returnPath: attempt.returnPath,
      status: "completed",
      surface: attempt.surface,
    };
  }

  async connectApiKey(
    raw: ConnectIntegrationApiKey,
    actor: { readonly ownerUserId: UserId; readonly requestId: string },
  ): Promise<IntegrationConnectionSummary> {
    const input = ConnectIntegrationApiKeySchema.parse(raw);
    const definition = await this.#installedDefinition?.(input.definitionId);
    if (!definition) {
      throw new OpensteerError({
        code: "conflict",
        message: "Install this integration before connecting an API key.",
      });
    }
    const method = requiredAuthMethod(definition, input.authMethodId, "api-key");
    const expected = new Set(method.inputs.map(({ variable }) => variable));
    const provided = Object.keys(input.values);
    const invalid = provided.find((variable) => !expected.has(variable));
    const missing = [...expected].find((variable) => !input.values[variable]);
    if (invalid || missing || provided.length !== expected.size) {
      throw new OpensteerError({
        code: "bad_request",
        message: invalid
          ? `${definition.name} does not accept credential value ${invalid}`
          : `${definition.name} requires credential value ${missing ?? "input"}`,
      });
    }
    // A reconnect keeps the account's own name unless the owner gives a new one.
    const reconnected = input.connectionId
      ? ((await this.#repository.listConnections(actor.ownerUserId)).find(
          ({ id }) => id === input.connectionId,
        ) ?? null)
      : null;
    if (input.connectionId && !reconnected) {
      throw new OpensteerError({
        code: "not_found",
        message: "This connection is no longer available to reconnect",
      });
    }
    const health = await this.#adapter(definition.adapter).checkHealth({
      config: definition.config,
      credentialValues: input.values,
      placements: method.placements,
    });
    if (!health.healthy) {
      throw new OpensteerError({
        code: "conflict",
        message:
          health.status === 401 || health.status === 403
            ? `${definition.name} rejected this key.`
            : `Opensteer couldn’t check the key with ${definition.name}${health.status ? ` (HTTP ${health.status})` : ""}. Check the key and permissions, then try again.`,
      });
    }
    const identity = health.identity;
    const connectionId =
      input.connectionId ??
      (identity
        ? ((await this.#repository.findReusableConnectionId({
            definitionId: definition.id,
            externalIdentityId: identity.externalIdentityId,
            externalTenantId: identity.externalTenantId ?? null,
            ownerUserId: actor.ownerUserId,
            provider: definition.provider,
          })) ?? createIntegrationId("connection"))
        : createIntegrationId("connection"));
    const sealed = await this.#vault.seal(
      input.values,
      connectionSecretContext(connectionId, actor.ownerUserId, definition.provider),
    );
    const connection = await this.#repository.connectApiKey({
      reconnect: input.connectionId !== undefined,
      connection: {
        accountIdentifier: identity?.accountIdentifier ?? null,
        applicationSource: { kind: "api-key" },
        authMethodId: method.id,
        authorizationDigest: authorizationDigest(definition),
        computer: null,
        connectionMethod: "api-key",
        definitionId: definition.id,
        displayName:
          input.displayName ??
          reconnected?.displayName ??
          identity?.displayName ??
          identity?.externalIdentityId ??
          definition.name,
        externalIdentityId: identity?.externalIdentityId ?? null,
        externalTenantId: identity?.externalTenantId ?? null,
        grantedScopes: [],
        id: connectionId,
        provider: definition.provider,
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        statusReason: null,
      },
      credential: sealed,
      credentialProvider: `integration:${definition.provider}:api-key`,
      ownerUserId: actor.ownerUserId,
      requestId: actor.requestId,
    });
    await this.#onConnectionConnected({
      connectionId: connection.id,
      ownerUserId: actor.ownerUserId,
    });
    return connection;
  }

  identifyAuthorizationCallback(state: string) {
    return this.#attempts.identifyCallback({ flow: "provider-oauth", state });
  }

  async #claimProviderAttempt(input: {
    readonly attemptId: import("@opensteer/integration-core").IntegrationOAuthAttemptId;
    readonly browserBinding: string;
    readonly provider: IntegrationProvider;
    readonly state: string;
  }) {
    const claimed = await this.#attempts.claim({
      browserBinding: input.browserBinding,
      flow: "provider-oauth",
      id: input.attemptId,
      state: input.state,
    });
    if (!claimed) throw invalidProviderAttempt();
    const payload = deserializeProviderAttempt(claimed.payload);
    if (payload.applicationSource !== "deployment-oauth") {
      await this.#attempts.fail(claimed.id, "exchange-failed");
      throw invalidProviderAttempt();
    }
    const application = await this.#repository.getProviderApplication(
      payload.providerApplicationId,
    );
    if (
      payload.provider !== input.provider ||
      !application ||
      application.id !== payload.providerApplicationId ||
      application.revision !== payload.providerApplicationRevision ||
      application.status !== "active" ||
      (application.ownerUserId !== null && application.ownerUserId !== claimed.ownerUserId)
    ) {
      await this.#attempts.fail(claimed.id, "exchange-failed");
      throw invalidProviderAttempt();
    }
    const definition = await this.#definition(payload.definitionId);
    if (definition.provider !== input.provider) {
      await this.#attempts.fail(claimed.id, "exchange-failed");
      throw invalidProviderAttempt();
    }
    requiredAuthMethod(definition, payload.authMethodId, "oauth");
    return {
      ...payload,
      id: IntegrationOAuthAttemptIdSchema.parse(claimed.id),
      ownerUserId: claimed.ownerUserId,
      providerApplication: application,
      surface: claimed.surface,
    };
  }

  async setProviderApplicationStatus(
    input: {
      readonly applicationId?: IntegrationProviderApplicationId;
      readonly expectedRevision: number;
      readonly provider: IntegrationProvider;
      readonly status: "active" | "disabled";
    },
    actor: {
      readonly isAdministrator: boolean;
      readonly requestId: string;
      readonly userId: UserId;
    },
  ): Promise<IntegrationProviderApplication> {
    const application = input.applicationId
      ? await this.#repository.getProviderApplication(input.applicationId)
      : await this.#repository.getSharedProviderApplication(input.provider);
    if (!application || application.provider !== input.provider) {
      throw new OpensteerError({ code: "not_found", message: "Provider application not found" });
    }
    if (
      application.ownerUserId === null
        ? !actor.isAdministrator
        : application.ownerUserId !== actor.userId
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "This provider application belongs to another owner",
      });
    }
    const saved = await this.#repository.setProviderApplicationStatus({
      actorUserId: actor.userId,
      applicationId: application.id,
      expectedRevision: input.expectedRevision,
      requestId: actor.requestId,
      status: input.status,
    });
    return publicApplication(
      saved,
      this.callbackUrl(saved.provider),
      this.#providerManifest(saved.provider),
      actor.userId,
      actor.isAdministrator,
    );
  }

  async setApplicationSourceDefault(
    input: {
      readonly applicationSource: "deployment-oauth" | "hosted-oauth";
      readonly provider: IntegrationProvider;
    },
    actor: { readonly requestId: string; readonly userId: UserId },
  ): Promise<void> {
    const authorization = (await this.providerAuthorizations(actor.userId))[input.provider];
    const sharedApplication =
      input.applicationSource === "deployment-oauth"
        ? await this.#repository.getSharedProviderApplication(input.provider)
        : null;
    const sourceAvailable = authorization?.availableSources.some((source) =>
      input.applicationSource === "hosted-oauth"
        ? source.kind === "hosted-oauth"
        : source.kind === "deployment-oauth" &&
          sharedApplication !== null &&
          source.providerApplicationId === sharedApplication.id,
    );
    if (!sourceAvailable) {
      throw new OpensteerError({
        code: "conflict",
        message:
          input.applicationSource === "hosted-oauth"
            ? "Link Opensteer Account before selecting hosted OAuth"
            : "Configure and enable your OAuth app before selecting it",
      });
    }
    await this.#repository.setApplicationSourceDefault({
      actorUserId: actor.userId,
      applicationSource: input.applicationSource,
      provider: input.provider,
      requestId: actor.requestId,
    });
  }

  /**
   * Disconnecting is always possible. Upstream revocation is best effort: when
   * this Deployment holds nothing it could revoke with, the local credential is
   * destroyed anyway and the caller is told the token may still be live at the
   * provider — leaving the account connected because the provider is out of
   * reach would strand the user with a credential they cannot remove, and
   * reporting success would claim a revocation that never happened.
   */
  async disconnect(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<IntegrationDisconnectOutcome> {
    const record = await this.#repository.getConnectionForRevocation(input);
    if (!record) {
      throw new OpensteerError({ code: "not_found", message: "Integration connection not found" });
    }
    let outcome: IntegrationDisconnectOutcome = { notice: null, revokedUpstream: false };
    if (record.connection.connectionMethod !== "api-key") {
      try {
        const secrets = await this.#vault.open(
          record.encryptedCredential,
          connectionSecretContext(
            record.connection.id,
            input.ownerUserId,
            record.connection.provider,
          ),
        );
        const definition = await this.#definition(record.connection.definitionId, {
          allowUnavailable: true,
        });
        const method = definition.authMethods.find(
          ({ id }) => id === record.connection.authMethodId,
        );
        if (method?.kind === "oauth") {
          const application = record.providerApplication;
          const applicationSecrets = application
            ? await this.#vault.open(
                application.encryptedSecrets,
                providerApplicationSecretContext(
                  application.id,
                  application.provider,
                  application.ownerUserId,
                ),
              )
            : undefined;
          const accessToken = secrets.accessToken;
          const obstacle = !method.oauth.revocation
            ? `${definition.name} declares no token revocation endpoint`
            : !application && record.connection.applicationSource?.kind !== "hosted-oauth"
              ? "the OAuth application it was authorized with is no longer configured"
              : null;
          if (obstacle !== null || accessToken === undefined) {
            outcome = {
              notice: unrevokedTokenNotice(
                definition.name,
                obstacle ?? "this Deployment no longer holds an access token for it",
              ),
              revokedUpstream: false,
            };
          } else {
            try {
              if (
                record.connection.applicationSource?.kind === "hosted-oauth" &&
                method.oauth.revocation?.clientAuth !== "none"
              ) {
                await this.#revokeHostedCredential(record, input.ownerUserId, secrets, definition);
              } else
                await revokeDeclarativeCredential({
                  accessToken,
                  clientId: application?.clientId ?? "opensteer-hosted-oauth",
                  ...(applicationSecrets?.clientSecret
                    ? { clientSecret: applicationSecrets.clientSecret }
                    : {}),
                  config: method.oauth,
                  fetch: this.#fetch,
                  ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
                });
              outcome = { notice: null, revokedUpstream: true };
            } catch {
              outcome = {
                notice: unrevokedTokenNotice(
                  definition.name,
                  "the provider did not accept its revocation request",
                ),
                revokedUpstream: false,
              };
            }
          }
        }
      } catch {
        outcome = {
          notice: unrevokedTokenNotice(
            record.connection.provider,
            "this Deployment could not prepare its revocation request",
          ),
          revokedUpstream: false,
        };
      }
    }
    const credential = await this.#vault.seal(
      { status: "revoked" },
      connectionSecretContext(record.connection.id, input.ownerUserId, record.connection.provider),
    );
    await this.#repository.revokeConnection({ ...input, credential });
    return outcome;
  }

  async #revokeHostedCredential(
    record: IntegrationConnectionSecretRecord,
    ownerUserId: UserId,
    secrets: Readonly<Record<string, string>>,
    definition: IntegrationDefinition,
  ): Promise<void> {
    const source = record.connection.applicationSource;
    const hosted = this.#hostedOAuth;
    if (source?.kind !== "hosted-oauth" || !hosted || hosted.broker.issuer !== source.brokerIssuer)
      throw new Error("Hosted OAuth service is unavailable");
    const account = validateIntegrationAccountBinding(await hosted.accountSubject(ownerUserId));
    if (!account) throw new Error("Opensteer Account link is unavailable");
    const metadata = await hosted.broker.metadata();
    if (
      metadata.providerRevisions[record.connection.provider] !== source.providerApplicationRevision
    )
      throw new Error("Hosted OAuth application revision changed");
    const context = OAuthBrokerRevocationContextSchema.parse({
      accountSubject: { issuer: account.issuer, subject: account.subject },
      authorizationDigest: record.connection.authorizationDigest,
      definitionId: definition.id,
      deploymentAuthorityDigest: hosted.deploymentAuthorityDigest,
      expiresAt: new Date(this.#now().getTime() + 120_000).toISOString(),
      provider: record.connection.provider,
      providerApplicationRevision: source.providerApplicationRevision,
      schemaVersion: 1,
      transactionId: HostedOAuthRevocationTransactionIdSchema.parse(`hov_${crypto.randomUUID()}`),
    });
    const { schemaVersion: _schemaVersion, ...request } = context;
    const result = await hosted.broker.revoke({
      ...request,
      brokerSealedCredential: sealOAuthBrokerPayload(
        {
          accessToken: secrets.accessToken,
          ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
        },
        metadata.encryptionPublicKey,
        context,
      ),
    });
    if (!result.revoked || result.transactionId !== context.transactionId)
      throw new Error("Hosted OAuth revocation was not confirmed");
  }

  async checkRepositoryAccess(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<import("@opensteer/integration-core").IntegrationRepositoryAccess> {
    let record = await this.#repository.getConnectionForRevocation(input);
    if (
      !record ||
      record.connection.provider !== "github" ||
      !["connected", "needs-attention"].includes(record.connection.status)
    ) {
      throw new OpensteerError({ code: "not_found", message: "GitHub connection not found" });
    }
    const definition = await this.#definition(record.connection.definitionId);
    if (record.connection.authorizationDigest !== authorizationDigest(definition)) {
      return this.#signInRequired(record, input.ownerUserId, authorizationChangedDetail);
    }
    const source = record.connection.applicationSource;
    const authorization = (await this.providerAuthorizations(input.ownerUserId)).github;
    if (
      !source ||
      !integrationApplicationSourcePinnedAndAvailable({ applicationSource: source, authorization })
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: integrationApplicationSourceUnavailableDetail,
      });
    }
    let installationUrl: string | null = null;
    if (source.kind === "hosted-oauth") {
      const metadata = await this.#hostedOAuth?.broker.metadata();
      if (!metadata || metadata.providerRevisions.github !== source.providerApplicationRevision) {
        throw new OpensteerError({
          code: "conflict",
          message: integrationApplicationSourceUnavailableDetail,
        });
      }
      installationUrl = metadata.installationUrls?.github ?? null;
    } else if (source.kind === "deployment-oauth") {
      installationUrl = record.providerApplication?.installationUrl ?? null;
    } else {
      throw new OpensteerError({
        code: "bad_request",
        message: "GitHub repository setup requires a GitHub App account.",
      });
    }
    let secrets = await this.#vault.open(
      record.encryptedCredential,
      connectionSecretContext(record.connection.id, input.ownerUserId, "github"),
    );
    const expiresAt = secrets.expiresAt === undefined ? null : Number(secrets.expiresAt);
    if (expiresAt !== null && !Number.isFinite(expiresAt)) {
      return this.#signInRequired(record, input.ownerUserId, invalidTokenExpiryDetail);
    }
    if (shouldRefreshToken({ expiresAt, now: this.#now().getTime() })) {
      const existing = this.#refreshFlights.get(input.connectionId);
      if (existing) secrets = await existing;
      else {
        const refresh = this.#refreshOAuthConnection(record, input.ownerUserId, secrets, true);
        this.#refreshFlights.set(input.connectionId, refresh);
        try {
          secrets = await refresh;
        } finally {
          if (this.#refreshFlights.get(input.connectionId) === refresh)
            this.#refreshFlights.delete(input.connectionId);
        }
      }
      const refreshed = await this.#repository.getConnectionForRevocation(input);
      if (
        !refreshed ||
        refreshed.connection.status === "revoked" ||
        refreshed.connection.authorizationDigest !== record.connection.authorizationDigest ||
        refreshed.credentialGeneration !== record.credentialGeneration + 1 ||
        (refreshed.connection.applicationSource?.kind !== "hosted-oauth" &&
          refreshed.connection.applicationSource?.kind !== "deployment-oauth") ||
        !sameIntegrationOAuthApplicationSource(refreshed.connection.applicationSource, source)
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "GitHub connection changed. Retry the check.",
        });
      }
      record = refreshed;
    }
    if (!secrets.accessToken)
      throw new OpensteerError({ code: "conflict", message: "Reconnect your GitHub account." });
    const result = await inspectGitHubRepositoryAccess({
      accessToken: secrets.accessToken,
      fetch: this.#fetch,
      installationUrl,
    });
    if (result === "credential-rejected") {
      return this.#signInRequired(
        record,
        input.ownerUserId,
        integrationCredentialRejectedDetail(definition.name, "sign-in"),
      );
    }
    const currentAuthorization = (await this.providerAuthorizations(input.ownerUserId)).github;
    if (
      !integrationApplicationSourcePinnedAndAvailable({
        applicationSource: source,
        authorization: currentAuthorization,
      })
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: integrationApplicationSourceUnavailableDetail,
      });
    }
    if (
      record.connection.status !== "connected" &&
      record.connection.status !== "needs-attention"
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "GitHub connection is no longer active.",
      });
    }
    const updated = await this.#repository.setConnectionRepositoryAccess({
      ...input,
      expectedGeneration: record.credentialGeneration,
      expectedApplicationSource: source,
      expectedStatus: record.connection.status,
      expectedStatusDetail: record.connection.statusDetail,
      status: result.ready ? "connected" : "needs-attention",
      statusDetail: result.ready
        ? null
        : "Install or configure this GitHub App for at least one repository you can access, then check again.",
      statusReason: result.ready ? null : "permissions",
    });
    if (!updated)
      throw new OpensteerError({
        code: "conflict",
        message: "GitHub connection changed. Retry the check.",
      });
    if (result.ready && record.connection.status !== "connected")
      await this.#onConnectionConnected(input);
    return result;
  }

  async materializeForAdapter(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly forceRefresh?: boolean;
    readonly operation: string;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly authMethodId: string;
    readonly connectionMethod: IntegrationConnectionSummary["connectionMethod"];
    readonly credentialGeneration: number;
    readonly credentialValues: Readonly<Record<string, string>>;
    readonly definitionId: string;
    readonly grantedScopes: readonly string[];
    readonly provider: IntegrationProvider;
  }> {
    if (!/^[a-zA-Z0-9_.:/-]{1,256}$/u.test(input.operation)) {
      throw new OpensteerError({ code: "bad_request", message: "Adapter operation is invalid" });
    }
    return this.#materializeForAdapter(input);
  }

  async markAdapterAuthorizationRequired(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly expectedGeneration: number;
    readonly ownerUserId: UserId;
    readonly statusDetail: string;
  }): Promise<void> {
    await this.#repository.markConnectionNeedsAttention(input);
  }

  async #materializeForAdapter(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly forceRefresh?: boolean;
    readonly operation: string;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly authMethodId: string;
    readonly connectionMethod: IntegrationConnectionSummary["connectionMethod"];
    readonly credentialGeneration: number;
    readonly credentialValues: Readonly<Record<string, string>>;
    readonly definitionId: string;
    readonly grantedScopes: readonly string[];
    readonly provider: IntegrationProvider;
  }> {
    const record = await this.#repository.getConnectionForAccess(input);
    if (!record) {
      throw new OpensteerError({ code: "not_found", message: "Integration connection not found" });
    }
    const definition = await this.#definition(record.connection.definitionId);
    if (record.connection.authorizationDigest !== authorizationDigest(definition)) {
      return this.#signInRequired(record, input.ownerUserId, authorizationChangedDetail);
    }
    const applicationSource = record.connection.applicationSource;
    if (
      applicationSource?.kind === "hosted-oauth" ||
      applicationSource?.kind === "deployment-oauth"
    ) {
      const authorization = (await this.providerAuthorizations(input.ownerUserId))[
        record.connection.provider
      ];
      if (!integrationApplicationSourcePinnedAndAvailable({ applicationSource, authorization })) {
        await this.#repository.markConnectionNeedsAttention({
          connectionId: input.connectionId,
          expectedGeneration: record.credentialGeneration,
          ownerUserId: input.ownerUserId,
          statusDetail: integrationApplicationSourceUnavailableDetail,
        });
        throw new OpensteerError({
          code: "conflict",
          message: integrationApplicationSourceUnavailableDetail,
        });
      }
    }
    let secrets = await this.#vault.open(
      record.encryptedCredential,
      connectionSecretContext(record.connection.id, input.ownerUserId, record.connection.provider),
    );
    // A refresh replaces the credential under the next generation.
    let credentialGeneration = record.credentialGeneration;
    if (record.connection.connectionMethod === "managed-oauth") {
      const expiresAt = secrets.expiresAt ? Number(secrets.expiresAt) : null;
      if (expiresAt !== null && !Number.isFinite(expiresAt)) {
        await this.#repository.markConnectionNeedsAttention({
          connectionId: input.connectionId,
          expectedGeneration: record.credentialGeneration,
          ownerUserId: input.ownerUserId,
          statusDetail: invalidTokenExpiryDetail,
        });
        throw new OpensteerError({ code: "conflict", message: "Integration must be reconnected" });
      }
      if (input.forceRefresh || shouldRefreshToken({ expiresAt, now: this.#now().getTime() })) {
        if (!secrets.refreshToken) {
          await this.#repository.markConnectionNeedsAttention({
            connectionId: input.connectionId,
            expectedGeneration: record.credentialGeneration,
            ownerUserId: input.ownerUserId,
            statusDetail: "The provider token cannot be refreshed; reconnect this account.",
          });
          throw new OpensteerError({
            code: "conflict",
            message: "Integration must be reconnected",
          });
        }
        const current = this.#refreshFlights.get(input.connectionId);
        if (current) {
          secrets = await current;
        } else {
          const refresh = this.#refreshOAuthConnection(record, input.ownerUserId, secrets);
          this.#refreshFlights.set(input.connectionId, refresh);
          try {
            secrets = await refresh;
          } finally {
            if (this.#refreshFlights.get(input.connectionId) === refresh) {
              this.#refreshFlights.delete(input.connectionId);
            }
          }
        }
        credentialGeneration = record.credentialGeneration + 1;
      }
      if (!secrets.accessToken) throw new Error("OAuth access token is unavailable");
      secrets = { accessToken: secrets.accessToken };
    }
    await this.#repository.recordConnectionAccess(input);
    return {
      authMethodId: record.connection.authMethodId,
      connectionMethod: record.connection.connectionMethod,
      credentialGeneration,
      credentialValues: secrets,
      definitionId: record.connection.definitionId,
      grantedScopes: record.connection.grantedScopes,
      provider: record.connection.provider,
    };
  }

  /**
   * Records a refusal only a new sign-in can fix, fenced to the credential it
   * judged, so the account is offered that sign-in and not the refused step
   * again.
   */
  async #signInRequired(
    record: IntegrationConnectionSecretRecord,
    ownerUserId: UserId,
    statusDetail: string,
  ): Promise<never> {
    await this.#repository.markConnectionNeedsAttention({
      connectionId: record.connection.id,
      expectedGeneration: record.credentialGeneration,
      ownerUserId,
      statusDetail,
    });
    throw new OpensteerError({ code: "conflict", message: statusDetail });
  }

  async #refreshOAuthConnection(
    record: IntegrationConnectionSecretRecord,
    ownerUserId: UserId,
    current: Readonly<Record<string, string>>,
    allowNeedsAttention = false,
  ): Promise<Readonly<Record<string, string>>> {
    const refreshToken = current.refreshToken;
    if (!refreshToken) throw new Error("OAuth refresh token is unavailable");
    const definition = await this.#definition(record.connection.definitionId);
    const method = requiredAuthMethod(definition, record.connection.authMethodId, "oauth");
    let secrets: Readonly<Record<string, string>>;
    let acknowledge: (() => Promise<void>) | undefined;
    if (record.connection.applicationSource?.kind === "hosted-oauth") {
      const hosted = this.#hostedOAuth;
      if (!hosted || hosted.broker.issuer !== record.connection.applicationSource.brokerIssuer) {
        throw new Error("Opensteer hosted OAuth service is unavailable");
      }
      const account = validateIntegrationAccountBinding(await hosted.accountSubject(ownerUserId));
      if (!account) throw new Error("Opensteer Account link is unavailable");
      const metadata = await hosted.broker.metadata();
      const revision = record.connection.applicationSource.providerApplicationRevision;
      if (metadata.providerRevisions[record.connection.provider] !== revision) {
        throw new Error("Hosted OAuth provider application revision is stale");
      }
      const transactionId = HostedOAuthRefreshTransactionIdSchema.parse(
        `hor_${crypto.randomUUID()}`,
      );
      const hostKeys = generateOAuthBrokerEphemeralKeyPair();
      const expiresAt = new Date(this.#now().getTime() + 2 * 60 * 1_000).toISOString();
      const context = OAuthBrokerRefreshContextSchema.parse({
        authorizationDigest: record.connection.authorizationDigest,
        definitionId: definition.id,
        deploymentAuthorityDigest: hosted.deploymentAuthorityDigest,
        expiresAt,
        providerApplicationRevision: revision,
        schemaVersion: 1,
        transactionId,
      });
      const brokerSealedCredential = sealOAuthBrokerPayload(
        { refreshToken },
        metadata.encryptionPublicKey,
        context,
      );
      const created = await hosted.broker.refresh({
        accountSubject: { issuer: account.issuer, subject: account.subject },
        authorizationDigest: record.connection.authorizationDigest,
        brokerSealedCredential,
        definitionId: definition.id,
        deploymentAuthorityDigest: hosted.deploymentAuthorityDigest,
        expiresAt,
        grantedScopes: record.connection.grantedScopes,
        hostPublicKey: hostKeys.publicKey,
        provider: record.connection.provider,
        providerApplicationRevision: revision,
        transactionId,
      });
      if (created.status === "failed") {
        return this.#throwRefreshFailure(
          record,
          ownerUserId,
          created.failureCode,
          created.providerError,
        );
      }
      const pulled = await hosted.broker.pullRefresh(transactionId);
      if (pulled.status !== "sealed" || !pulled.sealedResult) {
        return this.#throwRefreshFailure(
          record,
          ownerUserId,
          pulled.failureCode,
          pulled.providerError,
        );
      }
      const bundle = OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(pulled.sealedResult, hostKeys.privateKey, context),
      );
      const withheld = missingRequiredScopes({
        config: method.oauth,
        grantedScopes: bundle.grantedScopes,
        requiredScopes: method.oauth.scopes,
      });
      if (withheld.length > 0) {
        const statusDetail = missingOAuthScopesDetail(withheld, "reconnect");
        await this.#repository.markConnectionNeedsAttention({
          connectionId: record.connection.id,
          expectedGeneration: record.credentialGeneration,
          ownerUserId,
          statusDetail,
        });
        throw new OpensteerError({ code: "conflict", message: statusDetail });
      }
      secrets = credentialSecrets({
        accessToken: bundle.accessToken,
        ...(bundle.expiresAt === undefined ? {} : { expiresAt: bundle.expiresAt }),
        refreshToken: bundle.refreshToken ?? refreshToken,
        tokenType: bundle.tokenType,
      });
      acknowledge = () => hosted.broker.acknowledgeRefresh(transactionId);
    } else {
      const application = record.providerApplication;
      if (!application) throw new Error("OAuth provider application is unavailable");
      const applicationSecrets = await this.#vault.open(
        application.encryptedSecrets,
        providerApplicationSecretContext(
          application.id,
          application.provider,
          application.ownerUserId,
        ),
      );
      let refreshed: Awaited<ReturnType<typeof refreshDeclarativeCredential>>;
      try {
        refreshed = await refreshDeclarativeCredential({
          clientId: application.clientId,
          ...(applicationSecrets.clientSecret
            ? { clientSecret: applicationSecrets.clientSecret }
            : {}),
          config: method.oauth,
          fetch: this.#fetch,
          grantedScopes: record.connection.grantedScopes,
          now: this.#now().getTime(),
          refreshToken,
        });
      } catch (error) {
        if (!(error instanceof OAuth2Error)) throw error;
        return this.#throwRefreshFailure(
          record,
          ownerUserId,
          oauthFailureKind(error.error),
          providerErrorCode(error.error),
        );
      }
      const withheld = missingRequiredScopes({
        config: method.oauth,
        grantedScopes: refreshed.grantedScopes,
        requiredScopes: method.oauth.scopes,
      });
      if (withheld.length > 0) {
        const statusDetail = missingOAuthScopesDetail(withheld, "reconnect");
        await this.#repository.markConnectionNeedsAttention({
          connectionId: record.connection.id,
          expectedGeneration: record.credentialGeneration,
          ownerUserId,
          statusDetail,
        });
        throw new OpensteerError({ code: "conflict", message: statusDetail });
      }
      secrets = credentialSecrets(refreshed);
    }
    const sealed = await this.#vault.seal(
      secrets,
      connectionSecretContext(record.connection.id, ownerUserId, record.connection.provider),
    );
    const replaced = await this.#repository.replaceConnectionCredential({
      connectionId: record.connection.id,
      credential: sealed,
      expectedGeneration: record.credentialGeneration,
      ...(allowNeedsAttention ? { allowNeedsAttention: true } : {}),
      ownerUserId,
    });
    if (!replaced) {
      throw new OpensteerError({
        code: "conflict",
        message: "Integration token changed while it was being refreshed",
        retryable: true,
      });
    }
    await acknowledge?.();
    return secrets;
  }

  /**
   * Routes a refused token refresh by what the refusal actually proves. Only a rejected grant is
   * evidence that this account must be reconnected, so only that branch touches the connection: a
   * refused OAuth application is the operator's to fix and an unclassified refusal may well be a
   * passing outage, and marking either one would send the person to a reconnect that cannot help.
   */
  async #throwRefreshFailure(
    record: IntegrationConnectionSecretRecord,
    ownerUserId: UserId,
    failureCode: string | null,
    providerError: string | null,
  ): Promise<never> {
    const reported = providerError ? ` (${providerError})` : "";
    if (failureCode === "grant-rejected" || failureCode === "scope-escalation") {
      await this.#repository.markConnectionNeedsAttention({
        connectionId: record.connection.id,
        expectedGeneration: record.credentialGeneration,
        ownerUserId,
        statusDetail:
          failureCode === "scope-escalation"
            ? "OAuth scopes were reduced; reauthorization required."
            : `The provider rejected this account's sign-in grant${reported}; reconnect this account.`,
      });
      throw new OpensteerError({ code: "conflict", message: "Reauthorization required" });
    }
    if (failureCode === "client-rejected") {
      throw new OpensteerError({
        code: "internal",
        message: `The ${record.connection.provider} OAuth application was rejected by the provider${reported}; reconnecting accounts will not fix this.`,
      });
    }
    throw new OpensteerError({
      code: "workspace_unavailable",
      message: `The provider token refresh did not complete${reported}; this may be temporary — retry.`,
      retryable: true,
    });
  }

  /** Resolves the canonical provider authorization table; surface projection happens separately. */
  #resolveProviderAuthorizations(input: {
    readonly applications: readonly IntegrationProviderApplicationRecord[];
    readonly callbackRelayProviders: readonly string[];
    readonly hostedProviderRevisions: Readonly<Record<string, number>>;
    readonly hostedOAuthStatus: "available" | "temporarily-unavailable" | "unsupported";
    readonly posture: IntegrationDeploymentPosture;
    readonly savedSourceDefaults: Readonly<Record<string, "deployment-oauth" | "hosted-oauth">>;
  }): Readonly<Record<string, IntegrationProviderAuthorization>> {
    return Object.fromEntries(
      this.#providerManifests.map((manifest) => {
        const availableSources: IntegrationOAuthApplicationSource[] = [];
        const hostedRevision = this.#hostedProviderApplicationRevision(manifest.provider);
        if (
          this.#hostedOAuth &&
          hostedRevision &&
          input.hostedProviderRevisions[manifest.provider] === hostedRevision
        ) {
          availableSources.push({
            brokerIssuer: this.#hostedOAuth.broker.issuer,
            kind: "hosted-oauth",
            providerApplicationRevision: hostedRevision,
          });
        }
        const applications = input.applications.filter(
          (application) =>
            application.provider === manifest.provider && application.status === "active",
        );
        const requiresRelay =
          providerRequiresHttpsCallback(manifest.provider) && this.#publicUrl.protocol !== "https:";
        const callbackUrl = requiresRelay
          ? this.#hostedOAuth && input.callbackRelayProviders.includes(manifest.provider)
            ? this.#hostedOAuth.broker.callbackUrl(manifest.provider)
            : null
          : this.callbackUrl(manifest.provider).toString();
        const deploymentSources = callbackUrl
          ? applications.map(
              (application) =>
                ({
                  callbackUrl,
                  kind: "deployment-oauth",
                  providerApplicationId: application.id,
                  providerApplicationRevision: application.revision,
                }) satisfies IntegrationOAuthApplicationSource,
            )
          : [];
        availableSources.push(...deploymentSources);

        const savedKind = input.savedSourceDefaults[manifest.provider];
        const hostedSource = availableSources.find(({ kind }) => kind === "hosted-oauth") ?? null;
        const sharedApplication = applications.find(({ ownerUserId }) => ownerUserId === null);
        const sharedSource = sharedApplication
          ? (deploymentSources.find(
              (source) => source.providerApplicationId === sharedApplication.id,
            ) ?? null)
          : null;
        const hostedCouldBeAvailable = Boolean(this.#hostedOAuth && hostedRevision);
        const selectedSource = savedKind
          ? savedKind === "hosted-oauth"
            ? hostedSource
            : sharedSource
          : (hostedSource ??
            (hostedCouldBeAvailable && input.hostedOAuthStatus === "temporarily-unavailable"
              ? null
              : deploymentSources.length === 1
                ? deploymentSources[0]!
                : null));
        const selectedSourceKind = savedKind ?? selectedSource?.kind ?? null;
        const failure =
          !selectedSource &&
          hostedCouldBeAvailable &&
          input.hostedOAuthStatus === "temporarily-unavailable"
            ? {
                code: "HOSTED_OAUTH_TEMPORARILY_UNAVAILABLE" as const,
                detail: "Opensteer managed sign-in availability could not be checked; retry",
              }
            : !selectedSource && hostedCouldBeAvailable && !hostedSource
              ? {
                  code: "OAUTH_SOURCE_UNAVAILABLE" as const,
                  detail: "Opensteer managed sign-in is not available for this integration yet",
                }
              : requiresRelay && callbackUrl === null
                ? {
                    code: "ACCOUNT_LINK_REQUIRED" as const,
                    detail: this.#hostedOAuth
                      ? "Link Opensteer Account to give this provider the stable HTTPS callback it requires"
                      : "This provider requires an HTTPS callback. Opensteer managed sign-in isn’t available yet; use a deployment with a public HTTPS address and your own OAuth app.",
                  }
                : providerAuthorizationFailure(input.posture, selectedSourceKind);
        return [
          manifest.provider,
          IntegrationProviderAuthorizationSchema.parse({
            availableSources,
            code: selectedSource ? "READY" : failure.code,
            detail: selectedSource
              ? selectedSource.kind === "hosted-oauth"
                ? "Ready to connect through Opensteer hosted OAuth"
                : "Ready to connect through this deployment's OAuth application"
              : failure.detail,
            selectedSource,
            selectedSourceKind,
            hostedOAuthStatus: hostedCouldBeAvailable ? input.hostedOAuthStatus : "unsupported",
          }),
        ];
      }),
    );
  }

  callbackUrl(provider: IntegrationProvider): URL {
    return new URL(`/v1/integrations/oauth/callback/${provider}`, this.#publicUrl);
  }

  #customApplicationCallbackUrl(
    provider: IntegrationProvider,
    callbackRelayProviders: readonly string[],
  ): string | null {
    if (providerRequiresHttpsCallback(provider) && this.#publicUrl.protocol !== "https:") {
      if (this.#hostedOAuth && callbackRelayProviders.includes(provider)) {
        return this.#hostedOAuth.broker.callbackUrl(provider);
      }
      return null;
    }
    return this.callbackUrl(provider).toString();
  }

  #adapter(kind: IntegrationAdapterKind): IntegrationAdapter {
    const adapter = this.#adapters.get(kind);
    if (!adapter) throw new Error(`Integration adapter ${kind} is not registered`);
    return adapter;
  }

  /** Installed adapter configuration is the authority for both connection and invocation. */
  async #definition(
    id: string,
    options?: { readonly allowUnavailable: boolean },
  ): Promise<IntegrationDefinition> {
    const catalogued = this.#definitions.find((candidate) => candidate.id === id);
    // Computer apps have no adapter snapshot; their execution contract is shipped with the Host.
    if (catalogued?.adapter === "computer") return catalogued;
    const installed = options
      ? await this.#installedDefinition?.(id, options)
      : await this.#installedDefinition?.(id);
    const definition = installed ?? catalogued;
    if (!definition) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Integration definition ${id} is in neither the catalog nor any installation`,
      });
    }
    return definition;
  }

  #providerManifest(provider: IntegrationProvider): IntegrationProviderManifest {
    const manifest = this.#providerManifests.find((candidate) => candidate.provider === provider);
    if (!manifest) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Integration provider ${provider} has no OAuth application`,
      });
    }
    return manifest;
  }

  #hostedProviderApplicationRevision(provider: IntegrationProvider): number | null {
    const definition = this.#definitions.find(
      (candidate) => candidate.provider === provider && candidate.hostedOAuth,
    );
    return definition?.hostedOAuth?.providerApplicationRevision ?? null;
  }
}

/**
 * A non-canonical surface cannot launch authorization, but the resolved sources stay descriptive:
 * the administrator picker renders from them and admin mutations accept these sessions.
 */
function projectProviderAuthorizationsForSurface(
  authorizations: Readonly<Record<string, IntegrationProviderAuthorization>>,
  surface: IntegrationAuthorizationSurface,
): Readonly<Record<string, IntegrationProviderAuthorization>> {
  if (surface === "canonical") return authorizations;
  return Object.fromEntries(
    Object.entries(authorizations).map(([provider, authorization]) => [
      provider,
      IntegrationProviderAuthorizationSchema.parse({
        ...authorization,
        code: "CANONICAL_SURFACE_REQUIRED",
        detail: canonicalAuthorizationRepair,
      }),
    ]),
  );
}

function projectConnectionAuthorizationHealth(
  connection: IntegrationConnectionSummary,
  authorizations: Readonly<Record<string, IntegrationProviderAuthorization>>,
  applications: readonly IntegrationProviderApplicationRecord[],
): IntegrationConnectionSummary {
  // An account waiting only for permissions holds a working credential, so its
  // OAuth app's health decides its repair as it would a connected account's.
  if (
    connection.status === "revoked" ||
    connection.status === "paused" ||
    (connection.status === "needs-attention" && connection.statusReason !== "permissions")
  ) {
    return connection;
  }
  if (connection.applicationSource?.kind === "deployment-oauth") {
    const source = connection.applicationSource;
    const application = applications.find(({ id }) => id === source.providerApplicationId);
    if (
      !application ||
      application.status !== "active" ||
      application.revision !== source.providerApplicationRevision ||
      application.provider !== connection.provider
    ) {
      return {
        ...connection,
        status: "needs-attention",
        statusDetail: integrationApplicationSourceUnavailableDetail,
        statusReason: null,
      };
    }
  }
  if (
    integrationApplicationSourcePinnedAndAvailable({
      applicationSource: connection.applicationSource,
      authorization: authorizations[connection.provider],
    })
  ) {
    return connection;
  }
  return {
    ...connection,
    status: "needs-attention",
    statusDetail: integrationApplicationSourceUnavailableDetail,
    statusReason: null,
  };
}

function providerAuthorizationFailure(
  posture: IntegrationDeploymentPosture,
  selectedSourceKind: "deployment-oauth" | "hosted-oauth" | null,
): Pick<IntegrationProviderAuthorization, "code" | "detail"> {
  if (selectedSourceKind === "hosted-oauth") {
    return posture === "account-free-personal"
      ? {
          code: "ACCOUNT_LINK_REQUIRED",
          detail: "Link Opensteer Account to use hosted OAuth",
        }
      : {
          code: "OAUTH_SOURCE_UNAVAILABLE",
          detail: "The selected hosted OAuth service is unavailable",
        };
  }
  if (selectedSourceKind === "deployment-oauth") {
    return {
      code: "PROVIDER_APPLICATION_REQUIRED",
      detail: "Configure and enable this deployment's OAuth application",
    };
  }
  return {
    code: "ACCOUNT_LINK_OR_PROVIDER_APPLICATION_REQUIRED",
    detail: "Link Opensteer Account or configure this deployment's OAuth application",
  };
}

/** Slack bot grants reject loopback desktop redirects and require an HTTPS callback. */
function providerRequiresHttpsCallback(provider: IntegrationProvider): boolean {
  return provider === "slack";
}

function authorizationFailureReason(
  error: unknown,
): Exclude<IntegrationAuthAttemptFailureReason, "cancelled"> {
  if (error instanceof OpensteerError) {
    if (
      error.code === "conflict" &&
      error.message === integrationProviderIdentityAlreadyConnectedDetail
    )
      return "provider-identity-already-connected";
    if (error.reason === "expired") return "expired";
    const safe = HostedOAuthSafeFailureCodeSchema.safeParse(error.reason);
    if (safe.success) return safe.data;
  }
  return error instanceof OAuth2Error
    ? oauthAuthorizationFailure(error).failureCode
    : "exchange-failed";
}

/**
 * Names the permissions the provider withheld. A bare "reauthorization required" leaves the person
 * re-running the same consent screen without knowing which checkbox was the one that mattered, so
 * coverage is decided by the same list the message quotes.
 */
function missingOAuthScopesDetail(
  missing: readonly string[],
  repair: "authorize" | "reconnect",
): string {
  return `Missing OAuth scopes: ${missing.join(", ")}. ${
    repair === "authorize"
      ? "Approve every requested permission and authorize again."
      : "Reconnect this account and approve every requested permission."
  }`;
}

function oauthMethod(definition: IntegrationDefinition): Extract<AuthMethod, { kind: "oauth" }> {
  const method = definition.authMethods.find(
    (candidate): candidate is Extract<AuthMethod, { kind: "oauth" }> => candidate.kind === "oauth",
  );
  if (!method) {
    throw new OpensteerError({
      code: "bad_request",
      message: `${definition.name} does not support OAuth`,
    });
  }
  return method;
}

function requiredAuthMethod<K extends AuthMethod["kind"]>(
  definition: IntegrationDefinition,
  id: string,
  kind: K,
): Extract<AuthMethod, { kind: K }> {
  const method = definition.authMethods.find((candidate) => candidate.id === id);
  if (!method || method.kind !== kind) {
    throw new OpensteerError({
      code: "bad_request",
      message: `${definition.name} auth method ${id} is not ${kind}`,
    });
  }
  return method as Extract<AuthMethod, { kind: K }>;
}

function credentialSecrets(input: {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly refreshToken?: string;
  readonly tokenType: string;
}): Readonly<Record<string, string>> {
  return {
    accessToken: input.accessToken,
    ...(input.expiresAt === undefined ? {} : { expiresAt: String(input.expiresAt) }),
    ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
    tokenType: input.tokenType,
  };
}

function publicApplication(
  application: IntegrationProviderApplicationRecord,
  callbackUrl: URL | string,
  manifest: IntegrationProviderManifest,
  ownerUserId: UserId,
  isAdministrator: boolean,
): IntegrationProviderApplication {
  const {
    encryptedSecrets: _encryptedSecrets,
    encryptionKeyVersion: _keyVersion,
    ...publicFields
  } = application;
  return IntegrationProviderApplicationSchema.parse({
    ...publicFields,
    availability: application.ownerUserId === null ? "deployment" : "personal",
    callbackUrl: callbackUrl.toString(),
    canManage:
      application.ownerUserId === ownerUserId ||
      (application.ownerUserId === null && isAdministrator),
    configuredSecretFields: manifest.secretFields,
  });
}

function serializeProviderAttempt(
  payload: z.infer<typeof ProviderOAuthAttemptPayloadSchema>,
): Readonly<Record<string, string>> {
  return { payload: JSON.stringify(ProviderOAuthAttemptPayloadSchema.parse(payload)) };
}

function deserializeProviderAttempt(value: Readonly<Record<string, string>>) {
  const payload = value.payload;
  if (!payload || Buffer.byteLength(payload, "utf8") > 128 * 1_024) {
    throw invalidProviderAttempt();
  }
  try {
    return ProviderOAuthAttemptPayloadSchema.parse(JSON.parse(payload));
  } catch (error) {
    throw new OpensteerError({
      cause: error,
      code: "forbidden",
      message: "OAuth authorization is invalid, expired, or already used",
    });
  }
}

function invalidProviderAttempt(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    message: "OAuth authorization is invalid, expired, or already used",
  });
}

/**
 * Repeats the provider's own error code only in the bounded shape the broker protocol already
 * allows through, so a deployment-side provider cannot narrate anything to the agent.
 */
function providerErrorCode(value: string | undefined): string | null {
  const parsed = HostedOAuthProviderErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function hostedOAuthFailureMessage(
  code: string | null,
  operation: "authorization" | "refresh",
): string {
  switch (code) {
    case "catalog-version-skew":
      return "Opensteer hosted OAuth is updating; retry after the Host and broker catalogs match";
    case "authorization-denied":
      return "The provider authorization was not approved";
    case "scope-escalation":
      return "The provider did not grant every permission required by this integration";
    case "stale-provider-application":
      return "The hosted OAuth application changed; start the connection again";
    case "account-link-mismatch":
      return "The Opensteer Account link changed; link the account again";
    case "grant-rejected":
      return "The provider rejected this account's sign-in grant; reconnect this account";
    case "client-rejected":
      return "The provider rejected the hosted OAuth application; reconnecting accounts will not fix this";
    case "invalid-provider-response":
    case "provider-exchange-failed":
      return `The provider could not complete OAuth ${operation}`;
    default:
      return `Hosted OAuth ${operation} did not complete`;
  }
}

function unrevokedTokenNotice(integrationName: string, obstacle: string): string {
  return `The account was removed from Opensteer, but its ${integrationName} token could not be revoked because ${obstacle}. It may stay valid until it expires — revoke it in ${integrationName}'s own security settings.`;
}

function providerApplicationSecretContext(
  id: IntegrationProviderApplicationId,
  provider: IntegrationProvider,
  ownerUserId: UserId | null,
): IntegrationSecretContext {
  return {
    binding: provider,
    provider,
    purpose: "provider-application",
    recordId: id,
    scope: ownerUserId === null ? "instance" : `user:${ownerUserId}`,
  };
}

function connectionSecretContext(
  id: IntegrationConnectionId,
  ownerUserId: UserId,
  provider: IntegrationProvider,
): IntegrationSecretContext {
  return {
    binding: provider,
    provider,
    purpose: "provider-connection",
    recordId: id,
    scope: `user:${ownerUserId}`,
  };
}

function humanizeField(field: string): string {
  return field.replaceAll(/([a-z])([A-Z])/g, "$1 $2").toLocaleLowerCase();
}
