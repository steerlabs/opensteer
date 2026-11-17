import {
  handlePluginOAuthCommand,
  isPluginOAuthCommand,
  pluginOAuthHandlers,
} from "../plugins/plugin-oauth-routes.js";
import type { PluginOAuthService } from "../plugins/plugin-oauth-service.js";
import { createSettingsReadHandlers } from "./settings-read-handlers.js";
import type { ComputerViewService } from "../computer-use/computer-view-service.js";
import { OpensteerError, RunnerIdSchema } from "@opensteer/core";
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
import { listedPluginRow } from "../integrations/catalog-presentation.js";
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
} from "../access/integration-authorization-routes.js";
import {
  handleIntegrationPlatformCommand,
  type IntegrationPlatformCommand,
  type IntegrationPlatformRpcOptions,
} from "../integrations/integration-platform-routes.js";
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
    | "plugin.list"
    | "integration.platform.get"
    | "integration.computer.apps.installed"
    | "integration.computer.session.stop"
    | "integration.computer.setup.review"
    | "integration.computer.setup.list"
    | "integration.computer.policy.get"
    | "integration.server.secrets.list"
  >,
  integrationPlatform: IntegrationPlatformRpcOptions,
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
      const machines = await coreHandlers["machines.list"]({}, context);
      if (!machines.ok) return machines;
      const overview = await integrationPlatform.platform.store.settings.overview(
        requireSession(context).user.id,
        new Set(
          machines.data.machines
            .filter((machine) => machine.status === "online")
            .map((machine) => machine.id),
        ),
      );
      return rpcSuccess({ ...overview, rows: overview.rows.map(listedPluginRow) });
    },
    "plugins.detail.get": async (input, context) => {
      const machines = await coreHandlers["machines.list"]({}, context);
      if (!machines.ok) return machines;
      const detail = await integrationPlatform.platform.store.settings.detail(
        requireSession(context).user.id,
        input.target,
        new Set(machines.data.machines.filter((m) => m.status === "online").map((m) => m.id)),
      );
      detail.row = listedPluginRow(detail.row);
      const runnerIds = new Set<string>([
        ...detail.devices.map((d) => d.runnerId),
        ...detail.accounts.flatMap((account) => (account.runnerId ? [account.runnerId] : [])),
      ]);
      if (runnerIds.size) {
        for (const machine of machines.data.machines.filter((entry) => runnerIds.has(entry.id))) {
          const definitionId =
            input.target.kind === "device-app" ? input.target.definitionId : null;
          for (const app of machine.apps ?? []) {
            if (app.definitionId !== definitionId) continue;
            for (const operation of app.operations)
              detail.permissions.push({
                label: `${machine.name}: ${operation.operation}`.slice(0, 120),
                layer: "os-permission",
                state:
                  machine.status !== "online"
                    ? "unknown"
                    : operation.state === "ready"
                      ? "allowed"
                      : operation.state === "permission-required"
                        ? "denied"
                        : "unknown",
              });
          }
        }
        detail.devices = machines.data.machines
          .filter((machine) => runnerIds.has(machine.id))
          .map((machine) => ({
            runnerId: RunnerIdSchema.parse(machine.id),
            name: machine.name.slice(0, 120),
            status: machine.status,
          }));
      }
      return rpcSuccess(hostApi["plugins.detail.get"].success.parse(detail));
    },
    ...createSettingsReadHandlers({
      otherDevices: (owner, machines) =>
        integrationPlatform.platform.store.settings.otherDevices(owner, machines),
      catalog: () => integrationPlatform.platform.settingsCatalog(),
      requests: (owner) =>
        integrationPlatform.platform.store.requests.waitingOnUserPage({
          userId: owner,
          limit: 100,
        }),
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
    ...integrationHandlers,
    ...integrationAuthorizationHandlers,
    ...integrationPlatformHandlers,
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
      if (isIntegrationCommand(command)) {
        const output = await handleIntegrationCommand(integrations, command, context);
        return rpcSuccess(hostApi["commands.dispatch"].success.parse(output));
      }
      if (
        command.type === "integration.authorization.cancel" ||
        command.type === "integration.authorization.return"
      ) {
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
  | IntegrationCommand
  | IntegrationAuthorizationCommand
  | IntegrationPlatformCommand
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
    "plugins.get": refuse,
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
    case "plugin.update":
    case "plugin.remove":
    case "plugin.activation.set":
    case "plugin.list":
    case "plugin.install":
    case "integration.catalog.install":
    case "integration.computer.setup.request":
    case "integration.computer.setup.cancel":
    case "integration.computer.setup.set":
    case "integration.computer.setup.respond":
    case "integration.computer.policy.set":
    case "integration.computer.app.block":
    case "integration.grant.create":
    case "integration.grant.revoke":
    case "integration.mcp.authorization.begin":
    case "integration.mcp.disconnect":
    case "integration.remoteMcp.install":
    case "integration.server.secrets.set":
    case "integration.uninstall":
      return true;
    default:
      return false;
  }
}

function isChannelCommand(command: HostApiCommand): command is ChannelCommand {
  return command.type.startsWith("channel.");
}
