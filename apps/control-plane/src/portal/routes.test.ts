import {
  AccountLinkGenerationSchema,
  ActivatePersonalHostAccountLinkResponseSchema,
  CancelPersonalHostAccountLinkOperationResponseSchema,
  ConnectOperationIdSchema,
  PersonalHostAccountLinkChallengeIdSchema,
  PersonalHostAccountLinkOperationIdSchema,
  RevokeConnectResponseSchema,
  UnlinkPersonalHostResponseSchema,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerControlPlaneRoutes } from "./routes.js";
import type { HostAuthority } from "../database/store.js";

describe("Host-authorized control-plane routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("derives Connect revocation authority from the Host credential", async () => {
    const authority: HostAuthority = {
      credentialHash: "host-credential-hash",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    };
    const request = {
      hostInstanceId: authority.hostInstanceId,
      operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
    };
    const response = RevokeConnectResponseSchema.parse({
      generation: 8,
      revoked: true,
    });
    const authenticateHostCredential = vi.fn(async () => authority);
    const revokeForHost = vi.fn(async () => response);
    const accountAuthenticate = vi.fn(async () => {
      throw new Error("Account authentication must not authorize a Host route");
    });
    const app = Fastify();
    apps.push(app);
    registerControlPlaneRoutes(app, {
      authenticator: { authenticate: accountAuthenticate } as never,
      connectLifecycle: { revokeForHost } as never,
      managedDeploymentDomain: "managed.opensteer.test",
      publicOrigin: new URL("https://accounts.opensteer.test"),
      store: { authenticateHostCredential } as never,
    });

    const result = await app.inject({
      headers: {
        authorization: `Bearer osc_${"a".repeat(43)}`,
        "content-type": "application/json",
      },
      method: "DELETE",
      payload: request,
      url: "/v1/host/connect",
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(response);
    expect(authenticateHostCredential).toHaveBeenCalledWith(`Bearer osc_${"a".repeat(43)}`);
    expect(revokeForHost).toHaveBeenCalledWith(authority, request);
    expect(accountAuthenticate).not.toHaveBeenCalled();
  });

  it("rejects an invalid Host revoke request before the lifecycle runs", async () => {
    const authority: HostAuthority = {
      credentialHash: "host-credential-hash",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    };
    const revokeForHost = vi.fn();
    const app = Fastify();
    app.setErrorHandler((_error, _request, reply) => reply.status(400).send());
    apps.push(app);
    registerControlPlaneRoutes(app, {
      authenticator: { authenticate: vi.fn() } as never,
      connectLifecycle: { revokeForHost } as never,
      managedDeploymentDomain: "managed.opensteer.test",
      publicOrigin: new URL("https://accounts.opensteer.test"),
      store: { authenticateHostCredential: vi.fn(async () => authority) } as never,
    });

    const result = await app.inject({
      headers: {
        authorization: `Bearer osc_${"a".repeat(43)}`,
        "content-type": "application/json",
      },
      method: "DELETE",
      payload: {},
      url: "/v1/host/connect",
    });

    expect(result.statusCode).toBe(400);
    expect(revokeForHost).not.toHaveBeenCalled();
  });

  it("lets the Personal link authority authenticate exact Host activation", async () => {
    const authority: HostAuthority = {
      credentialHash: "host-credential-hash",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    };
    const body = {
      challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
      linkGeneration: AccountLinkGenerationSchema.parse("g".repeat(43)),
    };
    const response = ActivatePersonalHostAccountLinkResponseSchema.parse({
      activated: true,
      deploymentId: authority.deploymentId,
      linkGeneration: body.linkGeneration,
    });
    const authenticateHostCredential = vi.fn();
    const activateLink = vi.fn(async () => response);
    const app = Fastify();
    apps.push(app);
    registerControlPlaneRoutes(app, {
      authenticator: { authenticate: vi.fn() } as never,
      connectLifecycle: {} as never,
      managedDeploymentDomain: "managed.opensteer.test",
      personalRemoteAccount: { activateLink } as never,
      publicOrigin: new URL("https://accounts.opensteer.test"),
      store: {
        authenticateHostCredential,
      } as never,
    });

    const result = await app.inject({
      headers: { authorization: `Bearer osc_${"a".repeat(43)}` },
      method: "POST",
      payload: body,
      url: "/v1/host/personal-account-link/activate",
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(response);
    expect(activateLink).toHaveBeenCalledWith(`Bearer osc_${"a".repeat(43)}`, body);
    expect(authenticateHostCredential).not.toHaveBeenCalled();
  });

  it("cancels a pre-activation link operation with Account authority", async () => {
    const accountId = `acct_${crypto.randomUUID()}` as const;
    const operationId = PersonalHostAccountLinkOperationIdSchema.parse(
      `plo_${crypto.randomUUID()}`,
    );
    const response = CancelPersonalHostAccountLinkOperationResponseSchema.parse({
      cancelled: true,
      operationId,
    });
    const authenticate = vi.fn(async () => ({ accountId }));
    const cancelLinkOperation = vi.fn(async () => response);
    const app = Fastify();
    apps.push(app);
    registerControlPlaneRoutes(app, {
      authenticator: { authenticate } as never,
      connectLifecycle: {} as never,
      managedDeploymentDomain: "managed.opensteer.test",
      personalRemoteAccount: { cancelLinkOperation } as never,
      publicOrigin: new URL("https://accounts.opensteer.test"),
      store: {} as never,
    });

    const result = await app.inject({
      method: "DELETE",
      url: `/v1/account/personal-host-link-operations/${operationId}`,
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(response);
    expect(cancelLinkOperation).toHaveBeenCalledWith(accountId, {
      operationId,
    });
    expect(authenticate).toHaveBeenCalledWith(expect.any(Headers), {
      mutation: true,
      scope: "deployments:write",
    });
  });

  it("lets the Personal link authority cancel or delete the exact Host link", async () => {
    const body = {
      challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
      linkGeneration: AccountLinkGenerationSchema.parse("g".repeat(43)),
    };
    const authenticateHostCredential = vi.fn();
    const response = UnlinkPersonalHostResponseSchema.parse({
      deploymentId: createId("deployment"),
      unlinked: true,
    });
    const unlinkPersonalHost = vi.fn(async () => response);
    const app = Fastify();
    apps.push(app);
    registerControlPlaneRoutes(app, {
      authenticator: { authenticate: vi.fn() } as never,
      connectLifecycle: {} as never,
      managedDeploymentDomain: "managed.opensteer.test",
      personalRemoteAccount: { unlinkPersonalHost } as never,
      publicOrigin: new URL("https://accounts.opensteer.test"),
      store: {
        authenticateHostCredential,
      } as never,
    });

    const result = await app.inject({
      headers: { authorization: `Bearer osc_${"a".repeat(43)}` },
      method: "DELETE",
      payload: body,
      url: "/v1/host/personal-account-link",
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(response);
    expect(unlinkPersonalHost).toHaveBeenCalledWith(`Bearer osc_${"a".repeat(43)}`, body);
    expect(authenticateHostCredential).not.toHaveBeenCalled();
  });
});

describe("Account directory routes", () => {
  it("removes only the authenticated Account's listing", async () => {
    const deploymentId = createId("deployment");
    const accountId = `acct_${crypto.randomUUID()}`;
    const authenticate = vi.fn(async () => ({ accountId }));
    const removeDeploymentFromDirectory = vi.fn(async () => undefined);
    const app = Fastify();
    registerControlPlaneRoutes(app, {
      authenticator: { authenticate } as never,
      connectLifecycle: {} as never,
      managedDeploymentDomain: "managed.opensteer.test",
      publicOrigin: new URL("https://accounts.opensteer.test"),
      store: { removeDeploymentFromDirectory } as never,
    });

    const result = await app.inject({
      headers: { authorization: `Bearer ${"a".repeat(32)}` },
      method: "DELETE",
      url: `/v1/account/deployments/${deploymentId}`,
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ deploymentId, removed: true });
    expect(authenticate).toHaveBeenCalledWith(expect.anything(), {
      mutation: true,
      scope: "deployments:write",
    });
    expect(removeDeploymentFromDirectory).toHaveBeenCalledWith(accountId, deploymentId);
    await app.close();
  });
});
