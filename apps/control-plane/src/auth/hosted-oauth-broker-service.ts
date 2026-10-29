import { createHash } from "node:crypto";
import {
  AesGcmSecretVault,
  StaticEncryptionKeyProvider,
  type SealedSecret,
} from "@opensteer/access/host";
import {
  CreateHostedOAuthAttemptRequestSchema,
  CreateHostedOAuthAttemptResponseSchema,
  CreateOAuthCallbackRelayRequestSchema,
  CreateHostedOAuthRevocationRequestSchema,
  CreateHostedOAuthRevocationResponseSchema,
  CreateHostedOAuthRefreshRequestSchema,
  HostedOAuthAttemptIdSchema,
  OAuthBrokerAccountSubjectSchema,
  HostedOAuthAttemptStatusResponseSchema,
  HostedOAuthProviderErrorSchema,
  OAuthBrokerAuthorizationContextSchema,
  OAuthBrokerAuthorizationCodeBundleSchema,
  OAuthBrokerCallbackRelayContextSchema,
  OAuthBrokerDigestSchema,
  OAuthBrokerPublicMetadataSchema,
  OAuthBrokerRefreshContextSchema,
  OAuthBrokerRevocationContextSchema,
  OAuthBrokerRevocationCredentialSchema,
  OAuthBrokerSealedEnvelopeSchema,
  OAuthBrokerTokenBundleSchema,
  PullHostedOAuthRefreshResponseSchema,
  PullHostedOAuthResultResponseSchema,
  type ControlPlaneAccountId,
  type CreateHostedOAuthAttemptRequest,
  type HostedOAuthAttemptId,
  type HostedOAuthRefreshTransactionId,
} from "@opensteer/control-plane-protocol";
import {
  buildDeclarativeAuthorizationUrl,
  createOAuthState,
  missingRequiredScopes,
  exchangeDeclarativeAuthorizationToken,
  oauthAuthorizationFailure,
  oauthUserDeniedAuthorization,
  generateOAuthBrokerEphemeralKeyPair,
  OAuth2Error,
  oauthAuthorizationResponseState,
  oauthFailureKind,
  openOAuthBrokerPayload,
  refreshDeclarativeCredential,
  revokeDeclarativeCredential,
  sealOAuthBrokerPayload,
  validateOAuthAuthorizationResponse,
  hostedOAuthDeploymentAuthorityDigest,
} from "@opensteer/integration-auth";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import {
  integrationAuthorizationBrowserReturn,
  type IntegrationDefinition,
} from "@opensteer/integration-core";
import { authorizationDigest as computeAuthorizationDigest } from "@opensteer/integration-core/digest";
import { sameStringSet, type DeploymentId } from "@opensteer/core";
import { z } from "zod";
import { ControlPlaneError } from "../server/errors.js";
import { HostedOAuthBrokerStore } from "./hosted-oauth-broker-store.js";
import type { HostAuthority } from "../database/store.js";

const authorizationLifetimeMilliseconds = 10 * 60 * 1_000;
const refreshLifetimeMilliseconds = 2 * 60 * 1_000;

export interface HostedOAuthProviderApplication {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly installationUrl?: string;
  readonly provider: string;
  readonly revision: number;
}

interface BrokerAuthorizationContext {
  readonly accountSubject: z.infer<typeof OAuthBrokerAccountSubjectSchema>;
  readonly authorizationUrl: string;
  readonly codeVerifier: string | null;
  readonly clientSurface: "desktop" | "native" | "web";
  readonly definitionId: string;
  readonly authorizationDigest: string;
  readonly deploymentAuthorityDigest: string;
  readonly launchTicket: string;
  readonly mode: "managed" | "callback-relay";
  readonly clientId?: string | undefined;
  readonly providerApplicationId?: string | undefined;
  readonly returnPath?: string | undefined;
  readonly requestedScopes: readonly string[];
}

const BrokerAuthorizationContextSchema = z
  .strictObject({
    accountSubject: OAuthBrokerAccountSubjectSchema,
    authorizationUrl: z.url().max(262_144),
    codeVerifier: z.string().min(43).max(256).nullable(),
    clientSurface: z.enum(["desktop", "native", "web"]).default("web"),
    definitionId: z.string().min(1).max(64),
    authorizationDigest: OAuthBrokerDigestSchema,
    deploymentAuthorityDigest: OAuthBrokerDigestSchema,
    launchTicket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    mode: z.enum(["managed", "callback-relay"]).default("managed"),
    clientId: z.string().min(1).max(2_048).optional(),
    providerApplicationId: z
      .string()
      .regex(/^ipa_[0-9a-f-]{36}$/iu)
      .optional(),
    requestedScopes: z.array(z.string().min(1).max(256)).max(512),
    returnPath: z.string().min(1).max(2_048).optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === "callback-relay" && (!value.clientId || !value.providerApplicationId)) {
      context.addIssue({
        code: "custom",
        message: "Callback relay application binding is missing",
      });
    }
  });
const RefreshCredentialSchema = z.strictObject({ refreshToken: z.string().min(1).max(131_072) });

export class HostedOAuthBrokerService {
  readonly #applications: ReadonlyMap<string, HostedOAuthProviderApplication>;
  readonly #attemptVault: AesGcmSecretVault;
  readonly #brokerKeyPair: ReturnType<typeof generateOAuthBrokerEphemeralKeyPair>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuer: string;
  readonly #now: () => Date;
  readonly #store: HostedOAuthBrokerStore;

