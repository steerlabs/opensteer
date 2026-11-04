import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  ControlPlaneAccountIdSchema,
  CreateHostedOAuthAttemptRequestSchema,
  HostedOAuthAttemptIdSchema,
  OAuthBrokerTokenBundleSchema,
  type OAuthBrokerSealedEnvelope,
} from "@opensteer/control-plane-protocol";
import {
  generateOAuthBrokerEphemeralKeyPair,
  hostedOAuthDeploymentAuthorityDigest,
  openOAuthBrokerPayload,
} from "@opensteer/integration-auth";
import { slackIntegration } from "@opensteer/integration-catalog";
import { authorizationDigest } from "@opensteer/integration-core/digest";
import { HostedOAuthBrokerService } from "./hosted-oauth-broker-service.js";
import type { HostedOAuthAttemptDurableInput } from "./hosted-oauth-broker-store.js";

const method = slackIntegration.authMethods.find((candidate) => candidate.kind === "oauth");
if (!method || method.kind !== "oauth") throw new Error("Slack OAuth is unavailable");
const scopes = method.oauth.scopes.join(",");
const validResponse = {
  ok: true,
  access_token: "synthetic-access",
  token_type: "bot",
  scope: scopes,
  bot_user_id: "U_BOT",
  team: { id: "T_TEAM", name: "Test workspace" },
  authed_user: { id: "U_PERSON", access_token: "must-not-select-user", token_type: "user" },
};

type Row = Omit<
  HostedOAuthAttemptDurableInput,
  "encryptedContext" | "contextKeyVersion" | "launchTicketHash"
> & {
  encryptedContext: Buffer | null;
  contextKeyVersion: number | null;
  launchTicketHash: string | null;
  failureCode: string | null;
  status: "pending" | "launched" | "exchanging" | "held" | "sealed" | "failed" | "denied";
  createdAt: Date;
  updatedAt: Date;
  retryGeneration: number;
  sealedCiphertext: OAuthBrokerSealedEnvelope | null;
};

async function scenario(
  response: object,
  surface: "desktop" | "web" | "native" = "desktop",
  finish?: "app",
  appReturnPort?: number,
) {
  const now = new Date("2026-09-18T21:50:00Z");
  const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
  const deploymentId = createId("deployment");
  const hostInstanceId = createId("hostInstance");
  const attemptId = HostedOAuthAttemptIdSchema.parse(`hoa_${crypto.randomUUID()}`);
  const recipient = generateOAuthBrokerEphemeralKeyPair();
  const binding = {
    activeHostInstanceId: hostInstanceId,
    canonicalOrigin: "http://127.0.0.1:60470",
    hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    id: deploymentId,
    ownerAccountId: accountId,
    reachability: "canonical" as const,
  };
  let row: Row | null = null;
  const current = () => {
    if (!row) throw new Error("Missing attempt");
    return row;
  };
  const fetch = vi.fn(async () => Response.json(response));
  const broker = new HostedOAuthBrokerService({
    applications: [
      { clientId: "slack-client", clientSecret: "slack-secret", provider: "slack", revision: 1 },
    ],
    issuer: new URL("https://accounts.example.test"),
    now: () => now,
    fetch,
    attemptContextEncryptionKey: Buffer.alloc(32, 9).toString("base64url"),
    store: {
      deploymentBinding: vi.fn(async () => binding),
      hasDeploymentAccess: vi.fn(async () => true),
      createAttempt: vi.fn(async (input: HostedOAuthAttemptDurableInput) => {
        if (row?.attemptId === input.attemptId) return row;
        row = {
          ...input,
          createdAt: now,
          updatedAt: now,
          status: "pending",
          failureCode: null,
          retryGeneration: 0,
          sealedCiphertext: null,
        };
        return row;
      }),
      inspectLaunchAttempt: vi.fn(async () => current()),
      launchAttempt: vi.fn(async (input: { launchTicketHash: string }) => {
        if (current().status !== "pending" || current().launchTicketHash !== input.launchTicketHash)
          return null;
        row = { ...current(), status: "launched" };
        return row;
      }),
      callbackAttemptId: vi.fn(async () => current().attemptId),
      claimCallback: vi.fn(
        async (input: {
          stateHash: string;
          provider: string;
          browserBindings: readonly { attemptId: string; hash: string }[];
        }) => {
          const stateHash = input.stateHash;
          if (
            current().status !== "launched" ||
            current().stateHash !== stateHash ||
            current().provider !== input.provider ||
            !input.browserBindings.some(
              (binding) =>
                binding.attemptId === current().attemptId &&
                binding.hash === current().launchTicketHash,
            )
          )
            return null;
          row = { ...current(), status: "exchanging" };
          return row;
        },
      ),
      sealAttempt: vi.fn(
        async (
          _id: string,
          sealedCiphertext: OAuthBrokerSealedEnvelope,
          _now: Date,
          held?: { contextKeyVersion: number; encryptedContext: Buffer; returnProofHash: string },
        ) => {
          row = {
            ...current(),
            status: held ? "held" : "sealed",
            encryptedContext: held?.encryptedContext ?? null,
            contextKeyVersion: held?.contextKeyVersion ?? null,
            sealedCiphertext,
          };
        },
      ),
      failAttempt: vi.fn(async (_id: string, status: "failed" | "denied", failureCode: string) => {
        row = {
          ...current(),
          status,
          failureCode,
          encryptedContext: null,
          contextKeyVersion: null,
        };
      }),
    } as never,
  });
  const request = CreateHostedOAuthAttemptRequestSchema.parse({
    accountSubject: { issuer: "https://accounts.example.test", subject: accountId },
    attemptId,
    authorizationDigest: authorizationDigest(slackIntegration),
    clientSurface: surface,
    ...(finish ? { finish } : {}),
    ...(appReturnPort === undefined ? {} : { appReturnPort }),
    definitionId: slackIntegration.id,
    deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest(binding),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    hostPublicKey: recipient.publicKey,
    provider: "slack",
    providerApplicationRevision: 1,
    returnPath: "/threads/test",
  });
  const created = await broker.createAuthorizationAttempt(
    { credentialHash: "unused", deploymentId, hostInstanceId },
    request,
  );
  const launched = new URL(
    await broker.launchAuthorization(
      accountId,
      attemptId,
      new URL(created.launchUrl).searchParams.get("ticket")!,
    ),
  );
  const state = launched.searchParams.get("state")!;
  expect(current().stateHash).toBe(createHash("sha256").update(state).digest("base64url"));
  const complete = (parameters = new URLSearchParams({ state, code: "synthetic-code" })) =>
    broker.completeAuthorization({
      parameters,
      provider: "slack",
      cookieHeader: `__Secure-opensteer.oauth.${attemptId}=${new URL(created.launchUrl).searchParams.get("ticket")!}`,
    });
  return {
    attemptId,
    authority: { credentialHash: "unused", deploymentId, hostInstanceId },
    request,
    recipient,
    current,
    fetch,
    complete,
    state,
    deploymentId,
    broker,
  };
}

