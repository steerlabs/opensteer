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
  IntegrationServerIdSchema,
  McpOAuthAttemptIdSchema,
  type IntegrationConnectionId,
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
});

const McpOAuthAttemptPayloadSchema = z.strictObject({
  displayName: z.string().min(1).max(640),
  oauthState: StoredOAuthStateSchema,
  requestId: RequestIdSchema,
  returnPath: z.string().min(1).max(8_192),
  serverId: IntegrationServerIdSchema,
});

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
}

export interface RedactingOAuthClientProvider extends OAuthClientProvider {
  responseRedactor(): CredentialResponseRedactor;
}

export class McpOAuthService {
  readonly #callbackUrl: URL;
  readonly #attempts: IntegrationAuthAttemptLifecycle;
  readonly #clientMetadata: OAuthClientMetadata;
  readonly #clientMetadataUrl: URL | null;
  readonly #local: boolean;
  readonly #publicFetch = createPublicHttpsFetch();
  readonly #onConnectionConnected: IntegrationConnectionConnected;
  readonly #store: IntegrationPlatformStore;
  readonly #vault: AesGcmSecretVault;

  constructor(options: {
    readonly publicUrl: URL;
    readonly attempts: IntegrationAuthAttemptLifecycle;
    readonly exposure: HostExposure;
    readonly onConnectionConnected: IntegrationConnectionConnected;
    readonly store: IntegrationPlatformStore;
    readonly vault: AesGcmSecretVault;
  }) {
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
    if (input.requestSurface === "personal-remote") throw canonicalAuthorizationRequired();
    const context = await this.#store.getMcpOAuthServer(input);
    const attemptId = createIntegrationId("mcpOauthAttempt");
    let authorizationUrl: URL | undefined;
    const started = await this.#attempts.begin({
      flow: "mcp-oauth",
      id: attemptId,
      ownerUserId: input.ownerUserId,
      payload: async (state) => {
        const mutable: StoredOAuthState = {};
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
        return {
          authorizationUrl: authorizationUrl.toString(),
          payload: serializeAttempt({
            displayName: input.displayName,
            oauthState: StoredOAuthStateSchema.parse(mutable),
            requestId: input.requestId,
            returnPath: input.returnPath,
            serverId: context.server.id,
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
    const attempt = await this.#claim(input);
    let connected: IntegrationConnectionId;
    try {
      const mutable = attempt.oauthState;
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
        parameters: input.parameters,
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
      const provider = this.#provider({ mutable, server: attempt.server, state: input.state });
      const { client, transport } = this.#client(attempt.server, provider);
      try {
        await transport.finishAuth(authorizationResponse.code);
        await client.connect(transport as unknown as Transport, {
          maxTotalTimeout: connectionTimeoutMilliseconds,
          timeout: connectionTimeoutMilliseconds,
        });
        const connectionId = createIntegrationId("connection");
        const tools = normalizeTools(connectionId, await client.listTools());
        const sealed = await this.#vault.seal(
          serializeState(mutable),
          connectionSecretContext(connectionId, attempt.ownerUserId, attempt.server.id),
        );
        await this.#store.completeMcpOAuthAttempt({
          attemptId: attempt.id,
          connectionId,
          displayName: attempt.displayName,
          encryptedState: sealed.envelope,
          encryptionKeyVersion: sealed.keyVersion,
          ownerUserId: attempt.ownerUserId,
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
    let revision = connection.revision;
    return this.#provider({
      mutable,
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
    const payload = deserializeAttempt(claimed.payload);
    const context = await this.#store.getMcpOAuthServer({
      ownerUserId: claimed.ownerUserId,
      requestId: payload.requestId,
      serverId: payload.serverId,
    });
    return {
      ...context,
      ...payload,
      id: McpOAuthAttemptIdSchema.parse(claimed.id),
      ownerUserId: claimed.ownerUserId,
      surface: claimed.surface,
    };
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
    const secureFetch: typeof fetch = loopback
      ? fetch
      : (target, init) => this.#publicFetch(target, { ...init, redirect: "manual" });
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: provider,
      fetch: secureFetch,
      requestInit: { headers: server.transport.headers, redirect: "manual" },
    });
    return { client, transport };
  }

  #provider(input: {
    readonly mutable: StoredOAuthState;
    readonly onAuthorization?: (url: URL) => void;
    readonly onChange?: () => Promise<void>;
    readonly server: IntegrationServer;
    readonly state: string;
  }): RedactingOAuthClientProvider {
    const changed = async () => input.onChange?.();
    return {
      ...(this.#clientMetadataUrl ? { clientMetadataUrl: this.#clientMetadataUrl.toString() } : {}),
      clientInformation: () => input.mutable.clientInformation,
      clientMetadata: this.#clientMetadata,
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
      redirectUrl: this.#callbackUrl,
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
        input.mutable.clientInformation = clientInformation;
        await changed();
      },
      saveCodeVerifier: async (codeVerifier) => {
        input.mutable.codeVerifier = codeVerifier;
        await changed();
      },
      saveDiscoveryState: async (discovery) => {
        input.mutable.discovery = discovery;
        await changed();
      },
      saveTokens: async (tokens) => {
        input.mutable.tokens = tokens;
        await changed();
      },
      state: () => input.state,
      tokens: () => input.mutable.tokens,
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
      this.#clientMetadataUrl
    ) {
      clientInformation = OAuthClientInformationSchema.parse({
        client_id: this.#clientMetadataUrl.toString(),
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
            redirect_uris: this.#clientMetadata.redirect_uris,
            ...(this.#clientMetadata.response_types
              ? { response_types: this.#clientMetadata.response_types }
              : {}),
            token_endpoint_auth_method: "none",
          },
          registrationEndpoint,
        },
        { fetch: sharedFetch },
      );
      clientInformation = OAuthClientInformationFullSchema.parse({
        ...this.#clientMetadata,
        ...registered,
      });
    }
    mutable.clientInformation = clientInformation;
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
  return { ...parsed, oauthState: parsed.oauthState as unknown as StoredOAuthState };
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