  constructor(options: {
    readonly applications: readonly HostedOAuthProviderApplication[];
    readonly encryptionPrivateKey?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly issuer: URL;
    readonly now?: () => Date;
    readonly attemptContextEncryptionKey: string;
    readonly store: HostedOAuthBrokerStore;
  }) {
    this.#applications = new Map(
      options.applications.map((application) => [application.provider, application]),
    );
    if (this.#applications.size !== options.applications.length) {
      throw new TypeError("Hosted OAuth provider applications must be unique by provider");
    }
    for (const application of options.applications) {
      if (application.provider === "github" && !application.installationUrl) {
        throw new TypeError("Hosted OAuth GitHub requires its exact installation URL");
      }
      const qualified = integrationDefinitions.some(
        (definition) =>
          definition.provider === application.provider &&
          definition.hostedOAuth?.providerApplicationRevision === application.revision &&
          definition.hostedOAuth.qualification.authorizationCodeExchange &&
          definition.hostedOAuth.qualification.refresh,
      );
      if (!qualified) {
        throw new TypeError(
          `Hosted OAuth ${application.provider} revision ${application.revision} is not catalog-qualified`,
        );
      }
    }
    const generated = generateOAuthBrokerEphemeralKeyPair();
    this.#brokerKeyPair = options.encryptionPrivateKey
      ? privateKeyPair(options.encryptionPrivateKey)
      : generated;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#issuer = exactIssuer(options.issuer);
    this.#now = options.now ?? (() => new Date());
    this.#attemptVault = attemptVault(options.attemptContextEncryptionKey);
    this.#store = options.store;
  }

  metadata(includeInstallationUrls = true) {
    const metadata = OAuthBrokerPublicMetadataSchema.parse({
      encryptionPublicKey: this.#brokerKeyPair.publicKey,
      installationUrls: Object.fromEntries(
        [...this.#applications.values()].flatMap(({ installationUrl, provider }) =>
          installationUrl ? [[provider, installationUrl]] : [],
        ),
      ),
      issuer: this.#issuer,
      callbackRelayProviders: ["slack"],
      providerRevisions: Object.fromEntries(
        [...this.#applications.values()].map(({ provider, revision }) => [provider, revision]),
      ),
    });
    if (includeInstallationUrls) return metadata;
    const { installationUrls: _installationUrls, ...legacyMetadata } = metadata;
    return legacyMetadata as typeof metadata;
  }

  async createAuthorizationAttempt(authority: HostAuthority, raw: CreateHostedOAuthAttemptRequest) {
    const input = CreateHostedOAuthAttemptRequestSchema.parse(raw);
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, input.accountSubject);
    assertAuthorityDigest(input.deploymentAuthorityDigest, binding);
    const { application, definition, scopes } = this.#qualifiedProvider(
      input.provider,
      input.providerApplicationRevision,
      input.definitionId,
    );
    assertAuthorizationDigest(input.authorizationDigest, definition);
    const method = oauthMethod(definition);
    const now = this.#now();
    const expiresAt = new Date(input.expiresAt);
    if (
      expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() > now.getTime() + authorizationLifetimeMilliseconds
    ) {
      throw new ControlPlaneError("bad_request", "Hosted OAuth attempt expiry is invalid");
    }
    const state = createOAuthState();
    const launchTicket = createOAuthState();
    const authorization = await buildDeclarativeAuthorizationUrl({
      clientId: application.clientId,
      config: method.oauth,
      redirectUrl: this.callbackUrl(definition.provider),
      state,
    });
    if (!sameStringSet(authorization.scopes, scopes)) throw invalidAttempt();
    const context = {
      accountSubject: input.accountSubject,
      authorizationUrl: authorization.authorizationUrl,
      codeVerifier: authorization.codeVerifier ?? null,
      clientSurface: input.clientSurface,
      definitionId: definition.id,
      authorizationDigest: input.authorizationDigest,
      deploymentAuthorityDigest: input.deploymentAuthorityDigest,
      launchTicket,
      mode: "managed",
      requestedScopes: scopes,
      ...(input.returnPath ? { returnPath: input.returnPath } : {}),
    } satisfies BrokerAuthorizationContext;
    const sealed = await this.#sealAttemptContext(context, {
      attemptId: input.attemptId,
      deploymentId: authority.deploymentId,
      provider: input.provider,
    });
    const persisted = await this.#store.createAttempt(
      {
        accountSubject: input.accountSubject.subject,
        attemptId: input.attemptId,
        contextKeyVersion: sealed.keyVersion,
        deploymentId: authority.deploymentId,
        encryptedContext: sealed.envelope,
        expiresAt,
        hostPublicKey: input.hostPublicKey,
        launchTicketHash: secretDigest(launchTicket),
        provider: input.provider,
        providerApplicationRevision: input.providerApplicationRevision,
        requestedScopeDigest: scopeDigest(scopes),
        stateHash: secretDigest(state),
      },
      now,
    );
    const durableContext = await this.#openAttemptContext(persisted, input.attemptId);
    if (
      durableContext.accountSubject.issuer !== input.accountSubject.issuer ||
      durableContext.accountSubject.subject !== input.accountSubject.subject ||
      durableContext.definitionId !== definition.id ||
      durableContext.authorizationDigest !== input.authorizationDigest ||
      durableContext.deploymentAuthorityDigest !== input.deploymentAuthorityDigest ||
      !sameStringSet(durableContext.requestedScopes, scopes)
    ) {
      throw new ControlPlaneError("conflict", "Hosted OAuth attempt ID was already used");
    }
    const launchUrl = new URL(`/v1/oauth-broker/launch/${input.attemptId}`, this.#issuer);
    launchUrl.searchParams.set("ticket", durableContext.launchTicket);
    return CreateHostedOAuthAttemptResponseSchema.parse({
      attemptId: input.attemptId,
      expiresAt: expiresAt.toISOString(),
      launchUrl: launchUrl.toString(),
    });
  }

  async createCallbackRelay(authority: HostAuthority, raw: unknown) {
    const input = CreateOAuthCallbackRelayRequestSchema.parse(raw);
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, input.accountSubject);
    assertAuthorityDigest(input.deploymentAuthorityDigest, binding);
    const definition = integrationDefinitions.find(
      (candidate) => candidate.id === input.definitionId && candidate.provider === input.provider,
    );
    if (!definition || input.provider !== "slack") {
      throw new ControlPlaneError("conflict", "OAuth callback relay is unavailable");
    }
    assertAuthorizationDigest(input.authorizationDigest, definition);
    const method = oauthMethod(definition);
    const scopes = fixedOAuthScopes(method);
    const authorizationUrl = validateCallbackRelayAuthorizationUrl({
      authorizationUrl: input.authorizationUrl,
      callbackUrl: this.callbackUrl(input.provider),
      clientId: input.clientId,
      method,
      scopes,
    });
    const state = authorizationUrl.searchParams.get("state")!;
    const now = this.#now();
    const expiresAt = new Date(input.expiresAt);
    if (
      expiresAt.getTime() <= now.getTime() ||
      expiresAt.getTime() > now.getTime() + authorizationLifetimeMilliseconds
    ) {
      throw new ControlPlaneError("bad_request", "OAuth callback relay expiry is invalid");
    }
    const launchTicket = createOAuthState();
    const context = BrokerAuthorizationContextSchema.parse({
      accountSubject: input.accountSubject,
      authorizationUrl: authorizationUrl.toString(),
      clientId: input.clientId,
      clientSurface: input.clientSurface,
      codeVerifier: null,
      definitionId: input.definitionId,
      authorizationDigest: input.authorizationDigest,
      deploymentAuthorityDigest: input.deploymentAuthorityDigest,
      launchTicket,
      mode: "callback-relay",
      providerApplicationId: input.providerApplicationId,
      requestedScopes: scopes,
      ...(input.returnPath ? { returnPath: input.returnPath } : {}),
    });
    const sealed = await this.#sealAttemptContext(context, {
      attemptId: input.attemptId,
      deploymentId: authority.deploymentId,
      provider: input.provider,
    });
    const persisted = await this.#store.createAttempt(
      {
        accountSubject: input.accountSubject.subject,
        attemptId: input.attemptId,
        contextKeyVersion: sealed.keyVersion,
        deploymentId: authority.deploymentId,
        encryptedContext: sealed.envelope,
        expiresAt,
        hostPublicKey: input.hostPublicKey,
        launchTicketHash: secretDigest(launchTicket),
        provider: input.provider,
        providerApplicationRevision: input.providerApplicationRevision,
        requestedScopeDigest: scopeDigest(scopes),
        stateHash: secretDigest(state),
      },
      now,
    );
    const durable = await this.#openAttemptContext(persisted, input.attemptId);
    if (
      durable.mode !== "callback-relay" ||
      durable.accountSubject.subject !== input.accountSubject.subject ||
      durable.providerApplicationId !== input.providerApplicationId ||
      durable.clientId !== input.clientId ||
      durable.authorizationUrl !== authorizationUrl.toString()
    ) {
      throw new ControlPlaneError("conflict", "OAuth callback relay attempt ID was already used");
    }
    const launchUrl = new URL(`/v1/oauth-broker/launch/${input.attemptId}`, this.#issuer);
    launchUrl.searchParams.set("ticket", durable.launchTicket);
    return CreateHostedOAuthAttemptResponseSchema.parse({
      attemptId: input.attemptId,
      expiresAt: expiresAt.toISOString(),
      launchUrl: launchUrl.toString(),
    });
  }

  async launchAuthorization(
    accountId: ControlPlaneAccountId,
    attemptIdInput: HostedOAuthAttemptId,
    launchTicket: string,
  ): Promise<string> {
    const attemptId = HostedOAuthAttemptIdSchema.parse(attemptIdInput);
    const launched = await this.#store.launchAttempt({
      accountId,
      attemptId,
      launchTicketHash: secretDigest(launchTicket),
      now: this.#now(),
    });
    if (!launched) throw invalidAttempt();
    try {
      const context = await this.#openAttemptContext(launched, attemptId);
      const binding = await this.#requireDeploymentBinding(launched.deploymentId);
      await this.#assertAccountAccess(binding, context.accountSubject);
      assertAuthorityDigest(context.deploymentAuthorityDigest, binding);
      if (context.mode === "callback-relay") {
        const definition = integrationDefinitions.find(
          (candidate) =>
            candidate.id === context.definitionId && candidate.provider === launched.provider,
        );
        if (!definition || !context.clientId) throw invalidAttempt();
        assertAuthorizationDigest(context.authorizationDigest, definition);
        const method = oauthMethod(definition);
        const scopes = fixedOAuthScopes(method);
        const authorizationUrl = validateCallbackRelayAuthorizationUrl({
          authorizationUrl: context.authorizationUrl,
          callbackUrl: this.callbackUrl(definition.provider),
          clientId: context.clientId,
          method,
          scopes,
        });
        if (
          scopeDigest(scopes) !== launched.requestedScopeDigest ||
          !sameStringSet(scopes, context.requestedScopes) ||
          secretDigest(authorizationUrl.searchParams.get("state")!) !== launched.stateHash
        ) {
          throw invalidAttempt();
        }
        return authorizationUrl.toString();
      }
      const { application, definition, scopes } = this.#qualifiedProvider(
        launched.provider,
        launched.providerApplicationRevision,
        context.definitionId,
      );
      assertAuthorizationDigest(context.authorizationDigest, definition);
      if (
        application.provider !== definition.provider ||
        scopeDigest(scopes) !== launched.requestedScopeDigest ||
        !sameStringSet(scopes, context.requestedScopes)
      ) {
        throw invalidAttempt();
      }
      const authorizationUrl = new URL(context.authorizationUrl);
      if (
        authorizationUrl.searchParams.get("client_id") !== application.clientId ||
        authorizationUrl.searchParams.get("redirect_uri") !==
          this.callbackUrl(definition.provider) ||
        authorizationUrl.searchParams.get("state") === null ||
        secretDigest(authorizationUrl.searchParams.get("state")!) !== launched.stateHash
      ) {
        throw invalidAttempt();
      }
      return authorizationUrl.toString();
    } catch (error) {
      const failureCode = isCatalogVersionSkew(error)
        ? "catalog-version-skew"
        : "invalid-provider-response";
      await this.#store
        .failAttempt(attemptId, "failed", failureCode, this.#now())
        .catch(() => undefined);
      throw error;
    }
  }

  async completeAuthorization(input: {
    readonly parameters: URLSearchParams;
    readonly provider: string;
  }): Promise<{
    readonly attemptId: HostedOAuthAttemptId;
    readonly returnUrl?: string;
    readonly failureCode?: string;
    readonly providerError?: string | null;
    readonly status: "denied" | "failed" | "sealed";
  }> {
    const now = this.#now();
    let state: string;
    try {
      state = oauthAuthorizationResponseState(input.parameters);
    } catch {
      throw invalidAttempt();
    }
    const row = await this.#store.claimCallback(secretDigest(state), now);
    if (!row) throw invalidAttempt();
    const attemptId = HostedOAuthAttemptIdSchema.parse(row.attemptId);
    if (row.provider !== input.provider) {
      await this.#store.failAttempt(attemptId, "failed", "invalid-provider-response", now);
      return { attemptId, status: "failed", failureCode: "invalid-provider-response" };
    }
    let context: BrokerAuthorizationContext;
    let application: HostedOAuthProviderApplication | null = null;
    let definition: IntegrationDefinition;
    let method: ReturnType<typeof oauthMethod>;
    try {
      context = await this.#openAttemptContext(row, attemptId);
      if (context.mode === "callback-relay") {
        const found = integrationDefinitions.find(
          (candidate) =>
            candidate.id === context.definitionId && candidate.provider === row.provider,
        );
        if (!found || !context.clientId || !context.providerApplicationId) throw invalidAttempt();
        definition = found;
        method = oauthMethod(found);
      } else {
        ({ application, definition, method } = this.#qualifiedProvider(
          row.provider,
          row.providerApplicationRevision,
          context.definitionId,
        ));
      }
      assertAuthorizationDigest(context.authorizationDigest, definition);
      const scopes = fixedOAuthScopes(method);
      if (
        scopeDigest(scopes) !== row.requestedScopeDigest ||
        !sameStringSet(scopes, context.requestedScopes)
      ) {
        throw invalidAttempt();
      }
    } catch (error) {
      const failureCode = isCatalogVersionSkew(error)
        ? "catalog-version-skew"
        : error instanceof ControlPlaneError && error.code === "conflict"
          ? "stale-provider-application"
          : "invalid-provider-response";
      await this.#store.failAttempt(attemptId, "failed", failureCode, now).catch(() => undefined);
      return { attemptId, status: "failed", failureCode };
    }
    let returnUrl: string | null = null;
    try {
      const binding = await this.#requireDeploymentBinding(row.deploymentId);
      await this.#assertAccountAccess(binding, context.accountSubject);
      assertAuthorityDigest(context.deploymentAuthorityDigest, binding);
      returnUrl = callbackReturnUrl({
        attemptId,
        canonicalOrigin: binding.canonicalOrigin,
        clientSurface: context.clientSurface,
        deploymentId: binding.id,
        returnPath: context.returnPath,
      });
    } catch {
      await this.#store.failAttempt(attemptId, "failed", "account-link-mismatch", now);
      return { attemptId, status: "failed", failureCode: "account-link-mismatch" };
    }
    let authorizationResponse;
    try {
      authorizationResponse = validateOAuthAuthorizationResponse({
        clientId: context.mode === "callback-relay" ? context.clientId! : application!.clientId,
        issuer: method.oauth.issuer ?? null,
        parameters: input.parameters,
      });
    } catch {
      await this.#store.failAttempt(attemptId, "failed", "invalid-provider-response", now);
      return authorizationCompletion(attemptId, "failed", returnUrl, "invalid-provider-response");
    }
    if (authorizationResponse.kind === "error") {
      const denied = oauthUserDeniedAuthorization(authorizationResponse.error);
      const failure = oauthAuthorizationFailure(
        new OAuth2Error("Provider rejected authorization", {
          error: authorizationResponse.error,
          failureKind: "provider-error",
        }),
      );
      await this.#store.failAttempt(
        attemptId,
        denied ? "denied" : "failed",
        denied ? "authorization-denied" : failure.failureCode,
        now,
      );
      return {
        ...authorizationCompletion(
          attemptId,
          denied ? "denied" : "failed",
          returnUrl,
          denied ? "authorization-denied" : failure.failureCode,
        ),
        providerError: failure.providerError,
      };
    }
    if (context.mode === "callback-relay") {
      try {
        const sealingContext = OAuthBrokerCallbackRelayContextSchema.parse({
          accountSubject: context.accountSubject,
          attemptId,
          authorizationDigest: context.authorizationDigest,
          definitionId: context.definitionId,
          deploymentAuthorityDigest: context.deploymentAuthorityDigest,
          expiresAt: row.expiresAt.toISOString(),
          providerApplicationId: context.providerApplicationId,
          providerApplicationRevision: row.providerApplicationRevision,
          redirectUrl: this.callbackUrl(row.provider),
          schemaVersion: 1,
        });
        const sealed = OAuthBrokerSealedEnvelopeSchema.parse(
          sealOAuthBrokerPayload(
            OAuthBrokerAuthorizationCodeBundleSchema.parse({ code: authorizationResponse.code }),
            row.hostPublicKey,
            sealingContext,
          ),
        );
        await this.#store.sealAttempt(attemptId, sealed, now);
        return authorizationCompletion(attemptId, "sealed", returnUrl);
      } catch {
        await this.#store.failAttempt(attemptId, "failed", "invalid-provider-response", now);
        return authorizationCompletion(attemptId, "failed", returnUrl, "invalid-provider-response");
      }
    }
    let exchanged: Awaited<ReturnType<typeof exchangeDeclarativeAuthorizationToken>>;
    try {
      exchanged = await exchangeDeclarativeAuthorizationToken({
        clientId: application!.clientId,
        clientSecret: application!.clientSecret,
        code: authorizationResponse.code,
        ...(context.codeVerifier ? { codeVerifier: context.codeVerifier } : {}),
        config: method.oauth,
        fetch: this.#fetch,
        redirectUrl: this.callbackUrl(definition.provider),
      });
    } catch (error) {
      const failure = oauthAuthorizationFailure(error);
      await this.#store.failAttempt(attemptId, "failed", failure.failureCode, now);
      return { ...authorizationCompletion(attemptId, "failed", returnUrl), ...failure };
    }
    const response = exchanged.tokenResponse;
    const grantedScopes = tokenScopes(
      response.scope,
      method.oauth.scopeSeparator,
      context.requestedScopes,
      method,
    );
    if (
      missingRequiredScopes({
        config: method.oauth,
        requiredScopes: context.requestedScopes,
        grantedScopes: grantedScopes,
      }).length > 0
    ) {
      await this.#store.failAttempt(attemptId, "failed", "scope-escalation", now);
      return authorizationCompletion(attemptId, "failed", returnUrl, "scope-escalation");
    }
    try {
      const sealingContext = OAuthBrokerAuthorizationContextSchema.parse({
        accountSubject: context.accountSubject,
        attemptId,
        deploymentAuthorityDigest: context.deploymentAuthorityDigest,
        expiresAt: row.expiresAt.toISOString(),
        providerApplicationRevision: row.providerApplicationRevision,
        authorizationDigest: context.authorizationDigest,
        definitionId: context.definitionId,
        schemaVersion: 1,
      });
      const bundle = OAuthBrokerTokenBundleSchema.parse({
        accessToken: response.access_token,
        ...(exchanged.tokenResponseIdentity
          ? { tokenResponseIdentity: exchanged.tokenResponseIdentity }
          : {}),
        ...(typeof response.expires_in === "number"
          ? { expiresAt: now.getTime() + Math.max(0, response.expires_in) * 1_000 }
          : {}),
        grantedScopes,
        ...(typeof response.id_token === "string" ? { idToken: response.id_token } : {}),
        ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
        tokenType: response.token_type ?? "Bearer",
      });
      const sealed = OAuthBrokerSealedEnvelopeSchema.parse(
        sealOAuthBrokerPayload(bundle, row.hostPublicKey, sealingContext),
      );
      await this.#store.sealAttempt(attemptId, sealed, now);
      return authorizationCompletion(attemptId, "sealed", returnUrl);
    } catch {
      await this.#store
        .failAttempt(attemptId, "failed", "invalid-provider-response", now)
        .catch(() => undefined);
      return authorizationCompletion(attemptId, "failed", returnUrl, "invalid-provider-response");
    }
  }

  async status(authority: HostAuthority, attemptId: HostedOAuthAttemptId) {
    const row = await this.#store.getAttemptForHost(authority.deploymentId, attemptId, this.#now());
    if (!row) throw invalidAttempt();
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, {
      issuer: this.#issuer,
      subject: row.accountSubject,
    });
    return HostedOAuthAttemptStatusResponseSchema.parse({
      attemptId: row.attemptId,
      expiresAt: row.expiresAt.toISOString(),
      failureCode: row.failureCode,
      retryGeneration: row.retryGeneration,
      status: row.status === "exchanging" ? "launched" : row.status,
    });
  }

  async pull(authority: HostAuthority, attemptId: HostedOAuthAttemptId) {
    const status = await this.status(authority, attemptId);
    const row = await this.#store.pullAttemptResult(authority.deploymentId, attemptId, this.#now());
    if (!row && status.status === "sealed") throw invalidAttempt();
    return PullHostedOAuthResultResponseSchema.parse({
      ...status,
      retryGeneration: row?.retryGeneration ?? status.retryGeneration,
      sealedResult: row?.sealedCiphertext ?? null,
    });
  }

  async acknowledge(authority: HostAuthority, attemptId: HostedOAuthAttemptId): Promise<void> {
    await this.status(authority, attemptId);
    if (!(await this.#store.acknowledgeAttempt(authority.deploymentId, attemptId, this.#now()))) {
      throw invalidAttempt();
    }
  }

  async refresh(authority: HostAuthority, raw: unknown) {
    const input = CreateHostedOAuthRefreshRequestSchema.parse(raw);
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, input.accountSubject);
    assertAuthorityDigest(input.deploymentAuthorityDigest, binding);
    const expiresAt = new Date(input.expiresAt);
    const now = this.#now();
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + refreshLifetimeMilliseconds) {
      throw new ControlPlaneError("bad_request", "Hosted OAuth refresh expiry is invalid");
    }
    const { application, definition, method } = this.#qualifiedProvider(
      input.provider,
      input.providerApplicationRevision,
      input.definitionId,
    );
    assertAuthorizationDigest(input.authorizationDigest, definition);
    const reviewedScopes = fixedOAuthScopes(method);
    const priorGrantedScopes = normalizeScopes(method, input.grantedScopes);
    if (
      missingRequiredScopes({
        config: method.oauth,
        requiredScopes: reviewedScopes,
        grantedScopes: priorGrantedScopes,
      }).length > 0
    ) {
      throw new ControlPlaneError(
        "forbidden",
        "Hosted OAuth refresh is missing required functional scopes",
      );
    }
    const context = OAuthBrokerRefreshContextSchema.parse({
      authorizationDigest: input.authorizationDigest,
      definitionId: input.definitionId,
      deploymentAuthorityDigest: input.deploymentAuthorityDigest,
      expiresAt: input.expiresAt,
      providerApplicationRevision: input.providerApplicationRevision,
      schemaVersion: 1,
      transactionId: input.transactionId,
    });
    const claim = await this.#store.claimRefresh(
      {
        accountSubject: input.accountSubject.subject,
        deploymentId: authority.deploymentId,
        expiresAt,
        hostPublicKey: input.hostPublicKey,
        provider: input.provider,
        providerApplicationRevision: input.providerApplicationRevision,
        transactionId: input.transactionId,
      },
      now,
    );
    if (!claim.claimed) {
      if (claim.row.status === "pending") {
        throw new ControlPlaneError("unavailable", "Hosted OAuth refresh is already in progress");
      }
      return {
        expiresAt: claim.row.expiresAt.toISOString(),
        failureCode: claim.row.failureCode,
        providerError: claim.row.providerError,
        status: claim.row.status === "sealed" ? ("sealed" as const) : ("failed" as const),
        transactionId: input.transactionId,
      };
    }
    const credential = RefreshCredentialSchema.parse(
      openOAuthBrokerPayload(input.brokerSealedCredential, this.#brokerKeyPair.privateKey, context),
    );
    let refreshed: Awaited<ReturnType<typeof refreshDeclarativeCredential>>;
    try {
      refreshed = await refreshDeclarativeCredential({
        clientId: application.clientId,
        clientSecret: application.clientSecret,
        config: method.oauth,
        fetch: this.#fetch,
        grantedScopes: priorGrantedScopes,
        now: now.getTime(),
        refreshToken: credential.refreshToken,
      });
    } catch (error) {
      // A classified refusal is the refresh result, not a broker outage: only the provider's own
      // error code separates a dead user grant from a rejected shared OAuth client, and the Host
      // cannot choose between reconnecting and waiting once that evidence is thrown away.
      const errorCode = error instanceof OAuth2Error ? error.error : undefined;
      const kind = oauthFailureKind(errorCode);
      const failureCode = kind === "unknown" ? ("provider-exchange-failed" as const) : kind;
      const providerError = boundedProviderError(errorCode);
      await this.#store
        .failRefresh(input.transactionId, failureCode, providerError, now)
        .catch(() => undefined);
      return {
        expiresAt: input.expiresAt,
        failureCode,
        providerError,
        status: "failed" as const,
        transactionId: input.transactionId,
      };
    }
    const refreshedScopes = normalizeScopes(method, refreshed.grantedScopes);
    const grantedScopes = refreshedScopes;
    if (
      missingRequiredScopes({
        config: method.oauth,
        requiredScopes: reviewedScopes,
        grantedScopes: grantedScopes,
      }).length > 0
    ) {
      await this.#store.failRefresh(input.transactionId, "scope-escalation", null, now);
      throw new ControlPlaneError(
        "forbidden",
        "Hosted OAuth refresh is missing required functional scopes",
      );
    }
    const sealed = OAuthBrokerSealedEnvelopeSchema.parse(
      sealOAuthBrokerPayload(
        OAuthBrokerTokenBundleSchema.parse({ ...refreshed, grantedScopes }),
        input.hostPublicKey,
        context,
      ),
    );
    await this.#store.sealRefresh(input.transactionId, sealed, now);
    return {
      expiresAt: input.expiresAt,
      failureCode: null,
      providerError: null,
      status: "sealed" as const,
      transactionId: input.transactionId,
    };
  }

  async revoke(authority: HostAuthority, raw: unknown) {
    const input = CreateHostedOAuthRevocationRequestSchema.parse(raw);
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, input.accountSubject);
    assertAuthorityDigest(input.deploymentAuthorityDigest, binding);
    const expiresAt = new Date(input.expiresAt);
    const now = this.#now();
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + refreshLifetimeMilliseconds) {
      throw new ControlPlaneError("bad_request", "Hosted OAuth revocation expiry is invalid");
    }
    const { application, definition, method } = this.#qualifiedProvider(
      input.provider,
      input.providerApplicationRevision,
      input.definitionId,
    );
    assertAuthorizationDigest(input.authorizationDigest, definition);
    if (!method.oauth.revocation) {
      throw new ControlPlaneError(
        "bad_request",
        "Hosted OAuth provider does not declare token revocation",
      );
    }
    const context = OAuthBrokerRevocationContextSchema.parse({
      accountSubject: input.accountSubject,
      authorizationDigest: input.authorizationDigest,
      definitionId: input.definitionId,
      deploymentAuthorityDigest: input.deploymentAuthorityDigest,
      expiresAt: input.expiresAt,
      provider: input.provider,
      providerApplicationRevision: input.providerApplicationRevision,
      schemaVersion: 1,
      transactionId: input.transactionId,
    });
    const credential = OAuthBrokerRevocationCredentialSchema.parse(
      openOAuthBrokerPayload(input.brokerSealedCredential, this.#brokerKeyPair.privateKey, context),
    );
    try {
      await revokeDeclarativeCredential({
        accessToken: credential.accessToken,
        clientId: application.clientId,
        clientSecret: application.clientSecret,
        config: method.oauth,
        fetch: this.#fetch,
        ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
      });
    } catch {
      throw new ControlPlaneError(
        "unavailable",
        "Hosted OAuth provider did not accept token revocation",
      );
    }
    return CreateHostedOAuthRevocationResponseSchema.parse({
      revoked: true,
      transactionId: input.transactionId,
    });
  }

  async pullRefresh(authority: HostAuthority, transactionId: HostedOAuthRefreshTransactionId) {
    const row = await this.#store.getRefreshForHost(
      authority.deploymentId,
      transactionId,
      this.#now(),
    );
    if (!row) throw invalidAttempt();
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, {
      issuer: this.#issuer,
      subject: row.accountSubject,
    });
    if (row.status === "pending") {
      throw new ControlPlaneError("unavailable", "Hosted OAuth refresh is still in progress");
    }
    return PullHostedOAuthRefreshResponseSchema.parse({
      expiresAt: row.expiresAt.toISOString(),
      failureCode: row.failureCode,
      providerError: row.providerError,
      sealedResult: row.status === "sealed" ? row.sealedCiphertext : null,
      status: row.status,
      transactionId: row.transactionId,
    });
  }

  async acknowledgeRefresh(
    authority: HostAuthority,
    transactionId: HostedOAuthRefreshTransactionId,
  ) {
    if (
      !(await this.#store.acknowledgeRefresh(authority.deploymentId, transactionId, this.#now()))
    ) {
      throw invalidAttempt();
    }
  }

  #sealAttemptContext(
    context: BrokerAuthorizationContext,
    binding: {
      readonly attemptId: HostedOAuthAttemptId;
      readonly deploymentId: DeploymentId;
      readonly provider: string;
    },
  ): Promise<SealedSecret> {
    return this.#attemptVault.seal(
      {
        accountSubject: JSON.stringify(context.accountSubject),
        authorizationUrl: context.authorizationUrl,
        clientId: context.clientId ?? "",
        clientSurface: context.clientSurface,
        codeVerifier: context.codeVerifier ?? "",
        definitionId: context.definitionId,
        authorizationDigest: context.authorizationDigest,
        deploymentAuthorityDigest: context.deploymentAuthorityDigest,
        launchTicket: context.launchTicket,
        mode: context.mode,
        providerApplicationId: context.providerApplicationId ?? "",
        requestedScopes: JSON.stringify(context.requestedScopes),
        returnPath: context.returnPath ?? "",
      },
      brokerAttemptSecretContext(binding),
    );
  }

  async #openAttemptContext(
    row: {
      readonly contextKeyVersion: number | null;
      readonly deploymentId: DeploymentId;
      readonly encryptedContext: Buffer | null;
      readonly provider: string;
    },
    attemptId: HostedOAuthAttemptId,
  ): Promise<BrokerAuthorizationContext> {
    if (row.contextKeyVersion === null || row.encryptedContext === null) throw invalidAttempt();
    const opened = await this.#attemptVault.open(
      row.encryptedContext,
      brokerAttemptSecretContext({
        attemptId,
        deploymentId: row.deploymentId,
        provider: row.provider,
      }),
    );
    let accountSubject: unknown;
    let requestedScopes: unknown;
    try {
      accountSubject = JSON.parse(opened.accountSubject ?? "");
      requestedScopes = JSON.parse(opened.requestedScopes ?? "");
    } catch {
      throw invalidAttempt();
    }
    return BrokerAuthorizationContextSchema.parse({
      accountSubject,
      authorizationUrl: opened.authorizationUrl,
      clientId: opened.clientId || undefined,
      clientSurface: opened.clientSurface || undefined,
      codeVerifier: opened.codeVerifier || null,
      definitionId: opened.definitionId,
      authorizationDigest: opened.authorizationDigest,
      deploymentAuthorityDigest: opened.deploymentAuthorityDigest,
      launchTicket: opened.launchTicket,
      mode: opened.mode || undefined,
      providerApplicationId: opened.providerApplicationId || undefined,
      requestedScopes,
      returnPath: opened.returnPath || undefined,
    });
  }

  callbackUrl(provider: string): string {
    return new URL(
      `/v1/oauth-broker/callback/${encodeURIComponent(provider)}`,
      this.#issuer,
    ).toString();
  }

  #qualifiedProvider(provider: string, revision: number, definitionId: string) {
    const application = this.#applications.get(provider);
    const candidates = integrationDefinitions.filter(
      (definition) =>
        definition.provider === provider &&
        definition.hostedOAuth?.providerApplicationRevision === revision,
    );
    const definition = candidates.find((candidate) => candidate.id === definitionId);
    if (!application || application.revision !== revision || !definition?.hostedOAuth) {
      throw new ControlPlaneError("conflict", "Hosted OAuth provider application is stale");
    }
    const method = oauthMethod(definition);
    const scopes = fixedOAuthScopes(method);
    return { application, definition, method, scopes };
  }

  async #requireDeploymentBinding(deploymentId: DeploymentId) {
    const binding = await this.#store.deploymentBinding(deploymentId);
    if (!binding)
      throw new ControlPlaneError("forbidden", "Hosted OAuth deployment is unavailable");
    return binding;
  }

  async #assertAccountAccess(
    binding: NonNullable<Awaited<ReturnType<HostedOAuthBrokerStore["deploymentBinding"]>>>,
    account: { readonly issuer: string; readonly subject: ControlPlaneAccountId },
  ): Promise<void> {
    let accountIssuer: string;
    try {
      accountIssuer = exactIssuer(new URL(account.issuer));
    } catch {
      throw new ControlPlaneError("forbidden", "Hosted OAuth Account link does not match");
    }
    if (accountIssuer !== this.#issuer) {
      throw new ControlPlaneError("forbidden", "Hosted OAuth Account link does not match");
    }
    if (binding.reachability === "routed") {
      assertHostedOAuthAccountLink(account, this.#issuer, binding.ownerAccountId);
      return;
    }
    if (!(await this.#store.hasDeploymentAccess(binding.id, account.subject))) {
      throw new ControlPlaneError("forbidden", "Hosted OAuth Account membership is not active");
    }
  }
}

export function scopeDigest(scopes: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(scopes)].sort()))
    .digest("base64url");
}

