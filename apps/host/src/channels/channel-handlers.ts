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
          accessPolicy: command.accessPolicy,
          credentials: command.credentials,
          createdBy: userId,
          provider: command.provider,
          routingMode: command.routingMode,
          workspaceId: command.workspaceId,
        })),
        type: command.type,
      };
    case "channel.connection.computer.create":
      return {
        ...(await channels.createComputerConnection({
          createdBy: userId,
          ownerHandles: command.ownerHandles,
          provider: command.provider,
          runnerId: command.runnerId,
          workspaceId: command.workspaceId,
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
    case "channel.binding.create":
      return {
        binding: await channels.createBinding({
          accessPolicy: command.accessPolicy,
          accountId: command.accountId,
          createdBy: userId,
          executionPolicy: command.executionPolicy,
          selector: command.selector,
          workspaceId: command.workspaceId,
        }),
        type: command.type,
      };
    case "channel.binding.update":
      return {
        binding: await channels.updateBinding({
          bindingId: command.bindingId,
          expectedRevision: command.expectedRevision,
          accessPolicy: command.accessPolicy,
          ownerUserId: userId,
        }),
        type: command.type,
      };
    case "channel.access.review":
      return {
        grant: await channels.reviewAccess({
          bindingId: command.bindingId,
          externalUserId: command.externalUserId,
          expectedRevision: command.expectedRevision,
          decision: command.decision,
          ownerUserId: userId,
        }),
        type: command.type,
      };
    case "channel.binding.revoke":
      await channels.revokeBinding(command.bindingId, userId);
      return { type: command.type };
    case "channel.identity.link":
      return { ...(await channels.linkIdentity(command.code, userId)), type: command.type };
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
