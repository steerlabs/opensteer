import { pluginOAuthHandlers } from "../plugins/plugin-oauth-routes.js";
import type { PluginOAuthService } from "../plugins/plugin-oauth-service.js";
import { createSettingsReadHandlers } from "./settings-read-handlers.js";
import type { ComputerViewService } from "../computer-use/computer-view-service.js";
import { OpensteerError } from "@opensteer/core";
import { requireSession } from "./rpc-context.js";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { IdentityRpcHandlers } from "../identity/identity-routes.js";
import type { TriggerService } from "../triggers/trigger-service.js";
import type { DeviceRpcOptions } from "../devices/device-routes.js";
import type { PluginOwnerApi } from "../plugins/plugin-owner-api.js";
import type { ChannelService } from "../channels/channel-service.js";
import type { BrowserSourceRpcOptions } from "./browser-source-registration.js";
import { personActor } from "../commands/actor.js";
import { dispatchCommand, type CommandDoor } from "../commands/dispatch.js";
import type { CommandRequestService } from "../commands/requests.js";
import { createCommandRegistry, type CoreCommand } from "../commands/registry.js";

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
    | "personal.shell.get"
    | "personal.readiness.get"
    | "tasks.page"
    | "thread.snapshot.get"
    | "thread.items.page"
    | "node.items.page"
    | "thread.overlays.page"
    | "transcript.item.get"
    | "resources.detail.get"
    | "agentPhone.target.get"
    | "apps.list"
    | "apps.get"
    | "tabs.get"
    | "tabs.state"
    | "machines.list"
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
    | "asset.urls"
    | "file.open"
    | "file.content"
    | "thread.messages.list"
    | "thread.inputQueue.get"
    | "thread.message.revisions.list"
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
  commandRequests?: CommandRequestService,
): Omit<
  HostApiHandlers,
  | "personal.remoteAccess.get"
  | "personal.accountLink.get"
  | "connections.list"
  | "connections.authorization.get"
  | "connections.activity"
  | "threads.activity"
  | `team.${string}`
> {
  const door: CommandDoor = {
    registry: createCommandRegistry({
      ...(commandRequests
        ? {
            // The person's approval runs the proposed command through this same door, as them.
            approveCommand: async (actor, command, context) => ({
              type: command.type,
              outcome: await commandRequests.approve(
                actor,
                {
                  requestId: command.requestId,
                  expectedRevision: command.expectedRevision,
                  command: command.command,
                  idempotencyKey: command.idempotencyKey,
                },
                (person, approved) => dispatchCommand(person, approved, door, context),
                (proposal) => personActor(context, proposal),
              ),
            }),
          }
        : {}),
      triggers,
      devices,
      channels,
      browserSources,
      handleCoreCommand,
      computerViews,
      plugins,
      pluginOAuth,
    }),
  };
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
    "commands.dispatch": async (command, context) =>
      rpcSuccess(
        hostApi["commands.dispatch"].success.parse(
          await dispatchCommand(personActor(context), command, door, context),
        ),
      ),
  } satisfies Omit<
    HostApiHandlers,
    | "machines.list"
    | "tabs.get"
    | "tabs.state"
    | "apps.list"
    | "apps.get"
    | "personal.remoteAccess.get"
    | "personal.accountLink.get"
    | "connections.list"
    | "connections.authorization.get"
    | "connections.activity"
    | "threads.activity"
    | "connections.activity"
    | "threads.activity"
    | `team.${string}`
    | `team.${string}`
  >;
}

export type { CoreCommand } from "../commands/registry.js";

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
    "plugins.icons.get": refuse,
    "plugins.accounts.list": refuse,
    "plugins.account.review": refuse,
    "plugins.schedule.runs": refuse,
    "plugins.workflow.runs": refuse,
    "plugins.webhook.setup.get": refuse,
  };
}