/** The broker owns the fixed preset scope set; Host input is never scope authority. */
function fixedOAuthScopes(method: ReturnType<typeof oauthMethod>): readonly string[] {
  return [...new Set(method.oauth.scopes)];
}

function validateCallbackRelayAuthorizationUrl(input: {
  readonly authorizationUrl: string;
  readonly callbackUrl: string;
  readonly clientId: string;
  readonly method: ReturnType<typeof oauthMethod>;
  readonly scopes: readonly string[];
}): URL {
  let authorizationUrl: URL;
  const endpoint = new URL(input.method.oauth.authorizationUrl);
  try {
    authorizationUrl = new URL(input.authorizationUrl);
  } catch {
    throw invalidAttempt();
  }
  const state = authorizationUrl.searchParams.get("state");
  const scopes = authorizationUrl.searchParams
    .get("scope")
    ?.split(input.method.oauth.scopeSeparator)
    .filter(Boolean);
  if (
    authorizationUrl.origin !== endpoint.origin ||
    authorizationUrl.pathname !== endpoint.pathname ||
    authorizationUrl.username ||
    authorizationUrl.password ||
    authorizationUrl.hash ||
    authorizationUrl.searchParams.get("client_id") !== input.clientId ||
    authorizationUrl.searchParams.get("redirect_uri") !== input.callbackUrl ||
    authorizationUrl.searchParams.get("response_type") !== "code" ||
    !state ||
    !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
    !scopes ||
    !sameStringSet(scopes, input.scopes)
  ) {
    throw new ControlPlaneError("bad_request", "OAuth callback relay authorization is invalid");
  }
  return authorizationUrl;
}

