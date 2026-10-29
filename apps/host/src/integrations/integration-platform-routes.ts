import { McpOAuthAttemptIdSchema } from "@opensteer/integration-core";
import { WorkspaceIdSchema, type DeploymentId } from "@opensteer/core";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";
import type { HostAuthenticator } from "../identity/auth.js";
import type { IntegrationDashboardService } from "./integration-dashboard-service.js";
import type { IntegrationPlatformService } from "./integration-platform-service.js";
import type { McpOAuthService } from "./mcp-oauth-service.js";
import { registerOAuthCallbackRoute } from "./integration-authorization-routes.js";
import { requireAdministrator, requireSession, requireSurface } from "./integration-rpc-context.js";

export interface IntegrationPlatformRpcOptions {
  readonly authenticator: HostAuthenticator;
  readonly deploymentId?: DeploymentId;
  readonly dashboard: Pick<IntegrationDashboardService, "platformDashboard">;
  readonly platform: IntegrationPlatformService;
  readonly mcpOauth: McpOAuthService;
}

export function createIntegrationPlatformRpcHandlers(
  options: IntegrationPlatformRpcOptions,
): Pick<
  HostApiHandlers,
  | "integration.grants.list"
  | "integration.platform.get"
  | "integration.computer.apps.installed"
  | "integration.computer.session.stop"
  | "integration.computer.setup.list"
  | "integration.computer.policy.get"
> {
  return {
    "integration.computer.policy.get": async (input, context) => {
      const { appApproval } = await options.platform.computerAppApprovals.computerUsePolicy({
        ...input,
        ownerUserId: requireSession(context).user.id,
      });
      return rpcSuccess({ appApproval });
    },
    "integration.computer.apps.installed": async (input, context) =>
      rpcSuccess(
        hostApi["integration.computer.apps.installed"].success.parse(
          await options.platform.computerAppApprovals.installedComputerApps({
            ...input,
            actorUserId: requireSession(context).user.id,
          }),
        ),
      ),
    "integration.computer.session.stop": async (input, context) => {
      await options.platform.computerAppApprovals.stopComputerUseSession({
        actorUserId: requireSession(context).user.id,
        sessionId: input.sessionId,
      });
      return rpcSuccess({});
    },
    "integration.computer.setup.list": async (_input, context) =>
      rpcSuccess({
        requests: [
          ...(await options.platform.store.listComputerAppSetupRequests(
            requireSession(context).user.id,
          )),
        ],
      }),
    "integration.grants.list": async ({ workspaceId }, context) =>
      rpcSuccess(
        hostApi["integration.grants.list"].success.parse({
          grants: await options.platform.store.listGrants({
            ownerUserId: requireSession(context).user.id,
            workspaceId,
          }),
        }),
      ),
    "integration.platform.get": async (_input, context) =>
      rpcSuccess(
        hostApi["integration.platform.get"].success.parse(
          await options.dashboard.platformDashboard(
            requireSession(context).user.id,
            requireSurface(context),
          ),
        ),
      ),
  };
}

export type IntegrationPlatformCommand = Extract<
  HostApiCommand,
  {
    readonly type:
      | "integration.agentPlugin.install"
      | "integration.catalog.install"
      | "integration.computer.setup.set"
      | "integration.computer.approval-key.set"
      | "integration.computer.policy.set"
      | "integration.computer.app.block"
      | "integration.computer.setup.request"
      | "integration.computer.setup.cancel"
      | "integration.grant.create"
      | "integration.grant.revoke"
      | "integration.mcp.authorization.begin"
      | "integration.mcp.disconnect"
      | "integration.remoteMcp.install"
      | "integration.uninstall";
  }
>;

