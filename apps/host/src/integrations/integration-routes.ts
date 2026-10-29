import {
  IntegrationOAuthAttemptIdSchema,
  IntegrationProviderSchema,
} from "@opensteer/integration-core";
import type { FastifyInstance } from "fastify";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import { z } from "zod";
import type { HostAuthenticator } from "../identity/auth.js";
import type { DeploymentId } from "@opensteer/core";
import type { IntegrationDashboardService } from "./integration-dashboard-service.js";
import type { IntegrationService } from "./integration-service.js";
import type { IntegrationPlatformService } from "./integration-platform-service.js";
import { registerOAuthCallbackRoute } from "./integration-authorization-routes.js";
import { requireAdministrator, requireSession, requireSurface } from "./integration-rpc-context.js";

const ProviderParamsSchema = z.strictObject({ provider: IntegrationProviderSchema });

export interface IntegrationRpcOptions {
  readonly authenticator: HostAuthenticator;
  readonly deploymentId?: DeploymentId;
  readonly dashboard: Pick<IntegrationDashboardService, "providerDashboard">;
  readonly integrations: IntegrationService;
  readonly platform: Pick<IntegrationPlatformService, "computerAppApprovals" | "store">;
}

export function createIntegrationRpcHandlers(
  options: IntegrationRpcOptions,
): Pick<HostApiHandlers, "integrations.get" | "integration.repositoryAccess.check"> {
  return {
    "integration.repositoryAccess.check": async (input, context) => {
      const session = requireSession(context);
      return rpcSuccess(
        await options.integrations.checkRepositoryAccess({
          connectionId: input.connectionId,
          ownerUserId: session.user.id,
        }),
      );
    },
    "integrations.get": async (_input, context) => {
      const session = requireSession(context);
      return rpcSuccess(
        hostApi["integrations.get"].success.parse(
          await options.dashboard.providerDashboard(
            session.user.id,
            session.user.instanceRole === "administrator",
            requireSurface(context),
          ),
        ),
      );
    },
  };
}

export type IntegrationCommand = Extract<
  HostApiCommand,
  {
    readonly type:
      | "integration.apiKey.connect"
      | "integration.authorization.begin"
      | "integration.applicationSourceDefault.set"
      | "integration.disconnect"
      | "integration.providerApplication.save"
      | "integration.providerApplication.status.set";
  }
>;

export async function handleIntegrationCommand(
  options: IntegrationRpcOptions,
  command: IntegrationCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const session = requireSession(context);
  switch (command.type) {
    case "integration.providerApplication.save": {
      const application = await options.integrations.configureProviderApplication(command.input, {
        isAdministrator: session.user.instanceRole === "administrator",
        requestId: context.requestId,
        userId: session.user.id,
      });
      return { application, type: command.type };
    }
    case "integration.authorization.begin": {
      const input = command.input;
      const started = await options.integrations.beginAuthorization({
        ...(input.applicationSource ? { applicationSource: input.applicationSource } : {}),
        ...(input.exactApplicationSource
          ? { exactApplicationSource: input.exactApplicationSource }
          : {}),
        definitionId: input.definitionId,
        ownerUserId: session.user.id,
        requestSurface: requireSurface(context),
        returnPath: input.returnPath,
        surface: input.surface,
      });
      return {
        attemptId: started.attemptId,
        expiresAt: started.expiresAt.toISOString(),
        launchTicket: started.launchTicket,
        type: command.type,
      };
    }
    case "integration.apiKey.connect": {
      await options.integrations.connectApiKey(command.input, {
        ownerUserId: session.user.id,
        requestId: context.requestId,
      });
      return { type: command.type };
    }
    case "integration.providerApplication.status.set": {
      const application = await options.integrations.setProviderApplicationStatus(
        {
          ...(command.input.applicationId ? { applicationId: command.input.applicationId } : {}),
          expectedRevision: command.input.expectedRevision,
          provider: command.provider,
          status: command.input.status,
        },
        {
          isAdministrator: session.user.instanceRole === "administrator",
          requestId: context.requestId,
          userId: session.user.id,
        },
      );
      return { application, type: command.type };
    }
    case "integration.applicationSourceDefault.set":
      requireAdministrator(context);
      await options.integrations.setApplicationSourceDefault(
        { ...command.input, provider: command.provider },
        { requestId: context.requestId, userId: session.user.id },
      );
      return { type: command.type };
    case "integration.disconnect": {
      const input = {
        connectionId: command.connectionId,
        ownerUserId: session.user.id,
        requestId: context.requestId,
      };
      const disconnected =
        (await options.platform.store.getConnectionKind(input)) === "computer"
          ? await options.platform.computerAppApprovals.disconnectComputerConnection(input)
          : await options.integrations.disconnect(input);
      return { ...disconnected, type: command.type };
    }
  }
}
export function registerIntegrationRoutes(
  app: FastifyInstance,
  options: IntegrationRpcOptions,
): void {
  registerOAuthCallbackRoute<
    import("@opensteer/integration-core").IntegrationOAuthAttemptId,
    import("@opensteer/integration-core").IntegrationProvider
  >(app, {
    attemptIdSchema: IntegrationOAuthAttemptIdSchema,
    authenticator: options.authenticator,
    ...(options.deploymentId ? { deploymentId: options.deploymentId } : {}),
    handle: async ({ attemptId, browserBinding, parameters, prepared, state }) => {
      const result = await options.integrations.handleAuthorizationCallback({
        attemptId,
        browserBinding,
        parameters,
        provider: prepared,
        state,
      });
      return { returnPath: result.returnPath, status: result.status, surface: result.surface };
    },
    identify: (state) => options.integrations.identifyAuthorizationCallback(state),
    kind: "provider",
    path: "/v1/integrations/oauth/callback/:provider",
    prepare: (request) => ProviderParamsSchema.parse(request.params).provider,
  });
}