function callbackReturnUrl(input: {
  readonly attemptId: HostedOAuthAttemptId;
  readonly canonicalOrigin: string;
  readonly clientSurface: "desktop" | "native" | "web";
  readonly deploymentId: DeploymentId;
  readonly returnPath: string | undefined;
}): string | null {
  const result = integrationAuthorizationBrowserReturn({
    attemptId: `ioa_${input.attemptId.slice("hoa_".length)}`,
    canonicalOrigin: input.canonicalOrigin,
    surface: input.clientSurface,
    deploymentId: input.deploymentId,
    ...(input.returnPath === undefined ? {} : { returnPath: input.returnPath }),
  });
  return result.kind === "redirect" ? result.location : null;
}

function authorizationCompletion(
  attemptId: HostedOAuthAttemptId,
  status: "denied" | "failed" | "sealed",
  returnUrl: string | null,
  failureCode?: string,
) {
  return {
    attemptId,
    ...(returnUrl ? { returnUrl } : {}),
    ...(failureCode ? { failureCode } : {}),
    status,
  };
}

function assertAuthorizationDigest(expected: string, definition: IntegrationDefinition): void {
  if (computeAuthorizationDigest(definition) !== expected) {
    throw new ControlPlaneError(
      "conflict",
      "Hosted OAuth catalog authorization definition is stale",
    );
  }
}

