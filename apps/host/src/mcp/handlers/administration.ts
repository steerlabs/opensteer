import { harnessView } from "../../administration/authority.js";
import { OpensteerError, type UserId } from "@opensteer/core";
import type { IntegrationConnectionSummary } from "@opensteer/integration-core";
import { hostApi } from "@opensteer/protocol";
import * as specs from "@opensteer/agent-tools/tools";
import {
  AdministrationService,
  isAdministrationCommand,
  type AdministrationCommand,
} from "../../administration/administration-service.js";
import { isIntegrationAdministrationCommand } from "../../integrations/integration-administration.js";
import type { AgentCaller } from "../agent-caller.js";
import { operationId } from "../operations.js";
import { settings } from "../tool-access.js";
import type { ToolCall, AgentToolHandlers } from "./types.js";

type AdministrationToolName = (typeof specs.administrationTools)[number]["name"];
export type AdministrationHandlers = Pick<AgentToolHandlers, AdministrationToolName>;
function command(value: Record<string, unknown>): AdministrationCommand {
  const parsed = hostApi["commands.dispatch"].payload.parse(value);
  if (
    isAdministrationCommand(parsed) ||
    isIntegrationAdministrationCommand(parsed) ||
    parsed.type === "browser.site.remove" ||
    parsed.type === "channel.binding.revoke" ||
    parsed.type === "channel.connection.status.set"
  )
    return parsed;
  throw new OpensteerError({ code: "forbidden", message: "This command is unavailable to agents" });
}
export class AdministrationToolHandlers {
  readonly service: AdministrationService;
  readonly listConnections: (userId: UserId) => Promise<readonly IntegrationConnectionSummary[]>;
  constructor(
    service: AdministrationService,
    listConnections: (userId: UserId) => Promise<readonly IntegrationConnectionSummary[]>,
  ) {
    this.service = service;
    this.listConnections = listConnections;
  }
  #write(
    call: { caller: AgentCaller; operationKey: string },
    tool: AdministrationToolName,
    value: Record<string, unknown>,
  ) {
    return command({
      ...value,
      idempotencyKey: operationId(call.caller, call.operationKey, tool),
    });
  }
  settingsCommand(c: ToolCall<"settings_write">) {
    const i = c.input;
    const common = { environmentId: i.environmentId, harnessInstanceId: i.harnessInstanceId };
    switch (i.action) {
      case "set_default":
        return this.#write(c, "settings_write", { ...common, type: "harness.default.set" });
      case "configure_model":
        return this.#write(c, "settings_write", {
          ...common,
          type: "harness.model.configure",
          nativeModelId: i.nativeModelId,
          settings: i.settings,
        });
      case "set_enabled":
        return this.#write(c, "settings_write", {
          ...common,
          type: "harness.enabled.set",
          enabled: i.enabled,
        });
      case "rename":
        return this.#write(c, "settings_write", {
          ...common,
          type: "harness.rename",
          name: i.name,
        });
      case "remember_execution":
        return this.#write(c, "settings_write", {
          type: "execution.preferences.remember",
          selection: i.selection,
          accessMode: i.accessMode,
        });
      case "set_time_zone":
        return this.#write(c, "settings_write", {
          type: "viewer.timeZone.update",
          timeZone: i.timeZone,
        });
    }
  }
  computerCommand(c: ToolCall<"computer_write">) {
    const i = c.input;
    switch (i.action) {
      case "rename":
        return this.#write(c, "computer_write", {
          type: "machine.rename",
          machineId: i.machineId,
          name: i.name,
        });
      case "revoke":
        return this.#write(c, "computer_write", { type: "machine.revoke", machineId: i.machineId });
      case "stop_session":
        return this.#write(c, "computer_write", {
          type: "machine.access.session.stop",
          sessionId: i.sessionId,
        });
    }
  }
  async integrationCommand(c: ToolCall<"integration_manage">) {
    const i = c.input;
    switch (i.action) {
      case "list":
        return null;
      case "disconnect": {
        const kind = i.connectionId
          ? await this.service.dependencies.integrations.platform.store.getConnectionKind({
              connectionId: i.connectionId,
              ownerUserId: c.caller.userId,
            })
          : null;
        return this.#write(c, "integration_manage", {
          type: kind === "mcp-oauth" ? "integration.mcp.disconnect" : "integration.disconnect",
          connectionId: i.connectionId,
        });
      }
      case "uninstall":
        return this.#write(c, "integration_manage", {
          type: "integration.uninstall",
          installationId: i.installationId,
        });
      case "revoke_grant":
        return this.#write(c, "integration_manage", {
          type: "integration.grant.revoke",
          grantId: i.grantId,
        });
    }
  }
  channelCommand(c: ToolCall<"channel_manage">) {
    const i = c.input;
    switch (i.action) {
      case "list":
        return null;
      case "revoke_binding":
        return this.#write(c, "channel_manage", {
          type: "channel.binding.revoke",
          bindingId: i.bindingId,
        });
      case "pause":
      case "resume":
        return this.#write(c, "channel_manage", {
          type: "channel.connection.status.set",
          connectionId: i.connectionId,
          status: i.action === "pause" ? "paused" : "connected",
        });
    }
  }
  pluginCommand(c: ToolCall<"plugin_manage">) {
    const i = c.input;
    switch (i.action) {
      case "list":
        return null;
      case "update":
        return this.#write(c, "plugin_manage", {
          type: "plugin.update",
          pluginId: i.pluginId,
          input: { directory: i.directory, ...(i.runnerId ? { runnerId: i.runnerId } : {}) },
        });
      case "enable":
      case "disable":
        return this.#write(c, "plugin_manage", {
          type: "plugin.activation.set",
          pluginId: i.pluginId,
          active: i.action === "enable",
        });
      case "remove":
        return this.#write(c, "plugin_manage", { type: "plugin.remove", pluginId: i.pluginId });
      case "remove_specialist":
        return this.#write(c, "plugin_manage", {
          type: "specialist.remove",
          specialistId: i.specialistId,
        });
    }
  }
  browserCommand(c: ToolCall<"browser_profile_write">) {
    const i = c.input;
    switch (i.action) {
      case "list":
        return null;
      case "rename":
        return this.#write(c, "browser_profile_write", {
          type: "browser.profile.rename",
          profileId: i.profileId,
          name: i.name,
        });
      case "delete":
        return this.#write(c, "browser_profile_write", {
          type: "browser.profile.delete",
          profileId: i.profileId,
        });
      case "clear_history":
        return this.#write(c, "browser_profile_write", {
          type: "browser.history.clear",
          profileId: i.profileId,
        });
      case "remove_history":
        return this.#write(c, "browser_profile_write", {
          type: "browser.history.remove",
          profileId: i.profileId,
          url: i.url,
        });
      case "remove_site":
        return this.#write(c, "browser_profile_write", {
          type: "browser.site.remove",
          site: i.site,
        });
    }
  }
  async execute(caller: AgentCaller, command: AdministrationCommand) {
    return { ...(await this.service.execute(caller, command)), ok: true as const };
  }
  async settings_read({ caller }: ToolCall<"settings_read">) {
    const store = this.service.dependencies.store;
    const environments = await store.listEnvironmentsForUser(caller.userId);
    const [instances, preferences, timeZone] = await Promise.all([
      store.listHarnessInstances({ environmentIds: environments.map(({ id }) => id) }),
      store.getExecutionPreferences(caller.userId),
      store.notificationState.timeZoneFor(caller.userId),
    ]);
    return {
      harnesses: instances.map(harnessView),
      preferences,
      timeZone,
    };
  }
  async computer_list({ caller, input }: ToolCall<"computer_list">) {
    const { store, runners } = this.service.dependencies;
    await this.service.actor(caller);
    const page = await store.listRunners({
      ...(input.after ? { after: input.after } : {}),
      ownerId: caller.userId,
      includeDeployment: true,
      includeOtherOwners: false,
      limit: 100,
    });
    return {
      nextCursor: page.nextCursor,
      machines: await Promise.all(
        page.runners.map(async (runner) => {
          return {
            id: runner.id,
            name: runner.name,
            connected: runners.isRunnerConnected(runner.id),
            revoked: runner.revokedAt !== null,
            sessions: await store.listActiveShellSessions(runner.id),
          };
        }),
      ),
    };
  }
  async authorizeList(caller: AgentCaller) {
    settings(caller, []);
    await this.service.actor(caller);
  }
  async integration_list(c: ToolCall<"integration_manage">) {
    await this.authorizeList(c.caller);
    const platform = this.service.dependencies.integrations.platform;
    const [grants, connections, oauth, installations] = await Promise.all([
      platform.store.listGrants({ ownerUserId: c.caller.userId }),
      this.listConnections(c.caller.userId),
      platform.store.listMcpOAuthConnections(c.caller.userId),
      platform.store.listInstallations(),
    ]);
    return {
      ok: true as const,
      grants,
      installations,
      connections: [
        ...connections,
        ...oauth.map((connection) => ({ ...connection, id: connection.connectionId })),
      ],
    };
  }
  async channel_list(c: ToolCall<"channel_manage">) {
    await this.authorizeList(c.caller);
    const dashboard = await this.service.dependencies.channels.service.dashboard(c.caller.userId);
    return { ok: true as const, connections: dashboard.connections, bindings: dashboard.bindings };
  }
  async browser_list(c: ToolCall<"browser_profile_write">) {
    await this.authorizeList(c.caller);
    const { browser, browserSources } = this.service.dependencies;
    const [profiles, sources] = await Promise.all([
      browser.listProfiles(c.caller.userId),
      browserSources.listState({ ownerId: c.caller.userId }),
    ]);
    return { ok: true as const, profiles, sites: sources.sites };
  }
  async plugin_list(c: ToolCall<"plugin_manage">) {
    await this.authorizeList(c.caller);
    const { integrations } = this.service.dependencies;
    return {
      ok: true as const,
      plugins: await integrations.platform.store.plugins.listForUser(c.caller.userId),
      specialists: await integrations.platform.store.specialists.summaries(c.caller.userId),
    };
  }
}
export function administrationToolHandlers(
  admin: AdministrationToolHandlers,
): AdministrationHandlers {
  const mutation = <Name extends AdministrationToolName>(
    parse: (call: ToolCall<Name>) => AdministrationCommand | Promise<AdministrationCommand>,
  ) =>
    Object.assign(async (call: ToolCall<Name>) => admin.execute(call.caller, await parse(call)), {
      authorize: async (call: ToolCall<Name>) =>
        admin.service.authorize(call.caller, await parse(call)),
    });
  return {
    settings_write: mutation((c) => admin.settingsCommand(c)),
    computer_write: mutation((c) => admin.computerCommand(c)),
    browser_profile_write: Object.assign(
      async (c: ToolCall<"browser_profile_write">) =>
        c.input.action === "list"
          ? await admin.browser_list(c)
          : await admin.execute(c.caller, admin.browserCommand(c)!),
      {
        authorize: async (c: ToolCall<"browser_profile_write">) => {
          const command = admin.browserCommand(c);
          if (command) await admin.service.authorize(c.caller, command);
          else await admin.authorizeList(c.caller);
        },
      },
    ),
    settings_read: (c) => admin.settings_read(c),
    computer_list: async (c) => await admin.computer_list(c),
    integration_manage: Object.assign(
      async (c: ToolCall<"integration_manage">) =>
        c.input.action === "list"
          ? await admin.integration_list(c)
          : await admin.execute(c.caller, (await admin.integrationCommand(c))!),
      {
        authorize: async (c: ToolCall<"integration_manage">) => {
          const command = await admin.integrationCommand(c);
          if (command) await admin.service.authorize(c.caller, command);
          else await admin.authorizeList(c.caller);
        },
      },
    ),
    channel_manage: Object.assign(
      async (c: ToolCall<"channel_manage">) =>
        c.input.action === "list"
          ? await admin.channel_list(c)
          : await admin.execute(c.caller, admin.channelCommand(c)!),
      {
        authorize: async (c: ToolCall<"channel_manage">) => {
          const command = admin.channelCommand(c);
          if (command) await admin.service.authorize(c.caller, command);
          else await admin.authorizeList(c.caller);
        },
      },
    ),
    plugin_manage: Object.assign(
      async (c: ToolCall<"plugin_manage">) =>
        c.input.action === "list"
          ? await admin.plugin_list(c)
          : await admin.execute(c.caller, admin.pluginCommand(c)!),
      {
        authorize: async (c: ToolCall<"plugin_manage">) => {
          const command = admin.pluginCommand(c);
          if (command) await admin.service.authorize(c.caller, command);
          else await admin.authorizeList(c.caller);
        },
      },
    ),
  };
}
