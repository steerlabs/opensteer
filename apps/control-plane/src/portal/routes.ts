import {
  AcknowledgeHostAccountAdoptionRequestSchema,
  AcknowledgeHostAccountAdoptionResponseSchema,
  AdoptExistingDeploymentRequestSchema,
  AdoptExistingDeploymentResponseSchema,
  ConnectProjectionRequestSchema,
  ConnectProjectionResponseSchema,
  ControlPlaneAccountIdSchema,
  DeleteAccountResponseSchema,
  IssueAccountHostSessionGrantResponseSchema,
  DirectoryProjectionRequestSchema,
  DirectoryProjectionResponseSchema,
  HostAccountAdoptionProofIdSchema,
  ListAccountDeploymentsResponseSchema,
  RevokeAccountSessionsResponseSchema,
  RemoveAccountDeploymentResponseSchema,
  ProvisionConnectRequestSchema,
  PublishHostAuthorityRequestSchema,
  PublishHostAuthorityResponseSchema,
  ConnectCredentialResponseSchema,
  RotateConnectCredentialRequestSchema,
  RevokeConnectRequestSchema,
  RevokeConnectResponseSchema,
  ActivatePersonalHostAccountLinkRequestSchema,
  ActivatePersonalHostAccountLinkResponseSchema,
  CancelPersonalHostAccountLinkOperationResponseSchema,
  CompletePersonalHostAccountLinkRequestSchema,
  CompletePersonalHostAccountLinkResponseSchema,
  IssuePersonalHostAccountLinkChallengeRequestSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  IssuePersonalAccountHostSessionGrantRequestSchema,
  PersonalHostAccountLinkChallengeIdSchema,
  PersonalHostAccountLinkOperationIdSchema,
  UnlinkPersonalHostRequestSchema,
  UnlinkPersonalHostResponseSchema,
  UpdateAccountDeploymentNameRequestSchema,
  UpdateAccountDeploymentNameResponseSchema,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema } from "@opensteer/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuthenticator } from "../auth/auth.js";