/** The provider's raw error code travels onward only when it fits the bounded diagnostic shape. */
function boundedProviderError(errorCode: string | undefined): string | null {
  const parsed = HostedOAuthProviderErrorSchema.safeParse(errorCode);
  return parsed.success ? parsed.data : null;
}

function isCatalogVersionSkew(error: unknown): boolean {
  return (
    error instanceof ControlPlaneError &&
    error.message === "Hosted OAuth catalog authorization definition is stale"
  );
}

function assertAuthorityDigest(
  expected: string,
  binding: Parameters<typeof hostedOAuthDeploymentAuthorityDigest>[0],
) {
  if (hostedOAuthDeploymentAuthorityDigest(binding) !== expected) {
    throw new ControlPlaneError("forbidden", "Hosted OAuth deployment authority changed");
  }
}

export function assertHostedOAuthAccountLink(
  account: { readonly issuer: string; readonly subject: string },
  issuer: string,
  expectedSubject: string,
) {
  let accountIssuer: string;
  try {
    accountIssuer = exactIssuer(new URL(account.issuer));
  } catch {
    throw new ControlPlaneError("forbidden", "Hosted OAuth Account link does not match");
  }
  if (accountIssuer !== issuer || account.subject !== expectedSubject) {
    throw new ControlPlaneError("forbidden", "Hosted OAuth Account link does not match");
  }
}

