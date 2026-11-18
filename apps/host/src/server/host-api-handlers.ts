import {
  handlePluginOAuthCommand,
  isPluginOAuthCommand,
  pluginOAuthHandlers,
} from "../plugins/plugin-oauth-routes.js";
import type { PluginOAuthService } from "../plugins/plugin-oauth-service.js";
import { createSettingsReadHandlers } from "./settings-read-handlers.js";
import type { ComputerViewService } from "../computer-use/computer-view-service.js";
import { OpensteerError } from "@opensteer/core";
import { requireSession } from "./rpc-context.js";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
  type PluginCommand,
} from "@opensteer/protocol";
import type { IdentityRpcHandlers } from "../identity/identity-routes.js";
import { handleTriggerCommand } from "../triggers/trigger-routes.js";
import type { TriggerService } from "../triggers/trigger-service.js";
import {
  handleDeviceCommand,
  type DeviceCommand,
  type DeviceRpcOptions,
} from "../devices/device-routes.js";
import { handleChannelCommand, type ChannelCommand } from "../channels/channel-handlers.js";
import { isPluginCommand, type PluginOwnerApi } from "../plugins/plugin-owner-api.js";
import type { ChannelService } from "../channels/channel-service.js";

import {
  handleBrowserSourceCommand,
  isBrowserSourceCommand,
  type BrowserSourceCommand,
  type BrowserSourceRpcOptions,
} from "./browser-source-registration.js";

export function createHostApiHandlers(
  identityHandlers: IdentityRpcHandlers,
  triggerHandlers: Pick<HostApiHandlers, "triggers.get" | "triggers.list">,
  triggers: TriggerService,
  deviceHandlers: Pick<
    HostApiHandlers,
    | "integrations.get"
    | "integration.platform.get"
    | "integration.grants.list"
    | "integration.computer.apps.installed"
    | "integration.computer.session.stop"
    | "integration.computer.setup.review"
    | "integration.computer.setup.list"
    | "integration.computer.policy.get"
    | "integration.server.secrets.list"
  >,
  devices: DeviceRpcOptions,
  channelHandlers: Pick<HostApiHandlers, "channel.connection.check" | "channels.get">,
  channels: ChannelService,
  browserSourceHandlers: Pick<
    HostApiHandlers,
    "browser.sources.get" | "browser.sources.inspect" | "browser.password-sign-in.get"
  >,
  browserSources: BrowserSourceRpcOptions,
  coreHandlers: Pick<
    HostApiHandlers,
    | "agentPhone.target.get"
    | "apps.list"
    | "apps.get"
    | "tabs.get"
    | "tabs.state"
    | "machines.list"
    | "bootstrap.get"
    | "assignment.get"
    | "thread.assignments.list"
    | "browser.searchSuggestions.get"
    | "browser.contextCandidate.get"
    | "browser.tabIcon.get"
    | "browser.history.get"
    | "browser.history.icons.get"
    | "thread.browserUsage.get"
    | "apps.view"
    | "attachment.get"
    | "attachment.upload"
    | "attachment.content"
    | "attention.get"
    | "needsYou.get"
    | "teams.links.list"
    | "teams.threadTask.get"
    | "teams.replyTask.get"
    | "harness.authentication.get"
    | "automaticModels.get"
    | "harness.catalog.refresh"
    | "harness.modelServers.discover"
    | "voice.open"
    | "voice.start"
    | "voice.renew"
    | "voice.context"
    | "voice.say"
    | "voice.stop"
    | "machine.access.history"
    | "requests.list"
    | "run.attempts.list"
    | "tasks.list"
    | "thread.events.list"
    | "node.events.list"
    | "asset.urls"
    | "file.open"
    | "file.content"
    | "tool.output.get"
    | "thread.messages.list"
    | "thread.inputQueue.get"
    | "thread.message.revisions.list"
    | "thread.live.get"
    | "thread.requests.list"
    | "references.resolve"
  >,
  handleCoreCommand: (
    command: CoreCommand,
    context: HostApiServerContext,
  ) => Promise<HostApiCommandOutput>,
  computerViews?: ComputerViewService,
  plugins?: PluginOwnerApi,
  pluginOAuth?: PluginOAuthService,
): Omit<
  HostApiHandlers,
  | "personal.remoteAccess.get"
  | "connections.list"
  | "connections.authorization.get"
  | `team.${string}`
