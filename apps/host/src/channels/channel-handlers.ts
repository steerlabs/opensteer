import { OpensteerError } from "@opensteer/core";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { ChannelService } from "./channel-service.js";

export function createChannelRpcHandlers(
  channels: ChannelService,
): Pick<HostApiHandlers, "channel.connection.check" | "channels.get"> {
  return {
    "channel.connection.check": async ({ connectionId }, context) =>
      rpcSuccess(
        hostApi["channel.connection.check"].success.parse(
          await channels.checkConnection(connectionId, requireUserId(context)),
        ),
      ),
    "channels.get": async (_input, context) =>
      rpcSuccess(
        hostApi["channels.get"].success.parse(await channels.dashboard(requireUserId(context))),
      ),
  };
}

export type ChannelCommand = Extract<HostApiCommand, { readonly type: `channel.${string}` }>;

export async function handleChannelCommand(
  channels: ChannelService,
  command: ChannelCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const userId = requireUserId(context);
  switch (command.type) {
    case "channel.connection.create":
      return {
        ...(await channels.createConnection({
          credentials: command.credentials,
          createdBy: userId,
          provider: command.provider,
          routingMode: command.routingMode,
        })),
        type: command.type,
      };
    case "channel.connection.computer.create":
      return {
        ...(await channels.createComputerConnection({
          createdBy: userId,
          provider: command.provider,
          runnerId: command.runnerId,
        })),
        type: command.type,
      };
    case "channel.connection.credentials.replace":
      await channels.replaceConnectionCredentials({
        connectionId: command.connectionId,
        credentials: command.credentials,
        ownerUserId: userId,
      });
      return { type: command.type };
    // Routes, approvals and link codes in the chat are gone: a bridge is created on its consent
    // and edited as a connection. These commands leave the wire with this change's next step.
    case "channel.binding.create":
    case "channel.binding.update":
    case "channel.access.review":
    case "channel.binding.revoke":
    case "channel.identity.link":
      throw new OpensteerError({
        code: "not_found",
        message: "Update Opensteer to change Messaging.",
      });
    case "channel.connection.status.set":
      await channels.setConnectionStatus(command.connectionId, userId, command.status);
      return { type: command.type };
  }
}

function requireUserId(context: HostApiServerContext) {
  if (!context.session) {
    throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
  }
  return context.session.user.id;
}
