import {
  IntegrationPlatformDashboardSchema,
  integrationDefinitionSummary,
  type DeviceIntegrationConnectionSummary as IntegrationConnectionSummary,
  type IntegrationDefinition,
} from "@opensteer/integration-core";
import { ComputerAppSetupRequestViewSchema } from "@opensteer/integration-core/computer-app-setup";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { localMcpLaunchSecrets } from "@opensteer/integration-core/local-mcp";
import { OpensteerError, type UserId } from "@opensteer/core";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { HostAuthenticator } from "../identity/auth.js";
import type { LocalServerRegistry } from "../local-servers/local-server-registry.js";
import type { LocalServerService } from "../local-servers/local-server-service.js";
import { requirePersonalSession, requireSurface } from "../server/rpc-context.js";
import {
  executeDeviceAdministration,
  isDeviceAdministrationCommand,
} from "./device-administration.js";
import type { DeviceService } from "./device-service.js";

export interface DeviceRpcOptions {
  readonly authenticator: HostAuthenticator;
  readonly definitions: readonly IntegrationDefinition[];
  readonly devices: Pick<
    DeviceService,
    "computerAppApprovals" | "createGrant" | "revokeGrant" | "store"
  >;
  readonly listConnections: (
    ownerUserId: UserId,
  ) => Promise<readonly IntegrationConnectionSummary[]>;
  readonly localServers: Pick<LocalServerService, "setServerSecrets">;
  readonly localServerRegistry: Pick<LocalServerRegistry, "removePlugin">;
  readonly pluginsChanged?: (viewers: readonly UserId[]) => void;
}

/** The device and local-server reads every client shows: connections, catalog, approvals, secrets. */
export function createDeviceRpcHandlers(
  options: DeviceRpcOptions,
): Pick<
  HostApiHandlers,
  | "integrations.get"
  | "integration.platform.get"
  | "integration.grants.list"
  | "integration.computer.apps.installed"
  | "integration.computer.setup.review"
  | "integration.computer.setup.list"
  | "integration.computer.policy.get"
  | "integration.server.secrets.list"
