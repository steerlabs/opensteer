import {
  HostedOAuthAttemptIdSchema,
  OAuthBrokerMcpCallbackRelayContextSchema,
  OAuthBrokerMcpAuthorizationResponseSchema,
} from "@opensteer/control-plane-protocol";
import {
  generateOAuthBrokerEphemeralKeyPair,
  openOAuthBrokerPayload,
  oauthAuthorizationResponseState,
} from "@opensteer/integration-auth";
import { integrationSchemaDigest } from "@opensteer/integration-core/digest";
import {
  IntegrationAccountBindingSchema,
  validateIntegrationAccountBinding,
} from "./integration-account-binding.js";
import { integrationAuthAttemptLifetimeMilliseconds } from "./integration-auth-attempt-service.js";
import type { HostedOAuthOptions } from "./integration-service.js";
import { randomBytes } from "node:crypto";
import { isLoopbackHostname } from "@opensteer/core";
import {
  createCredentialResponseRedactor,
  createPublicHttpsFetch,
  type AesGcmSecretVault,
  type CredentialResponseRedactor,
} from "@opensteer/access/host";
import {
  createIntegrationId,
  IntegrationConnectionIdSchema,
  IntegrationServerIdSchema,
  McpOAuthAttemptIdSchema,
  type IntegrationConnectionId,
  type IntegrationDeploymentPosture,
  type McpOAuthAttemptId,
  type IntegrationServer,
  type IntegrationToolId,
  type IntegrationToolMaterial,
} from "@opensteer/integration-core";
import { type IntegrationAuthAttemptSurface } from "@opensteer/integration-core/ports";
import { boundedToolDescription, boundedToolTitle } from "@opensteer/integration-core/tool-schemas";
import {
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  oauthUserDeniedAuthorization,
  registerDynamicClient,
  validateOAuthAuthorizationResponse,
} from "@opensteer/integration-auth";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  OpensteerError,
  RequestIdSchema,
  type HostExposure,
  type RequestId,
  type UserId,
} from "@opensteer/core";
import type { IntegrationPlatformStore } from "@opensteer/database";
import { z } from "zod";
import type { IntegrationAuthAttemptLifecycle } from "./integration-auth-attempt-service.js";
import type { IntegrationConnectionConnected } from "./integration-service.js";
import { canonicalAuthorizationRequired, type HostSessionSurface } from "../identity/auth.js";

const connectionTimeoutMilliseconds = 15_000;
const maximumToolsPerServer = 2_000;

const StoredOAuthStateSchema = z.strictObject({
  clientInformation: z
    .union([OAuthClientInformationFullSchema, OAuthClientInformationSchema])
    .optional(),
  codeVerifier: z.string().min(43).max(256).optional(),
  discovery: z.record(z.string(), z.unknown()).optional(),
  tokens: OAuthTokensSchema.optional(),
  redirectUrl: z.url().optional(),
  clientMetadataUrl: z.url().optional(),
});

const McpOAuthAttemptPayloadSchema = z.strictObject({
  displayName: z.string().min(1).max(640),
  oauthState: StoredOAuthStateSchema,
  requestId: RequestIdSchema,
  reconnect: z
    .strictObject({
      connectionId: IntegrationConnectionIdSchema,
      revision: z.number().int().positive(),
    })
    .optional(),
  returnPath: z.string().min(1).max(8_192),
  serverId: IntegrationServerIdSchema,
  relay: z
    .strictObject({
      binding: IntegrationAccountBindingSchema,
      finish: z.literal("app").optional(),
      context: OAuthBrokerMcpCallbackRelayContextSchema,
      hostPrivateKey: z.string().min(1).max(512),
    })
    .optional(),
});

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
  redirectUrl?: string;
  clientMetadataUrl?: string;
}

type McpClaimedAttempt = Omit<z.infer<typeof McpOAuthAttemptPayloadSchema>, "oauthState"> & {
  readonly oauthState: StoredOAuthState;
  readonly id: McpOAuthAttemptId;
  readonly ownerUserId: UserId;
  readonly surface: IntegrationAuthAttemptSurface;
  readonly server: IntegrationServer;
};

export interface RedactingOAuthClientProvider extends OAuthClientProvider {
  credentialRevision(): number | null;
  responseRedactor(): CredentialResponseRedactor;
}

export class McpOAuthReauthorizationError extends UnauthorizedError {
  readonly credentialRevision: number;

  constructor(credentialRevision: number) {
    super("MCP account requires renewed user authorization");
    this.credentialRevision = credentialRevision;
  }
}

export class McpOAuthService {
  readonly #callbackUrl: URL;
  readonly #hostedOAuth: HostedOAuthOptions | undefined;
  readonly #deploymentPosture: () => Promise<IntegrationDeploymentPosture>;
  readonly #authorizationFlights = new Map<string, Promise<void>>();
  readonly #attempts: IntegrationAuthAttemptLifecycle;
  readonly #clientMetadata: OAuthClientMetadata;
  readonly #clientMetadataUrl: URL | null;
  readonly #local: boolean;
  readonly #publicFetch = createPublicHttpsFetch();
  readonly #onConnectionConnected: IntegrationConnectionConnected;
  readonly #store: IntegrationPlatformStore;
  readonly #vault: AesGcmSecretVault;