function oauthMethod(definition: IntegrationDefinition) {
  const method = definition.authMethods.find(
    (candidate): candidate is Extract<(typeof definition.authMethods)[number], { kind: "oauth" }> =>
      candidate.kind === "oauth",
  );
  if (!method) throw invalidAttempt();
  return method;
}

function tokenScopes(
  value: string | undefined,
  separator: string,
  requested: readonly string[],
  method: ReturnType<typeof oauthMethod>,
): readonly string[] {
  return normalizeScopes(method, value === undefined ? requested : value.split(separator));
}

function normalizeScopes(
  method: ReturnType<typeof oauthMethod>,
  scopes: readonly string[],
): readonly string[] {
  const aliases = new Map<string, string>();
  for (const [canonical, values] of Object.entries(method.oauth.scopeAliases ?? {})) {
    aliases.set(canonical, canonical);
    for (const alias of values) aliases.set(alias, canonical);
  }
  const canonical = new Set(fixedOAuthScopes(method));
  return [
    ...new Set(
      scopes
        .map((scope) => aliases.get(scope.trim()) ?? scope.trim())
        .filter((scope) => scope.length > 0 && canonical.has(scope)),
    ),
  ];
}

function secretDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function exactIssuer(value: URL): string {
  if (value.pathname !== "/" || value.search || value.hash || value.username || value.password) {
    throw new TypeError("Hosted OAuth broker issuer must be a bare origin");
  }
  return value.origin;
}

