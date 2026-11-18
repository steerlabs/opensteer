import type { AdministrationCommandIdentity } from "@opensteer/database";
import { OpensteerError, type UserId } from "@opensteer/core";
import type { HostApiCommand, HostApiCommandOutput } from "@opensteer/protocol";
import type { DeviceService } from "./device-service.js";
import type { LocalServerRegistry } from "../local-servers/local-server-registry.js";

/** The commands that turn off a device app, revoke an agent's grant or remove a local server. */
export const deviceAdministrationCommandTypes = [
  "integration.disconnect",
  "integration.grant.revoke",
  "plugin.remove",
] as const;
export type DeviceAdministrationCommand = Extract<
  HostApiCommand,
  { type: (typeof deviceAdministrationCommandTypes)[number] }
>;
export function isDeviceAdministrationCommand(
  command: HostApiCommand,
): command is DeviceAdministrationCommand {
  return deviceAdministrationCommandTypes.some((type) => command.type === type);
}
export interface AdministrationActor {
  readonly userId: UserId;
}

export async function executeDeviceAdministration(
  options: {
    readonly devices: Pick<DeviceService, "computerAppApprovals" | "revokeGrant" | "store">;
    readonly localServers: Pick<LocalServerRegistry, "removePlugin">;
  },
  actor: AdministrationActor,
  command: DeviceAdministrationCommand,
  requestId: string,
  administration?: AdministrationCommandIdentity | undefined,
): Promise<HostApiCommandOutput> {
  const store = options.devices.store;
  await store.connections.assertOwner(actor.userId);
  switch (command.type) {
    case "plugin.remove":
      await options.localServers.removePlugin(actor, command.pluginId, requestId, administration);
      return { type: command.type };
    case "integration.grant.revoke":
      await options.devices.revokeGrant({
        administration,
        grantId: command.grantId,
        ownerUserId: actor.userId,
        requestId,
      });
      return { type: command.type };
    case "integration.disconnect": {
      const input = {
        administration,
        connectionId: command.connectionId,
        ownerUserId: actor.userId,
        requestId,
      };
      if ((await store.getConnectionKind(input)) !== "computer")
        throw new OpensteerError({ code: "not_found", message: "That device app was not found" });
      return {
        ...(await options.devices.computerAppApprovals.disconnectComputerConnection(input)),
        type: command.type,
      };
    }
  }
}
