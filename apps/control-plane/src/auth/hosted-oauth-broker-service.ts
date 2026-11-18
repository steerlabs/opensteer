import type { OAuthMethodConfig } from "./provider-oauth-config.js";
import { createHash } from "node:crypto";
import {
  AesGcmSecretVault,
  StaticEncryptionKeyProvider,
  type SealedSecret,
} from "@opensteer/access/host";
import {
  CreatePluginOAuthAttemptRequestSchema,
  CreatePluginOAuthCallbackRelayRequestSchema,
  CreatePluginOAuthRefreshRequestSchema,
  CreatePluginOAuthRevocationRequestSchema,
  OAuthBrokerPluginAuthorizationContextSchema,
  OAuthBrokerPluginRelayContextSchema,
  OAuthBrokerPluginProviderSchema,
  OAuthBrokerPluginRelaySchema,
  OAuthBrokerPluginRefreshContextSchema,
  OAuthBrokerPluginRevocationContextSchema,
  CreateHostedOAuthAttemptResponseSchema,
  CreateHostedOAuthRevocationResponseSchema,
  HostedOAuthAttemptIdSchema,
  OAuthBrokerAccountSubjectSchema,
  HostedOAuthAttemptStatusResponseSchema,
  HostedOAuthProviderErrorSchema,
  OAuthBrokerAuthorizationResponseSchema,
  OAuthBrokerDigestSchema,
  OAuthBrokerPublicMetadataSchema,
  OAuthBrokerRevocationCredentialSchema,
  OAuthBrokerSealedEnvelopeSchema,
  OAuthBrokerTokenBundleSchema,
  PullHostedOAuthRefreshResponseSchema,
  PullHostedOAuthResultResponseSchema,
  ReturnHostedOAuthAttemptResponseSchema,
  type ControlPlaneAccountId,
  type HostedOAuthAttemptId,
  type HostedOAuthRefreshTransactionId,
} from "@opensteer/control-plane-protocol";
import {
  buildDeclarativeAuthorizationUrl,
  missingRequiredScopes,
  exchangeDeclarativeAuthorizationToken,
  refreshDeclarativeCredential,
  revokeDeclarativeCredential,
} from "./provider-oauth-flow.js";
import {
  createOAuthState,
  oauthAuthorizationFailure,
  oauthUserDeniedAuthorization,
  OAuth2Error,
  oauthFailureKind,
  validateOAuthAuthorizationResponse,
} from "./provider-oauth.js";
import {
  generateOAuthBrokerEphemeralKeyPair,
  openOAuthBrokerPayload,
  sealOAuthBrokerPayload,
  hostedOAuthDeploymentAuthorityDigest,
} from "@opensteer/control-plane-protocol/broker-sealing";
import {
  HostedOAuthProviderRegistrySchema,
  registryOAuthConfig,
  type HostedOAuthProviderApplication,
} from "./hosted-oauth-provider-registry.js";
export type { HostedOAuthProviderApplication } from "./hosted-oauth-provider-registry.js";
import {
  integrationAuthorizationBrowserReturn,
  IntegrationAuthorizationReturnPortSchema,
  type IntegrationAuthorizationAppHandoff,
  type IntegrationAuthorizationBrowserReturn,
} from "@opensteer/integration-core";
import { sameStringSet, type DeploymentId } from "@opensteer/core";
import { z } from "zod";
import { ControlPlaneError } from "../server/errors.js";
import { HostedOAuthBrokerStore } from "./hosted-oauth-broker-store.js";
import type { HostAuthority } from "../database/store.js";

const authorizationLifetimeMilliseconds = 10 * 60 * 1_000;
const refreshLifetimeMilliseconds = 2 * 60 * 1_000;

const BrokerAuthorizationContextSchema = OAuthBrokerPluginProviderSchema.extend({
  authorizationUrl: z.url().max(262_144),
  codeVerifier: z.string().min(43).max(256).nullable(),
  clientSurface: z.enum(["desktop", "native", "web"]),
  finish: z.literal("app").optional(),
  appReturnPort: IntegrationAuthorizationReturnPortSchema.optional(),
  launchTicket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  mode: z.enum(["managed", "callback-relay"]),
  relay: OAuthBrokerPluginRelaySchema.optional(),
  returnPath: z.string().min(1).max(2_048).optional(),
})
  .strict()
  .superRefine((value, context) => {
    if ((value.mode === "callback-relay") !== Boolean(value.relay)) {
      context.addIssue({
        code: "custom",
        message: "Callback relay binding is missing or unexpected",
      });
    }
  });
type BrokerAuthorizationContext = z.infer<typeof BrokerAuthorizationContextSchema>;

