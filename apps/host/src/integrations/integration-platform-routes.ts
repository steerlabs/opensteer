import {
  executeIntegrationAdministration,
  isIntegrationAdministrationCommand,
} from "./integration-administration.js";
import {
  ComputerAppSetupRequestViewSchema,
  McpOAuthAttemptIdSchema,
  localMcpLaunchSecrets,
} from "@opensteer/integration-core";
import { OpensteerError, WorkspaceIdSchema, type DeploymentId, type UserId } from "@opensteer/core";
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
  readonly pluginsChanged?: (viewers: readonly UserId[]) => void;
}

export function createIntegrationPlatformRpcHandlers(
  options: IntegrationPlatformRpcOptions,
): Pick<
  HostApiHandlers,
  | "integration.grants.list"
  | "specialist.list"
  | "plugin.list"
  | "integration.platform.get"
  | "integration.computer.apps.installed"
  | "integration.computer.session.stop"
  | "integration.computer.setup.review"
  | "integration.computer.setup.list"
  | "integration.computer.policy.get"
  | "integration.server.secrets.list"
> {
  return {
    "specialist.list": async (input, context) =>
      rpcSuccess({
        specialists: await options.platform.store.specialists.list(
          input.workspaceId,
          requireSession(context).user.id,
        ),
      }),
    "plugin.list": async (input, context) => {
      return rpcSuccess({
        plugins: await options.platform.store.plugins.listForUser(
          requireSession(context).user.id,
          input.workspaceId,
        ),
      });
    },
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
    "integration.computer.setup.review": async (input, context) =>
      rpcSuccess(
        await options.platform.computerAppApprovals.reviewComputerAppSetup({
          ...input,
          ownerUserId: requireSession(context).user.id,
        }),
      ),
    "integration.server.secrets.list": async (_input, context) =>
      rpcSuccess({
        servers: (
          await options.platform.store.localMcp.withSecretsOwnedBy(requireSession(context).user.id)
        ).map((server) => ({
          computer: server.runnerName,
          installationId: server.installationId,
          id: server.id,
          name: server.name,
          plugin: server.installationTitle,
          secrets: [...localMcpLaunchSecrets(server.launch)],
        })),
      }),
    "integration.computer.setup.list": async (_input, context) =>
      rpcSuccess({
        requests: (
          await options.platform.store.listComputerAppSetupRequests(requireSession(context).user.id)
        ).map((request) => ComputerAppSetupRequestViewSchema.parse(request)),
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
      | "plugin.install"
      | "plugin.update"
      | "plugin.remove"
      | "plugin.activation.set"
      | "specialist.bind"
      | "specialist.add"
      | "specialist.remove"
      | "specialist.list"
      | "plugin.list"
      | "integration.catalog.install"
      | "integration.computer.setup.set"
      | "integration.computer.setup.respond"
      | "integration.computer.policy.set"
      | "integration.computer.app.block"
      | "integration.computer.setup.request"
      | "integration.computer.setup.cancel"
      | "integration.grant.create"
      | "integration.grant.revoke"
      | "integration.mcp.authorization.begin"
      | "integration.mcp.disconnect"
      | "integration.remoteMcp.install"
      | "integration.server.secrets.set"
      | "integration.uninstall";
  }
>;

export async function handleIntegrationPlatformCommand(
  options: IntegrationPlatformRpcOptions,
  command: IntegrationPlatformCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const owner = requireSession(context).user.id;
  if (command.type === "plugin.list" || command.type === "specialist.list")
    return executeIntegrationPlatformCommand(options, command, context);
  const viewers = options.pluginsChanged
    ? await options.platform.store.settings.affectedViewers({
        ...((command.type.startsWith("plugin.") || command.type.startsWith("specialist.")) &&
        "workspaceId" in command &&
        command.workspaceId !== undefined
          ? { workspaceId: command.workspaceId }
          : {}),
        ...(command.type === "integration.uninstall"
          ? { installationId: command.installationId }
          : {}),
        ...(command.type === "plugin.remove" ? { pluginId: command.pluginId } : {}),
      })
    : [];
  const result = await executeIntegrationPlatformCommand(options, command, context);
  options.pluginsChanged?.([...new Set([owner, ...viewers])]);
  return result;
}

async function executeIntegrationPlatformCommand(
  options: IntegrationPlatformRpcOptions,
  command: IntegrationPlatformCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const session = requireSession(context);
  if (isIntegrationAdministrationCommand(command))
    return executeIntegrationAdministration(
      { platform: options.platform },
      { userId: session.user.id, isAdministrator: session.user.instanceRole === "administrator" },
      command,
      context.requestId,
    );
  switch (command.type) {
    case "integration.computer.policy.set":
      return {
        type: command.type,
        ...(await options.platform.computerAppApprovals.setComputerUsePolicy({
          ...command.input,
          settlementSessionId: session.id,
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
        request: ComputerAppSetupRequestViewSchema.parse(
          await options.platform.computerAppApprovals.requestComputerAppSetup({
            ...command.input,
            actorUserId: session.user.id,
          }),
        ),
      };
    case "integration.computer.setup.cancel":
      await options.platform.computerAppApprovals.cancelComputerAppSetup({
        settlementSessionId: session.id,
        requestId: command.requestId,
        ownerUserId: session.user.id,
      });
      return { type: command.type };
    case "integration.computer.setup.respond":
      await options.platform.computerAppApprovals.respondComputerAppSetup({
        settlementSessionId: session.id,
        setupRequestId: command.setupRequestId,
        decision: command.decision,
        secrets: command.secrets,
        actorUserId: session.user.id,
        isAdministrator: session.user.instanceRole === "administrator",
        requestId: context.requestId,
        authorize: async () => {
          const current = await options.authenticator.authenticateSession(context.headers, {
            mutation: true,
          });
          if (
            current.id !== session.id ||
            current.user.id !== session.user.id ||
            current.user.instanceRole !== session.user.instanceRole
          )
            throw new OpensteerError({
              code: "unauthorized",
              message: "Your session changed. Review this approval again.",
            });
        },
      });
      return { type: command.type };
    case "integration.server.secrets.set":
      await options.platform.setServerSecrets({
        actorUserId: session.user.id,
        secrets: command.secrets,
        serverId: command.serverId,
      });
      return { type: command.type };
    case "integration.computer.setup.set": {
      const connection = await options.platform.computerAppApprovals.setComputerConnection({
        ...command.input,
        settlementSessionId: session.id,
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
    case "specialist.bind":
      return {
        type: command.type,
        specialist: await options.platform.store.specialists.bind({
          ...command,
          actorUserId: session.user.id,
        }),
      };
    case "specialist.add":
      return {
        type: command.type,
        specialist: await options.platform.store.specialists.add({
          ...command,
          actorUserId: session.user.id,
        }),
      };
    case "specialist.list":
      return {
        type: command.type,
        specialists: await options.platform.store.specialists.list(
          command.workspaceId,
          session.user.id,
        ),
      };
    case "plugin.list":
      return {
        type: command.type,
        plugins: await options.platform.store.plugins.listForUser(
          session.user.id,
          command.workspaceId,
        ),
      };
    case "plugin.install": {
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
