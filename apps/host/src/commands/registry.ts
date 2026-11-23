import { OpensteerError } from "@opensteer/core";
import {
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiServerContext,
  type PluginCommand,
} from "@opensteer/protocol";
import { commandTable, type Command, type CommandType } from "@opensteer/protocol/command-table";
import type { ChannelService } from "../channels/channel-service.js";
import { handleChannelCommand, type ChannelCommand } from "../channels/channel-handlers.js";
import type { ComputerViewService } from "../computer-use/computer-view-service.js";
import {
  handleDeviceCommand,
  type DeviceCommand,
  type DeviceRpcOptions,
} from "../devices/device-routes.js";
import { handlePluginOAuthCommand, isPluginOAuthCommand } from "../plugins/plugin-oauth-routes.js";
import type { PluginOAuthService } from "../plugins/plugin-oauth-service.js";
import { isPluginCommand, type PluginOwnerApi } from "../plugins/plugin-owner-api.js";
import {
  handleBrowserSourceCommand,
  isBrowserSourceCommand,
  type BrowserSourceCommand,
  type BrowserSourceRpcOptions,
} from "../server/browser-source-registration.js";
import { requireSession } from "../server/rpc-context.js";
import { handleTriggerCommand } from "../triggers/trigger-routes.js";
import type { TriggerService } from "../triggers/trigger-service.js";
import type { Actor, PersonActor } from "./actor.js";
import type { CommandAuthority } from "./dispatch.js";

/**
 * A handler written for the person: it reaches the store with the session's user as authority, so
 * only a `PersonActor` may call it. An agent's command for it waits for the person instead.
 */
export interface PersonCommandHandler<K extends CommandType> {
  readonly accepts: "person";
  run(
    actor: PersonActor,
    command: Command<K>,
    context: HostApiServerContext,
  ): Promise<HostApiCommandOutput>;
}
/**
 * A handler written for agents too: it takes the actor and hands its store the authority the door
 * made, which the store admits again in the effect's transaction. The person reaches it with no
 * authority, as today.
 */
export interface ActorCommandHandler<K extends CommandType> {
  readonly accepts: "any";
  run(
    actor: Actor,
    command: Command<K>,
    on: {
      readonly context: HostApiServerContext | null;
      readonly authority: CommandAuthority | null;
    },
  ): Promise<HostApiCommandOutput>;
}
export type CommandHandler<K extends CommandType> =
  PersonCommandHandler<K> | ActorCommandHandler<K>;
export type CommandRegistry = { readonly [K in CommandType]: CommandHandler<K> };

type TriggerCommand = Extract<HostApiCommand, { readonly type: `trigger.${string}` }>;
export type CoreCommand = Exclude<
  HostApiCommand,
  | Extract<HostApiCommand, { type: `computer.view.${string}` }>
  | TriggerCommand
  | DeviceCommand
  | ChannelCommand
  | BrowserSourceCommand
  | PluginCommand
>;

/** The families the person's commands reach, as the Host wires them. */
export interface CommandFamilies {
  /** The person's approval of a command an agent proposed: it runs that command through the door. */
  readonly approveCommand?: (
    actor: PersonActor,
    command: Command<"request.command.approve">,
    context: HostApiServerContext,
  ) => Promise<HostApiCommandOutput>;
  readonly triggers: TriggerService;
  readonly devices: DeviceRpcOptions;
  readonly channels: ChannelService;
  readonly browserSources: BrowserSourceRpcOptions;
  readonly handleCoreCommand: (
    command: CoreCommand,
    context: HostApiServerContext,
  ) => Promise<HostApiCommandOutput>;
  readonly computerViews?: ComputerViewService | undefined;
  readonly plugins?: PluginOwnerApi | undefined;
  readonly pluginOAuth?: PluginOAuthService | undefined;
}

/** One entry per command type: the family handler the person's `commands.dispatch` used. */
export function createCommandRegistry(families: CommandFamilies): CommandRegistry {
  const registry: Partial<Record<CommandType, PersonCommandHandler<CommandType>>> = {};
  for (const type of Object.keys(commandTable) as CommandType[])
    registry[type] = { accepts: "person", run: familyHandler(type, families) };
  return registry as CommandRegistry;
}

/** The family a command type goes to, in the order the person's dispatch has always tried them. */
function familyHandler(
  type: CommandType,
  families: CommandFamilies,
): (
  actor: PersonActor,
  command: HostApiCommand,
  context: HostApiServerContext,
) => Promise<HostApiCommandOutput> {
  const probe = { type } as HostApiCommand;
  if (type === "request.command.approve")
    return async (actor, command, context) => {
      if (!families.approveCommand)
        throw new OpensteerError({ code: "not_found", message: "Request not found" });
      return families.approveCommand(actor, command as Command<"request.command.approve">, context);
    };
  if (type === "computer.view.close" || type === "computer.view.renew")
    return async (_actor, command, context) => {
      const owner = requireSession(context).user.id;
      const computerViews = families.computerViews;
      if (!computerViews)
        throw new OpensteerError({
          code: "conflict",
          reason: "computer-view-unsupported",
          message: "This Host does not support owner views.",
        });
      return {
        type: command.type,
        view: await computerViews.command(
          owner,
          command as Command<"computer.view.close" | "computer.view.renew">,
        ),
      } as HostApiCommandOutput;
    };
  if (isPluginCommand(probe))
    return async (_actor, command, context) => {
      if (!families.plugins)
        throw new OpensteerError({ code: "not_found", message: "Plugins are unavailable." });
      return families.plugins.command(command as PluginCommand, context);
    };
  if (isBrowserSourceCommand(probe))
    return (_actor, command, context) =>
      handleBrowserSourceCommand(families.browserSources, command as BrowserSourceCommand, context);
  // Plugin account sign-in.
  if (isPluginOAuthCommand(probe))
    return (_actor, command, context) =>
      handlePluginOAuthCommand(
        families.pluginOAuth,
        command as Parameters<typeof handlePluginOAuthCommand>[1],
        context,
      );
  if (type.startsWith("trigger."))
    return (actor, command, context) =>
      handleTriggerCommand(families.triggers, command as TriggerCommand, context, actor);
  if (isDeviceCommand(type))
    return (_actor, command, context) =>
      handleDeviceCommand(families.devices, command as DeviceCommand, context);
  if (type.startsWith("channel."))
    return (_actor, command, context) =>
      handleChannelCommand(families.channels, command as ChannelCommand, context);
  return (_actor, command, context) => families.handleCoreCommand(command as CoreCommand, context);
}

function isDeviceCommand(type: CommandType): boolean {
  switch (type) {
    case "plugin.remove":
    case "integration.disconnect":
    case "integration.computer.setup.request":
    case "integration.computer.setup.cancel":
    case "integration.computer.session.stop":
    case "integration.computer.setup.set":
    case "integration.computer.setup.respond":
    case "integration.computer.policy.set":
    case "integration.computer.app.block":
    case "integration.grant.create":
    case "integration.grant.revoke":
    case "integration.server.secrets.set":
      return true;
    default:
      return false;
  }
}
