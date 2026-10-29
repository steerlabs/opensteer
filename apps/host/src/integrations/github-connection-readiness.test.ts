import { createId } from "@opensteer/core";
import { githubIntegration } from "@opensteer/integration-catalog";
import {
  createIntegrationId,
  IntegrationConnectionSummarySchema,
} from "@opensteer/integration-core";
import type { IntegrationConnectionSecretRecord } from "@opensteer/integration-core/ports";
import { authorizationDigest } from "@opensteer/integration-core/digest";
import { describe, expect, it, vi } from "vitest";
import { IntegrationService } from "./integration-service.js";

function fixture() {
  const ownerUserId = createId("user");
  const connectionId = createIntegrationId("connection");
  const applicationId = createIntegrationId("providerApplication");
  const source = {
    kind: "deployment-oauth" as const,
    callbackUrl: "https://host.example/v1/integrations/github/callback",
    providerApplicationId: applicationId,
    providerApplicationRevision: 1,
  };
  let record: IntegrationConnectionSecretRecord = {
    connection: IntegrationConnectionSummarySchema.parse({
      id: connectionId,
      provider: "github",
      definitionId: "github",
      authMethodId: "github-app",
      connectionMethod: "managed-oauth",
      applicationSource: source,
      authorizationDigest: authorizationDigest(githubIntegration),
      computer: null,
      accountIdentifier: "user",
      displayName: "user",
      externalIdentityId: "1",
      externalTenantId: null,
      providerApplicationId: applicationId,
      grantedScopes: [],
      status: "needs-attention",
      statusDetail: "Choose repositories.",
      statusReason: "permissions",
      createdAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T00:00:00Z",
    }),
    credentialGeneration: 3,
    encryptedCredential: Buffer.from("credential"),
    encryptionKeyVersion: 1,
    providerApplication: {
      id: applicationId,
      provider: "github",
      clientId: "client",
      displayName: "Own GitHub app",
      ownerUserId,
      revision: 1,
      status: "active",
      createdAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T00:00:00Z",
      installationUrl: "https://github.com/apps/own-app/installations/new",
      encryptedSecrets: Buffer.from("app"),
      encryptionKeyVersion: 1,
    },
  };
  const getConnectionForRevocation = vi.fn(async () => record);
  const markConnectionNeedsAttention = vi.fn(async () => undefined);
  const setConnectionRepositoryAccess = vi.fn(async () => true);
  const replaceConnectionCredential = vi.fn(async () => {
    record = { ...record, credentialGeneration: record.credentialGeneration + 1 };
    return true;
  });
  const open = vi.fn(async () => ({
    accessToken: "token",
    refreshToken: "refresh",
    clientSecret: "client-secret",
    expiresAt: "9999999999999",
  }));
  const onConnectionConnected = vi.fn(async () => undefined);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    Response.json(
      String(url).includes("/repositories?")
        ? { total_count: 2 }
        : {
            total_count: 1,
            installations: [
              {
                id: 123,
                account: { login: "company" },
                repository_selection: "selected",
                suspended_at: null,
                html_url: "https://github.com/organizations/company/settings/installations/123",
              },
            ],
          },
    ),
  );
  const service = new IntegrationService({
    attempts: {} as never,
    definitions: [githubIntegration],
    deploymentPosture: async () => "independent-self-hosted",
    fetch,
    onConnectionConnected,
    publicUrl: new URL("https://host.example"),
    repository: {
      getConnectionForRevocation,
      markConnectionNeedsAttention,
      setConnectionRepositoryAccess,
      replaceConnectionCredential,
    } as never,
    vault: {
      open,
      seal: vi.fn(async () => ({ envelope: Buffer.from("rotated"), keyVersion: 1 })),
    } as never,
  });
  const authorization = vi.spyOn(service, "providerAuthorizations").mockResolvedValue({
    github: {
      availableSources: [source],
      selectedSource: source,
      selectedSourceKind: "deployment-oauth",
      code: "READY",
      detail: "Ready",
      hostedOAuthStatus: "unsupported",
    },
  });
  return {
    service,
    open,
    replaceConnectionCredential,
    input: { connectionId, ownerUserId },
    getConnectionForRevocation,
    markConnectionNeedsAttention,
    setConnectionRepositoryAccess,
    onConnectionConnected,
    fetch,
    authorization,
    changeRecord: (
      change: (value: IntegrationConnectionSecretRecord) => IntegrationConnectionSecretRecord,
    ) => {
      record = change(record);
    },
  };
}

