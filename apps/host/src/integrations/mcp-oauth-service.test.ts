import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createIntegrationId } from "@opensteer/integration-core";
import { createId } from "@opensteer/core";
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
          new URL(`https://accounts.example.test/authorize?state=${state}`),
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

afterEach(() => vi.unstubAllGlobals());

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

  it.each([true, false])(
    "requires supported registration before storing MCP credentials (DCR: %s)",
    async (supportsDcr) => {
      const ownerUserId = createId("user");
      const connectionId = createIntegrationId("connection");
      const serverId = createIntegrationId("server");
      const endpoint = "http://127.0.0.1:43123/mcp";
      const fetch_ = vi.fn(async (target: string | URL | Request) => {
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
              response_types_supported: ["code"],
              token_endpoint: "http://127.0.0.1:43124/token",
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/register")) {
          return new Response(JSON.stringify({ client_id: "registered-opensteer" }), {
            status: 201,
          });
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
          open: vi.fn(async () => ({ state: "{}" })),
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
      await expect(provider.discoveryState?.()).resolves.toMatchObject({
        authorizationServerUrl: "http://127.0.0.1:43124",
        resourceMetadata: { resource: endpoint },
      });
      expect(provider.clientInformation()).toMatchObject({
        client_id: "registered-opensteer",
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

  it.each([false, true])(
    "authorizes a new or existing MCP account (reconnect: %s)",
    async (reconnect) => {
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
        fail: vi.fn(async () => undefined),
      };
      const complete = vi.fn();
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
      const service = new McpOAuthService({
        attempts: attempts as never,
        exposure: "loopback",
        onConnectionConnected,
        publicUrl: new URL("http://127.0.0.1:43122"),
        store: store as never,
        vault: vault as never,
      });

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
      expect(store.getMcpOAuthServer).not.toHaveBeenCalled();

      const begun = await service.beginAuthorization({
        displayName: "Work account",
        ownerUserId,
        requestId,
        requestSurface: "canonical",
        returnPath: "/",
        serverId,
        surface: "desktop",
      });
      expect(begun).toMatchObject({ attemptId, launchTicket: "t".repeat(43) });
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
        !reconnect,
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
      const completed = await service.handleAuthorizationCallback({
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
      expect(completed.status).toBe("completed");
      if (completed.status !== "completed") throw new Error("Expected completed authorization");
      if (reconnect) expect(completed.connectionId).toBe(existingConnectionId);
      expect(completed.returnPath).toBe("/");
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: completed.connectionId,
          displayName: "Work account",
          ownerUserId,
          serverId,
          tools: [
            expect.objectContaining({ connectionId: completed.connectionId, name: "search" }),
          ],
        }),
      );
      expect(onConnectionConnected).toHaveBeenCalledExactlyOnceWith({
        connectionId: completed.connectionId,
        ownerUserId,
      });
      expect(onConnectionConnected.mock.invocationCallOrder[0]).toBeGreaterThan(
        complete.mock.invocationCallOrder[0]!,
      );

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
    },
  );
});
