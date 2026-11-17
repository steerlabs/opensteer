import { deviceAccessStates } from "@opensteer/database";
import type { z } from "zod";
import {
  OpensteerError,
  formatReferenceLink,
  RunnerIdSchema,
  type ExecutionPreferencesViewSchema,
  type EnvironmentId,
  type HarnessInstanceId,
  type UserId,
} from "@opensteer/core";
import type { IntegrationConnectionSummary } from "@opensteer/integration-core/models";
import { hostApi } from "@opensteer/protocol";
import {
  AdministrationService,
  isAdministrationCommand,
  type AdministrationCommand,
} from "../../administration/administration-service.js";
import { isIntegrationAdministrationCommand } from "../../integrations/integration-administration.js";
import type { AgentCaller } from "../agent-caller.js";
import { computerIds } from "../computer-ids.js";
import { operationId } from "../operations.js";
import type { ToolCall, AgentToolHandlers } from "./types.js";

type AdministrationToolName =
  | "opensteer_ai_account_update"
  | "opensteer_defaults_read"
  | "opensteer_defaults_update"
  | "computer_list"
  | "computer_update"
  | "computer_remove"
  | "browser_profile_list"
  | "browser_profile_update"
  | "browser_profile_remove"
  | "integration_list"
  | "integration_remove"
  | "opensteer_messaging_bridge_list"
  | "opensteer_messaging_bridge_update"
  | "opensteer_messaging_bridge_remove";
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
  readonly canExecute: (environmentId: EnvironmentId) => boolean;
  constructor(
    service: AdministrationService,
    listConnections: (userId: UserId) => Promise<readonly IntegrationConnectionSummary[]>,
    canExecute: (environmentId: EnvironmentId) => boolean,
  ) {
    this.service = service;
    this.listConnections = listConnections;
    this.canExecute = canExecute;
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
  async #account(userId: UserId, aiAccountId: HarnessInstanceId) {
    const [account] = await this.service.dependencies.store.listAgentHarnessInstancesForUser(
      userId,
      { id: aiAccountId, includeDisabled: true, limit: 1 },
    );
    if (!account)
      throw new OpensteerError({ code: "not_found", message: "That AI account is unavailable" });
    return account;
  }
  async aiAccountCommand(c: ToolCall<"opensteer_ai_account_update">) {
    const i = c.input;
    const account = await this.#account(c.caller.userId, i.aiAccountId);
    const common = { environmentId: account.environmentId, harnessInstanceId: account.id };
    const tool = "opensteer_ai_account_update";
    switch (i.action) {
      case "rename":
        return this.#write(c, tool, { ...common, type: "harness.rename", name: i.name });
      case "enable":
      case "disable":
        return this.#write(c, tool, {
          ...common,
          type: "harness.enabled.set",
          enabled: i.action === "enable",
        });
      case "set_default":
        return this.#write(c, tool, { ...common, type: "harness.default.set" });
      case "set_model_limits": {
        const [catalog] = await this.service.dependencies.store.listHarnessCatalogs(
          [account.environmentId],
          [account.id],
        );
        const listed = catalog?.catalog.models.find(
          ({ modelId }) => modelId === i.modelLimits?.modelId,
        );
        return this.#write(c, tool, {
          ...common,
          type: "harness.model.configure",
          nativeModelId: listed?.nativeModelId ?? i.modelLimits?.modelId,
          settings: i.modelLimits?.limits,
        });
      }
    }
  }
  async defaultsCommands(c: ToolCall<"opensteer_defaults_update">) {
    const { selection, accessMode } = c.input;
    const account = selection
      ? await this.#account(c.caller.userId, selection.aiAccountId)
      : undefined;
    if (!account && !accessMode) return [];
    return [
      this.#write(c, "opensteer_defaults_update", {
        type: "execution.preferences.remember",
        ...(accessMode ? { accessMode } : {}),
        ...(account && selection
          ? {
              selection: {
                environmentId: account.environmentId,
                harnessInstanceId: account.id,
                modelSelection: selection.model,
              },
            }
          : {}),
      }),
    ];
  }
  computerCommand(c: ToolCall<"computer_update"> | ToolCall<"computer_remove">) {
    const i = c.input;
    if (!("target" in i))
      return this.#write(c, "computer_update", {
        type: "machine.rename",
        machineId: i.computerId,
        name: i.name,
      });
    return i.target === "computer"
      ? this.#write(c, "computer_remove", { type: "machine.revoke", machineId: i.computerId })
      : this.#write(c, "computer_remove", {
          type: "machine.access.session.stop",
          sessionId: i.sessionId,
        });
  }
  browserCommand(c: ToolCall<"browser_profile_update"> | ToolCall<"browser_profile_remove">) {
    const i = c.input;
    if (!("target" in i))
      return this.#write(c, "browser_profile_update", {
        type: "browser.profile.rename",
        profileId: i.profileId,
        name: i.name,
      });
    const tool = "browser_profile_remove";
    switch (i.target) {
      case "profile":
        return this.#write(c, tool, { type: "browser.profile.delete", profileId: i.profileId });
      case "history":
        return this.#write(c, tool, { type: "browser.history.clear", profileId: i.profileId });
      case "history_url":
        return this.#write(c, tool, {
          type: "browser.history.remove",
          profileId: i.profileId,
          url: i.url,
        });
      case "site":
        return this.#write(c, tool, { type: "browser.site.remove", site: i.site });
    }
  }
  async integrationCommand(c: ToolCall<"integration_remove">) {
    const i = c.input;
    const tool = "integration_remove";
    switch (i.target) {
      case "account": {
        const kind = i.connectionId
          ? await this.service.dependencies.integrations.platform.store.getConnectionKind({
              connectionId: i.connectionId,
              ownerUserId: c.caller.userId,
            })
          : null;
        return this.#write(c, tool, {
          type: kind === "mcp-oauth" ? "integration.mcp.disconnect" : "integration.disconnect",
          connectionId: i.connectionId,
        });
      }
      case "integration":
        return this.#write(c, tool, {
          type: "integration.uninstall",
          installationId: i.installationId,
        });
      case "grant":
        return this.#write(c, tool, { type: "integration.grant.revoke", grantId: i.grantId });
    }
  }
  bridgeCommand(
    c:
      ToolCall<"opensteer_messaging_bridge_update"> | ToolCall<"opensteer_messaging_bridge_remove">,
  ) {
    const i = c.input;
    return "routeId" in i
      ? this.#write(c, "opensteer_messaging_bridge_remove", {
          type: "channel.binding.revoke",
          bindingId: i.routeId,
        })
      : this.#write(c, "opensteer_messaging_bridge_update", {
          type: "channel.connection.status.set",
          connectionId: i.bridgeId,
          status: i.paused ? "paused" : "connected",
        });
  }

  async execute(caller: AgentCaller, command: AdministrationCommand) {
    return { ...(await this.service.execute(caller, command)), ok: true as const };
  }
  async opensteer_defaults_read({ caller }: ToolCall<"opensteer_defaults_read">) {
    const store = this.service.dependencies.store;
    await this.service.actor(caller);
    const [preferences, owner] = await Promise.all([
      store.getExecutionPreferences(caller.userId),
      store.ownerProfile.read(),
    ]);
    return { ...defaultsView(preferences), ownerName: owner?.name ?? null };
  }
  async opensteer_defaults_update(c: ToolCall<"opensteer_defaults_update">) {
    let changed: Record<string, unknown> = { ok: true };
    for (const next of await this.defaultsCommands(c)) {
      const output = await this.service.execute(c.caller, next);
      if (output.type === "execution.preferences.remember")
        changed = { ...changed, ...defaultsView(output.preferences) };
    }
    return changed;
  }
  async computer_list({ caller, input }: ToolCall<"computer_list">) {
    const { store, runners } = this.service.dependencies;
    await this.service.actor(caller);
    const after = input.cursor === undefined ? undefined : RunnerIdSchema.safeParse(input.cursor);
    if (after && !after.success)
      throw new OpensteerError({
        code: "bad_request",
        message: "cursor is not from computer_list. Start again without it.",
      });
    const [page, computers] = await Promise.all([
      store.listRunners({
        ...(after?.data ? { after: after.data } : {}),
        ownerId: caller.userId,
        includeDeployment: true,
        includeOtherOwners: false,
        limit: 100,
      }),
      computerIds(store, caller.userId),
    ]);
    return {
      nextCursor: page.nextCursor,
      computers: await Promise.all(
        page.runners
          .filter((runner) => runner.kind !== "managed")
          .map(async (runner) => {
            const environmentId = computers.environmentId(runner.id);
            return {
              computerId: runner.id,
              link: formatReferenceLink(runner.id, runner.name),
              name: runner.name,
              online: runners.isRunnerConnected(runner.id),
              hosting: environmentId !== undefined,
              canRunTasks: environmentId !== undefined && this.canExecute(environmentId),
              capabilities: runner.capabilities,
              revoked: runner.revokedAt !== null,
              access: deviceAccessStates(
                runner.accessPolicy,
                runner.allowedModules,
                runner.moduleDescriptors,
                runner.kind === "main" && runner.ownerKind === "deployment",
              ),
              sessions: await store.listActiveShellSessions(runner.id),
            };
          }),
      ),
    };
  }
  async browser_profile_list({ caller }: ToolCall<"browser_profile_list">) {
    await this.service.actor(caller);
    const { browser, browserSources } = this.service.dependencies;
    const [profiles, sources] = await Promise.all([
      browser.listAgentProfiles(caller.userId),
      browserSources.listState({ ownerId: caller.userId }),
    ]);
    return {
      profiles: profiles.map(({ home, ...profile }) => ({
        ...profile,
        home: home && { computerId: home.runnerId, name: home.name, reachable: home.reachable },
      })),
      sites: sources.sites,
    };
  }
  async integration_list({ caller }: ToolCall<"integration_list">) {
    await this.service.actor(caller);
    const platform = this.service.dependencies.integrations.platform;
    const [grants, connections, oauth, installations] = await Promise.all([
      platform.store.listGrants({ ownerUserId: caller.userId }),
      this.listConnections(caller.userId),
      platform.store.listMcpOAuthConnections(caller.userId),
      platform.store.listInstallations(),
    ]);
    return {
      grants,
      installations,
      connections: [
        ...connections,
        ...oauth.map((connection) => ({ ...connection, id: connection.connectionId })),
      ],
    };
  }
  async opensteer_messaging_bridge_list({ caller }: ToolCall<"opensteer_messaging_bridge_list">) {
    await this.service.actor(caller);
    const dashboard = await this.service.dependencies.channels.service.dashboard(caller.userId);
    return {
      bridges: dashboard.connections.map((connection) => {
        const accounts = new Set(
          dashboard.accounts
            .filter((account) => account.connectionId === connection.id)
            .map(({ id }) => id),
        );
        return {
          bridgeId: connection.id,
          name: connection.displayName,
          provider: connection.provider,
          status: connection.status,
          routes: dashboard.bindings
            .filter((binding) => accounts.has(binding.accountId))
            .map(({ id, status }) => ({ routeId: id, status })),
        };
      }),
    };
  }
}
function defaultsView(preferences: z.output<typeof ExecutionPreferencesViewSchema>) {
  const latest = preferences.history[0];
  return {
    accessMode: preferences.accessMode,
    selection: latest
      ? {
          aiAccountId: latest.harnessInstanceId,
          model: {
            modelId: latest.modelSelection.modelId,
            providerId: latest.modelSelection.providerId,
            options: latest.modelSelection.options,
          },
        }
      : null,
  };
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
    opensteer_ai_account_update: mutation((c) => admin.aiAccountCommand(c)),
    opensteer_defaults_read: (c) => admin.opensteer_defaults_read(c),
    opensteer_defaults_update: Object.assign(
      async (c: ToolCall<"opensteer_defaults_update">) => await admin.opensteer_defaults_update(c),
      {
        authorize: async (c: ToolCall<"opensteer_defaults_update">) => {
          for (const next of await admin.defaultsCommands(c))
            await admin.service.authorize(c.caller, next);
        },
      },
    ),
    computer_list: (c) => admin.computer_list(c),
    computer_update: mutation((c) => admin.computerCommand(c)),
    computer_remove: mutation((c) => admin.computerCommand(c)),
    browser_profile_list: (c) => admin.browser_profile_list(c),
    browser_profile_update: mutation((c) => admin.browserCommand(c)),
    browser_profile_remove: mutation((c) => admin.browserCommand(c)),
    integration_list: (c) => admin.integration_list(c),
    integration_remove: mutation((c) => admin.integrationCommand(c)),
    opensteer_messaging_bridge_list: (c) => admin.opensteer_messaging_bridge_list(c),
    opensteer_messaging_bridge_update: mutation((c) => admin.bridgeCommand(c)),
    opensteer_messaging_bridge_remove: mutation((c) => admin.bridgeCommand(c)),
  };
}