describe("GitHub connection readiness", () => {
  it("refreshes an expired setup credential before inspection and fences the new generation", async () => {
    const f = fixture();
    f.open.mockResolvedValue({
      accessToken: "expired",
      refreshToken: "refresh",
      clientSecret: "client-secret",
      expiresAt: "0",
    });
    const inspections = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, options) =>
      String(url).includes("/login/oauth/access_token")
        ? Response.json({
            access_token: "rotated",
            refresh_token: "rotated-refresh",
            token_type: "bearer",
            scope: "",
            expires_in: 28800,
          })
        : inspections(url, options),
    );
    await expect(f.service.checkRepositoryAccess(f.input)).resolves.toMatchObject({ ready: true });
    expect(f.replaceConnectionCredential).toHaveBeenCalledWith(
      expect.objectContaining({ allowNeedsAttention: true, expectedGeneration: 3 }),
    );
    expect(f.setConnectionRepositoryAccess).toHaveBeenCalledWith(
      expect.objectContaining({ expectedGeneration: 4 }),
    );
  });

  it("checks the owned credential and promotes only after verified repositories, fenced by generation/status", async () => {
    const f = fixture();
    const result = await f.service.checkRepositoryAccess(f.input);
    expect(f.getConnectionForRevocation).toHaveBeenCalledWith(f.input);
    expect(result).toMatchObject({
      ready: true,
      installationUrl: "https://github.com/apps/own-app/installations/new",
    });
    expect(f.setConnectionRepositoryAccess).toHaveBeenCalledWith({
      ...f.input,
      expectedApplicationSource: expect.objectContaining({ kind: "deployment-oauth" }),
      expectedGeneration: 3,
      expectedStatus: "needs-attention",
      expectedStatusDetail: "Choose repositories.",
      status: "connected",
      statusDetail: null,
      statusReason: null,
    });
    expect(f.onConnectionConnected).toHaveBeenCalledExactlyOnceWith(f.input);
  });
  it("keeps an account without installations unavailable to agents", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(Response.json({ total_count: 0, installations: [] }));
    expect(await f.service.checkRepositoryAccess(f.input)).toMatchObject({ ready: false });
    expect(f.setConnectionRepositoryAccess).toHaveBeenCalledWith(
      expect.objectContaining({ status: "needs-attention", statusReason: "permissions" }),
    );
    expect(f.onConnectionConnected).not.toHaveBeenCalled();
  });
  it.each(["revoked", "paused", "pending"] as const)(
    "does not inspect a %s connection",
    async (status) => {
      const f = fixture();
      f.changeRecord((r) => ({ ...r, connection: { ...r.connection, status } }));
      await expect(f.service.checkRepositoryAccess(f.input)).rejects.toThrow(/not found/);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it("refuses a changed authorization digest or app source before exposing a token", async () => {
    const f = fixture();
    f.changeRecord((r) => ({
      ...r,
      connection: { ...r.connection, authorizationDigest: "changed" },
    }));
    await expect(f.service.checkRepositoryAccess(f.input)).rejects.toThrow(
      /changed how this service connects/,
    );
    expect(f.fetch).not.toHaveBeenCalled();
    const other = fixture();
    other.authorization.mockResolvedValue({});
    await expect(other.service.checkRepositoryAccess(other.input)).rejects.toThrow();
    expect(other.fetch).not.toHaveBeenCalled();
    // The dashboard already reports an account whose app is gone as needing a
    // sign-in, and the app may return, so that refusal records nothing.
    expect(other.markConnectionNeedsAttention).not.toHaveBeenCalled();
  });
  // The ways it could fail: a refusal only a new sign-in can fix leaves the
  // account waiting for repositories, so Settings keeps offering a check that
  // is refused again and never Reconnect; the record is written without its
  // generation, so refusing a token a newer sign-in replaced sends that
  // sign-in back; a refreshed token's refusal is fenced to the token before
  // it; the check reports access or resumes the agent anyway.
  it.each([
    [
      "its authorization changed",
      (f: ReturnType<typeof fixture>) =>
        f.changeRecord((r) => ({
          ...r,
          connection: { ...r.connection, authorizationDigest: "changed" },
        })),
      "Opensteer changed how this service connects. Reconnect this account to keep using it.",
    ],
    [
      "its token expiry is unreadable",
      (f: ReturnType<typeof fixture>) =>
        f.open.mockResolvedValue({ accessToken: "token", expiresAt: "soon" } as never),
      "The provider token expiry is invalid; reconnect this account.",
    ],
    [
      "GitHub refuses its token",
      (f: ReturnType<typeof fixture>) =>
        f.fetch.mockResolvedValue(new Response(null, { status: 401 })),
      "GitHub REST rejected the saved sign-in",
    ],
  ])("sends the account to sign in again when %s", async (_case, arrange, statusDetail) => {
    const f = fixture();
    arrange(f);
    await expect(f.service.checkRepositoryAccess(f.input)).rejects.toThrow(statusDetail);
    expect(f.markConnectionNeedsAttention).toHaveBeenCalledExactlyOnceWith({
      ...f.input,
      expectedGeneration: 3,
      statusDetail,
    });
    expect(f.setConnectionRepositoryAccess).not.toHaveBeenCalled();
    expect(f.onConnectionConnected).not.toHaveBeenCalled();
  });
  it("fences GitHub's refusal of a refreshed token to that token", async () => {
    const f = fixture();
    f.open.mockResolvedValue({
      accessToken: "expired",
      refreshToken: "refresh",
      clientSecret: "client-secret",
      expiresAt: "0",
    });
    f.fetch.mockImplementation(async (url) =>
      String(url).includes("/login/oauth/access_token")
        ? Response.json({
            access_token: "rotated",
            refresh_token: "rotated-refresh",
            token_type: "bearer",
            scope: "",
            expires_in: 28800,
          })
        : new Response(null, { status: 401 }),
    );
    await expect(f.service.checkRepositoryAccess(f.input)).rejects.toThrow(
      "GitHub REST rejected the saved sign-in",
    );
    expect(f.markConnectionNeedsAttention).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedGeneration: 4 }),
    );
  });
  it("does not resume the agent if disconnect or refresh won the readiness write", async () => {
    const f = fixture();
    f.setConnectionRepositoryAccess.mockResolvedValue(false);
    await expect(f.service.checkRepositoryAccess(f.input)).rejects.toThrow(/changed/);
    expect(f.onConnectionConnected).not.toHaveBeenCalled();
  });
  // The way it could fail: a passing failure (offline, GitHub erring, limiting
  // or asking for organization approval) takes the repository step away.
  it.each([
    ["offline", () => Promise.reject(new Error("offline")), "offline"],
    ["HTTP 403", async () => new Response(null, { status: 403 }), "GitHub refused"],
    ["HTTP 429", async () => new Response(null, { status: 429 }), "could not be checked"],
    ["HTTP 503", async () => new Response(null, { status: 503 }), "could not be checked"],
  ] as const)("does not change durable status when GitHub is %s", async (_case, answer, error) => {
    const f = fixture();
    f.fetch.mockImplementation(answer);
    await expect(f.service.checkRepositoryAccess(f.input)).rejects.toThrow(error);
    expect(f.setConnectionRepositoryAccess).not.toHaveBeenCalled();
    expect(f.markConnectionNeedsAttention).not.toHaveBeenCalled();
  });
  it("does not emit a second connection event for an already-connected account", async () => {
    const f = fixture();
    f.changeRecord((r) => ({
      ...r,
      connection: { ...r.connection, status: "connected", statusDetail: null, statusReason: null },
    }));
    await f.service.checkRepositoryAccess(f.input);
    expect(f.onConnectionConnected).not.toHaveBeenCalled();
  });
});