  constructor(options: {
    readonly hostedOAuth?: HostedOAuthOptions;
    readonly deploymentPosture?: () => Promise<IntegrationDeploymentPosture>;
    readonly publicUrl: URL;
    readonly attempts: IntegrationAuthAttemptLifecycle;
    readonly exposure: HostExposure;
    readonly onConnectionConnected: IntegrationConnectionConnected;
    readonly store: IntegrationPlatformStore;
    readonly vault: AesGcmSecretVault;
  }) {
    this.#hostedOAuth = options.hostedOAuth;
    this.#deploymentPosture =
      options.deploymentPosture ?? (() => Promise.resolve("account-free-personal"));
    this.#attempts = options.attempts;
    this.#onConnectionConnected = options.onConnectionConnected;
    this.#callbackUrl = new URL("/v1/integration-platform/mcp-oauth/callback", options.publicUrl);
    this.#clientMetadataUrl =
      options.publicUrl.protocol === "https:"
        ? new URL("/v1/integration-platform/mcp-oauth/client-metadata.json", options.publicUrl)
        : null;
    this.#clientMetadata = {
      client_name: "Opensteer",
      client_uri: options.publicUrl.toString(),
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.#callbackUrl.toString()],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    this.#local = options.exposure === "loopback";
    this.#store = options.store;
    this.#vault = options.vault;
  }