function invalidAttempt(): ControlPlaneError {
  return new ControlPlaneError(
    "forbidden",
    "Hosted OAuth attempt is invalid, expired, or already used",
  );
}

function attemptVault(encodedKey: string): AesGcmSecretVault {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encodedKey) {
    throw new TypeError("Hosted OAuth attempt key must be canonical base64url for 32 bytes");
  }
  try {
    return new AesGcmSecretVault(new StaticEncryptionKeyProvider(new Map([[1, key]]), 1));
  } finally {
    key.fill(0);
  }
}

function brokerAttemptSecretContext(input: {
  readonly attemptId: HostedOAuthAttemptId;
  readonly deploymentId: DeploymentId;
  readonly provider: string;
}) {
  return {
    binding: input.provider,
    purpose: "hosted-oauth-authorization-attempt",
    recordId: input.attemptId,
    scope: `deployment:${input.deploymentId}`,
  } as const;
}

function privateKeyPair(privateKey: string) {
  // The public half is configured beside the private half so key rotation is explicit.
  const separator = privateKey.indexOf(".");
  if (separator < 1)
    throw new TypeError("Hosted OAuth broker key must contain private and public parts");
  const pair = {
    privateKey: privateKey.slice(0, separator),
    publicKey: privateKey.slice(separator + 1),
  };
  try {
    const sealed = sealOAuthBrokerPayload({ probe: true }, pair.publicKey, {
      purpose: "key-check",
    });
    openOAuthBrokerPayload(sealed, pair.privateKey, { purpose: "key-check" });
  } catch {
    throw new TypeError("Hosted OAuth broker encryption private key is invalid");
  }
  return pair;
}