describe("managed provider authorization contract", () => {
  it.each(["desktop", "native"] as const)(
    "holds managed %s consent for its app",
    async (surface) => {
      const s = await scenario(validResponse, surface, "app");
      const result = await s.complete();
      expect(result.status).toBe("held");
      expect(new URL(result.returnUrl!).searchParams.get("return")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(s.broker.metadata()).toHaveProperty("appFinish", 1);
      expect(s.broker.metadata(false)).not.toHaveProperty("appFinish");
    },
  );

  it.each(["desktop", "native"] as const)(
    "returns denied and failed %s consent to the app without a proof",
    async (surface) => {
      for (const error of ["access_denied", "server_error"]) {
        const s = await scenario(validResponse, surface, "app");
        const result = await s.complete(new URLSearchParams({ state: s.state, error }));
        expect(result.status).toBe(error === "access_denied" ? "denied" : "failed");
        expect(new URL(result.returnUrl!).searchParams.has("return")).toBe(false);
        if (surface === "desktop") expect(result.returnKind).toBe("open-app");
        expect(s.fetch).not.toHaveBeenCalled();
      }
    },
  );

  it("seals the port at creation and returns the proof in a form, not an address", async () => {
    const s = await scenario(validResponse, "desktop", "app", 48_203);
    const result = await s.complete();
    expect(result.status).toBe("held");
    const proof = new URL(result.returnUrl!).searchParams.get("return")!;
    expect(result.returnHandoff).toEqual({
      action: "http://127.0.0.1:48203/oauth/integration-callback",
      fields: {
        attempt_id: `ioa_${s.attemptId.slice(4)}`,
        deployment_id: s.deploymentId,
        return: proof,
      },
    });
    expect(s.broker.metadata()).toHaveProperty("appReturnPort", 1);
    expect(s.broker.metadata(false)).not.toHaveProperty("appReturnPort");
  });

  it("keeps a held consent without a port on the app link alone", async () => {
    const s = await scenario(validResponse, "desktop", "app");
    expect(await s.complete()).not.toHaveProperty("returnHandoff");
  });

  it("hands off nothing when consent fails", async () => {
    const s = await scenario(validResponse, "desktop", "app", 48_203);
    const result = await s.complete(
      new URLSearchParams({ state: s.state, error: "access_denied" }),
    );
    expect(result.status).toBe("denied");
    expect(result).not.toHaveProperty("returnHandoff");
  });

  it("refuses a repeated attempt that changes its port", async () => {
    const s = await scenario(validResponse, "desktop", "app", 48_203);
    await expect(
      s.broker.createAuthorizationAttempt(s.authority, { ...s.request, appReturnPort: 48_204 }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("seals an MCP relay's port the same way and returns its own attempt", async () => {
    const s = await scenario(validResponse);
    const uuid = crypto.randomUUID();
    const mcp = {
      serverId: `isv_${crypto.randomUUID()}`,
      issuer: "https://mcp-issuer.example.test/",
      authorizationEndpoint: "https://mcp-issuer.example.test/authorize",
      authorizationResponseIssuerParameterSupported: true,
    };
    const state = "s".repeat(43);
    const authorizationUrl = new URL(mcp.authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      state,
      client_id: "mcp-client",
      redirect_uri: s.broker.callbackUrl("mcp"),
      response_type: "code",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    }).toString();
    const relay = {
      accountSubject: s.request.accountSubject,
      appReturnPort: 48_205,
      attemptId: `hoa_${uuid}`,
      authorizationDigest: "d".repeat(43),
      authorizationUrl: authorizationUrl.toString(),
      clientId: "mcp-client",
      clientSurface: "desktop",
      definitionId: mcp.serverId,
      deploymentAuthorityDigest: s.request.deploymentAuthorityDigest,
      expiresAt: s.request.expiresAt,
      finish: "app",
      hostPublicKey: s.recipient.publicKey,
      mcp,
      provider: "mcp",
      providerApplicationRevision: 1,
    };
    const created = await s.broker.createCallbackRelay(s.authority, relay);
    await expect(
      s.broker.createCallbackRelay(s.authority, { ...relay, appReturnPort: 48_206 }),
    ).rejects.toMatchObject({ code: "conflict" });
    const ticket = new URL(created.launchUrl).searchParams.get("ticket")!;
    await s.broker.launchAuthorization(null, relay.attemptId as never, ticket);
    const result = await s.broker.completeAuthorization({
      cookieHeader: `__Secure-opensteer.oauth.${relay.attemptId}=${ticket}`,
      parameters: new URLSearchParams({ code: "mcp-code", state, iss: mcp.issuer }),
      provider: "mcp",
    });
    expect(result.status).toBe("held");
    expect(result.returnHandoff).toMatchObject({
      action: "http://127.0.0.1:48205/oauth/integration-callback",
      fields: { attempt_id: `imo_${uuid}` },
    });
  });

  it.each([
    ["native", "app"],
    ["desktop", undefined],
    ["web", undefined],
  ] as const)("refuses a port from %s with finish %s", async (surface, finish) => {
    await expect(scenario(validResponse, surface, finish, 48_203)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("refuses app finish from a web client", async () => {
    await expect(scenario(validResponse, "web", "app")).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it.each(["desktop", "web", "native"] as const)(
    "preserves Slack bot and workspace identity for %s",
    async (surface) => {
      const s = await scenario(validResponse, surface);
      const result = await s.complete();
      expect(result.status).toBe("sealed");
      const integrationAttemptId = `ioa_${s.attemptId.slice(4)}`;
      if (surface === "desktop") expect(result.returnUrl).toBeUndefined();
      if (surface === "web")
        expect(result.returnUrl).toBe(
          `http://127.0.0.1:60470/threads/test?integrationAttempt=${integrationAttemptId}`,
        );
      if (surface === "native")
        expect(new URL(result.returnUrl!).searchParams.get("attempt_id")).toBe(
          integrationAttemptId,
        );
      const bundle = OAuthBrokerTokenBundleSchema.parse(
        openOAuthBrokerPayload(s.current().sealedCiphertext!, s.recipient.privateKey, {
          accountSubject: s.request.accountSubject,
          attemptId: s.attemptId,
          authorizationDigest: s.request.authorizationDigest,
          definitionId: s.request.definitionId,
          deploymentAuthorityDigest: s.request.deploymentAuthorityDigest,
          expiresAt: s.request.expiresAt,
          providerApplicationRevision: 1,
          schemaVersion: 1,
        }),
      );
      expect(bundle).toEqual({
        accessToken: "synthetic-access",
        tokenType: "bearer",
        grantedScopes: expect.any(Array),
        tokenResponseIdentity: {
          externalIdentityId: "U_BOT",
          externalTenantId: "T_TEAM",
          displayName: "Test workspace",
        },
      });
      expect(JSON.stringify(bundle)).not.toContain("must-not-select-user");
      await expect(s.complete()).rejects.toThrow();
      expect(s.fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [{ ...validResponse, scope: "" }, "scope-escalation"],
    [{ ...validResponse, bot_user_id: undefined }, "invalid-provider-response"],
    [{ ...validResponse, team: undefined }, "invalid-provider-response"],
    [{ ...validResponse, token_type: "user" }, "invalid-provider-response"],
    [{ ...validResponse, token_type: "bearer" }, "invalid-provider-response"],
    [{ ...validResponse, token_type: "dpop" }, "invalid-provider-response"],
    [{ ok: false, error: "invalid_client" }, "client-rejected"],
    [{ ok: false, error: "invalid_grant" }, "grant-rejected"],
  ] as const)(
    "classifies provider failures without sealing a connection (%j)",
    async (response, failureCode) => {
      const s = await scenario(response);
      expect(await s.complete()).toMatchObject({ status: "failed" });
      expect(s.current()).toMatchObject({ failureCode, sealedCiphertext: null });
    },
  );

  it.each(["server_error", "access_denied"])(
    "keeps callback error semantics for %s",
    async (error) => {
      const s = await scenario(validResponse);
      const result = await s.complete(new URLSearchParams({ state: s.state, error }));
      expect(result.status).toBe(error === "access_denied" ? "denied" : "failed");
      expect(s.fetch).not.toHaveBeenCalled();
    },
  );
});
