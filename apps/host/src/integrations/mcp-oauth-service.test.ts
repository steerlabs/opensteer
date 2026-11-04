import { sealOAuthBrokerPayload } from "@opensteer/integration-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createIntegrationId } from "@opensteer/integration-core";
import { createId, OpensteerError } from "@opensteer/core";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { canonicalAuthorizationRepair } from "../identity/auth.js";

const sdk = vi.hoisted(() => {
  const state: { fetch?: typeof fetch } = {};
  class Transport {
    readonly authProvider;
    finished = false;
    constructor(_url: URL, options: { authProvider: unknown; fetch: typeof fetch }) {
      this.authProvider = options.authProvider;
      state.fetch = options.fetch;
    }
    async finishAuth() {
      this.finished = true;
    }
  }
  class Client {
    async connect(transport: Transport) {
      const provider = transport.authProvider as {
        redirectToAuthorization(url: URL): void;
        saveClientInformation(value: { client_id: string }): Promise<void>;
        saveCodeVerifier(value: string): Promise<void>;
        saveDiscoveryState(value: {
          authorizationServerMetadata: {
            authorization_endpoint: string;
            issuer: string;
            response_types_supported: string[];
            token_endpoint: string;
          };
          authorizationServerUrl: string;
        }): Promise<void>;
        state(): Promise<string> | string;
        redirectUrl: URL;
      };
      if (!transport.finished) {
        await provider.saveDiscoveryState({
          authorizationServerMetadata: {
            authorization_endpoint: "https://accounts.example.test/authorize",
            issuer: "https://accounts.example.test",
            response_types_supported: ["code"],
            token_endpoint: "https://accounts.example.test/token",
          },
          authorizationServerUrl: "https://accounts.example.test",
        });
        await provider.saveClientInformation({ client_id: "registered-opensteer" });
        await provider.saveCodeVerifier("v".repeat(43));
        const state = await provider.state();
        provider.redirectToAuthorization(
          new URL(
            `https://accounts.example.test/authorize?state=${state}&client_id=registered-opensteer&redirect_uri=${encodeURIComponent(provider.redirectUrl.toString())}&response_type=code&code_challenge=${"c".repeat(43)}&code_challenge_method=S256`,
          ),
        );
        throw new UnauthorizedError();
      }
    }
    async listTools() {
      return {
        tools: [
          {
            description: "Search records",
            inputSchema: { properties: { query: { type: "string" } }, type: "object" },
            name: "search",
          },
        ],
      };
    }
    async close() {}
  }
  return { Client, Transport, state };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: sdk.Client }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: sdk.Transport,
}));