> {
  return {
    ...pluginOAuthHandlers(pluginOAuth),
    "plugins.overview.get": async (_input, context) => {
      const overview = await devices.devices.store.settings.overview(
        requireSession(context).user.id,
      );
      return rpcSuccess(overview);
    },
    ...createSettingsReadHandlers({
      otherDevices: (owner, machines) =>
        devices.devices.store.settings.otherDevices(owner, machines),
      machines: coreHandlers["machines.list"],
    }),
    "computer.app.windows": async (input, context) => {
      const owner = requireSession(context).user.id;
      if (!computerViews)
        throw new OpensteerError({
          code: "conflict",
          reason: "computer-view-unsupported",
          message: "This Host does not support owner windows.",
        });
      return rpcSuccess({
        windows: await computerViews.windows(owner, input.machineId, input.app),
      });
    },
    "integration.computer.apps.approved": async (_input, context) => {
      const owner = requireSession(context).user.id;
      return rpcSuccess({ apps: computerViews ? await computerViews.approved(owner) : [] });
    },
    ...(plugins?.reads() ?? pluginsUnavailable()),
    ...identityHandlers,
    ...triggerHandlers,
    ...deviceHandlers,
    ...channelHandlers,
    ...browserSourceHandlers,
    ...coreHandlers,
    "commands.dispatch": async (command, context) => {
      if (isTeamCommand(command))
        throw new OpensteerError({
          code: "forbidden",
          message: "Team commands require a team Host",
        });
      if (command.type === "computer.view.close" || command.type === "computer.view.renew") {
        const owner = requireSession(context).user.id;
        if (!computerViews)
          throw new OpensteerError({
            code: "conflict",
            reason: "computer-view-unsupported",
            message: "This Host does not support owner views.",
          });
        return rpcSuccess(
          hostApi["commands.dispatch"].success.parse({
            type: command.type,
            view: await computerViews.command(owner, command),
          }),
        );
      }
      if (isPluginCommand(command)) {
        if (!plugins)
          throw new OpensteerError({ code: "not_found", message: "Plugins are unavailable." });
        return rpcSuccess(
          hostApi["commands.dispatch"].success.parse(await plugins.command(command, context)),
        );
      }
      if (isBrowserSourceCommand(command)) {
        return rpcSuccess(
          hostApi["commands.dispatch"].success.parse(
            await handleBrowserSourceCommand(browserSources, command, context),
          ),
        );
      }
      // Plugin account sign-in.
      if (isPluginOAuthCommand(command))
        return rpcSuccess(
          hostApi["commands.dispatch"].success.parse(
            await handlePluginOAuthCommand(pluginOAuth, command, context),
          ),
        );
      if (isTriggerCommand(command)) {
        const output = await handleTriggerCommand(triggers, command, context);
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      if (isDeviceCommand(command)) {
        const output = await handleDeviceCommand(devices, command, context);
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      if (isChannelCommand(command)) {
        const output = await handleChannelCommand(channels, command, context);
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      const output = await handleCoreCommand(command, context);
      return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
    },
  } satisfies Omit<
    HostApiHandlers,
    | "machines.list"
    | "bootstrap.get"
    | "tabs.get"
    | "tabs.state"
    | "apps.list"
    | "apps.get"
    | "personal.remoteAccess.get"
    | "connections.list"
    | "connections.authorization.get"
    | `team.${string}`
    | `team.${string}`
  >;
}

type TriggerCommand = Extract<HostApiCommand, { readonly type: `trigger.${string}` }>;
export type CoreCommand = Exclude<
  HostApiCommand,
  | Extract<HostApiCommand, { type: `computer.view.${string}` | "phone.tab.close" }>
  | TriggerCommand
  | DeviceCommand
  | ChannelCommand
  | BrowserSourceCommand
  | PluginCommand
>;

function pluginsUnavailable(): ReturnType<PluginOwnerApi["reads"]> {
  const refuse = async (): Promise<never> => {
    throw new OpensteerError({ code: "not_found", message: "Plugins are unavailable." });
  };
  return {
    "plugins.installed.list": refuse,
    "plugins.installed.page": refuse,
    "plugins.local.get": refuse,
    "plugins.get": refuse,
    "plugins.tools.list": refuse,
    "plugins.skills.list": refuse,
    "plugins.versions.list": refuse,
    "plugins.page.view": refuse,
    "plugins.catalog.list": refuse,
    "plugins.catalog.get": refuse,
    "plugins.accounts.list": refuse,
    "plugins.account.review": refuse,
    "plugins.schedule.runs": refuse,
    "plugins.workflow.runs": refuse,
    "plugins.webhook.setup.get": refuse,
  };
}

type TeamCommand = Extract<HostApiCommand, { readonly type: `team.${string}` }>;
function isTeamCommand(command: HostApiCommand): command is TeamCommand {
  return command.type.startsWith("team.");
}

function isTriggerCommand(command: HostApiCommand): command is TriggerCommand {
  return command.type.startsWith("trigger.");
}

function isDeviceCommand(command: HostApiCommand): command is DeviceCommand {
  switch (command.type) {
    case "plugin.remove":
    case "integration.disconnect":
    case "integration.computer.setup.request":
    case "integration.computer.setup.cancel":
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

function isChannelCommand(command: HostApiCommand): command is ChannelCommand {
  return command.type.startsWith("channel.");
}