import type { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import { ControlPlaneError } from "../server/errors.js";
import type { ControlPlaneStore } from "../database/store.js";
import type { PersonalRemoteAccountService } from "../account/personal-remote-account.js";

const DeploymentParamsSchema = z.strictObject({ deploymentId: DeploymentIdSchema });
const AdoptionParamsSchema = z.strictObject({ proofId: HostAccountAdoptionProofIdSchema });
const PersonalLinkParamsSchema = z.strictObject({
  challengeId: PersonalHostAccountLinkChallengeIdSchema,
});
const PersonalLinkOperationParamsSchema = z.strictObject({
  operationId: PersonalHostAccountLinkOperationIdSchema,
});
const EdgeTlsAllowQuerySchema = z.strictObject({ domain: z.string().min(1).max(254) });

export function registerControlPlaneRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly authenticator: ControlPlaneAuthenticator;
    readonly connectLifecycle: ConnectLifecycleService;
    readonly managedDeploymentDomain: string;
    readonly personalRemoteAccount?: PersonalRemoteAccountService;
    readonly publicOrigin: URL;
    readonly store: ControlPlaneStore;
  },
): void {
  const managedDeploymentDomain = normalizedBareDnsHostname(dependencies.managedDeploymentDomain);
  app.get("/v1/edge/tls-allow", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    const { domain: input } = EdgeTlsAllowQuerySchema.parse(request.query);
    const domain = normalizedBareDnsHostname(input);
    const allowed =
      domain === dependencies.publicOrigin.hostname.toLowerCase() ||
      domain === managedDeploymentDomain ||
      (await dependencies.store.hasActiveDeploymentOrigin(`https://${domain}`));
    if (!allowed) return reply.code(404).type("text/plain; charset=utf-8").send("not found");
    return reply.type("text/plain; charset=utf-8").send("ok");
  });

  app.get("/v1/account/deployments", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      scope: "deployments:read",
    });
    void reply.header("cache-control", "no-store");
    return ListAccountDeploymentsResponseSchema.parse({
      deployments: await dependencies.store.listDeployments(principal.accountId),
    });
  });

  app.delete("/v1/account/deployments/:deploymentId", async (request, reply) => {
    const { deploymentId } = DeploymentParamsSchema.parse(request.params);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    await dependencies.store.removeDeploymentFromDirectory(principal.accountId, deploymentId);
    void reply.header("cache-control", "no-store");
    return RemoveAccountDeploymentResponseSchema.parse({ deploymentId, removed: true });
  });

  app.put("/v1/account/deployments/:deploymentId/name", async (request, reply) => {
    const { deploymentId } = DeploymentParamsSchema.parse(request.params);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    void reply.header("cache-control", "no-store");
    const body = UpdateAccountDeploymentNameRequestSchema.parse(request.body);
    return UpdateAccountDeploymentNameResponseSchema.parse({
      deployment: await dependencies.store.renamePersonalDeployment(
        principal.accountId,
        deploymentId,
        body.name,
      ),
    });
  });

  app.post("/v1/account/deployment-adoptions", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    const response = await dependencies.store.adoptExistingDeployment(
      principal.accountId,
      AdoptExistingDeploymentRequestSchema.parse(request.body),
    );
    void reply.code(201).header("cache-control", "no-store");
    return AdoptExistingDeploymentResponseSchema.parse(response);
  });

  app.post("/v1/account/personal-host-links/challenges", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    const service = requirePersonalRemoteAccount(dependencies.personalRemoteAccount);
    const response = await service.issueLinkChallenge(
      principal.accountId,
      IssuePersonalHostAccountLinkChallengeRequestSchema.parse(request.body),
    );
    void reply.code(201).header("cache-control", "no-store");
    return IssuePersonalHostAccountLinkChallengeResponseSchema.parse(response);
  });

  app.post("/v1/account/personal-host-links/:challengeId/complete", async (request, reply) => {
    const { challengeId } = PersonalLinkParamsSchema.parse(request.params);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    const service = requirePersonalRemoteAccount(dependencies.personalRemoteAccount);
    const body = CompletePersonalHostAccountLinkRequestSchema.parse(request.body);
    if (body.proof.document.challenge.id !== challengeId) {
      throw new ControlPlaneError(
        "bad_request",
        "Account-link challenge path does not match proof",
      );
    }
    const response = await service.completeLink(principal.accountId, body);
    void reply.code(201).header("cache-control", "no-store");
    return CompletePersonalHostAccountLinkResponseSchema.parse(response);
  });

  app.delete("/v1/account/personal-host-link-operations/:operationId", async (request, reply) => {
    const { operationId } = PersonalLinkOperationParamsSchema.parse(request.params);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    const service = requirePersonalRemoteAccount(dependencies.personalRemoteAccount);
    const response = await service.cancelLinkOperation(principal.accountId, {
      operationId,
    });
    void reply.header("cache-control", "no-store");
    return CancelPersonalHostAccountLinkOperationResponseSchema.parse(response);
  });

  app.post(
    "/v1/account/deployments/:deploymentId/personal-session-grants",
    async (request, reply) => {
      const { deploymentId } = DeploymentParamsSchema.parse(request.params);
      const principal = await dependencies.authenticator.authenticate(
        toWebHeaders(request.headers),
        { mutation: true, scope: "deployments:read" },
      );
      const service = requirePersonalRemoteAccount(dependencies.personalRemoteAccount);
      const grantRequest = IssuePersonalAccountHostSessionGrantRequestSchema.parse(request.body);
      // A browser grant is the portal's own redirect and carries the portal
      // origin it was rendered on; it is minted by the portal, never asked for
      // over this API. The application surfaces hold an Account credential of
      // their own, so they may.
      if (grantRequest.clientSurface === "browser") {
        throw new ControlPlaneError(
          "forbidden",
          "Browser Host session grants are issued only by the Account portal",
        );
      }
      const response = await service.issueSessionGrant(
        principal.accountId,
        deploymentId,
        grantRequest,
      );
      void reply.header("cache-control", "no-store");
      return IssueAccountHostSessionGrantResponseSchema.parse(response);
    },
  );

  app.put("/v1/account/deployments/:deploymentId/connect", async (request, reply) => {
    const { deploymentId } = DeploymentParamsSchema.parse(request.params);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    const response = await dependencies.connectLifecycle.provision(
      principal.accountId,
      deploymentId,
      ProvisionConnectRequestSchema.parse(request.body),
    );
    void reply.header("cache-control", "no-store");
    return ConnectCredentialResponseSchema.parse(response);
  });

  app.post(
    "/v1/account/deployments/:deploymentId/connect/credential/rotate",
    async (request, reply) => {
      const { deploymentId } = DeploymentParamsSchema.parse(request.params);
      const principal = await dependencies.authenticator.authenticate(
        toWebHeaders(request.headers),
        { mutation: true, scope: "deployments:write" },
      );
      const response = await dependencies.connectLifecycle.rotateCredential(
        principal.accountId,
        deploymentId,
        RotateConnectCredentialRequestSchema.parse(request.body),
      );
      void reply.header("cache-control", "no-store");
      return ConnectCredentialResponseSchema.parse(response);
    },
  );

  app.delete("/v1/account/deployments/:deploymentId/connect", async (request, reply) => {
    const { deploymentId } = DeploymentParamsSchema.parse(request.params);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    const response = await dependencies.connectLifecycle.revoke(
      principal.accountId,
      deploymentId,
      RevokeConnectRequestSchema.parse(request.body),
    );
    void reply.header("cache-control", "no-store");
    return RevokeConnectResponseSchema.parse(response);
  });

  app.delete("/v1/host/connect", async (request, reply) => {
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    const response = await dependencies.connectLifecycle.revokeForHost(
      authority,
      RevokeConnectRequestSchema.parse(request.body),
    );
    void reply.header("cache-control", "no-store");
    return RevokeConnectResponseSchema.parse(response);
  });

  app.put("/v1/host/authority", async (request, reply) => {
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    const response = await dependencies.store.publishHostAuthority(
      authority,
      PublishHostAuthorityRequestSchema.parse(request.body),
    );
    void reply.header("cache-control", "no-store");
    return PublishHostAuthorityResponseSchema.parse(response);
  });

  app.put("/v1/host/directory/:accountId", async (request, reply) => {
    const { accountId } = z
      .strictObject({ accountId: ControlPlaneAccountIdSchema })
      .parse(request.params);
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    const response = await dependencies.store.projectDirectoryEntry(
      authority,
      accountId,
      DirectoryProjectionRequestSchema.parse(request.body),
    );
    void reply.header("cache-control", "no-store");
    return DirectoryProjectionResponseSchema.parse(response);
  });

  app.delete("/v1/host/personal-account-link", async (request, reply) => {
    const service = requirePersonalRemoteAccount(dependencies.personalRemoteAccount);
    const response = await service.unlinkPersonalHost(
      firstHeader(request.headers.authorization),
      UnlinkPersonalHostRequestSchema.parse(request.body),
    );
    void reply.header("cache-control", "no-store");
    return UnlinkPersonalHostResponseSchema.parse(response);
  });

  app.post("/v1/host/personal-account-link/activate", async (request, reply) => {
    const body = ActivatePersonalHostAccountLinkRequestSchema.parse(request.body);
    const service = requirePersonalRemoteAccount(dependencies.personalRemoteAccount);
    const response = await service.activateLink(firstHeader(request.headers.authorization), body);
    void reply.header("cache-control", "no-store");
    return ActivatePersonalHostAccountLinkResponseSchema.parse(response);
  });

  app.put("/v1/host/connect", async (request, reply) => {
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    const response = await dependencies.store.projectConnect(
      authority,
      ConnectProjectionRequestSchema.parse(request.body),
    );
    void reply.header("cache-control", "no-store");
    return ConnectProjectionResponseSchema.parse(response);
  });

  app.post("/v1/host/account-adoptions/:proofId/acknowledge", async (request, reply) => {
    const { proofId } = AdoptionParamsSchema.parse(request.params);
    AcknowledgeHostAccountAdoptionRequestSchema.parse(request.body);
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    await dependencies.store.acknowledgeAccountAdoption(authority, proofId);
    void reply.header("cache-control", "no-store");
    return AcknowledgeHostAccountAdoptionResponseSchema.parse({
      acknowledged: true,
      proofId,
    });
  });

  app.delete("/v1/account/sessions", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "account:delete",
    });
    await dependencies.store.revokeAccountSessions(principal.accountId);
    void reply.header("cache-control", "no-store");
    return RevokeAccountSessionsResponseSchema.parse({ revoked: true });
  });

  app.delete("/v1/account", async (request, reply) => {
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      fresh: true,
      mutation: true,
      scope: "account:delete",
    });
    await dependencies.store.deleteAccount(principal.accountId);
    void reply.header("cache-control", "no-store");
    return DeleteAccountResponseSchema.parse({ deleted: true });
  });
}

function requirePersonalRemoteAccount(
  service: PersonalRemoteAccountService | undefined,
): PersonalRemoteAccountService {
  if (!service) {
    throw new ControlPlaneError(
      "unavailable",
      "Personal Host Account linking is not configured on this control plane",
    );
  }
  return service;
}

export function toWebHeaders(input: Readonly<Record<string, unknown>>): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, String(value));
    } else {
      headers.set(name, String(raw));
    }
  }
  return headers;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function normalizedBareDnsHostname(value: string): string {
  const lowered = value.toLowerCase();
  const domain = lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
  if (
    !domain ||
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(
      domain,
    )
  ) {
    throw new ControlPlaneError("bad_request", "Domain must be a bare DNS hostname");
  }
  return domain;
}