  clientMetadataDocument(): Readonly<Record<string, unknown>> {
    if (!this.#clientMetadataUrl) {
      throw new OpensteerError({
        code: "not_found",
        message: "MCP client metadata requires a public HTTPS Host URL",
      });
    }
    return { ...this.#clientMetadata, client_id: this.#clientMetadataUrl.toString() };
  }

  async beginAuthorization(input: {
    readonly displayName: string;
    readonly finish?: "app" | undefined;
    readonly ownerUserId: UserId;
    readonly requestId: RequestId;
    readonly requestSurface: HostSessionSurface;
    readonly returnPath: string;
    readonly serverId: import("@opensteer/integration-core").IntegrationServerId;
    readonly surface: IntegrationAuthAttemptSurface;
  }): Promise<{
    readonly attemptId: import("@opensteer/integration-core").McpOAuthAttemptId;
    readonly expiresAt: Date;
    readonly launchTicket: string;
  }> {
    const posture = await this.#deploymentPosture();
    const relayed =
      posture === "account-linked-personal" || posture === "account-adopted-self-hosted";
    const hosted = relayed ? this.#hostedOAuth : undefined;
    const binding = hosted
      ? validateIntegrationAccountBinding(await hosted.accountSubject(input.ownerUserId))
      : null;
    if (
      relayed &&
      (!hosted || !binding || new URL(binding.issuer).origin !== hosted.broker.issuer)
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Link your own Opensteer Account before starting MCP sign-in.",
      });
    }
    if (!relayed && input.requestSurface === "personal-remote")
      throw canonicalAuthorizationRequired();
    // Direct callbacks ignore finish because clients do not know the Host posture.
    const finish = hosted && input.surface !== "web" ? input.finish : undefined;
    const metadata = hosted ? await hosted.broker.metadata() : null;
    if (
      hosted &&
      (metadata?.mcpCallbackRelay !== 1 || (finish === "app" && metadata.appFinish !== 1))
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Opensteer Account must be updated before MCP sign-in can use its HTTPS callback.",
      });
    }
    const redirectUrl = hosted ? hosted.broker.callbackUrl("mcp") : this.#callbackUrl.toString();
    const context = await this.#store.getMcpOAuthServer(input);
    const attemptId = createIntegrationId("mcpOauthAttempt");
    let authorizationUrl: URL | undefined;
    const started = await this.#attempts.begin({
      flow: "mcp-oauth",
      id: attemptId,
      ownerUserId: input.ownerUserId,
      payload: async (state) => {
        const mutable: StoredOAuthState = {
          redirectUrl,
          ...(hosted
            ? {
                clientMetadataUrl: new URL(
                  "/v1/oauth-broker/mcp/client-metadata.json",
                  hosted.broker.issuer,
                ).toString(),
              }
            : {}),
        };
        const provider = this.#provider({
          mutable,
          onAuthorization: (url) => {
            authorizationUrl = this.#validateAuthorizationUrl(url);
          },
          server: context.server,
          state,
        });
        const { client, transport } = this.#client(context.server, provider);
        try {
          await client.connect(transport as unknown as Transport, {
            maxTotalTimeout: connectionTimeoutMilliseconds,
            timeout: connectionTimeoutMilliseconds,
          });
          throw new OpensteerError({
            code: "conflict",
            message: "This MCP server did not request OAuth authorization",
          });
        } catch (error) {
          if (!authorizationUrl) {
            if (error instanceof UnauthorizedError) {
              throw new OpensteerError({
                code: "conflict",
                message: "The MCP server requires authorization but supplied no authorization URL",
              });
            }
            throw error;
          }
        } finally {
          await client.close().catch(() => undefined);
        }
        if (!authorizationUrl) throw new Error("MCP OAuth authorization URL was not captured");
        let relay: z.infer<typeof McpOAuthAttemptPayloadSchema>["relay"];
        let launchUrl = authorizationUrl.toString();
        if (hosted && binding) {
          const discovery = mutable.discovery!;
          const metadata = discovery.authorizationServerMetadata!;
          const mcp = {
            serverId: context.server.id,
            issuer: discoveryIssuer(discovery),
            authorizationEndpoint: metadata.authorization_endpoint,
            authorizationResponseIssuerParameterSupported:
              Reflect.get(metadata, "authorization_response_iss_parameter_supported") === true,
          };
          const brokerAttemptId = HostedOAuthAttemptIdSchema.parse(
            `hoa_${attemptId.slice("imo_".length)}`,
          );
          const keys = generateOAuthBrokerEphemeralKeyPair();
          const relayContext = OAuthBrokerMcpCallbackRelayContextSchema.parse({
            accountSubject: { issuer: binding.issuer, subject: binding.subject },
            attemptId: brokerAttemptId,
            authorizationDigest: integrationSchemaDigest({
              serverId: context.server.id,
              authorizationUrl: launchUrl,
            }),
            deploymentAuthorityDigest: hosted.deploymentAuthorityDigest,
            expiresAt: new Date(
              Date.now() + integrationAuthAttemptLifetimeMilliseconds,
            ).toISOString(),
            clientId: mutable.clientInformation!.client_id,
            mcp,
            redirectUrl,
            schemaVersion: 1,
          });
          const created = await hosted.broker.createCallbackRelay({
            accountSubject: relayContext.accountSubject,
            attemptId: brokerAttemptId,
            authorizationDigest: relayContext.authorizationDigest,
            authorizationUrl: launchUrl,
            clientId: relayContext.clientId,
            clientSurface: input.surface,
            ...(finish ? { finish } : {}),
            definitionId: context.server.id,
            deploymentAuthorityDigest: relayContext.deploymentAuthorityDigest,
            expiresAt: relayContext.expiresAt,
            hostPublicKey: keys.publicKey,
            provider: "mcp",
            providerApplicationRevision: 1,
            mcp,
            ...(input.requestSurface === "personal-remote" ? {} : { returnPath: input.returnPath }),
          });
          relay = {
            binding,
            ...(finish ? { finish } : {}),
            context: { ...relayContext, expiresAt: created.expiresAt },
            hostPrivateKey: keys.privateKey,
          };
          launchUrl = created.launchUrl;
        }
        return {
          authorizationUrl: launchUrl,
          payload: serializeAttempt({
            ...(relay ? { relay } : {}),
            displayName: input.displayName,
            oauthState: StoredOAuthStateSchema.parse(mutable),
            requestId: input.requestId,
            returnPath: input.returnPath,
            serverId: context.server.id,
            ...(context.reconnect ? { reconnect: context.reconnect } : {}),
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

  async handleAuthorizationCallback(input: {
    readonly attemptId: import("@opensteer/integration-core").McpOAuthAttemptId;
    readonly browserBinding: string;
    readonly parameters: URLSearchParams;
    readonly state: string;
  }): Promise<
    | {
        readonly attemptId: import("@opensteer/integration-core").McpOAuthAttemptId;
        readonly returnPath: string;
        readonly status: "denied" | "failed";
        readonly failureReason?: "exchange-failed";
        readonly surface: IntegrationAuthAttemptSurface;
      }
    | {
        readonly connectionId: IntegrationConnectionId;
        readonly ownerUserId: UserId;
        readonly returnPath: string;
        readonly status: "completed";
        readonly surface: IntegrationAuthAttemptSurface;
      }
  > {
    const posture = await this.#deploymentPosture();
    if (posture === "account-linked-personal" || posture === "account-adopted-self-hosted") {
      throw new OpensteerError({
        code: "conflict",
        message: "This consent must restart through Opensteer Account.",
      });
    }
    return this.#completeAuthorization(await this.#claim(input), input.parameters, input.state);
  }

  async #completeAuthorization(
    attempt: McpClaimedAttempt,
    parameters: URLSearchParams,
    state: string,
  ): ReturnType<McpOAuthService["handleAuthorizationCallback"]> {
    let connected: IntegrationConnectionId;
    try {
      const mutable = attempt.oauthState;
      requireBoundCredentials(mutable);
      const clientId = mutable.clientInformation?.client_id;
      const discovery = mutable.discovery;
      const issuer =
        discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl;
      if (!clientId || !issuer) {
        throw new OpensteerError({
          code: "conflict",
          message: "MCP OAuth authorization context is incomplete",
        });
      }
      const metadata = discovery?.authorizationServerMetadata as
        (Record<string, unknown> & { issuer: string }) | undefined;
      const issuerParameterSupported =
        metadata?.["authorization_response_iss_parameter_supported"] === true;
      const authorizationResponse = validateOAuthAuthorizationResponse({
        authorizationResponseIssuerParameterSupported: issuerParameterSupported,
        clientId,
        issuer,
        parameters: parameters,
      });
      if (authorizationResponse.kind === "error") {
        if (!oauthUserDeniedAuthorization(authorizationResponse.error)) {
          throw new OpensteerError({
            code: "conflict",
            message: `The authorization server rejected this authorization (${authorizationResponse.error})`,
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
      const provider = this.#provider({ mutable, server: attempt.server, state: state });
      const { client, transport } = this.#client(attempt.server, provider);
      try {
        await transport.finishAuth(authorizationResponse.code);
        await client.connect(transport as unknown as Transport, {
          maxTotalTimeout: connectionTimeoutMilliseconds,
          timeout: connectionTimeoutMilliseconds,
        });
        const connectionId = attempt.reconnect?.connectionId ?? createIntegrationId("connection");
        const tools = normalizeTools(connectionId, await client.listTools());
        const sealed = await this.#vault.seal(
          serializeState(mutable),
          connectionSecretContext(connectionId, attempt.ownerUserId, attempt.server.id),
        );
        await this.#store.completeMcpOAuthAttempt({
          ...(attempt.relay
            ? {
                accountBinding: {
                  ...attempt.relay.binding,
                  kind: this.#hostedOAuth!.kind,
                },
              }
            : {}),
          attemptId: attempt.id,
          connectionId,
          displayName: attempt.displayName,
          encryptedState: sealed.envelope,
          encryptionKeyVersion: sealed.keyVersion,
          ownerUserId: attempt.ownerUserId,
          ...(attempt.reconnect
            ? {
                reconnect: {
                  expectedRevision: attempt.reconnect.revision,
                  requestId: attempt.requestId,
                },
              }
            : {}),
          serverId: attempt.server.id,
          tools,
        });
        connected = connectionId;
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch {
      await this.#attempts.fail(attempt.id, "exchange-failed");
      return {
        attemptId: attempt.id,
        returnPath: attempt.returnPath,
        status: "failed",
        failureReason: "exchange-failed",
        surface: attempt.surface,
      };
    }
    await this.#onConnectionConnected({
      connectionId: connected,
      ownerUserId: attempt.ownerUserId,
    });
    return {
      connectionId: connected,
      ownerUserId: attempt.ownerUserId,
      returnPath: attempt.returnPath,
      status: "completed",
      surface: attempt.surface,
    };
  }

  async returnAuthorization(input: {
    readonly attemptId: McpOAuthAttemptId;
    readonly ownerUserId: UserId;
    readonly returnProof: string;
  }) {
    const local = await this.#attempts.status({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    if (!local || (local.status !== "pending" && local.status !== "launched")) return local;
    const raw = await this.#attempts.inspect?.({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    const relay = raw ? deserializeAttempt(raw).relay : null;
    const hosted = this.#hostedOAuth;
    if (!relay || relay.finish !== "app" || !hosted) {
      throw new OpensteerError({
        code: "conflict",
        message: "This authorization does not finish through Opensteer Account in the app.",
      });
    }
    const binding = validateIntegrationAccountBinding(
      await hosted.accountSubject(input.ownerUserId),
    );
    if (
      !binding ||
      binding.issuer !== relay.binding.issuer ||
      binding.subject !== relay.binding.subject ||
      binding.linkGeneration !== relay.binding.linkGeneration
    ) {
      await this.#attempts.fail(input.attemptId, "account-link-mismatch");
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    await hosted.broker.returnAttempt(relay.context.attemptId, input.returnProof);
    return this.authorizationStatus(input);
  }

  async authorizationStatus(input: {
    readonly attemptId: McpOAuthAttemptId;
    readonly ownerUserId: UserId;
  }) {
    const local = await this.#attempts.status({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    if (!local || local.status !== "launched") return local;
    const inspected = await this.#attempts.inspect?.({
      id: input.attemptId,
      ownerUserId: input.ownerUserId,
    });
    if (!inspected) return local;
    const payload = deserializeAttempt(inspected);
    const relay = payload.relay;
    if (!relay) return local;
    const hosted = this.#hostedOAuth;
    const binding = hosted
      ? validateIntegrationAccountBinding(await hosted.accountSubject(input.ownerUserId))
      : null;
    if (
      !binding ||
      binding.issuer !== relay.binding.issuer ||
      binding.subject !== relay.binding.subject ||
      binding.linkGeneration !== relay.binding.linkGeneration
    ) {
      await this.#attempts.fail(input.attemptId, "account-link-mismatch");
      return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
    }
    const remote = await hosted!.broker.status(relay.context.attemptId).catch(() => null);
    if (!remote || remote.status === "pending" || remote.status === "launched") return local;
    if (remote.status !== "sealed") {
      await this.#attempts.fail(
        input.attemptId,
        remote.status === "denied"
          ? "denied"
          : remote.status === "expired"
            ? "expired"
            : "exchange-failed",
      );
    } else {
      let flight = this.#authorizationFlights.get(input.attemptId);
      if (!flight) {
        flight = this.#completeRelay(input, relay);
        this.#authorizationFlights.set(input.attemptId, flight);
      }
      try {
        await flight;
      } finally {
        if (this.#authorizationFlights.get(input.attemptId) === flight)
          this.#authorizationFlights.delete(input.attemptId);
      }
    }
    return this.#attempts.status({ id: input.attemptId, ownerUserId: input.ownerUserId });
  }

  async #completeRelay(
    input: { readonly attemptId: McpOAuthAttemptId; readonly ownerUserId: UserId },
    relay: NonNullable<z.infer<typeof McpOAuthAttemptPayloadSchema>["relay"]>,
  ) {
    const hosted = this.#hostedOAuth!;
    // A lost app-finish result response must leave the attempt available for another return.
    const returnedResult =
      relay.finish === "app" ? await hosted.broker.pull(relay.context.attemptId) : null;
    try {
      const pulled = returnedResult ?? (await hosted.broker.pull(relay.context.attemptId));
      if (pulled.status !== "sealed" || !pulled.sealedResult)
        throw new Error("MCP consent result is unavailable");
      const bundle = OAuthBrokerMcpAuthorizationResponseSchema.parse(
        openOAuthBrokerPayload(pulled.sealedResult, relay.hostPrivateKey, relay.context),
      );
      const parameters = new URLSearchParams(bundle.parameters);
      const state = oauthAuthorizationResponseState(parameters);
      const claimed = await this.#attempts.claimHosted?.({
        id: input.attemptId,
        ownerUserId: input.ownerUserId,
        flow: "mcp-oauth",
        state,
      });
      if (!claimed) {
        // The in-process flight owns completion. A spent claim with no flight
        // belongs to an interrupted Host, and its code must never be exchanged again.
        await this.#attempts.fail(input.attemptId, "grant-rejected");
        return;
      }
      const context = await this.#claimedContext(claimed);
      if (context.relay?.context.attemptId !== relay.context.attemptId)
        throw new Error("MCP consent changed");
      if (
        context.oauthState.redirectUrl !== relay.context.redirectUrl ||
        context.oauthState.clientInformation?.client_id !== relay.context.clientId ||
        !context.oauthState.discovery ||
        discoveryIssuer(context.oauthState.discovery) !== relay.context.mcp.issuer ||
        context.serverId !== relay.context.mcp.serverId
      )
        throw new Error("MCP authorization binding changed");
      await this.#completeAuthorization(context, parameters, state);
    } catch {
      await this.#attempts.fail(input.attemptId, "exchange-failed");
    }
    await hosted.broker.acknowledge(relay.context.attemptId).catch(() => undefined);
  }

  identifyAuthorizationCallback(state: string) {
    return this.#attempts.identifyCallback({ flow: "mcp-oauth", state });
  }

  async providerFor(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly serverId: import("@opensteer/integration-core").IntegrationServerId;
  }): Promise<RedactingOAuthClientProvider> {
    const connection = await this.#store.getMcpOAuthConnection(input);
    if (!connection) {
      throw new OpensteerError({ code: "forbidden", message: "MCP account is unavailable" });
    }
    const opened = await this.#vault.open(
      connection.encryptedState,
      connectionSecretContext(
        connection.connectionId,
        connection.ownerUserId,
        connection.server.id,
      ),
    );
    const mutable = deserializeState(opened);
    try {
      requireBoundCredentials(mutable);
    } catch (error) {
      if (error instanceof UnauthorizedError)
        throw new McpOAuthReauthorizationError(connection.revision);
      throw error;
    }
    let revision = connection.revision;
    return this.#provider({
      mutable,
      credentialRevision: () => revision,
      onChange: async () => {
        const sealed = await this.#vault.seal(
          serializeState(mutable),
          connectionSecretContext(
            connection.connectionId,
            connection.ownerUserId,
            connection.server.id,
          ),
        );
        const replaced = await this.#store.replaceMcpOAuthCredential({
          connectionId: connection.connectionId,
          encryptedState: sealed.envelope,
          encryptionKeyVersion: sealed.keyVersion,
          expectedRevision: revision,
        });
        if (!replaced) {
          throw new OpensteerError({
            code: "conflict",
            message: "MCP account credentials changed during this request",
          });
        }
        revision += 1;
      },
      server: connection.server,
      state: randomBytes(32).toString("base64url"),
    });
  }

  async #claim(input: {
    readonly attemptId: import("@opensteer/integration-core").McpOAuthAttemptId;
    readonly browserBinding: string;
    readonly state: string;
  }) {
    const claimed = await this.#attempts.claim({
      browserBinding: input.browserBinding,
      flow: "mcp-oauth",
      id: input.attemptId,
      state: input.state,
    });
    if (!claimed) {
      throw new OpensteerError({
        code: "forbidden",
        message: "MCP OAuth authorization is invalid, expired, or already used",
      });
    }
    return this.#claimedContext(claimed);
  }

  async #claimedContext(claimed: {
    readonly id: import("@opensteer/integration-core/ports").IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
    readonly payload: Readonly<Record<string, string>>;
    readonly surface: IntegrationAuthAttemptSurface;
  }): Promise<McpClaimedAttempt> {
    try {
      const payload = deserializeAttempt(claimed.payload);
      const context = await this.#store.getMcpOAuthServer({
        ownerUserId: claimed.ownerUserId,
        requestId: payload.requestId,
        serverId: payload.serverId,
      });
      if (
        context.reconnect?.connectionId !== payload.reconnect?.connectionId ||
        context.reconnect?.revision !== payload.reconnect?.revision
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "MCP account changed; restart authorization",
        });
      }
      return {
        ...context,
        ...payload,
        id: McpOAuthAttemptIdSchema.parse(claimed.id),
        ownerUserId: claimed.ownerUserId,
        surface: claimed.surface,
      };
    } catch (error) {
      await this.#attempts.fail(claimed.id, "exchange-failed");
      throw error;
    }
  }

  #client(server: IntegrationServer, provider: OAuthClientProvider) {
    if (server.transport.type !== "streamable-http") {
      throw new OpensteerError({ code: "conflict", message: "MCP OAuth requires Streamable HTTP" });
    }
    const client = new Client({ name: "opensteer-integration-host", version: "1.0.0" });
    const url = new URL(server.transport.url);
    const loopback = isLoopbackHostname(url.hostname);
    if (url.protocol === "http:" && (!loopback || !this.#local)) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Plain HTTP MCP authorization is allowed only on local loopback",
      });
    }
    if (loopback && !this.#local) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Hosted Opensteer cannot use loopback MCP",
      });
    }
    const secureFetch: typeof fetch = (target, init) => this.#oauthFetch(target, init);
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: provider,
      fetch: secureFetch,
      requestInit: { headers: server.transport.headers, redirect: "manual" },
    });
    return { client, transport };
  }

  #provider(input: {
    readonly mutable: StoredOAuthState;
    readonly credentialRevision?: () => number;
    readonly onAuthorization?: (url: URL) => void;
    readonly onChange?: () => Promise<void>;
    readonly server: IntegrationServer;
    readonly state: string;
  }): RedactingOAuthClientProvider {
    const changed = async () => input.onChange?.();
    const redirectUrl = input.mutable.redirectUrl ?? this.#callbackUrl.toString();
    const clientMetadataUrl =
      input.mutable.clientMetadataUrl ?? this.#clientMetadataUrl?.toString();
    const clientMetadata = { ...this.#clientMetadata, redirect_uris: [redirectUrl] };
    return {
      credentialRevision: () => input.credentialRevision?.() ?? null,
      ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
      clientInformation: () => {
        requireBoundCredentials(input.mutable);
        return input.mutable.clientInformation;
      },
      clientMetadata,
      codeVerifier: () => {
        if (!input.mutable.codeVerifier) throw new Error("MCP OAuth verifier is unavailable");
        return input.mutable.codeVerifier;
      },
      discoveryState: async () => {
        if (!input.mutable.discovery) {
          await this.#bootstrapSharedOAuth(input.server, input.mutable);
          await changed();
        }
        return input.mutable.discovery;
      },
      invalidateCredentials: async (scope) => {
        if (scope === "all" || scope === "client") delete input.mutable.clientInformation;
        if (scope === "all" || scope === "tokens") delete input.mutable.tokens;
        if (scope === "all" || scope === "verifier") delete input.mutable.codeVerifier;
        if (scope === "all" || scope === "discovery") delete input.mutable.discovery;
        await changed();
      },
      redirectToAuthorization: (url) => {
        if (!input.onAuthorization) {
          throw new UnauthorizedError("MCP account requires renewed user authorization");
        }
        input.onAuthorization(url);
      },
      redirectUrl: new URL(redirectUrl),
      responseRedactor: () =>
        createCredentialResponseRedactor(
          input.mutable.tokens
            ? [
                input.mutable.tokens.access_token,
                input.mutable.tokens.refresh_token,
                input.mutable.tokens.id_token,
              ].filter((value): value is string => typeof value === "string")
            : [],
        ),
      saveClientInformation: async (clientInformation) => {
        const issuer =
          (input.mutable.clientInformation?.issuer
            ? normalizeIssuer(input.mutable.clientInformation.issuer)
            : undefined) ??
          (input.mutable.discovery ? discoveryIssuer(input.mutable.discovery) : undefined);
        if (
          !issuer ||
          (clientInformation.issuer && normalizeIssuer(clientInformation.issuer) !== issuer)
        ) {
          throw new UnauthorizedError("MCP account requires renewed user authorization");
        }
        clientInformation = { ...clientInformation, issuer };
        input.mutable.clientInformation = clientInformation;
        await changed();
      },
      saveCodeVerifier: async (codeVerifier) => {
        input.mutable.codeVerifier = codeVerifier;
        await changed();
      },
      saveDiscoveryState: async (discovery) => {
        const issuer = discoveryIssuer(discovery);
        if (
          (discovery.authorizationServerMetadata &&
            normalizeIssuer(discovery.authorizationServerMetadata.issuer) !== issuer) ||
          (input.mutable.clientInformation?.issuer &&
            normalizeIssuer(input.mutable.clientInformation.issuer) !== issuer) ||
          (input.mutable.tokens?.issuer && normalizeIssuer(input.mutable.tokens.issuer) !== issuer)
        ) {
          throw new UnauthorizedError("MCP account requires renewed user authorization");
        }
        input.mutable.discovery = discovery;
        await changed();
      },
      saveTokens: async (tokens) => {
        const issuer =
          input.mutable.clientInformation?.issuer &&
          normalizeIssuer(input.mutable.clientInformation.issuer);
        if (!issuer || (tokens.issuer && normalizeIssuer(tokens.issuer) !== issuer)) {
          throw new UnauthorizedError("MCP account requires renewed user authorization");
        }
        tokens = { ...tokens, issuer };
        input.mutable.tokens = tokens;
        await changed();
      },
      state: () => input.state,
      tokens: () => {
        requireBoundCredentials(input.mutable);
        return input.mutable.tokens;
      },
    };
  }

  async #bootstrapSharedOAuth(server: IntegrationServer, mutable: StoredOAuthState): Promise<void> {
    if (server.transport.type !== "streamable-http") {
      throw new OpensteerError({ code: "conflict", message: "MCP OAuth requires Streamable HTTP" });
    }
    const resourceUrl = server.transport.url;
    const sharedFetch: typeof fetch = (target, init) => this.#oauthFetch(target, init);
    const protectedResource = await discoverProtectedResourceMetadata(resourceUrl, {
      fetch: sharedFetch,
    });
    const authorizationServerUrl =
      protectedResource?.metadata.authorization_servers?.[0] ?? new URL(resourceUrl).origin;
    const authorizationServer = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
      fetch: sharedFetch,
    });
    if (!authorizationServer) {
      throw new OpensteerError({
        code: "conflict",
        message: "MCP OAuth authorization server metadata is unavailable",
      });
    }
    const issuer = new URL(authorizationServerUrl).toString();
    if (normalizeIssuer(authorizationServer.metadata.issuer) !== issuer) {
      throw new UnauthorizedError("MCP account requires renewed user authorization");
    }
    if (
      mutable.clientInformation?.issuer &&
      normalizeIssuer(mutable.clientInformation.issuer) !== issuer
    ) {
      throw new UnauthorizedError("MCP account requires renewed user authorization");
    }
    const discovery = {
      authorizationServerMetadata: {
        ...authorizationServer.metadata,
        response_types_supported: authorizationServer.metadata.response_types_supported ?? ["code"],
      },
      authorizationServerUrl,
      ...(protectedResource
        ? {
            resourceMetadata: {
              ...protectedResource.metadata,
              resource: protectedResource.metadata.resource ?? resourceUrl,
            },
            resourceMetadataUrl: protectedResource.metadataUrl,
          }
        : {}),
    } as OAuthDiscoveryState;
    if (mutable.clientInformation) {
      mutable.discovery = discovery;
      return;
    }
    let clientInformation: OAuthClientInformationMixed;
    if (
      authorizationServer.metadata.client_id_metadata_document_supported === true &&
      (mutable.clientMetadataUrl || this.#clientMetadataUrl)
    ) {
      clientInformation = OAuthClientInformationSchema.parse({
        client_id: mutable.clientMetadataUrl ?? this.#clientMetadataUrl!.toString(),
      });
    } else {
      const registrationEndpoint = authorizationServer.metadata.registration_endpoint;
      if (!registrationEndpoint) {
        throw new OpensteerError({
          code: "conflict",
          message:
            "This MCP service requires a registered OAuth app. Opensteer does not yet support that connection method for MCP; reinstalling or retrying cannot complete sign-in.",
        });
      }
      const registered = await registerDynamicClient(
        {
          metadata: {
            ...(this.#clientMetadata.client_name
              ? { client_name: this.#clientMetadata.client_name }
              : {}),
            ...(this.#clientMetadata.client_uri
              ? { client_uri: this.#clientMetadata.client_uri }
              : {}),
            ...(this.#clientMetadata.grant_types
              ? { grant_types: this.#clientMetadata.grant_types }
              : {}),
            redirect_uris: [mutable.redirectUrl ?? this.#callbackUrl.toString()],
            ...(this.#clientMetadata.response_types
              ? { response_types: this.#clientMetadata.response_types }
              : {}),
            token_endpoint_auth_method: "none",
          },
          registrationEndpoint,
        },
        { fetch: sharedFetch },
      ).catch(() => {
        throw new OpensteerError({
          code: "conflict",
          message: `This MCP service could not register the required redirect URI: ${mutable.redirectUrl ?? this.#callbackUrl.toString()}. It must accept this redirect before sign-in can work.`,
        });
      });
      const redirectUrl = mutable.redirectUrl ?? this.#callbackUrl.toString();
      if (registered.redirect_uris && !registered.redirect_uris.includes(redirectUrl)) {
        throw new OpensteerError({
          code: "conflict",
          message: `This MCP service rejected the required redirect URI: ${redirectUrl}. It must accept this HTTPS redirect before sign-in can work.`,
        });
      }
      clientInformation = OAuthClientInformationFullSchema.parse({
        ...this.#clientMetadata,
        redirect_uris: [redirectUrl],
        ...registered,
      });
    }
    mutable.clientInformation = { ...clientInformation, issuer };
    mutable.discovery = discovery;
  }

  #oauthFetch(target: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(target instanceof Request ? target.url : target.toString());
    if (isLoopbackHostname(url.hostname)) {
      if (!this.#local) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Hosted Opensteer cannot use loopback MCP",
        });
      }
      return fetch(target, { ...init, redirect: "manual" });
    }
    return this.#publicFetch(target, { ...init, redirect: "manual" });
  }

  #validateAuthorizationUrl(url: URL): URL {
    const candidate = new URL(url);
    if (candidate.username || candidate.password || candidate.hash) {
      throw new OpensteerError({ code: "forbidden", message: "MCP authorization URL is invalid" });
    }
    if (candidate.protocol === "https:") return candidate;
    if (this.#local && candidate.protocol === "http:" && isLoopbackHostname(candidate.hostname)) {
      return candidate;
    }
    throw new OpensteerError({
      code: "forbidden",
      message: "MCP authorization must use public HTTPS",
    });
  }
}

