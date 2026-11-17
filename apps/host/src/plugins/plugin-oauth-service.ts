import { oauthReviewDigest } from "./oauth-review.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { OpensteerError, type UserId } from "@opensteer/core";
import { requirePersonalOwner } from "@opensteer/database";
import {
  PluginOAuthBeginSchema,
  PluginOAuthTargetSchema,
  PluginOAuthStatusSchema,
  type HostApiServerContext,
} from "@opensteer/protocol";
import { IntegrationAuthorizationAttemptIdSchema } from "@opensteer/integration-core";
import {
  CreatePluginOAuthRefreshRequestSchema,
  HostedOAuthAttemptIdSchema,
  HostedOAuthRevocationTransactionIdSchema,
  OAuthBrokerPluginAuthorizationContextSchema,
  OAuthBrokerPluginRelayContextSchema,
  OAuthBrokerPluginRefreshContextSchema,
  OAuthBrokerPluginRevocationContextSchema,
  OAuthBrokerPluginRelaySchema,
  OAuthBrokerTokenBundleSchema,
  OAuthBrokerMcpAuthorizationResponseSchema,
} from "@opensteer/control-plane-protocol";
import {
  generateOAuthBrokerEphemeralKeyPair,
  openOAuthBrokerPayload,
  sealOAuthBrokerPayload,
} from "@opensteer/control-plane-protocol/broker-sealing";
import {
  accountReturnPort,
  IntegrationAccountBindingSchema,
  resolveIntegrationAccountBinding,
} from "../access/integration-account-binding.js";
import {
  integrationAuthAttemptLifetimeMilliseconds,
  type DefaultIntegrationAuthAttemptLifecycle,
} from "../access/integration-auth-attempt-service.js";
import type { HostedOAuthBrokerClient } from "../access/hosted-oauth-broker-client.js";
import { PluginOAuthStore } from "./plugin-oauth-store.js";
import type { PluginService } from "./plugin-service.js";
import {
  OAuthConfigurationSchema,
  BrokerBindingSchema,
  ConsentSchema,
  PluginBrokerError,
  PluginServiceError,
  type PluginBrokerInput,
  type PluginBrokerOperation,
  type PluginBrokerOutput,
  type PluginConsent,
} from "./engine-protocol.js";

const importConfiguration = (value: unknown) =>
  OAuthConfigurationSchema.parse(JSON.parse(JSON.stringify(value)));