export async function handleIntegrationPlatformCommand(
  options: IntegrationPlatformRpcOptions,
  command: IntegrationPlatformCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const session = requireSession(context);
  switch (command.type) {
    case "integration.computer.policy.set":
      return {
        type: command.type,
        ...(await options.platform.computerAppApprovals.setComputerUsePolicy({
          ...command.input,
          ownerUserId: session.user.id,
          requestId: context.requestId,
        })),
      };
    case "integration.computer.app.block":
      await options.platform.computerAppApprovals.blockComputerApp({
        connectionId: command.connectionId,
        ownerUserId: session.user.id,
        requestId: context.requestId,
      });
      return { type: command.type };
    case "integration.computer.setup.request":
      return {
        type: command.type,
        request: await options.platform.computerAppApprovals.requestComputerAppSetup({
          ...command.input,
          actorUserId: session.user.id,
        }),
      };
    case "integration.computer.setup.cancel":
      await options.platform.computerAppApprovals.cancelComputerAppSetup({
        requestId: command.requestId,
        ownerUserId: session.user.id,
      });
      return { type: command.type };
    case "integration.computer.approval-key.set":
      return {
        type: command.type,
        ...(await options.platform.computerAppApprovals.registerComputerUseApprovalKey({
          ...command.input,
          ownerUserId: session.user.id,
          requestId: context.requestId,
        })),
      };
    case "integration.computer.setup.set": {
      const connection = await options.platform.computerAppApprovals.setComputerConnection({
        ...command.input,
        actorUserId: session.user.id,
        isAdministrator: session.user.instanceRole === "administrator",
        requestId: context.requestId,
      });
      return { connection, type: command.type };
    }
    case "integration.mcp.authorization.begin": {
      const started = await options.mcpOauth.beginAuthorization({
        ...command.input,
        ownerUserId: session.user.id,
        requestSurface: requireSurface(context),
      });
      return {
        attemptId: started.attemptId,
        expiresAt: started.expiresAt.toISOString(),
        launchTicket: started.launchTicket,
        type: command.type,
      };
    }
    case "integration.mcp.disconnect":
      await options.platform.store.revokeMcpOAuthConnection({
        connectionId: command.connectionId,
        ownerUserId: session.user.id,
        requestId: context.requestId,
      });
      return { type: command.type };
    case "integration.agentPlugin.install": {
      requireAdministrator(context);
      const result = await options.platform.installAgentPlugin({
        actorUserId: session.user.id,
        directory: command.input.directory,
        requestId: context.requestId,
        ...(command.input.runnerId ? { runnerId: command.input.runnerId } : {}),
      });
      return hostApi["commands.dispatch"].success.parse({
        issues: result.issues,
        type: command.type,
      });
    }
    case "integration.remoteMcp.install": {
      requireAdministrator(context);
      const installation = await options.platform.installRemoteMcp({
        actorUserId: session.user.id,
        description: command.input.description,
        name: command.input.name,
        requestId: context.requestId,
        title: command.input.title,
        url: command.input.url,
      });
      return { installation, type: command.type };
    }
    case "integration.catalog.install": {
      requireAdministrator(context);
      const installation = await options.platform.installCatalogDefinition({
        actorUserId: session.user.id,
        definitionId: command.input.definitionId,
        digest: command.input.digest,
        requestId: context.requestId,
      });
      return { installation, type: command.type };
    }
    case "integration.uninstall": {
      requireAdministrator(context);
      const outcome = await options.platform.uninstallIntegration({
        actorUserId: session.user.id,
        installationId: command.installationId,
        requestId: context.requestId,
      });
      return { ...outcome, type: command.type };
    }
    case "integration.grant.create": {
      const input = command.input;
      const grant = await options.platform.createGrant({
        access: input.access,
        alias: input.alias,
        connectionId: input.connectionId,
        createdBy: session.user.id,
        installationId: input.installationId,
        isDefault: input.isDefault,
        ownerUserId: session.user.id,
        workspaceId: WorkspaceIdSchema.parse(input.workspaceId),
      });
      return { grant, type: command.type };
    }
    case "integration.grant.revoke":
      await options.platform.revokeGrant({
        grantId: command.grantId,
        ownerUserId: session.user.id,
        requestId: context.requestId,
        workspaceId: command.workspaceId,
      });
      return { type: command.type };
  }
}

export function registerIntegrationPlatformRoutes(
  app: FastifyInstance,
  options: IntegrationPlatformRpcOptions,
): void {
  app.get("/v1/integration-platform/mcp-oauth/client-metadata.json", (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=3600")
      .header("content-type", "application/json")
      .send(options.mcpOauth.clientMetadataDocument()),
  );

  registerOAuthCallbackRoute(app, {
    attemptIdSchema: McpOAuthAttemptIdSchema,
    authenticator: options.authenticator,
    ...(options.deploymentId ? { deploymentId: options.deploymentId } : {}),
    handle: ({ attemptId, browserBinding, parameters, state }) =>
      options.mcpOauth.handleAuthorizationCallback({
        attemptId,
        browserBinding,
        parameters,
        state,
      }),
    identify: (state) => options.mcpOauth.identifyAuthorizationCallback(state),
    kind: "mcp",
    path: "/v1/integration-platform/mcp-oauth/callback",
    prepare: () => undefined,
  });
}