function normalizeTools(
  connectionId: IntegrationConnectionId,
  listed: Awaited<ReturnType<Client["listTools"]>>,
): readonly IntegrationToolMaterial[] {
  if (listed.tools.length > maximumToolsPerServer) {
    throw new OpensteerError({ code: "forbidden", message: "MCP server exposes too many tools" });
  }
  return listed.tools.map((tool): IntegrationToolMaterial => ({
    annotations: objectValue(tool.annotations ?? {}),
    connectionId,
    description: boundedToolDescription(tool.description),
    id: createIntegrationId("tool") as IntegrationToolId,
    inputSchema: objectValue(tool.inputSchema),
    name: tool.name,
    outputSchema: tool.outputSchema ? objectValue(tool.outputSchema) : null,
    status: "active",
    title: boundedToolTitle(tool.title ?? tool.annotations?.title, tool.name),
  }));
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpensteerError({ code: "bad_request", message: "MCP tool schema must be an object" });
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireBoundCredentials(state: StoredOAuthState): void {
  const { clientInformation, tokens } = state;
  const boundIssuer = clientInformation?.issuer && normalizeIssuer(clientInformation.issuer);
  if (
    (clientInformation || tokens) &&
    (!boundIssuer ||
      (tokens && (!tokens.issuer || normalizeIssuer(tokens.issuer) !== boundIssuer)) ||
      (state.discovery && discoveryIssuer(state.discovery) !== boundIssuer) ||
      (state.discovery?.authorizationServerMetadata &&
        normalizeIssuer(state.discovery.authorizationServerMetadata.issuer) !== boundIssuer))
  ) {
    throw new UnauthorizedError("MCP account requires renewed user authorization");
  }
}

function discoveryIssuer(discovery: OAuthDiscoveryState): string {
  return normalizeIssuer(discovery.authorizationServerUrl);
}

function normalizeIssuer(issuer: string | URL): string {
  try {
    return new URL(issuer).toString();
  } catch {
    throw new UnauthorizedError("MCP account requires renewed user authorization");
  }
}

function serializeState(state: StoredOAuthState): Readonly<Record<string, string>> {
  return { state: JSON.stringify(StoredOAuthStateSchema.parse(state)) };
}

function deserializeState(value: Readonly<Record<string, string>>): StoredOAuthState {
  const encoded = value.state;
  if (!encoded || Buffer.byteLength(encoded, "utf8") > 4 * 1_024 * 1_024) {
    throw new OpensteerError({ code: "forbidden", message: "MCP OAuth state is invalid" });
  }
  return StoredOAuthStateSchema.parse(JSON.parse(encoded)) as unknown as StoredOAuthState;
}

function serializeAttempt(
  payload: z.infer<typeof McpOAuthAttemptPayloadSchema>,
): Readonly<Record<string, string>> {
  return { payload: JSON.stringify(McpOAuthAttemptPayloadSchema.parse(payload)) };
}

function deserializeAttempt(value: Readonly<Record<string, string>>) {
  const payload = value.payload;
  if (!payload || Buffer.byteLength(payload, "utf8") > 4 * 1_024 * 1_024) {
    throw new OpensteerError({ code: "forbidden", message: "MCP OAuth state is invalid" });
  }
  const parsed = McpOAuthAttemptPayloadSchema.parse(JSON.parse(payload));
  return {
    ...parsed,
    oauthState: parsed.oauthState as unknown as StoredOAuthState,
  };
}

function connectionSecretContext(
  connectionId: IntegrationConnectionId,
  ownerUserId: UserId,
  serverId: IntegrationServer["id"],
) {
  return {
    binding: `mcp:${serverId}`,
    purpose: "mcp-oauth-connection",
    recordId: connectionId,
    scope: `user:${ownerUserId}`,
  } as const;
}