const ownerCaller = { caller: "personal", mode: "automatic" as const };
const sessionSchema = z.strictObject({
  connection: z.string(),
  callbackProvider: z.enum(["plugin", "mcp"]),
  target: PluginOAuthTargetSchema,
  consent: ConsentSchema,
  account: IntegrationAccountBindingSchema.nullable(),
  redirectUri: z.url(),
  input: PluginOAuthBeginSchema.omit({ client: true }).optional(),
  localId: IntegrationAuthorizationAttemptIdSchema.optional(),
  returnToHost: z.boolean().optional(),
  reviews: z
    .record(
      z.string(),
      z.strictObject({
        digest: z.string(),
        configurationDigest: z.string(),
        scopes: z.array(z.string()),
      }),
    )
    .optional(),
  broker: z
    .strictObject({
      id: HostedOAuthAttemptIdSchema,
      context: z.union([
        OAuthBrokerPluginRelayContextSchema,
        OAuthBrokerPluginAuthorizationContextSchema,
      ]),
      privateKey: z.string().optional(),
      binding: BrokerBindingSchema.optional(),
      proven: z.boolean(),
    })
    .optional(),
});
type Session = z.infer<typeof sessionSchema>;
const refreshSchema = z.strictObject({
  context: OAuthBrokerPluginRefreshContextSchema,
  privateKey: z.string(),
  request: CreatePluginOAuthRefreshRequestSchema,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () =>
  new OpensteerError({ code: "not_found", message: "Plugin sign-in is unavailable or expired" });

interface PluginOAuthServiceOptions {
  plugins: PluginService;
  store: PluginOAuthStore;
  attempts: DefaultIntegrationAuthAttemptLifecycle;
  origin: string;
  owner: () => Promise<UserId>;
  broker?: { client: HostedOAuthBrokerClient; deploymentAuthorityDigest: string };
  accountLinked: (input: {
    owner: UserId;
    plugin: string;
    requirement: string;
    scope: "app" | "user";
    consent: PluginConsent;
    settlementSessionId?: string;
  }) => Promise<void>;
}

export class PluginOAuthService {
  readonly #finishing = new Map<string, Promise<void>>();
  readonly options: PluginOAuthServiceOptions;
  constructor(options: PluginOAuthServiceOptions) {
    this.options = options;
  }

  async assertOwner(owner: UserId) {
    await requirePersonalOwner(this.options.store.database, owner);
  }
  async #account(owner: UserId) {
    return resolveIntegrationAccountBinding({
      database: this.options.store.database,
      ownerUserId: owner,
    });
  }
  async #current(session: Session, owner: UserId) {
    const current = await this.#account(owner);
    if (!same(current, session.account)) throw new PluginBrokerError("binding_changed");
    if (current && this.options.broker?.client.issuer !== new URL(current.issuer).origin)
      throw new PluginBrokerError("binding_changed");
  }
  #callback() {
    return new URL("/v1/plugin-oauth/callback", this.options.origin).href;
  }
  async #metadata() {
    const broker = this.options.broker;
    if (!broker)
      throw new OpensteerError({
        code: "conflict",
        message: "Link Opensteer Account to use this sign-in",
      });
    const metadata = await broker.client.metadata();
    if (new URL(metadata.issuer).origin !== broker.client.issuer)
      throw new PluginBrokerError("binding_changed");
    return metadata;
  }
  async configuration(
    linked: boolean,
  ): Promise<import("./engine-protocol.js").PluginOAuthConfiguration> {
    const owner = await this.options.owner();
    const account = linked ? await this.#account(owner) : null;
    if (!account)
      return {
        clients: [],
        metadataUrl: new URL("/v1/plugin-oauth/client-metadata.json", this.options.origin).href,
        metadataRedirectUri: this.#callback(),
      };
    const key = `configuration:${oauthReviewDigest(account)}`;
    let metadata: Awaited<ReturnType<HostedOAuthBrokerClient["metadata"]>>;
    try {
      metadata = await this.#metadata();
    } catch (error) {
      if (error instanceof OpensteerError && error.retryable) {
        const cached = await this.options.store.read(key, owner, OAuthConfigurationSchema);
        if (cached) return cached;
      }
      throw error;
    }
    const issuer = this.options.broker!.client.issuer;
    const configuration = importConfiguration({
      clients: Object.entries(metadata.pluginProviders ?? {}).flatMap(([provider, config]) =>
        config.placement
          ? [
              {
                id: "broker-" + createHash("sha256").update(provider).digest("hex").slice(0, 56),
                label: "Opensteer",
                server: {
                  authorizationUrl: config.authorizationUrl,
                  tokenUrl: config.tokenUrl,
                  ...(config.revocationUrl ? { revocationUrl: config.revocationUrl } : {}),
                  scopeSeparator: config.scopeSeparator,
                },
                broker: {
                  provider,
                  revision: config.revision,
                  redirectUri: new URL(`/v1/oauth-broker/callback/${provider}`, issuer).href,
                },
                defaultScopes: [],
                allowedScopes: config.allowedScopes,
                placement: config.placement,
              },
            ]
          : [],
      ),
      metadataUrl: new URL("/v1/oauth-broker/mcp/client-metadata.json", issuer).href,
      metadataRedirectUri: new URL("/v1/oauth-broker/callback/mcp", issuer).href,
    });
    await this.options.store.save(key, owner, configuration);
    return configuration;
  }
  async prepare(target: z.infer<typeof PluginOAuthTargetSchema>, owner: UserId) {
    await this.assertOwner(owner);
    const prepared = await this.options.plugins.prepareOAuth(target, ownerCaller);
    const account = await this.#account(owner);
    const session: Session = {
      ...prepared,
      target,
      account,
      redirectUri: account
        ? new URL(
            `/v1/oauth-broker/callback/${prepared.callbackProvider}`,
            this.options.broker?.client.issuer ?? account.issuer,
          ).href
        : this.#callback(),
    };
    await this.options.store.save(prepared.connection, owner, session);
    return this.methods(prepared.connection, owner);
  }
  async #session(key: string, owner: UserId) {
    await this.assertOwner(owner);
    const session = await this.options.store.read(key, owner, sessionSchema);
    if (!session) throw invalid();
    return session;
  }
  async methods(connection: string, owner: UserId) {
    const session = await this.#session(connection, owner);
    await this.#current(session, owner);
    const consent = await this.options.plugins.reviewAccountLink(session.target, ownerCaller);
    if (!same(consent, session.consent))
      throw new OpensteerError({
        code: "conflict",
        message: "Plugin declaration changed. Review it again.",
      });
    const configuration = await this.configuration(session.account !== null);
    const methods = await this.options.plugins.oauthMethods(
      { connection, redirectUri: session.redirectUri, linked: session.account !== null },
      ownerCaller,
    );
    session.reviews = {};
    const reviewed = methods.map((method) => {
      const scopes = z.array(z.string()).parse(method.setup.scopes);
      const digest = oauthReviewDigest({
        connection,
        consent,
        redirectUri: session.redirectUri,
        method,
        configuration,
      });
      session.reviews![method.method] = {
        digest,
        scopes,
        configurationDigest: oauthReviewDigest(configuration),
      };
      return { ...method, review: digest };
    });
    if (!(await this.options.store.savePending(session.connection, owner, session)))
      throw new OpensteerError({
        code: "conflict",
        message:
          "This connection already has a sign-in. Read its status or prepare a new connection.",
      });
    return { connection, consent, redirectUri: session.redirectUri, methods: reviewed };
  }

  async begin(
    input: z.infer<typeof PluginOAuthBeginSchema>,
    owner: UserId,
    surface: Exclude<HostApiServerContext["surface"], null>,
  ) {
    const offered = await this.methods(input.connection, owner);
    const method = offered.methods.find((method) => method.method === input.method);
    if (!method || method.review !== input.review)
      throw new OpensteerError({
        code: "conflict",
        message: "Sign-in scopes or client configuration changed. Review them again.",
      });
    const session = await this.#session(input.connection, owner);
    if (session.localId)
      throw new OpensteerError({
        code: "conflict",
        message: "This connection already has a sign-in. Cancel it and prepare a new connection.",
      });
    await this.#current(session, owner);
    if (!session.account && surface === "personal-remote")
      throw new OpensteerError({
        code: "conflict",
        message: "Link this Host to Opensteer Account before starting sign-in remotely",
      });
    if (!same(session.consent, input.consent))
      throw new OpensteerError({
        code: "conflict",
        message: "Review this plugin's sites and credential access before signing in",
      });
    if (session.account) {
      const metadata = await this.#metadata();
      if (metadata.pluginCallbackRelay !== 1)
        throw new OpensteerError({
          code: "conflict",
          message: "Update Opensteer Account to enable plugin callback relay",
        });
      if (input.finish === "app" && input.surface !== "web" && metadata.appFinish !== 1)
        throw new OpensteerError({
          code: "conflict",
          message: "Update Opensteer Account to enable app sign-in return",
        });
    }
    if (!(await this.options.store.claimBegin(session.connection, owner)))
      throw new OpensteerError({
        code: "conflict",
        message:
          "This connection already has a sign-in. Read its status or prepare a new connection.",
      });
    session.returnToHost = surface === "canonical";
    const { client: _client, ...authorizationInput } = input;
    session.input = {
      ...authorizationInput,
      ...(surface === "personal-remote" ? { returnPath: "/" } : {}),
    };
    session.localId = IntegrationAuthorizationAttemptIdSchema.parse(`ioa_${randomUUID()}`);
    await this.options.store.save(session.connection, owner, session);
    await this.options.plugins.pinOAuth(
      {
        connection: session.connection,
        ownerUserId: owner,
        localId: session.localId,
        account: session.account,
      },
      ownerCaller,
    );
    try {
      const result = await this.options.plugins.startOAuth(
        {
          connection: session.connection,
          consent: session.consent,
          method: input.method,
          redirectUri: session.redirectUri,
          linked: session.account !== null,
          configurationDigest: session.reviews![input.method]!.configurationDigest,
          ...(input.client ? { client: input.client } : {}),
        },
        ownerCaller,
      );
      if (result.status !== "redirect")
        throw new OpensteerError({
          code: "conflict",
          message: "Choose a browser OAuth method for this connection",
        });
      if (typeof result.brokerAttemptId === "string") {
        const saved = await this.#session(session.localId, owner);
        const status = await this.options.attempts.status({
          id: session.localId,
          ownerUserId: owner,
        });
        const ticket = new URL(z.url().parse(result.authorizationUrl)).searchParams.get("ticket");
        if (!status || !ticket || !saved.broker) throw invalid();
        return {
          attemptId: session.localId,
          connection: session.connection,
          expiresAt: status.expiresAt.toISOString(),
          launchTicket: ticket,
        };
      }
      const authorizationUrl = z.url().parse(result.authorizationUrl);
      const redirect = z.url().parse(result.redirectUri);
      if (redirect !== session.redirectUri)
        throw new OpensteerError({
          code: "conflict",
          message:
            "The saved OAuth client uses a different callback. Register the displayed callback and save a new client.",
        });
      const started = await this.#startAttempt(session, owner, {
        authorizationUrl,
        state: new URL(authorizationUrl).searchParams.get("state") ?? "",
        relay: OAuthBrokerPluginRelaySchema.parse(result.relay),
        scopes: z.array(z.string()).parse(result.scopes),
      });
      return {
        attemptId: started.attemptId,
        connection: session.connection,
        expiresAt: started.expiresAt.toISOString(),
        launchTicket: started.launchTicket,
      };
    } catch (error) {
      await this.options.plugins
        .cancelOAuth({ connection: session.connection }, ownerCaller)
        .catch(() => undefined);
      if (session.localId)
        await this.options.attempts.fail(
          session.localId,
          error instanceof PluginBrokerError && error.reason === "binding_changed"
            ? "account-link-mismatch"
            : "exchange-failed",
        );
      throw error instanceof OpensteerError
        ? error
        : new OpensteerError({
            code: "conflict",
            message:
              "Plugin sign-in could not start. Review the sign-in method and callback, then try again.",
          });
    }
  }
  async #startAttempt(
    session: Session,
    owner: UserId,
    prepared?: {
      authorizationUrl: string;
      state: string;
      relay: z.infer<typeof OAuthBrokerPluginRelaySchema>;
      scopes: string[];
    },
    brokerBinding?: z.infer<typeof BrokerBindingSchema>,
  ) {
    const input = session.input;
    const localId = session.localId;
    if (!input || !localId) throw invalid();
    const review = session.reviews?.[input.method];
    const scopes = prepared?.scopes ?? brokerBinding?.scopes;
    if (
      !review ||
      review.digest !== input.review ||
      !scopes ||
      !same([...review.scopes].sort(), [...scopes].sort())
    )
      throw new PluginBrokerError("binding_changed");
    const metadata = session.account ? await this.#metadata() : null;
    const finish = input.surface !== "web" && session.account ? input.finish : undefined;
    return this.options.attempts.begin({
      id: localId,
      flow: "provider-oauth",
      ownerUserId: owner,
      surface: input.surface,
      ...(prepared ? { state: prepared.state } : {}),
      payload: async () => {
        let authorizationUrl = prepared?.authorizationUrl;
        if (session.account) {
          const broker = this.options.broker!;
          const keys = generateOAuthBrokerEphemeralKeyPair();
          const binding = brokerBinding ?? session.broker?.binding;
          const base = {
            attemptId: HostedOAuthAttemptIdSchema.parse(`hoa_${localId.slice(4)}`),
            expiresAt: new Date(
              Date.now() + integrationAuthAttemptLifetimeMilliseconds,
            ).toISOString(),
            provider: binding?.provider ?? session.callbackProvider,
            registryRevision: binding?.revision ?? 1,
            requestedScopes: binding?.scopes ?? prepared!.scopes,
            binding: {
              accountSubject: { issuer: session.account.issuer, subject: session.account.subject },
              accountLinkGeneration: session.account.linkGeneration,
              deploymentAuthorityDigest: broker.deploymentAuthorityDigest,
              hostPublicKey: keys.publicKey,
              requirementDigest:
                binding?.requirementDigest ??
                createHash("sha256").update(session.consent.digest).digest("base64url"),
              redirectUrl: binding?.redirectUri ?? session.redirectUri,
            },
            clientSurface: input.surface,
            ...(finish ? { finish } : {}),
            ...(accountReturnPort(metadata, finish, input.appReturnPort) === undefined
              ? {}
              : { appReturnPort: accountReturnPort(metadata, finish, input.appReturnPort) }),
            ...(session.returnToHost ? { returnPath: input.returnPath } : {}),
          };
          const created = prepared
            ? await broker.client.createPluginCallbackRelay({
                ...base,
                kind: "plugin-relay",
                authorizationUrl: prepared.authorizationUrl,
                relay: prepared.relay,
              })
            : await broker.client.createPluginAttempt({ ...base, kind: "plugin" });
          const pins = {
            provider: base.provider,
            registryRevision: base.registryRevision,
            requestedScopes: base.requestedScopes,
            binding: base.binding,
            attemptId: created.attemptId,
            expiresAt: created.expiresAt,
            schemaVersion: 2,
          };
          const context = prepared
            ? OAuthBrokerPluginRelayContextSchema.parse({ ...pins, relay: prepared.relay })
            : OAuthBrokerPluginAuthorizationContextSchema.parse(pins);
          session.broker = {
            id: created.attemptId,
            context,
            privateKey: keys.privateKey,
            ...(binding ? { binding } : {}),
            proven: false,
          };
          authorizationUrl = created.launchUrl;
        }
        await this.#saveSession(session, owner);
        if (!authorizationUrl) throw invalid();
        return { authorizationUrl, payload: { plugin: "1", connection: session.connection } };
      },
    });
  }
  async #saveSession(session: Session, owner: UserId) {
    await this.options.store.save(session.connection, owner, session);
    if (session.localId) await this.options.store.save(session.localId, owner, session);
  }
  async validateLaunch(localId: string) {
    const owner = await this.options.owner();
    const session = await this.options.store.read(localId, owner, sessionSchema);
    if (!session) return;
    try {
      await this.#current(session, owner);
    } catch {
      await this.options.attempts.fail(
        IntegrationAuthorizationAttemptIdSchema.parse(localId),
        "account-link-mismatch",
      );
      throw invalid();
    }
  }
  async status(
    attemptId: string,
    owner: UserId,
    settlementSessionId?: string,
  ): Promise<z.infer<typeof PluginOAuthStatusSchema>> {
    const session = await this.#session(attemptId, owner);
    const localId = IntegrationAuthorizationAttemptIdSchema.parse(attemptId);
    let local = await this.options.attempts.status({ id: localId, ownerUserId: owner });
    if (!local) throw invalid();
    if (["pending", "launched"].includes(local.status)) {
      try {
        await this.#current(session, owner);
        if (session.broker) {
          const remote = await this.options.broker!.client.status(session.broker.id);
          if (remote.status === "denied") await this.options.attempts.fail(localId, "denied");
          else if (["failed", "expired"].includes(remote.status))
            await this.options.attempts.fail(localId, remote.failureCode ?? "expired");
          else if (remote.status === "sealed") {
            session.broker.proven = true;
            await this.#saveSession(session, owner);
            await this.#complete(session, owner, settlementSessionId);
          }
        }
      } catch (error) {
        const bindingChanged = !same(await this.#account(owner), session.account);
        if (
          bindingChanged ||
          (error instanceof PluginBrokerError && error.reason === "binding_changed")
        )
          await this.options.attempts.fail(localId, "account-link-mismatch");
        else if (error instanceof OpensteerError && error.retryable) {
          /* A transport outage leaves the attempt available. */
        } else
          await this.options.attempts.fail(
            localId,
            error instanceof PluginServiceError &&
              (error.code === "consent-changed" || error.tag === "AccountConnectionTargetChanged")
              ? "plugin-declaration-changed"
              : "exchange-failed",
          );
      }
      local = (await this.options.attempts.status({ id: localId, ownerUserId: owner }))!;
    }
    let account: string | null = null;
    if (local.status === "completed") {
      const connection = await this.options.plugins.oauthStatus(
        { connection: session.connection },
        ownerCaller,
      );
      const state = z
        .object({ status: z.string(), account: z.object({ id: z.string() }).optional() })
        .parse(connection.state);
      account = state.account?.id ?? null;
      await this.options.accountLinked({
        owner,
        ...session.target,
        consent: session.consent,
        ...(settlementSessionId ? { settlementSessionId } : {}),
      });
    }
    return {
      attemptId: localId,
      connection: session.connection,
      account,
      expiresAt: local.expiresAt.toISOString(),
      failureCode: local.failureCode,
      status: local.status,
    };
  }
  async returned(
    attemptId: string,
    returnProof: string,
    owner: UserId,
    settlementSessionId?: string,
  ) {
    const session = await this.#session(attemptId, owner);
    try {
      await this.#current(session, owner);
    } catch {
      await this.options.attempts.fail(
        IntegrationAuthorizationAttemptIdSchema.parse(attemptId),
        "account-link-mismatch",
      );
      throw new OpensteerError({
        code: "conflict",
        reason: "account-link-mismatch",
        message: "Opensteer Account changed during consent. Start sign-in again.",
      });
    }
    if (!session.broker || session.input?.finish !== "app" || session.input.surface === "web")
      throw invalid();
    await this.options.broker!.client.returnAttempt(session.broker.id, returnProof);
    return this.status(attemptId, owner, settlementSessionId);
  }
  async cancel(attemptId: string, owner: UserId) {
    const session = await this.#session(attemptId, owner);
    if (
      await this.options.attempts.cancel({
        id: IntegrationAuthorizationAttemptIdSchema.parse(attemptId),
        ownerUserId: owner,
      })
    )
      await this.options.plugins.cancelOAuth({ connection: session.connection }, ownerCaller);
    return this.status(attemptId, owner);
  }
  async #complete(
    session: Session,
    owner: UserId,
    settlementSessionId?: string,
    callbackUrl?: string,
  ) {
    const id = session.localId!;
    const existing = this.#finishing.get(id);
    if (existing) return existing;
    const finish = async () => {
      await this.#current(session, owner);
      if (!callbackUrl) {
        const claim = await this.options.attempts.claimHosted({ id, ownerUserId: owner });
        if (!claim) {
          const row = await this.options.store.database
            .selectFrom("integrationAuthAttempts")
            .select("status")
            .where("id", "=", id)
            .where("ownerUserId", "=", owner)
            .executeTakeFirst();
          if (row?.status !== "claimed") throw invalid();
        }
      }
      let callback = callbackUrl;
      if (session.broker && !("binding" in session.broker && session.broker.binding)) {
        if (
          !session.broker.proven ||
          !session.broker.privateKey ||
          !("relay" in session.broker.context)
        )
          throw invalid();
        const pulled = await this.options.broker!.client.pull(session.broker.id);
        if (!pulled.sealedResult) throw invalid();
        const response = OAuthBrokerMcpAuthorizationResponseSchema.parse(
          openOAuthBrokerPayload(
            pulled.sealedResult,
            session.broker.privateKey,
            session.broker.context,
          ),
        );
        const url = new URL(session.redirectUri);
        for (const [key, value] of response.parameters) url.searchParams.append(key, value);
        callback = url.href;
      }
      await this.options.plugins.completeOAuth(
        {
          connection: session.connection,
          ...(session.broker?.binding
            ? { attemptId: session.broker.id }
            : { callbackUrl: callback! }),
        },
        ownerCaller,
      );
      if (session.broker && !session.broker.binding) {
        delete session.broker.privateKey;
        await this.#saveSession(session, owner);
        await this.options.broker!.client.acknowledge(session.broker.id).catch(() => undefined);
      }
      await this.options.accountLinked({
        owner,
        ...session.target,
        consent: session.consent,
        ...(settlementSessionId ? { settlementSessionId } : {}),
      });
    };
    const work = finish();
    this.#finishing.set(id, work);
    try {
      await work;
    } finally {
      if (this.#finishing.get(id) === work) this.#finishing.delete(id);
    }
  }
  async directCallback(input: {
    attemptId: string;
    browserBinding: string;
    parameters: URLSearchParams;
    state: string;
  }) {
    const id = IntegrationAuthorizationAttemptIdSchema.parse(input.attemptId);
    const owner = await this.options.owner();
    const session = await this.#session(id, owner);
    const claim = await this.options.attempts.claim({
      id,
      browserBinding: input.browserBinding,
      flow: "provider-oauth",
      state: input.state,
    });
    if (!claim || session.account || session.broker) throw invalid();
    let status: "completed" | "failed" = "failed";
    try {
      const callback = new URL(session.redirectUri);
      for (const [key, value] of input.parameters) callback.searchParams.append(key, value);
      await this.#complete(session, owner, undefined, callback.href);
      status = "completed";
    } catch {
      await this.options.attempts.fail(id, "exchange-failed");
    }
    return { status, returnPath: session.input!.returnPath, surface: session.input!.surface };
  }
  readonly broker = async <K extends PluginBrokerOperation>(
    operation: K,
    input: PluginBrokerInput<K>,
  ): Promise<PluginBrokerOutput<K>> => {
    try {
      return (await this.#broker(operation, input)) as PluginBrokerOutput<K>;
    } catch (error) {
      throw error instanceof PluginBrokerError
        ? error
        : new PluginBrokerError(error instanceof z.ZodError ? "invalid_response" : "unavailable");
    }
  };
  async #broker(
    operation: PluginBrokerOperation,
    raw: PluginBrokerInput<PluginBrokerOperation>,
  ): Promise<unknown> {
    const owner = await this.options.owner();
    const broker = this.options.broker;
    if (!broker) throw new PluginBrokerError("unavailable");
    if (operation === "oauthStart") {
      const input = raw as PluginBrokerInput<"oauthStart">;
      const session = await this.#session(input.connection, owner);
      await this.#current(session, owner);
      if (!session.account || input.owner !== "personal")
        throw new PluginBrokerError("binding_changed");
      const binding = { ...input.binding, accountLinkGeneration: session.account.linkGeneration };
      const started = await this.#startAttempt(session, owner, undefined, binding);
      const url = new URL(
        `/v1/integration-authorizations/${started.attemptId}/launch`,
        this.options.origin,
      );
      url.searchParams.set("ticket", started.launchTicket);
      return {
        attemptId: session.broker!.id,
        authorizationUrl: url.href,
        expiresAt: new Date(session.broker!.context.expiresAt).getTime(),
        accountLinkGeneration: binding.accountLinkGeneration,
      };
    }
    const input = raw as Exclude<
      PluginBrokerInput<PluginBrokerOperation>,
      PluginBrokerInput<"oauthStart">
    >;
    const session = await this.#session(`ioa_${input.attemptId.slice(4)}`, owner);
    await this.#current(session, owner);
    const authorization = session.broker;
    if (
      !authorization?.binding ||
      !same(authorization.binding, input.binding) ||
      authorization.id !== input.attemptId
    )
      throw new PluginBrokerError("binding_changed");
    if (operation === "oauthPull") {
      if (!authorization.proven || !authorization.privateKey)
        throw new PluginBrokerError("binding_changed");
      const result = await broker.client.pull(authorization.id);
      if (!result.sealedResult) throw new PluginBrokerError("unavailable");
      return {
        attemptId: input.attemptId,
        binding: input.binding,
        tokens: this.#tokens(
          openOAuthBrokerPayload(
            result.sealedResult,
            authorization.privateKey,
            authorization.context,
          ),
        ),
      };
    }
    if (operation === "oauthAcknowledge") {
      const ack = raw as PluginBrokerInput<"oauthAcknowledge">;
      if (ack.kind === "authorization") {
        delete authorization.privateKey;
        await this.#saveSession(session, owner);
        await broker.client.acknowledge(authorization.id);
      } else {
        const pending = await this.options.store.read(
          `refresh:${ack.resultId}`,
          owner,
          refreshSchema,
        );
        if (pending) {
          await broker.client.acknowledgeRefresh(pending.context.transactionId);
          await this.options.store.remove(`refresh:${ack.resultId}`, owner);
        }
      }
      return null;
    }
    const metadata = await this.#metadata();
    const configured = metadata.pluginProviders?.[input.binding.provider];
    if (!configured || configured.revision !== input.binding.revision)
      throw new PluginBrokerError("client_rejected");
    const base = {
      provider: input.binding.provider,
      registryRevision: input.binding.revision,
      requestedScopes: input.binding.scopes,
      binding: authorization.context.binding,
    };
    if (operation === "oauthRefresh") {
      const refresh = raw as PluginBrokerInput<"oauthRefresh">;
      const key = `refresh:${refresh.resultId}`;
      let pending = await this.options.store.read(key, owner, refreshSchema);
      if (!pending) {
        const keys = generateOAuthBrokerEphemeralKeyPair();
        const context = OAuthBrokerPluginRefreshContextSchema.parse({
          ...base,
          binding: { ...base.binding, hostPublicKey: keys.publicKey },
          schemaVersion: 2,
          transactionId: `hor_${randomUUID()}`,
          expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        });
        const { schemaVersion: _, ...request } = context;
        pending = {
          context,
          privateKey: keys.privateKey,
          request: {
            ...request,
            kind: "plugin",
            grantedScopes: refresh.grantedScopes,
            brokerSealedCredential: sealOAuthBrokerPayload(
              { refreshToken: refresh.refreshToken },
              metadata.encryptionPublicKey,
              context,
            ),
          },
        };
        await this.options.store.save(key, owner, pending, context.expiresAt, true);
        pending = (await this.options.store.read(key, owner, refreshSchema))!;
      }
      if (new Date(pending.context.expiresAt).getTime() <= Date.now())
        throw new PluginBrokerError("unavailable");
      if (
        !same(pending.context.binding.accountSubject, base.binding.accountSubject) ||
        pending.context.binding.requirementDigest !== base.binding.requirementDigest
      )
        throw new PluginBrokerError("binding_changed");
      await broker.client.refreshPlugin(pending.request);
      const pulled = await broker.client.pullRefresh(pending.context.transactionId);
      if (!pulled.sealedResult)
        throw new PluginBrokerError(
          pulled.failureCode === "grant-rejected"
            ? "grant_rejected"
            : pulled.failureCode === "client-rejected" ||
                pulled.failureCode === "stale-provider-application"
              ? "client_rejected"
              : pulled.failureCode === "invalid-provider-response" ||
                  pulled.failureCode === "scope-escalation"
                ? "invalid_response"
                : "unavailable",
        );
      return {
        attemptId: input.attemptId,
        binding: input.binding,
        tokens: this.#tokens(
          openOAuthBrokerPayload(pulled.sealedResult, pending.privateKey, pending.context),
        ),
      };
    }
    const revoke = raw as PluginBrokerInput<"oauthRevoke">;
    const context = OAuthBrokerPluginRevocationContextSchema.parse({
      ...base,
      schemaVersion: 2,
      transactionId: HostedOAuthRevocationTransactionIdSchema.parse(`hov_${randomUUID()}`),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { schemaVersion: _, ...request } = context;
    await broker.client.revokePlugin({
      ...request,
      kind: "plugin",
      brokerSealedCredential: sealOAuthBrokerPayload(
        {
          accessToken: revoke.tokens.accessToken,
          ...(revoke.tokens.refreshToken ? { refreshToken: revoke.tokens.refreshToken } : {}),
        },
        metadata.encryptionPublicKey,
        context,
      ),
    });
    return null;
  }
  #tokens(value: unknown) {
    const bundle = OAuthBrokerTokenBundleSchema.parse(value);
    return {
      accessToken: bundle.accessToken,
      tokenType: bundle.tokenType,
      grantedScopes: bundle.grantedScopes,
      ...(bundle.refreshToken ? { refreshToken: bundle.refreshToken } : {}),
      ...(bundle.expiresAt === undefined ? {} : { expiresAt: bundle.expiresAt }),
    };
  }
}
