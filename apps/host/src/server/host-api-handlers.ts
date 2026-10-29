import type { ComputerViewService } from "../computer-use/computer-view-service.js";
import { OpensteerError } from "@opensteer/core";
import { requireSession } from "../integrations/integration-rpc-context.js";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { IdentityRpcHandlers } from "../identity/identity-routes.js";
import { handleTriggerCommand } from "../triggers/trigger-routes.js";
import type { TriggerService } from "../triggers/trigger-service.js";
import {
  handleIntegrationCommand,
  type IntegrationCommand,
  type IntegrationRpcOptions,
} from "../integrations/integration-routes.js";
import {
  handleIntegrationAuthorizationCommand,
  type IntegrationAuthorizationCommand,
  type IntegrationAuthorizationRpcOptions,
} from "../integrations/integration-authorization-routes.js";
import {
  handleIntegrationPlatformCommand,
  type IntegrationPlatformCommand,
  type IntegrationPlatformRpcOptions,
} from "../integrations/integration-platform-routes.js";
import { handleChannelCommand, type ChannelCommand } from "../channels/channel-handlers.js";
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
  integrationHandlers: Pick<
    HostApiHandlers,
    "integrations.get" | "integration.repositoryAccess.check"
  >,
  integrations: IntegrationRpcOptions,
  integrationAuthorizationHandlers: Pick<HostApiHandlers, "integration.authorization.get">,
  integrationAuthorization: IntegrationAuthorizationRpcOptions,
  integrationPlatformHandlers: Pick<
    HostApiHandlers,
    | "integration.grants.list"
    | "integration.platform.get"
    | "integration.computer.apps.installed"
    | "integration.computer.session.stop"
    | "integration.computer.setup.list"
    | "integration.computer.policy.get"
  >,
  integrationPlatform: IntegrationPlatformRpcOptions,
  channelHandlers: Pick<HostApiHandlers, "channel.connection.check" | "channels.get">,
  channels: ChannelService,
  browserSourceHandlers: Pick<HostApiHandlers, "browser.sources.get" | "browser.sources.inspect">,
  browserSources: BrowserSourceRpcOptions,
  coreHandlers: Pick<
    HostApiHandlers,
    | "agentPhone.target.get"
    | "assignment.get"
    | "thread.assignments.list"
    | "browser.searchSuggestions.get"
    | "browser.contextCandidate.get"
    | "browser.tabs.get"
    | "workspace.tabs.get"
    | "browser.tabIcon.get"
    | "thread.browserUsage.get"
    | "attachment.get"
    | "attachment.upload"
    | "attachment.content"
    | "bootstrap.get"
    | "harness.authentication.get"
    | "harness.catalog.refresh"
    | "harness.modelServers.discover"
    | "machine.access.history"
    | "machines.list"
    | "requests.list"
    | "run.attempts.list"
    | "tasks.list"
    | "thread.events.list"
    | "thread.messages.list"
    | "thread.readState.get"
    | "thread.inputQueue.get"
    | "thread.live.get"
    | "thread.requests.list"
    | "workspace.catalog.list"
    | "workspace.files.list"
    | "workspace.files.preview"
    | "workspace.invitations.list"
    | "workspace.members.list"
    | "workspace.prefetch"
  >,
  handleCoreCommand: (
    command: CoreCommand,
    context: HostApiServerContext,
  ) => Promise<HostApiCommandOutput>,
  computerViews?: ComputerViewService,
): HostApiHandlers {
  return {
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
    ...identityHandlers,
    ...triggerHandlers,
    ...integrationHandlers,
    ...integrationAuthorizationHandlers,
    ...integrationPlatformHandlers,
    ...channelHandlers,
    ...browserSourceHandlers,
    ...coreHandlers,
    "commands.dispatch": async (command, context) => {
      if (
        command.type === "computer.view.open" ||
        command.type === "computer.view.close" ||
        command.type === "computer.view.renew"
      ) {
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
      if (isBrowserSourceCommand(command)) {
        return rpcSuccess(
          hostApi["commands.dispatch"].success.parse(
            await handleBrowserSourceCommand(browserSources, command, context),
          ),
        );
      }
      if (isTriggerCommand(command)) {
        const output = await handleTriggerCommand(triggers, command, context);
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      if (isIntegrationCommand(command)) {
        const output = await handleIntegrationCommand(integrations, command, context);
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      if (command.type === "integration.authorization.cancel") {
        const output = await handleIntegrationAuthorizationCommand(
          integrationAuthorization,
          command,
          context,
        );
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      if (isIntegrationPlatformCommand(command)) {
        const output = await handleIntegrationPlatformCommand(
          integrationPlatform,
          command,
          context,
        );
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      if (isChannelCommand(command)) {
        const output = await handleChannelCommand(channels, command, context);
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      const output = await handleCoreCommand(command, context);
      return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
    },
  } satisfies HostApiHandlers;
}

type TriggerCommand = Extract<HostApiCommand, { readonly type: `trigger.${string}` }>;
export type CoreCommand = Exclude<
  HostApiCommand,
  | Extract<HostApiCommand, { type: `computer.view.${string}` }>
  | TriggerCommand
  | IntegrationCommand
  | IntegrationAuthorizationCommand
  | IntegrationPlatformCommand
  | ChannelCommand
  | BrowserSourceCommand
>;

function isTriggerCommand(command: HostApiCommand): command is TriggerCommand {
  return command.type.startsWith("trigger.");
}

function isIntegrationCommand(command: HostApiCommand): command is IntegrationCommand {
  switch (command.type) {
    case "integration.apiKey.connect":
    case "integration.authorization.begin":
    case "integration.applicationSourceDefault.set":
    case "integration.disconnect":
    case "integration.providerApplication.save":
    case "integration.providerApplication.status.set":
      return true;
    default:
      return false;
  }
}

function isIntegrationPlatformCommand(
  command: HostApiCommand,
): command is IntegrationPlatformCommand {
  switch (command.type) {
    case "integration.agentPlugin.install":
    case "integration.catalog.install":
    case "integration.computer.setup.request":
    case "integration.computer.setup.cancel":
    case "integration.computer.setup.set":
    case "integration.computer.approval-key.set":
    case "integration.computer.policy.set":
    case "integration.computer.app.block":
    case "integration.grant.create":
    case "integration.grant.revoke":
    case "integration.mcp.authorization.begin":
    case "integration.mcp.disconnect":
    case "integration.remoteMcp.install":
    case "integration.uninstall":
      return true;
    default:
      return false;
  }
}

function isChannelCommand(command: HostApiCommand): command is ChannelCommand {
  return command.type.startsWith("channel.");
}