const ReturnReceiptSchema = z.strictObject({
  accountSubject: OAuthBrokerAccountSubjectSchema,
  deploymentAuthorityDigest: OAuthBrokerDigestSchema,
  returnProofHash: OAuthBrokerDigestSchema,
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
      HostedOAuthProviderRegistrySchema.parse(options.applications).map((application) => [
        application.provider,
        application,
      ]),
    );
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

  metadata() {
    return OAuthBrokerPublicMetadataSchema.parse({
      encryptionPublicKey: this.#brokerKeyPair.publicKey,
      installationUrls: Object.fromEntries(
        [...this.#applications.values()].flatMap(({ installationUrl, provider }) =>
          installationUrl ? [[provider, installationUrl]] : [],
        ),
      ),
      issuer: this.#issuer,
      pluginProviders: Object.fromEntries(
        [...this.#applications.values()].map((application) => [
          application.provider,
          {
            revision: application.revision,
            authorizationUrl: application.oauth.authorizationUrl,
            tokenUrl: application.oauth.tokenUrl,
            ...(application.oauth.revocation
              ? { revocationUrl: application.oauth.revocation.url }
              : {}),
            allowedScopes: application.allowedScopes,
            scopeSeparator: application.oauth.scopeSeparator,
            ...(application.placement ? { placement: application.placement } : {}),
          },
        ]),
      ),
      pluginOAuth: 1,
      pluginCallbackRelay: 1,
      appFinish: 1,
      appReturnPort: 1,
    });
  }

  async createAuthorizationAttempt(authority: HostAuthority, raw: unknown) {
    const input = CreatePluginOAuthAttemptRequestSchema.parse(raw);
    assertAppFinishSurface(input);
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, input.binding.accountSubject);
    assertAuthorityDigest(input.binding.deploymentAuthorityDigest, binding);
    const { application, oauth, scopes } = this.#qualifiedProvider(input);
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
      config: oauth,
      redirectUrl: this.callbackUrl(input.provider),
      state,
    });
    if (!sameStringSet(authorization.scopes, scopes)) throw invalidAttempt();
    const context = BrokerAuthorizationContextSchema.parse({
      ...pluginProvider(input),
      authorizationUrl: authorization.authorizationUrl,
      codeVerifier: authorization.codeVerifier ?? null,
      clientSurface: input.clientSurface,
      ...(input.finish ? { finish: input.finish } : {}),
      ...(input.appReturnPort === undefined ? {} : { appReturnPort: input.appReturnPort }),
      launchTicket,
      mode: "managed",
      ...(input.returnPath ? { returnPath: input.returnPath } : {}),
    });
    const sealed = await this.#sealAttemptContext(context, {
      attemptId: input.attemptId,
      deploymentId: authority.deploymentId,
      provider: input.provider,
    });
    const persisted = await this.#store.createAttempt(
      {
        accountSubject: input.binding.accountSubject.subject,
        attemptId: input.attemptId,
        contextKeyVersion: sealed.keyVersion,
        deploymentId: authority.deploymentId,
        encryptedContext: sealed.envelope,
        expiresAt,
        hostPublicKey: input.binding.hostPublicKey,
        launchTicketHash: secretDigest(launchTicket),
        provider: input.provider,
        registryRevision: input.registryRevision,
        requestedScopeDigest: scopeDigest(scopes),
        stateHash: secretDigest(state),
      },
      now,
    );
    const durableContext = await this.#openAttemptContext(persisted, input.attemptId);
    if (
      durableContext.mode !== "managed" ||
      durableContext.finish !== input.finish ||
      durableContext.appReturnPort !== input.appReturnPort ||
      durableContext.clientSurface !== input.clientSurface ||
      JSON.stringify(pluginProvider(durableContext)) !== JSON.stringify(pluginProvider(input)) ||
      durableContext.returnPath !== input.returnPath
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
    const input = CreatePluginOAuthCallbackRelayRequestSchema.parse(raw);
    assertAppFinishSurface(input);
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, input.binding.accountSubject);
    assertAuthorityDigest(input.binding.deploymentAuthorityDigest, binding);
    if (input.binding.redirectUrl !== this.callbackUrl(input.provider)) throw invalidAttempt();
    const authorizationUrl = validatePluginRelay(input);
    const now = this.#now();
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + authorizationLifetimeMilliseconds)
      throw invalidAttempt();
    const launchTicket = createOAuthState();
    const context = BrokerAuthorizationContextSchema.parse({
      ...pluginProvider(input),
      clientSurface: input.clientSurface,
      ...(input.finish ? { finish: input.finish } : {}),
      ...(input.appReturnPort === undefined ? {} : { appReturnPort: input.appReturnPort }),
      ...(input.returnPath ? { returnPath: input.returnPath } : {}),
      authorizationUrl: authorizationUrl.toString(),
      codeVerifier: null,
      launchTicket,
      mode: "callback-relay",
      relay: input.relay,
    });
    const sealed = await this.#sealAttemptContext(context, {
      attemptId: input.attemptId,
      deploymentId: authority.deploymentId,
      provider: input.provider,
    });
    const row = await this.#store.createAttempt(
      {
        accountSubject: input.binding.accountSubject.subject,
        attemptId: input.attemptId,
        deploymentId: authority.deploymentId,
        provider: input.provider,
        contextKeyVersion: sealed.keyVersion,
        encryptedContext: sealed.envelope,
        expiresAt,
        hostPublicKey: input.binding.hostPublicKey,
        launchTicketHash: secretDigest(launchTicket),
        stateHash: secretDigest(authorizationUrl.searchParams.get("state")!),
        registryRevision: input.registryRevision,
        requestedScopeDigest: scopeDigest(input.requestedScopes),
      },
      now,
    );
    const durable = await this.#openAttemptContext(row, input.attemptId);
    if (
      durable.mode !== "callback-relay" ||
      JSON.stringify(pluginProvider(durable)) !== JSON.stringify(pluginProvider(context)) ||
      JSON.stringify(durable.relay) !== JSON.stringify(input.relay) ||
      durable.authorizationUrl !== context.authorizationUrl ||
      durable.finish !== context.finish ||
      durable.appReturnPort !== context.appReturnPort ||
      durable.clientSurface !== context.clientSurface ||
      durable.returnPath !== context.returnPath
    )
      throw new ControlPlaneError("conflict", "OAuth callback relay attempt ID was already used");
    const launchUrl = new URL(`/v1/oauth-broker/launch/${input.attemptId}`, this.#issuer);
    launchUrl.searchParams.set("ticket", durable.launchTicket);
    return CreateHostedOAuthAttemptResponseSchema.parse({
      attemptId: input.attemptId,
      expiresAt: input.expiresAt,
      launchUrl: launchUrl.toString(),
    });
  }

  async inspectLaunch(attemptId: HostedOAuthAttemptId, ticket: string) {
    const row = await this.#store.inspectLaunchAttempt(attemptId, secretDigest(ticket));
    if (!row) return { status: "invalid" as const };
    if (row.expiresAt <= this.#now()) return { status: "expired" as const };
    if (row.status !== "pending") return { status: "used" as const };
    const context = await this.#openAttemptContext(row, attemptId);
    return { status: "ready" as const, finish: context.finish };
  }

  async launchAuthorization(
    accountId: ControlPlaneAccountId | null,
    attemptIdInput: HostedOAuthAttemptId,
    launchTicket: string,
  ): Promise<string> {
    const attemptId = HostedOAuthAttemptIdSchema.parse(attemptIdInput);
    const pending = await this.#store.inspectLaunchAttempt(attemptId, secretDigest(launchTicket));
    if (!pending || pending.expiresAt <= this.#now() || pending.status !== "pending") {
      throw new HostedOAuthBrokerRefusal(attemptId, "invalid-or-expired-link");
    }
    let pendingContext: BrokerAuthorizationContext;
    try {
      pendingContext = await this.#openAttemptContext(pending, attemptId);
    } catch {
      throw new HostedOAuthBrokerRefusal(attemptId, "launch-context-invalid");
    }
    if (pendingContext.finish !== "app" && accountId !== pending.accountSubject) {
      throw new HostedOAuthBrokerRefusal(
        attemptId,
        accountId ? "account-mismatch" : "sign-in-required",
      );
    }
    const launched = await this.#store.launchAttempt({
      accountId: pending.accountSubject,
      attemptId,
      launchTicketHash: secretDigest(launchTicket),
      now: this.#now(),
    });
    if (!launched) throw new HostedOAuthBrokerRefusal(attemptId, "launch-access-refused");
    let refusalReason = "launch-authority-mismatch";
    try {
      const context = await this.#openAttemptContext(launched, attemptId);
      const binding = await this.#requireDeploymentBinding(launched.deploymentId);
      await this.#assertAccountAccess(binding, context.binding.accountSubject);
      assertAuthorityDigest(context.binding.deploymentAuthorityDigest, binding);
      refusalReason = "launch-authorization-invalid";
      const authorizationUrl = new URL(context.authorizationUrl);
      if (
        secretDigest(authorizationUrl.searchParams.get("state") ?? "") !== launched.stateHash ||
        scopeDigest(context.requestedScopes) !== launched.requestedScopeDigest
      )
        throw invalidAttempt();
      if (context.relay) {
        if (context.binding.redirectUrl !== this.callbackUrl(launched.provider))
          throw invalidAttempt();
        return validatePluginRelay({ ...context, relay: context.relay }).toString();
      }
      const { application, scopes } = this.#qualifiedProvider(context);
      if (
        context.provider !== launched.provider ||
        context.registryRevision !== launched.registryRevision ||
        !sameStringSet(scopes, context.requestedScopes) ||
        authorizationUrl.searchParams.get("client_id") !== application.clientId ||
        authorizationUrl.searchParams.get("redirect_uri") !== context.binding.redirectUrl
      )
        throw invalidAttempt();
      return authorizationUrl.toString();
    } catch (error) {
      const failureCode =
        error instanceof ControlPlaneError && error.code === "conflict"
          ? "stale-provider-application"
          : refusalReason === "launch-authority-mismatch"
            ? "account-link-mismatch"
            : "invalid-provider-response";
      await this.#store
        .failAttempt(attemptId, "failed", failureCode, this.#now())
        .catch(() => undefined);
      throw new HostedOAuthBrokerRefusal(
        attemptId,
        failureCode === "invalid-provider-response" || failureCode === "account-link-mismatch"
          ? refusalReason
          : failureCode,
      );
    }
  }

  async completeAuthorization(input: {
    readonly parameters: URLSearchParams;
    readonly cookieHeader?: string | undefined;
    readonly provider: string;
  }): Promise<{
    readonly attemptId: HostedOAuthAttemptId;
    readonly returnUrl?: string;
    readonly failureCode?: string;
    readonly providerError?: string | null;
    readonly status: "denied" | "failed" | "sealed" | "held";
    readonly returnKind?: "open-app";
    readonly returnHandoff?: IntegrationAuthorizationAppHandoff;
  }> {
    const now = this.#now();
    let state: string;
    try {
      const states = input.parameters.getAll("state");
      if (states.length !== 1) throw invalidAttempt();
      state = z
        .string()
        .min(32)
        .max(1024)
        .regex(/^[^\p{Cc}\p{Cf}]+$/u)
        .parse(states[0]);
    } catch {
      throw new HostedOAuthBrokerRefusal(null, "invalid-callback-state");
    }
    const browserBindings = (input.cookieHeader ?? "").split(";").flatMap((cookie) => {
      const match = /^__Secure-opensteer\.oauth\.(hoa_[0-9a-f-]{36})=([A-Za-z0-9_-]{43})$/iu.exec(
        cookie.trim(),
      );
      return match ? [{ attemptId: match[1]!, hash: secretDigest(match[2]!) }] : [];
    });
    const row = await this.#store.claimCallback({
      browserBindings,
      now,
      provider: input.provider,
      stateHash: secretDigest(state),
    });
    if (!row)
      throw new HostedOAuthBrokerRefusal(
        await this.#store.callbackAttemptId(secretDigest(state)),
        "callback-claim-refused",
      );
    const attemptId = HostedOAuthAttemptIdSchema.parse(row.attemptId);
    let context: BrokerAuthorizationContext;
    try {
      context = await this.#openAttemptContext(row, attemptId);
    } catch {
      await this.#store.failAttempt(attemptId, "failed", "invalid-provider-response", now);
      return { attemptId, status: "failed", failureCode: "invalid-provider-response" };
    }
    const appFailureReturn =
      context.finish === "app"
        ? callbackReturnUrl({
            attemptId,
            canonicalOrigin: this.#issuer,
            clientSurface: context.clientSurface,
            deploymentId: row.deploymentId,
            returnPath: context.returnPath,
            finish: "app",
          })
        : null;
    if (context.relay) {
      let returnUrl: IntegrationAuthorizationBrowserReturn | null = appFailureReturn;
      try {
        const binding = await this.#requireDeploymentBinding(row.deploymentId);
        await this.#assertAccountAccess(binding, context.binding.accountSubject);
        assertAuthorityDigest(context.binding.deploymentAuthorityDigest, binding);
        if (
          context.binding.redirectUrl !== this.callbackUrl(row.provider) ||
          context.provider !== row.provider ||
          context.registryRevision !== row.registryRevision ||
          scopeDigest(context.requestedScopes) !== row.requestedScopeDigest
        )
          throw invalidAttempt();
        validatePluginRelay({ ...context, relay: context.relay });
        returnUrl = callbackReturnUrl({
          attemptId,
          canonicalOrigin: binding.canonicalOrigin,
          clientSurface: context.clientSurface,
          finish: context.finish,
          deploymentId: binding.id,
          returnPath: context.returnPath,
        });
        const response = validateOAuthAuthorizationResponse({
          clientId: context.relay.clientId,
          issuer: context.relay.issuer,
          authorizationResponseIssuerParameterSupported:
            context.relay.authorizationResponseIssuerParameterSupported,
          parameters: input.parameters,
          expectedState: new URL(context.authorizationUrl).searchParams.get("state")!,
        });
        if (response.kind === "error") {
          const status = oauthUserDeniedAuthorization(response.error) ? "denied" : "failed";
          await this.#store.failAttempt(attemptId, status, "authorization-denied", now);
          return authorizationCompletion(attemptId, status, returnUrl, "authorization-denied");
        }
        const sealingContext = OAuthBrokerPluginRelayContextSchema.parse({
          ...pluginProvider(context),
          attemptId,
          expiresAt: row.expiresAt.toISOString(),
          relay: context.relay,
          schemaVersion: 2,
        });
        const sealed = sealOAuthBrokerPayload(
          OAuthBrokerAuthorizationResponseSchema.parse({ parameters: [...input.parameters] }),
          row.hostPublicKey,
          sealingContext,
        );
        return await this.#sealAuthorizationResult(row, context, sealed, returnUrl);
      } catch {
        await this.#store.failAttempt(attemptId, "failed", "invalid-provider-response", now);
        return authorizationCompletion(attemptId, "failed", returnUrl, "invalid-provider-response");
      }
    }
    let application: HostedOAuthProviderApplication;
    let oauth: OAuthMethodConfig;
    try {
      ({ application, oauth } = this.#qualifiedProvider(context));
      if (
        context.provider !== row.provider ||
        context.registryRevision !== row.registryRevision ||
        scopeDigest(context.requestedScopes) !== row.requestedScopeDigest
      )
        throw invalidAttempt();
    } catch (error) {
      const failureCode =
        error instanceof ControlPlaneError && error.code === "conflict"
          ? "stale-provider-application"
          : "invalid-provider-response";
      await this.#store.failAttempt(attemptId, "failed", failureCode, now);
      return authorizationCompletion(attemptId, "failed", appFailureReturn, failureCode);
    }
    let returnUrl: IntegrationAuthorizationBrowserReturn | null = appFailureReturn;
    try {
      const binding = await this.#requireDeploymentBinding(row.deploymentId);
      await this.#assertAccountAccess(binding, context.binding.accountSubject);
      assertAuthorityDigest(context.binding.deploymentAuthorityDigest, binding);
      returnUrl = callbackReturnUrl({
        attemptId,
        canonicalOrigin: binding.canonicalOrigin,
        clientSurface: context.clientSurface,
        finish: context.finish,
        deploymentId: binding.id,
        returnPath: context.returnPath,
      });
    } catch {
      await this.#store.failAttempt(attemptId, "failed", "account-link-mismatch", now);
      return authorizationCompletion(
        attemptId,
        "failed",
        appFailureReturn,
        "account-link-mismatch",
      );
    }
    let authorizationResponse;
    try {
      authorizationResponse = validateOAuthAuthorizationResponse({
        clientId: application.clientId,
        issuer: oauth.issuer ?? null,
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
    let exchanged: Awaited<ReturnType<typeof exchangeDeclarativeAuthorizationToken>>;
    try {
      exchanged = await exchangeDeclarativeAuthorizationToken({
        clientId: application.clientId,
        clientSecret: application.clientSecret,
        code: authorizationResponse.code,
        ...(context.codeVerifier ? { codeVerifier: context.codeVerifier } : {}),
        config: oauth,
        fetch: this.#fetch,
        redirectUrl: context.binding.redirectUrl,
      });
    } catch (error) {
      const failure = oauthAuthorizationFailure(error);
      await this.#store.failAttempt(attemptId, "failed", failure.failureCode, now);
      return { ...authorizationCompletion(attemptId, "failed", returnUrl), ...failure };
    }
    const response = exchanged.tokenResponse;
    const grantedScopes = tokenScopes(
      response.scope,
      oauth.scopeSeparator,
      context.requestedScopes,
      oauth,
    );
    if (
      grantedScopes.some(
        (scope) =>
          !context.requestedScopes.includes(scope) || !application.allowedScopes.includes(scope),
      ) ||
      missingRequiredScopes({
        config: oauth,
        requiredScopes: context.requestedScopes.filter((scope) => scope !== "offline_access"),
        grantedScopes: grantedScopes,
      }).length > 0
    ) {
      await this.#store.failAttempt(attemptId, "failed", "scope-escalation", now);
      return authorizationCompletion(attemptId, "failed", returnUrl, "scope-escalation");
    }
    try {
      const sealingContext = OAuthBrokerPluginAuthorizationContextSchema.parse({
        ...pluginProvider(context),
        attemptId,
        expiresAt: row.expiresAt.toISOString(),
        schemaVersion: 2,
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
        tokenType:
          oauth.tokenResponseProfile === "slack-bot" ? "Bearer" : (response.token_type ?? "Bearer"),
      });
      const sealed = OAuthBrokerSealedEnvelopeSchema.parse(
        sealOAuthBrokerPayload(bundle, row.hostPublicKey, sealingContext),
      );
      return await this.#sealAuthorizationResult(row, context, sealed, returnUrl);
    } catch {
      await this.#store
        .failAttempt(attemptId, "failed", "invalid-provider-response", now)
        .catch(() => undefined);
      return authorizationCompletion(attemptId, "failed", returnUrl, "invalid-provider-response");
    }
  }

  async #sealAuthorizationResult(
    row: NonNullable<Awaited<ReturnType<HostedOAuthBrokerStore["claimCallback"]>>>,
    context: BrokerAuthorizationContext,
    sealed: z.infer<typeof OAuthBrokerSealedEnvelopeSchema>,
    returnUrl: IntegrationAuthorizationBrowserReturn | null,
  ) {
    const now = this.#now();
    if (row.expiresAt <= now) {
      await this.#store.purgeExpired(now);
      throw new HostedOAuthBrokerRefusal(row.attemptId, "callback-expired");
    }
    if (context.finish !== "app") {
      await this.#store.sealAttempt(row.attemptId, sealed, now);
      return authorizationCompletion(row.attemptId, "sealed", returnUrl);
    }
    const proof = createOAuthState();
    const returnProofHash = secretDigest(proof);
    // Keep only authority and the proof digest after exchange. The encrypted receipt
    // also verifies a lost /return response after ACK has erased the result and proof column.
    const receipt = await this.#attemptVault.seal(
      {
        accountSubject: JSON.stringify(context.binding.accountSubject),
        deploymentAuthorityDigest: context.binding.deploymentAuthorityDigest,
        returnProofHash,
      },
      brokerAttemptSecretContext(row),
    );
    await this.#store.sealAttempt(row.attemptId, sealed, now, {
      contextKeyVersion: receipt.keyVersion,
      encryptedContext: receipt.envelope,
      returnProofHash,
    });
    return authorizationCompletion(
      row.attemptId,
      "held",
      callbackReturnUrl({
        appReturnPort: context.appReturnPort,
        attemptId: row.attemptId,
        canonicalOrigin: this.#issuer,
        clientSurface: context.clientSurface,
        deploymentId: row.deploymentId,
        finish: "app",
        returnPath: context.returnPath,
        returnProof: proof,
      }),
    );
  }

  async returnAttempt(
    authority: HostAuthority,
    attemptId: HostedOAuthAttemptId,
    returnProof: string,
  ) {
    let reason = "return-attempt-unavailable";
    try {
      const now = this.#now();
      const row = await this.#store.getAttemptForHost(authority.deploymentId, attemptId, now);
      if (!row || row.expiresAt <= now || !["held", "sealed", "acknowledged"].includes(row.status))
        throw invalidAttempt();
      reason = "return-receipt-invalid";
      if (!row.encryptedContext || row.contextKeyVersion === null) throw invalidAttempt();
      const opened = await this.#attemptVault.open(
        row.encryptedContext,
        brokerAttemptSecretContext(row),
      );
      const receipt = ReturnReceiptSchema.parse({
        ...opened,
        accountSubject: JSON.parse(opened.accountSubject ?? ""),
      });
      reason = "return-proof-mismatch";
      const returnProofHash = secretDigest(returnProof);
      if (
        returnProofHash !== receipt.returnProofHash ||
        (row.status === "held" && row.returnProofHash !== returnProofHash)
      )
        throw invalidAttempt();
      reason = "return-authority-mismatch";
      const binding = await this.#requireDeploymentBinding(authority.deploymentId);
      await this.#assertAccountAccess(binding, receipt.accountSubject);
      if (row.accountSubject !== receipt.accountSubject.subject) throw invalidAttempt();
      assertAuthorityDigest(receipt.deploymentAuthorityDigest, binding);
      if (row.status === "held") {
        reason = "return-access-refused";
        if (
          !(await this.#store.returnAttempt({
            deploymentId: authority.deploymentId,
            attemptId,
            returnProofHash,
            binding,
            now,
          }))
        ) {
          const current = await this.#store.getAttemptForHost(
            authority.deploymentId,
            attemptId,
            now,
          );
          if (
            !current ||
            current.expiresAt <= now ||
            !["sealed", "acknowledged"].includes(current.status)
          )
            throw invalidAttempt();
        }
      }
      return ReturnHostedOAuthAttemptResponseSchema.parse(await this.status(authority, attemptId));
    } catch (error) {
      // A refusal is final for the Host; a database or vault outage must stay
      // retryable, so only decided refusals and malformed receipts become one.
      if (error instanceof ControlPlaneError || error instanceof z.ZodError) {
        throw new HostedOAuthBrokerRefusal(attemptId, reason);
      }
      throw error;
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
      status: row.status === "exchanging" || row.status === "held" ? "launched" : row.status,
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
    const input = CreatePluginOAuthRefreshRequestSchema.parse(raw);
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, input.binding.accountSubject);
    assertAuthorityDigest(input.binding.deploymentAuthorityDigest, binding);
    const expiresAt = new Date(input.expiresAt);
    const now = this.#now();
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + refreshLifetimeMilliseconds) {
      throw new ControlPlaneError("bad_request", "Hosted OAuth refresh expiry is invalid");
    }
    const { application, oauth } = this.#qualifiedProvider(input);
    const reviewedScopes = oauth.scopes;
    const priorGrantedScopes = normalizeScopes(oauth, input.grantedScopes);
    if (
      priorGrantedScopes.some(
        (scope) =>
          !input.requestedScopes.includes(scope) || !application.allowedScopes.includes(scope),
      )
    )
      throw new ControlPlaneError("forbidden", "Hosted OAuth refresh scope exceeds consent");
    if (
      missingRequiredScopes({
        config: oauth,
        requiredScopes: reviewedScopes.filter((scope) => scope !== "offline_access"),
        grantedScopes: priorGrantedScopes,
      }).length > 0
    ) {
      throw new ControlPlaneError(
        "forbidden",
        "Hosted OAuth refresh is missing required functional scopes",
      );
    }
    const context = OAuthBrokerPluginRefreshContextSchema.parse({
      ...pluginProvider(input),
      expiresAt: input.expiresAt,
      transactionId: input.transactionId,
      schemaVersion: 2,
    });
    const claim = await this.#store.claimRefresh(
      {
        requestBindingDigest: secretDigest(
          JSON.stringify({ context, grantedScopes: [...priorGrantedScopes].sort() }),
        ),
        accountSubject: input.binding.accountSubject.subject,
        deploymentId: authority.deploymentId,
        expiresAt,
        hostPublicKey: input.binding.hostPublicKey,
        provider: input.provider,
        registryRevision: input.registryRevision,
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
        config: oauth,
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
    const refreshedScopes = normalizeScopes(oauth, refreshed.grantedScopes);
    const grantedScopes = refreshedScopes;
    if (
      grantedScopes.some(
        (scope) =>
          !input.requestedScopes.includes(scope) || !application.allowedScopes.includes(scope),
      ) ||
      missingRequiredScopes({
        config: oauth,
        requiredScopes: reviewedScopes.filter((scope) => scope !== "offline_access"),
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
        input.binding.hostPublicKey,
        context,
      ),
    );
    await this.#store.sealRefresh(input.transactionId, sealed, this.#now());
    return {
      expiresAt: input.expiresAt,
      failureCode: null,
      providerError: null,
      status: "sealed" as const,
      transactionId: input.transactionId,
    };
  }

  async revoke(authority: HostAuthority, raw: unknown) {
    const input = CreatePluginOAuthRevocationRequestSchema.parse(raw);
    const binding = await this.#requireDeploymentBinding(authority.deploymentId);
    await this.#assertAccountAccess(binding, input.binding.accountSubject);
    assertAuthorityDigest(input.binding.deploymentAuthorityDigest, binding);
    const expiresAt = new Date(input.expiresAt);
    const now = this.#now();
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + refreshLifetimeMilliseconds) {
      throw new ControlPlaneError("bad_request", "Hosted OAuth revocation expiry is invalid");
    }
    const { application, oauth } = this.#qualifiedProvider(input);
    if (!oauth.revocation) {
      throw new ControlPlaneError(
        "bad_request",
        "Hosted OAuth provider does not declare token revocation",
      );
    }
    const context = OAuthBrokerPluginRevocationContextSchema.parse({
      ...pluginProvider(input),
      expiresAt: input.expiresAt,
      transactionId: input.transactionId,
      schemaVersion: 2,
    });
    const credential = OAuthBrokerRevocationCredentialSchema.parse(
      openOAuthBrokerPayload(input.brokerSealedCredential, this.#brokerKeyPair.privateKey, context),
    );
    try {
      await revokeDeclarativeCredential({
        accessToken: credential.accessToken,
        clientId: application.clientId,
        clientSecret: application.clientSecret,
        config: oauth,
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
      { context: JSON.stringify(BrokerAuthorizationContextSchema.parse(context)) },
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
    return BrokerAuthorizationContextSchema.parse(JSON.parse(opened.context ?? ""));
  }

  callbackUrl(provider: string): string {
    return new URL(
      `/v1/oauth-broker/callback/${encodeURIComponent(provider)}`,
      this.#issuer,
    ).toString();
  }

  mcpClientMetadata() {
    return {
      client_id: new URL("/v1/oauth-broker/mcp/client-metadata.json", this.#issuer).toString(),
      client_name: "Opensteer",
      client_uri: this.#issuer,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.callbackUrl("mcp")],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  #qualifiedProvider(input: z.infer<typeof OAuthBrokerPluginProviderSchema>) {
    const application = this.#applications.get(input.provider);
    if (!application || application.revision !== input.registryRevision)
      throw new ControlPlaneError("conflict", "Hosted OAuth provider registry revision is stale");
    if (input.binding.redirectUrl !== this.callbackUrl(input.provider)) throw invalidAttempt();
    let oauth: OAuthMethodConfig;
    try {
      oauth = registryOAuthConfig(application, input.requestedScopes);
    } catch {
      throw new ControlPlaneError(
        "forbidden",
        "Requested OAuth scopes exceed the provider registry",
      );
    }
    return { application, oauth, scopes: [...new Set(input.requestedScopes)] };
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

function callbackReturnUrl(input: {
  readonly appReturnPort?: number | undefined;
  readonly attemptId: HostedOAuthAttemptId;
  readonly canonicalOrigin: string;
  readonly clientSurface: "desktop" | "native" | "web";
  readonly deploymentId: DeploymentId;
  readonly returnPath: string | undefined;
  readonly finish?: "app" | undefined;
  readonly returnProof?: string;
}): IntegrationAuthorizationBrowserReturn {
  return integrationAuthorizationBrowserReturn({
    attemptId: `ioa_${input.attemptId.slice("hoa_".length)}`,
    canonicalOrigin: input.canonicalOrigin,
    surface: input.clientSurface,
    deploymentId: input.deploymentId,
    ...(input.appReturnPort === undefined ? {} : { appReturnPort: input.appReturnPort }),
    ...(input.finish ? { finish: input.finish } : {}),
    ...(input.returnProof ? { returnProof: input.returnProof } : {}),
    ...(input.returnPath === undefined ? {} : { returnPath: input.returnPath }),
  });
}

function authorizationCompletion(
  attemptId: HostedOAuthAttemptId,
  status: "denied" | "failed" | "sealed" | "held",
  browserReturn: IntegrationAuthorizationBrowserReturn | null,
  failureCode?: string,
) {
  const returnUrl =
    browserReturn?.kind === "redirect" || browserReturn?.kind === "open-app"
      ? browserReturn.location
      : null;
  return {
    attemptId,
    ...(returnUrl ? { returnUrl } : {}),
    ...(browserReturn?.kind === "open-app" ? { returnKind: "open-app" as const } : {}),
    ...(browserReturn?.kind === "open-app" && browserReturn.handoff
      ? { returnHandoff: browserReturn.handoff }
      : {}),
    ...(failureCode ? { failureCode } : {}),
    status,
  };
}

/** The provider's raw error code travels onward only when it fits the bounded diagnostic shape. */
function boundedProviderError(errorCode: string | undefined): string | null {
  const parsed = HostedOAuthProviderErrorSchema.safeParse(errorCode);
  return parsed.success ? parsed.data : null;
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

function tokenScopes(
  value: string | undefined,
  separator: string,
  requested: readonly string[],
  oauth: OAuthMethodConfig,
): readonly string[] {
  return normalizeScopes(oauth, value === undefined ? requested : value.split(separator));
}

function normalizeScopes(oauth: OAuthMethodConfig, scopes: readonly string[]): readonly string[] {
  const aliases = new Map<string, string>();
  for (const [canonical, values] of Object.entries(oauth.scopeAliases ?? {})) {
    aliases.set(canonical, canonical);
    for (const alias of values) aliases.set(alias, canonical);
  }
  return [
    ...new Set(
      scopes
        .map((scope) => aliases.get(scope.trim()) ?? scope.trim())
        .filter((scope) => scope.length > 0),
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

export function hostedOAuthBindingCookieName(attemptId: string): string {
  return `__Secure-opensteer.oauth.${attemptId}`;
}

function assertAppFinishSurface(input: {
  readonly appReturnPort?: number | undefined;
  readonly clientSurface: string;
  readonly finish?: "app" | undefined;
}) {
  if (
    input.finish === "app" &&
    input.clientSurface !== "desktop" &&
    input.clientSurface !== "native"
  ) {
    throw new ControlPlaneError("bad_request", "App finish requires a desktop or native client");
  }
  if (
    input.appReturnPort !== undefined &&
    (input.finish !== "app" || input.clientSurface !== "desktop")
  ) {
    throw new ControlPlaneError("bad_request", "A return port requires a desktop app finish");
  }
}

export class HostedOAuthBrokerRefusal extends ControlPlaneError {
  readonly attemptId: HostedOAuthAttemptId | null;
  readonly refusalReason: string;

  constructor(attemptId: HostedOAuthAttemptId | null, refusalReason: string) {
    super("forbidden", "Hosted OAuth attempt is invalid, expired, or already used");
    this.attemptId = attemptId;
    this.refusalReason = refusalReason;
  }
}

function pluginProvider(input: z.infer<typeof OAuthBrokerPluginProviderSchema>) {
  return OAuthBrokerPluginProviderSchema.parse({
    provider: input.provider,
    registryRevision: input.registryRevision,
    requestedScopes: input.requestedScopes,
    binding: input.binding,
  });
}
function validatePluginRelay(
  input: z.infer<typeof OAuthBrokerPluginProviderSchema> & {
    readonly authorizationUrl: string;
    readonly relay: z.infer<typeof OAuthBrokerPluginRelaySchema>;
  },
) {
  const relay = input.relay;
  if (input.provider === "mcp" && (!relay.usesPkce || relay.issuer === null))
    throw invalidAttempt();
  for (const value of [relay.issuer, relay.authorizationEndpoint, input.binding.redirectUrl]) {
    if (value === null) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw invalidAttempt();
  }
  const url = new URL(input.authorizationUrl);
  const endpoint = new URL(relay.authorizationEndpoint);
  const state = url.searchParams.get("state");
  if (
    url.origin !== endpoint.origin ||
    url.pathname !== endpoint.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("client_id").length !== 1 ||
    url.searchParams.get("client_id") !== relay.clientId ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.get("redirect_uri") !== input.binding.redirectUrl ||
    url.searchParams.getAll("response_type").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    url.searchParams.getAll("state").length !== 1 ||
    !state ||
    state.length < 32 ||
    state.length > 1024 ||
    /[\p{Cc}\p{Cf}]/u.test(state) ||
    url.searchParams.getAll("scope").length > 1 ||
    (relay.authorizationResponseIssuerParameterSupported && relay.issuer === null) ||
    (relay.usesPkce &&
      (url.searchParams.getAll("code_challenge_method").length !== 1 ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        url.searchParams.getAll("code_challenge").length !== 1 ||
        !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("code_challenge") ?? "")))
  )
    throw invalidAttempt();
  const scopes = url.searchParams.get("scope")?.split(relay.scopeSeparator).filter(Boolean) ?? [];
  if (!sameStringSet(scopes, input.requestedScopes)) throw invalidAttempt();
  return url;
}