> {
  const store = options.devices.store;
  const approvals = options.devices.computerAppApprovals;
  const owner = async (context: HostApiServerContext) =>
    (await requirePersonalSession(context, store.connections)).user.id;
  return {
    "integrations.get": async (_input, context) => {
      const ownerUserId = await owner(context);
      return rpcSuccess(
        hostApi["integrations.get"].success.parse({
          authorizationSurface: requireSurface(context),
          connections: await Promise.all(
            (await options.listConnections(ownerUserId)).map(async (connection) => {
              const self = connection.computer
                ? await store.getDeviceSelfRunnerId(connection.computer.deviceId)
                : null;
              if (!self || !connection.computer) return connection;
              const { deviceId: _deviceId, ...computer } = connection.computer;
              return { ...connection, computer: { ...computer, runnerId: self } };
            }),
          ),
          isAdministrator: true,
        }),
      );
    },
    "integration.platform.get": async (_input, context) => {
      const ownerUserId = await owner(context);
      const installations = await store.listInstallations();
      return rpcSuccess(
        hostApi["integration.platform.get"].success.parse(
          IntegrationPlatformDashboardSchema.parse({
            authorizationSurface: requireSurface(context),
            catalog: options.definitions.map((definition) => ({
              definition: integrationDefinitionSummary(definition),
              digest: integrationDefinitionDigest(definition),
              installationId:
                installations.find(
                  (installation) => installation.provenance.definitionId === definition.id,
                )?.id ?? null,
            })),
            // The dashboard shows at most its first 1,000, as it always has.
            installations: await Promise.all(
              installations.slice(0, 1_000).map(async (installation) => ({
                installation,
                servers: (await store.listServers(installation.id)).map(
                  ({ transport, ...server }) => ({ ...server, transportType: transport.type }),
                ),
                tools: await store.listTools(installation.id, ownerUserId),
              })),
            ),
          }),
        ),
      );
    },
    "integration.computer.policy.get": async (input, context) => {
      const { appApproval } = await approvals.computerUsePolicy({
        ...input,
        ownerUserId: await owner(context),
      });
      return rpcSuccess({ appApproval });
    },
    "integration.computer.apps.installed": async (input, context) =>
      rpcSuccess(
        hostApi["integration.computer.apps.installed"].success.parse(
          await approvals.installedComputerApps({ ...input, actorUserId: await owner(context) }),
        ),
      ),
    "integration.computer.setup.review": async (input, context) => {
      const result = await approvals.reviewComputerAppSetup({
        ...input,
        ownerUserId: await owner(context),
      });
      return rpcSuccess({
        ...result,
        request: {
          ...result.request,
          runnerId: await store.requireDeviceSelfRunnerId(result.request.deviceId),
        },
      });
    },
    "integration.server.secrets.list": async (_input, context) =>
      rpcSuccess({
        servers: (await store.localMcp.withSecretsOwnedBy(await owner(context))).map((server) => ({
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
        requests: await Promise.all(
          (await store.listDeviceComputerAppSetupRequests(await owner(context))).map(
            async (request) => {
              const self = await store.getDeviceSelfRunnerId(request.deviceId);
              if (!self) return request;
              const { deviceId: _deviceId, ...rest } = request;
              return { ...rest, runnerId: self };
            },
          ),
        ),
      }),
    "integration.grants.list": async (_input, context) =>
      rpcSuccess(
        hostApi["integration.grants.list"].success.parse({
          grants: await store.listGrants({ ownerUserId: await owner(context) }),
        }),
      ),
  };
}

export type DeviceCommand = Extract<
  HostApiCommand,
  {
    readonly type:
      | "plugin.remove"
      | "integration.disconnect"
      | "integration.computer.setup.set"
      | "integration.computer.setup.respond"
      | "integration.computer.policy.set"
      | "integration.computer.app.block"
      | "integration.computer.setup.request"
      | "integration.computer.setup.cancel"
      | "integration.computer.session.stop"
      | "integration.grant.create"
      | "integration.grant.revoke"
      | "integration.server.secrets.set";
  }
>;

export async function handleDeviceCommand(
  options: DeviceRpcOptions,
  command: DeviceCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const store = options.devices.store;
  const owner = (await requirePersonalSession(context, store.connections)).user.id;
  const viewers =
    options.pluginsChanged && command.type === "plugin.remove"
      ? await store.settings.affectedViewers({ pluginId: command.pluginId })
      : [];
  const result = await executeDeviceCommand(options, command, context);
  options.pluginsChanged?.([...new Set([owner, ...viewers])]);
  return result;
}

async function executeDeviceCommand(
  options: DeviceRpcOptions,
  command: DeviceCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const store = options.devices.store;
  const approvals = options.devices.computerAppApprovals;
  const session = await requirePersonalSession(context, store.connections);
  if (isDeviceAdministrationCommand(command))
    return executeDeviceAdministration(
      { devices: options.devices, localServers: options.localServerRegistry },
      { userId: session.user.id },
      command,
      context.requestId,
    );
  switch (command.type) {
    case "integration.computer.policy.set":
      return {
        type: command.type,
        ...(await approvals.setComputerUsePolicy({
          ...command.input,
          settlementSessionId: session.id,
          ownerUserId: session.user.id,
          requestId: context.requestId,
        })),
      };
    case "integration.computer.app.block":
      await approvals.blockComputerApp({
        connectionId: command.connectionId,
        ownerUserId: session.user.id,
        requestId: context.requestId,
      });
      return { type: command.type };
    case "integration.computer.setup.request": {
      const request = await approvals.requestComputerAppSetup({
        ...command.input,
        actorUserId: session.user.id,
      });
      return {
        type: command.type,
        request: ComputerAppSetupRequestViewSchema.parse({
          ...request,
          runnerId: await store.requireDeviceSelfRunnerId(request.deviceId),
        }),
      };
    }
    case "integration.computer.session.stop":
      // The same call the person's route made: what it ends and records is unchanged.
      await approvals.stopComputerUseSession({
        actorUserId: session.user.id,
        sessionId: command.sessionId,
      });
      return { type: command.type };
    case "integration.computer.setup.cancel":
      await approvals.cancelComputerAppSetup({
        settlementSessionId: session.id,
        requestId: command.requestId,
        ownerUserId: session.user.id,
      });
      return { type: command.type };
    case "integration.computer.setup.respond":
      await approvals.respondComputerAppSetup({
        settlementSessionId: session.id,
        setupRequestId: command.setupRequestId,
        decision: command.decision,
        secrets: command.secrets,
        actorUserId: session.user.id,
        requestId: context.requestId,
        authorize: async () => {
          const current = await options.authenticator.authenticateSession(context.headers, {
            mutation: true,
          });
          await store.connections.assertOwner(current.user.id);
          if (current.id !== session.id || current.user.id !== session.user.id)
            throw new OpensteerError({
              code: "unauthorized",
              message: "Your session changed. Review this approval again.",
            });
        },
      });
      return { type: command.type };
    case "integration.server.secrets.set":
      await options.localServers.setServerSecrets({
        actorUserId: session.user.id,
        secrets: command.secrets,
        serverId: command.serverId,
      });
      return { type: command.type };
    case "integration.computer.setup.set": {
      const connection = await approvals.setComputerConnection({
        ...command.input,
        settlementSessionId: session.id,
        actorUserId: session.user.id,
        requestId: context.requestId,
      });
      const self = connection?.computer
        ? await store.getDeviceSelfRunnerId(connection.computer.deviceId)
        : null;
      if (!self || !connection?.computer) return { connection, type: command.type };
      const { deviceId: _deviceId, ...computer } = connection.computer;
      return {
        connection: { ...connection, computer: { ...computer, runnerId: self } },
        type: command.type,
      };
    }
    case "integration.grant.create": {
      const input = command.input;
      const grant = await options.devices.createGrant({
        access: input.access,
        alias: input.alias,
        connectionId: input.connectionId,
        createdBy: session.user.id,
        installationId: input.installationId,
        isDefault: input.isDefault,
        ownerUserId: session.user.id,
      });
      return { grant, type: command.type };
    }
  }
}