import { McpOAuthService } from "./mcp-oauth-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("McpOAuthService", () => {
  it("requires reconnect before exposing legacy OAuth credentials without an issuer", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const ownerUserId = createId("user");
    const connectionId = createIntegrationId("connection");
    const serverId = createIntegrationId("server");
    const service = new McpOAuthService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: {} as never,
      exposure: "loopback",
      publicUrl: new URL("http://127.0.0.1:43122"),
      store: {
        getMcpOAuthConnection: vi.fn(async () => ({
          connectionId,
          ownerUserId,
          revision: 1,
          encryptedState: Buffer.from("encrypted"),
          server: { id: serverId },
        })),
      } as never,
      vault: {
        open: vi.fn(async () => ({
          state: JSON.stringify({
            clientInformation: { client_id: "client", client_secret: "secret" },
            tokens: { access_token: "access", refresh_token: "refresh", token_type: "Bearer" },
          }),
        })),
      } as never,
    });

    await expect(service.providerFor({ connectionId, ownerUserId, serverId })).rejects.toThrow(
      UnauthorizedError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects credentials if stored discovery names a different issuer", async () => {
    const ownerUserId = createId("user");
    const connectionId = createIntegrationId("connection");
    const serverId = createIntegrationId("server");
    const service = new McpOAuthService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: {} as never,
      exposure: "loopback",
      publicUrl: new URL("http://127.0.0.1:43122"),
      store: {
        getMcpOAuthConnection: vi.fn(async () => ({
          connectionId,
          ownerUserId,
          revision: 1,
          encryptedState: Buffer.from("encrypted"),
          server: { id: serverId },
        })),
      } as never,
      vault: {
        open: vi.fn(async () => ({
          state: JSON.stringify({
            clientInformation: { client_id: "client", issuer: "https://trusted.example/" },
            tokens: {
              access_token: "access",
              token_type: "Bearer",
              issuer: "https://trusted.example/",
            },
            discovery: { authorizationServerUrl: "https://attacker.example/" },
          }),
        })),
      } as never,
    });
    await expect(service.providerFor({ connectionId, ownerUserId, serverId })).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it("persists issuer binding across refresh and rejects a changed discovery", async () => {
    const ownerUserId = createId("user");
    const connectionId = createIntegrationId("connection");
    const serverId = createIntegrationId("server");
    const issuer = "https://trusted.example/";
    const seal = vi.fn(async (value: Readonly<Record<string, string>>) => ({
      envelope: Buffer.from(value.state!),
      keyVersion: 1,
    }));
    const replace = vi.fn(async () => true);
    const service = new McpOAuthService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: {} as never,
      exposure: "loopback",
      publicUrl: new URL("http://127.0.0.1:43122"),
      store: {
        getMcpOAuthConnection: vi.fn(async () => ({
          connectionId,
          ownerUserId,
          revision: 7,
          encryptedState: Buffer.from("encrypted"),
          server: { id: serverId },
        })),
        replaceMcpOAuthCredential: replace,
      } as never,
      vault: {
        seal,
        open: vi.fn(async () => ({
          state: JSON.stringify({
            clientInformation: { client_id: "client", issuer },
            tokens: { access_token: "old", token_type: "Bearer", issuer },
            discovery: {
              authorizationServerUrl: issuer.slice(0, -1),
              authorizationServerMetadata: {
                issuer,
                authorization_endpoint: `${issuer}authorize`,
                token_endpoint: `${issuer}token`,
                response_types_supported: ["code"],
              },
            },
          }),
        })),
      } as never,
    });
    const provider = await service.providerFor({ connectionId, ownerUserId, serverId });
    await provider.saveTokens!({
      access_token: "new",
      refresh_token: "refresh",
      token_type: "Bearer",
      issuer,
    });
    expect(JSON.parse(seal.mock.calls[0]![0].state!)).toMatchObject({
      clientInformation: { issuer },
      tokens: { access_token: "new", issuer },
    });
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7 }));
    await expect(
      provider.saveClientInformation!({ client_id: "client", issuer: "https://trusted.example" }),
    ).resolves.toBeUndefined();
    const upstream: typeof fetch = async (target) => {
      const url = String(target instanceof Request ? target.url : target);
      if (url.includes(".well-known")) return new Response(null, { status: 404 });
      if (url === `${issuer}token`)
        return Response.json({ access_token: "refreshed", token_type: "Bearer" });
      throw new Error(`Unexpected OAuth request ${url}`);
    };
    await expect(
      auth(provider, { serverUrl: new URL("https://mcp.example/"), fetchFn: upstream }),
    ).resolves.toBe("AUTHORIZED");
    await expect(
      provider.saveDiscoveryState!({
        authorizationServerUrl: "https://attacker.example/",
      }),
    ).rejects.toThrow(UnauthorizedError);
    expect(replace).toHaveBeenCalledTimes(3);
  });

  it.each(["local-dcr", "unsupported", "relay-dcr", "relay-metadata", "relay-rejected"] as const)(
    "pins redirect and issuer through supported registration (%s)",
    async (mode) => {
      const supportsDcr = mode !== "unsupported";
      const relay = mode.startsWith("relay");
      const redirectUrl = relay
        ? "https://account.example.test/v1/oauth-broker/callback/mcp"
        : "http://127.0.0.1:43122/v1/integration-platform/mcp-oauth/callback";
      const metadataUrl = "https://account.example.test/v1/oauth-broker/mcp/client-metadata.json";
      let registeredMetadata: unknown;
      const ownerUserId = createId("user");
      const connectionId = createIntegrationId("connection");
      const serverId = createIntegrationId("server");
      const endpoint = "http://127.0.0.1:43123/mcp";
      const fetch_ = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
        const url = String(target instanceof Request ? target.url : target);
        if (url.includes("oauth-protected-resource")) {
          return new Response(
            JSON.stringify({
              authorization_servers: ["http://127.0.0.1:43124"],
              resource: endpoint,
            }),
            { status: 200 },
          );
        }
        if (url.includes("oauth-authorization-server")) {
          return new Response(
            JSON.stringify({
              authorization_endpoint: "http://127.0.0.1:43124/authorize",
              issuer: "http://127.0.0.1:43124",
              ...(supportsDcr ? { registration_endpoint: "http://127.0.0.1:43124/register" } : {}),
              client_id_metadata_document_supported: mode === "relay-metadata",
              response_types_supported: ["code"],
              token_endpoint: "http://127.0.0.1:43124/token",
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/register")) {
          registeredMetadata = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              client_id: "registered-opensteer",
              ...(mode === "relay-rejected"
                ? { redirect_uris: ["http://127.0.0.1:43122/callback"] }
                : {}),
            }),
            {
              status: 201,
            },
          );
        }
        throw new Error(`Unexpected OAuth request ${url}`);
      });
      vi.stubGlobal("fetch", fetch_);
      const replaceMcpOAuthCredential = vi.fn(async () => true);
      const service = new McpOAuthService({
        onConnectionConnected: vi.fn(async () => undefined),
        attempts: {} as never,
        exposure: "loopback",
        publicUrl: new URL("http://127.0.0.1:43122"),
        store: {
          getMcpOAuthConnection: vi.fn(async () => ({
            connectionId,
            encryptedState: Buffer.from("encrypted"),
            ownerUserId,
            revision: 1,
            server: {
              id: serverId,
              transport: { headers: {}, type: "streamable-http", url: endpoint },
            },
          })),
          replaceMcpOAuthCredential,
        } as never,
        vault: {
          open: vi.fn(async () => ({
            state: JSON.stringify({
              redirectUrl,
              ...(mode === "relay-metadata" ? { clientMetadataUrl: metadataUrl } : {}),
            }),
          })),
          seal: vi.fn(async () => ({ envelope: Buffer.from("sealed"), keyVersion: 1 })),
        } as never,
      });

      const provider = await service.providerFor({ connectionId, ownerUserId, serverId });
      if (!supportsDcr) {
        await expect(provider.discoveryState?.()).rejects.toThrow(
          "Opensteer does not yet support that connection method for MCP",
        );
        expect(replaceMcpOAuthCredential).not.toHaveBeenCalled();
        expect(fetch_.mock.calls.some(([target]) => String(target).endsWith("/register"))).toBe(
          false,
        );
        return;
      }
      if (mode === "relay-rejected") {
        await expect(provider.discoveryState?.()).rejects.toThrow(redirectUrl);
        expect(replaceMcpOAuthCredential).not.toHaveBeenCalled();
        return;
      }
      await expect(provider.discoveryState?.()).resolves.toMatchObject({
        authorizationServerUrl: "http://127.0.0.1:43124",
        resourceMetadata: { resource: endpoint },
      });
      expect(provider.clientInformation()).toMatchObject({
        client_id: mode === "relay-metadata" ? metadataUrl : "registered-opensteer",
      });
      expect(provider.clientMetadata.redirect_uris).toEqual([redirectUrl]);
      if (mode === "relay-metadata") {
        expect(registeredMetadata).toBeUndefined();
        expect(provider.clientMetadataUrl).toBe(metadataUrl);
        return;
      }
      expect(registeredMetadata).toMatchObject({
        redirect_uris: [redirectUrl],
        token_endpoint_auth_method: "none",
      });
      expect(fetch_.mock.calls.map(([target]) => String(target))).toEqual(
        expect.arrayContaining([
          expect.stringContaining("oauth-protected-resource"),
          expect.stringContaining("oauth-authorization-server"),
          "http://127.0.0.1:43124/register",
        ]),
      );
      expect(replaceMcpOAuthCredential).toHaveBeenCalledOnce();
    },
  );

  it("exposes redaction without exposing stored OAuth token values", async () => {
    const ownerUserId = createId("user");
    const connectionId = createIntegrationId("connection");
    const serverId = createIntegrationId("server");
    const accessToken = "mcp-access-token+/=abc123";
    const refreshToken = "mcp-refresh-token+/=xyz789";
    const store = {
      getMcpOAuthConnection: vi.fn(async () => ({
        connectionId,
        encryptedState: Buffer.from("encrypted"),
        ownerUserId,
        revision: 1,
        server: { id: serverId },
      })),
    };
    const vault = {
      open: vi.fn(async () => ({
        state: JSON.stringify({
          clientInformation: { client_id: "client", issuer: "https://accounts.example.test/" },
          discovery: {
            authorizationServerUrl: "https://accounts.example.test",
            authorizationServerMetadata: {
              issuer: "https://accounts.example.test",
              authorization_endpoint: "https://accounts.example.test/authorize",
              token_endpoint: "https://accounts.example.test/token",
              response_types_supported: ["code"],
            },
          },
          tokens: {
            access_token: accessToken,
            issuer: "https://accounts.example.test/",
            refresh_token: refreshToken,
            token_type: "Bearer",
          },
        }),
      })),
    };
    const service = new McpOAuthService({
      onConnectionConnected: vi.fn(async () => undefined),
      attempts: {} as never,
      exposure: "loopback",
      publicUrl: new URL("http://127.0.0.1:43122"),
      store: store as never,
      vault: vault as never,
    });

    const provider = await service.providerFor({ connectionId, ownerUserId, serverId });
    const reflected = [
      accessToken,
      encodeURIComponent(accessToken),
      Buffer.from(accessToken, "utf8").toString("base64"),
      refreshToken,
    ].join(" ");
    const redacted = provider.responseRedactor().redactText(reflected);
    expect(redacted).not.toContain(accessToken);
    expect(redacted).not.toContain(encodeURIComponent(accessToken));
    expect(redacted).not.toContain(Buffer.from(accessToken, "utf8").toString("base64"));
    expect(redacted).not.toContain(refreshToken);
  });

  it.each([
    { reconnect: false, relay: false },
    { reconnect: true, relay: false },
    { reconnect: false, relay: true },
    { reconnect: true, relay: true },
    { reconnect: false, relay: true, badIssuer: true },
    { reconnect: false, relay: true, abandonedClaim: true },
    { reconnect: false, relay: true, finish: "app", surface: "desktop" },
    { reconnect: true, relay: true, finish: "app", surface: "native" },
    { reconnect: false, relay: true, finish: "app", oldAccount: true },
    { reconnect: false, relay: true, finish: "app", changedLink: true },
    { reconnect: false, relay: false, finish: "app", surface: "desktop" },
  ] as const)("authorizes a new or existing MCP account (%j)", async (scenario) => {
    const { reconnect, relay } = scenario;
    const badIssuer = "badIssuer" in scenario && scenario.badIssuer;
    const abandonedClaim = "abandonedClaim" in scenario && scenario.abandonedClaim;
    const finish = "finish" in scenario ? scenario.finish : undefined;
    const surface = "surface" in scenario ? scenario.surface : undefined;
    const oldAccount = "oldAccount" in scenario && scenario.oldAccount;
    const ownerUserId = createId("user");
    const requestId = createId("request");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const existingConnectionId = createIntegrationId("connection");
    const server = {
      connectionRequirement: { kind: "mcp-oauth" as const },
      id: serverId,
      installationId,
      name: "default",
      status: "needs-attention" as const,
      statusDetail: "Unauthorized",
      toolGeneration: 1,
      transport: {
        headers: {},
        type: "streamable-http" as const,
        url: "http://127.0.0.1:43123/mcp",
      },
      updatedAt: new Date().toISOString(),
    };
    const installation = {
      createdAt: new Date().toISOString(),
      description: "Example",
      id: installationId,
      manifest: {},
      name: "example",
      provenance: {},
      revision: 1,
      sourceKind: "remote-mcp" as const,
      status: "active" as const,
      title: "Example",
      trust: "administrator-approved" as const,
      updatedAt: new Date().toISOString(),
      version: null,
    };
    let attemptId: ReturnType<typeof createIntegrationId<"mcpOauthAttempt">> | undefined;
    let attemptPayload: Readonly<Record<string, string>> | undefined;
    let attemptAuthorizationUrl = "";
    const attemptState = "s".repeat(43);
    let status = "launched";
    let failureCode: string | null = null;
    let resultConnectionId: string | null = null;
    const attempts = {
      begin: vi.fn(
        async (input: {
          id: ReturnType<typeof createIntegrationId<"mcpOauthAttempt">>;
          payload: (state: string) => Promise<{
            authorizationUrl: string;
            payload: Readonly<Record<string, string>>;
          }>;
        }) => {
          attemptId = input.id;
          const built = await input.payload(attemptState);
          attemptAuthorizationUrl = built.authorizationUrl;
          attemptPayload = built.payload;
          return {
            attemptId: input.id,
            expiresAt: new Date("2026-08-13T12:10:00.000Z"),
            launchTicket: "t".repeat(43),
            state: attemptState,
          };
        },
      ),
      claim: vi.fn(async () => ({
        id: attemptId,
        ownerUserId,
        payload: attemptPayload,
        surface: "desktop",
      })),
      fail: vi.fn(async (_id: string, reason: string) => {
        status = "failed";
        failureCode = reason === "exchange-failed" ? null : reason;
      }),
      status: vi.fn(async (input: { ownerUserId: string }) =>
        input.ownerUserId !== ownerUserId
          ? null
          : {
              status: status === "claimed" ? "launched" : status,
              connectionId: resultConnectionId,
              expiresAt: new Date(),
              failureCode,
            },
      ),
      inspect: vi.fn(async () => attemptPayload),
      claimHosted: vi.fn(async () => {
        if (status !== "launched") return null;
        status = "claimed";
        return { id: attemptId, ownerUserId, payload: attemptPayload, surface: "web" };
      }),
    };
    const complete = vi.fn(async (input: { connectionId: string }) => {
      status = "completed";
      resultConnectionId = input.connectionId;
    });
    const completionGate = Promise.withResolvers<void>();
    if (relay && !badIssuer && !abandonedClaim)
      complete.mockImplementationOnce(async (input) => {
        await completionGate.promise;
        status = "completed";
        resultConnectionId = input.connectionId;
      });
    const store = {
      completeMcpOAuthAttempt: complete,
      getMcpOAuthServer: vi.fn(async () => ({
        installation,
        server,
        ...(reconnect ? { reconnect: { connectionId: existingConnectionId, revision: 3 } } : {}),
      })),
    };
    const vault = {
      open: vi.fn(async (envelope: Buffer) => JSON.parse(envelope.toString("utf8"))),
      seal: vi.fn(async (value: Readonly<Record<string, string>>) => ({
        envelope: Buffer.from(JSON.stringify(value)),
        keyVersion: 1,
      })),
    };
    const onConnectionConnected = vi.fn(async () => undefined);
    const binding = {
      issuer: "https://account.example.test",
      subject: `acct_${crypto.randomUUID()}`,
      linkGeneration: "g".repeat(43),
    };
    let hostPublicKey = "";
    let returned = !finish;
    const broker = {
      returnAttempt: vi.fn(async () => {
        returned = true;
      }),
      issuer: binding.issuer,
      callbackUrl: () => `${binding.issuer}/v1/oauth-broker/callback/mcp`,
      metadata: vi.fn(async () => ({
        mcpCallbackRelay: 1,
        ...(oldAccount ? {} : { appFinish: 1 }),
      })),
      createCallbackRelay: vi.fn(
        async (input: { hostPublicKey: string; attemptId: string; expiresAt: string }) => {
          hostPublicKey = input.hostPublicKey;
          return {
            attemptId: input.attemptId,
            expiresAt: input.expiresAt,
            launchUrl: `${binding.issuer}/launch`,
          };
        },
      ),
      status: vi.fn(async () => ({ status: returned ? "sealed" : "launched" })),
      pull: vi.fn(async () => ({
        status: "sealed",
        sealedResult: sealOAuthBrokerPayload(
          {
            parameters: [
              ["state", attemptState],
              ["code", "authorization-code"],
              [
                "iss",
                badIssuer ? "https://attacker.example.test" : "https://accounts.example.test",
              ],
            ],
          },
          hostPublicKey,
          JSON.parse(attemptPayload!.payload!).relay.context,
        ),
      })),
      acknowledge: vi.fn(async () => undefined),
    };
    const service = new McpOAuthService({
      ...(relay
        ? {
            hostedOAuth: {
              kind: "personal" as const,
              accountSubject: async () => binding as never,
              broker: broker as never,
              deploymentAuthorityDigest: "d".repeat(43),
            },
            deploymentPosture: async () => "account-linked-personal" as const,
          }
        : {}),
      attempts: attempts as never,
      exposure: "loopback",
      onConnectionConnected,
      publicUrl: new URL("http://127.0.0.1:43122"),
      store: store as never,
      vault: vault as never,
    });

    if (!relay)
      await expect(
        service.beginAuthorization({
          displayName: "Work account",
          ownerUserId,
          requestId,
          requestSurface: "personal-remote",
          returnPath: "/",
          serverId,
          surface: "web",
        }),
      ).rejects.toMatchObject({
        code: "canonical_surface_required",
        message: canonicalAuthorizationRepair,
      });
    if (!relay) expect(store.getMcpOAuthServer).not.toHaveBeenCalled();

    const begin = () =>
      service.beginAuthorization({
        displayName: "Work account",
        ownerUserId,
        requestId,
        requestSurface: relay ? "personal-remote" : "canonical",
        returnPath: "/",
        serverId,
        surface: surface ?? "desktop",
        ...(finish ? { finish: "app" as const } : {}),
      });
    if (oldAccount) {
      await expect(begin()).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("Opensteer Account must be updated"),
      });
      expect(broker.createCallbackRelay).not.toHaveBeenCalled();
      expect(attempts.begin).not.toHaveBeenCalled();
      return;
    }
    const begun = await begin();
    if (relay) {
      expect(Object.hasOwn(broker.createCallbackRelay.mock.calls[0]![0], "finish")).toBe(!!finish);
      expect(JSON.parse(attemptPayload!.payload!).relay.finish).toBe(finish);
    }
    if ("changedLink" in scenario) {
      binding.linkGeneration = "h".repeat(43);
      await expect(
        service.returnAuthorization({
          attemptId: attemptId!,
          ownerUserId,
          returnProof: "r".repeat(43),
        }),
      ).resolves.toMatchObject({ status: "failed", failureCode: "account-link-mismatch" });
      expect(broker.returnAttempt).not.toHaveBeenCalled();
      expect(broker.pull).not.toHaveBeenCalled();
      return;
    }
    if (relay && finish) {
      const returnInput = { attemptId: attemptId!, ownerUserId, returnProof: "r".repeat(43) };
      await expect(service.authorizationStatus(returnInput)).resolves.toMatchObject({
        status: "launched",
      });
      expect(broker.pull).not.toHaveBeenCalled();
      await expect(
        service.returnAuthorization({ ...returnInput, ownerUserId: createId("user") }),
      ).resolves.toBeNull();
      expect(broker.returnAttempt).not.toHaveBeenCalled();
      broker.pull.mockRejectedValueOnce(
        new OpensteerError({ code: "conflict", message: "Lost result", retryable: true }),
      );
      await expect(service.returnAuthorization(returnInput)).rejects.toMatchObject({
        retryable: true,
      });
      expect(attempts.claimHosted).not.toHaveBeenCalled();
      expect(attempts.fail).not.toHaveBeenCalled();
      const returnCall = service.returnAuthorization(returnInput);
      await vi.waitFor(() =>
        expect(complete, "App return never committed MCP credentials").toHaveBeenCalledOnce(),
      );
      completionGate.resolve();
      await expect(returnCall).resolves.toMatchObject({ status: "completed" });
      expect(broker.returnAttempt).toHaveBeenLastCalledWith(
        `hoa_${attemptId!.slice(4)}`,
        returnInput.returnProof,
      );
      await expect(service.returnAuthorization(returnInput)).resolves.toMatchObject({
        status: "completed",
      });
      expect(broker.returnAttempt).toHaveBeenCalledTimes(2);
      expect(broker.acknowledge).toHaveBeenCalledOnce();
      return;
    }
    await expect(
      service.returnAuthorization({
        attemptId: attemptId!,
        ownerUserId,
        returnProof: "r".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(broker.returnAttempt).not.toHaveBeenCalled();
    expect(begun).toMatchObject({ attemptId, launchTicket: "t".repeat(43) });
    if (relay) expect(attemptAuthorizationUrl).toBe(`${binding.issuer}/launch`);
    else
      expect(attemptAuthorizationUrl).toMatch(
        /^https:\/\/accounts\.example\.test\/authorize\?state=/u,
      );
    expect(attempts.begin).toHaveBeenCalledOnce();
    const previousPayloadSchema = z.strictObject({
      displayName: z.unknown(),
      oauthState: z.unknown(),
      requestId: z.unknown(),
      returnPath: z.unknown(),
      serverId: z.unknown(),
    });
    expect(previousPayloadSchema.safeParse(JSON.parse(attemptPayload!.payload!)).success).toBe(
      !reconnect && !relay,
    );
    const fetchSpy = vi.fn(
      async (_target: string | URL | Request, _init?: RequestInit) =>
        new Response(null, {
          status: 307,
          headers: { location: "https://attacker.example/token" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const redirect = await sdk.state.fetch!("http://127.0.0.1:43124/token", {
      method: "POST",
      body: "refresh_token=test-secret",
    });
    expect(redirect.status).toBe(307);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });

    const state = new URL(attemptAuthorizationUrl).searchParams.get("state")!;
    if (abandonedClaim) status = "claimed";
    const finishAuth = vi.spyOn(sdk.Transport.prototype, "finishAuth");
    const firstPoll = relay
      ? service.authorizationStatus({ attemptId: attemptId!, ownerUserId })
      : null;
    if (relay && !badIssuer && !abandonedClaim) {
      await vi.waitFor(() =>
        expect(complete, "MCP completion did not reach persistence").toHaveBeenCalledOnce(),
      );
      expect(status).toBe("claimed");
    }
    const secondPoll = relay
      ? service.authorizationStatus({ attemptId: attemptId!, ownerUserId })
      : null;
    completionGate.resolve();
    const completed = relay
      ? (await Promise.all([firstPoll!, secondPoll!]))[0]!
      : await service.handleAuthorizationCallback({
          attemptId: attemptId!,
          browserBinding: "b".repeat(43),
          parameters: new URLSearchParams({
            code: "authorization-code",
            future_provider_field: "accepted",
            scope: "records.read",
            state,
          }),
          state,
        });
    if (abandonedClaim) {
      expect(completed).toMatchObject({ status: "failed", failureCode: "grant-rejected" });
      expect(attempts.fail).toHaveBeenCalledWith(attemptId, "grant-rejected");
      expect(complete).not.toHaveBeenCalled();
      expect(finishAuth).not.toHaveBeenCalled();
      expect(onConnectionConnected).not.toHaveBeenCalled();
      expect(
        await service.authorizationStatus({ attemptId: attemptId!, ownerUserId }),
      ).toMatchObject({
        status: "failed",
        failureCode: "grant-rejected",
      });
      expect(attempts.claimHosted).toHaveBeenCalledOnce();
      return;
    }
    if (badIssuer) {
      expect(completed.status).toBe("failed");
      expect(complete).not.toHaveBeenCalled();
      expect(onConnectionConnected).not.toHaveBeenCalled();
      return;
    }
    expect(completed.status).toBe("completed");
    if (completed.status !== "completed") throw new Error("Expected completed authorization");
    if (reconnect) expect(completed.connectionId).toBe(existingConnectionId);
    if ("returnPath" in completed) expect(completed.returnPath).toBe("/");
    if (relay) {
      expect(attempts.claimHosted).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ accountBinding: { ...binding, kind: "personal" } }),
      );
      expect(JSON.stringify(broker.createCallbackRelay.mock.calls)).not.toContain("v".repeat(43));
      expect(broker.createCallbackRelay).toHaveBeenCalledWith(
        expect.objectContaining({
          mcp: expect.objectContaining({ serverId, issuer: "https://accounts.example.test/" }),
          authorizationUrl: expect.stringContaining(encodeURIComponent(broker.callbackUrl())),
        }),
      );
    }
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: completed.connectionId,
        displayName: "Work account",
        ownerUserId,
        serverId,
        tools: [expect.objectContaining({ connectionId: completed.connectionId, name: "search" })],
      }),
    );
    expect(onConnectionConnected).toHaveBeenCalledExactlyOnceWith({
      connectionId: completed.connectionId,
      ownerUserId,
    });
    expect(onConnectionConnected.mock.invocationCallOrder[0]).toBeGreaterThan(
      complete.mock.invocationCallOrder[0]!,
    );

    if (relay) {
      expect(
        await service.authorizationStatus({ attemptId: attemptId!, ownerUserId }),
      ).toMatchObject({ status: "completed" });
      expect(complete).toHaveBeenCalledOnce();
      expect(attempts.claimHosted).toHaveBeenCalledOnce();
      return;
    }
    const failed = await service.handleAuthorizationCallback({
      attemptId: attemptId!,
      browserBinding: "b".repeat(43),
      parameters: new URLSearchParams({ error: "server_error", state }),
      state,
    });
    expect(failed).toMatchObject({
      attemptId,
      returnPath: "/",
      status: "failed",
      surface: "desktop",
    });
    expect(attempts.fail).toHaveBeenCalledWith(attemptId, "exchange-failed");
    if (reconnect) {
      store.getMcpOAuthServer.mockResolvedValue({
        installation,
        server,
        reconnect: { connectionId: existingConnectionId, revision: 4 },
      });
      await expect(
        service.handleAuthorizationCallback({
          attemptId: attemptId!,
          browserBinding: "b".repeat(43),
          parameters: new URLSearchParams({ code: "authorization-code", state }),
          state,
        }),
      ).rejects.toThrow(/restart authorization/i);
      expect(complete).toHaveBeenCalledOnce();
    }
  });
});

it.each(["failed", "denied", "cancelled", "expired"] as const)(
  "returns the owner's durable %s outcome on an app-return retry after payload erasure",
  async (status) => {
    const ownerUserId = createId("user");
    const attemptId = createIntegrationId("mcpOauthAttempt");
    const outcome = {
      status,
      failureCode: "provider-denied",
      connectionId: null,
      expiresAt: new Date(),
    };
    const inspect = vi.fn(async () => null);
    const attempts = {
      status: vi.fn(async (input: { ownerUserId: string }) =>
        input.ownerUserId === ownerUserId ? outcome : null,
      ),
      inspect,
    };
    const service = new McpOAuthService({
      attempts: attempts as never,
      exposure: "loopback",
      store: {} as never,
      publicUrl: new URL("http://127.0.0.1:4310"),
      onConnectionConnected: async () => undefined,
      vault: {} as never,
    });
    const input = { attemptId, ownerUserId, returnProof: "r".repeat(43) };
    await expect(service.returnAuthorization(input)).resolves.toEqual(outcome);
    await expect(
      service.returnAuthorization({ ...input, ownerUserId: createId("user") }),
    ).resolves.toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  },
);
