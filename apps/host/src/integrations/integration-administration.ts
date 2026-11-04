import type { AdministrationCommandIdentity } from "@opensteer/database";
import { OpensteerError, type UserId } from "@opensteer/core";
import type { HostApiCommand, HostApiCommandOutput } from "@opensteer/protocol";
import type { IntegrationPlatformService } from "./integration-platform-service.js";
import type { IntegrationService } from "./integration-service.js";
export const integrationAdministrationCommandTypes = [
  "integration.disconnect",
  "integration.mcp.disconnect",
  "integration.uninstall",
  "integration.grant.revoke",
  "plugin.activation.set",
  "plugin.remove",
  "plugin.update",
  "specialist.remove",
] as const;
export type IntegrationAdministrationCommand = Extract<
  HostApiCommand,
  { type: (typeof integrationAdministrationCommandTypes)[number] }
>;
export function isIntegrationAdministrationCommand(
  command: HostApiCommand,
): command is IntegrationAdministrationCommand {
  return integrationAdministrationCommandTypes.some((type) => command.type === type);
}
export interface AdministrationActor {
  readonly userId: UserId;
  readonly isAdministrator: boolean;
}
export function assertAdministrator(actor: AdministrationActor) {
  if (!actor.isAdministrator)
    throw new OpensteerError({ code: "forbidden", message: "Administrator access required" });
}
type Options = {
  readonly platform: IntegrationPlatformService;
  readonly integrations?: IntegrationService;
};
function requiredIntegrations(options: Options) {
  if (!options.integrations) throw new Error("Integration service is unavailable");
  return options.integrations;
}
export async function executeIntegrationAdministration(
  options: Options,
  actor: AdministrationActor,
  command: IntegrationAdministrationCommand,
  requestId: string,
  administration?: AdministrationCommandIdentity | undefined,
): Promise<HostApiCommandOutput> {
  switch (command.type) {
    case "integration.mcp.disconnect":
      await options.platform.store.revokeMcpOAuthConnection({
        administration,
        connectionId: command.connectionId,
        ownerUserId: actor.userId,
        requestId,
      });
      return { type: command.type };
    case "specialist.remove":
      await options.platform.store.specialists.remove({
        ...command,
        administration,
        actorUserId: actor.userId,
      });
      return { type: command.type };
    case "plugin.activation.set":
      await options.platform.store.plugins.setActivation({
        ...command,
        administration,
        actorUserId: actor.userId,
      });
      return { type: command.type };
    case "plugin.remove": {
      assertAdministrator(actor);
      await options.platform.store.specialists.retirePlugin(command.pluginId);
      for (const installation of await options.platform.store.listInstallations()) {
        if (installation.pluginId === command.pluginId)
          await options.platform.uninstallIntegration({
            installationId: installation.id,
            actorUserId: actor.userId,
            requestId,
          });
      }
      await options.platform.store.plugins.remove(command.pluginId, administration);
      return { type: command.type };
    }
    case "plugin.update":
      assertAdministrator(actor);
      await options.platform.installAgentPlugin({
        administration,
        actorUserId: actor.userId,
        directory: command.input.directory,
        pluginId: command.pluginId,
        requestId,
        ...(command.input.runnerId ? { runnerId: command.input.runnerId } : {}),
      });
      return { type: command.type };
    case "integration.uninstall": {
      assertAdministrator(actor);
      const outcome = await options.platform.uninstallIntegration({
        administration,
        actorUserId: actor.userId,
        installationId: command.installationId,
        requestId,
      });
      return { ...outcome, type: command.type };
    }
    case "integration.grant.revoke":
      await options.platform.revokeGrant({
        administration,
        grantId: command.grantId,
        ownerUserId: actor.userId,
        requestId,
        workspaceId: command.workspaceId,
      });
      return { type: command.type };
    case "integration.disconnect":
      return disconnectIntegration(
        { platform: options.platform, integrations: requiredIntegrations(options) },
        actor,
        command.connectionId,
        requestId,
        administration,
      );
  }
}

export async function disconnectIntegration(
  options: {
    readonly platform: Pick<IntegrationPlatformService, "store" | "computerAppApprovals">;
    readonly integrations: IntegrationService;
  },
  actor: AdministrationActor,
  connectionId: Extract<HostApiCommand, { type: "integration.disconnect" }>["connectionId"],
  requestId: string,
  administration?: AdministrationCommandIdentity | undefined,
) {
  const input = {
    administration,
    connectionId: connectionId,
    ownerUserId: actor.userId,
    requestId,
  };
  const disconnected =
    (await options.platform.store.getConnectionKind(input)) === "computer"
      ? await options.platform.computerAppApprovals.disconnectComputerConnection(input)
      : await options.integrations.disconnect(input);
  return { ...disconnected, type: "integration.disconnect" as const };
}
