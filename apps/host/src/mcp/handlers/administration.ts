import { projectMachines } from "../../runtime/machines.js";
import { deviceAccessStates } from "@opensteer/database";
import type { z } from "zod";
import {
  OpensteerError,
  agentGrantAllows,
  type DeviceId,
  formatReferenceLink,
  DeviceIdSchema,
  type ExecutionPreferencesViewSchema,
  type EnvironmentId,
  type HarnessInstanceId,
  type UserId,
} from "@opensteer/core";
import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import { RunnerModuleNameSchema, hostApi } from "@opensteer/protocol";
import {
  AdministrationService,
  isAdministrationCommand,
  type AdministrationCommand,
} from "../../administration/administration-service.js";
import { callerLineage, type AgentCaller } from "../agent-caller.js";
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
  | "opensteer_messaging_bridge_list"
  | "opensteer_messaging_bridge_update"
  | "opensteer_messaging_bridge_remove";
export type AdministrationHandlers = Pick<AgentToolHandlers, AdministrationToolName>;

function command(value: Record<string, unknown>): AdministrationCommand {
  const parsed = hostApi["commands.dispatch"].payload.parse(value);
  if (
    isAdministrationCommand(parsed) ||
    parsed.type === "browser.site.remove" ||
    parsed.type === "channel.binding.revoke" ||
    parsed.type === "channel.connection.status.set"
  )
    return parsed;
  throw new OpensteerError({ code: "forbidden", message: "This command is unavailable to agents" });
}
export class AdministrationToolHandlers {
  readonly service: AdministrationService;
  readonly canExecute: (environmentId: EnvironmentId) => boolean;
  constructor(
    service: AdministrationService,
    canExecute: (environmentId: EnvironmentId) => boolean,
  ) {
    this.service = service;
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
    const after = input.cursor === undefined ? undefined : DeviceIdSchema.safeParse(input.cursor);
    if (after && !after.success)
      throw new OpensteerError({
        code: "bad_request",
        message: "cursor is not from computer_list. Start again without it.",
      });
    const [page, drivers, computers, connections] = await Promise.all([
      store.listDevices({
        ...(after?.data ? { after: after.data } : {}),
        ownerId: caller.userId,
        includeDeployment: true,
        limit: 100,
      }),
      store.listDeviceDrivers({ includeDetached: true }),
      computerIds(store, caller.userId),
      this.service.dependencies.integrations.devices.deviceConnections(caller.userId),
    ]);
    // A selected grant sees only the Devices where an app or phone screen it names is still
    // approved, scoped before anything is projected; a stale approval names no Device.
    const grant = callerLineage(caller)?.grant;
    const live = (resource: { readonly approvalId: string; readonly deviceId: string }) =>
      connections.some(
        (entry) =>
          entry.id === resource.approvalId &&
          entry.status !== "revoked" &&
          entry.computer?.deviceId === resource.deviceId &&
          !entry.computer.blockedAt,
      );
    const grantedResources =
      grant?.scope === "selected"
        ? grant.resources.flatMap((resource) =>
            resource.kind === "computer-app" && live(resource) ? [resource] : [],
          )
        : null;
    const grantedDevices = grantedResources
      ? new Set(grantedResources.map((resource) => resource.deviceId))
      : null;
    const grantedPhones = new Set(
      (grantedResources ?? []).flatMap((resource) =>
        resource.app.kind === "phone-screen" ? [resource.deviceId] : [],
      ),
    );
    let scoped = page;
    if (grantedDevices) {
      const devices: (typeof page.devices)[number][] = [];
      let cursor: DeviceId | undefined;
      for (;;) {
        const next = await store.listDevices({
          ...(cursor ? { after: cursor } : {}),
          ownerId: caller.userId,
          includeDeployment: true,
          limit: 100,
        });
        devices.push(...next.devices.filter((device) => grantedDevices.has(device.id)));
        if (!next.nextCursor) break;
        cursor = DeviceIdSchema.parse(next.nextCursor);
      }
      scoped = { ...page, devices, nextCursor: null };
    }
    const pageDeviceIds = new Set(scoped.devices.map((device) => device.id));
    const runnerIds = [
      ...new Set(
        drivers
          .filter((driver) => pageDeviceIds.has(driver.deviceId))
          .map((driver) => driver.runnerId),
      ),
    ];
    const runnerPages = [];
    for (let offset = 0; offset < runnerIds.length; offset += 100) {
      runnerPages.push(
        await store.listRunners({
          ids: runnerIds.slice(offset, offset + 100),
          ownerId: caller.userId,
          includeDeployment: true,
          includeOtherOwners: false,
          limit: 100,
        }),
      );
    }
    const pageRunners = runnerPages.flatMap((page) => page.runners);
    const byRunner = new Map(pageRunners.map((runner) => [runner.id, runner]));
    const hub = this.service.dependencies.computerApps;
    const summaries = projectMachines({
      deploymentOwnsMainComputer: true,
      pendingRunners: [],
      access: new Map(),
      apps: new Map(scoped.devices.map((device) => [device.id, hub.status(device.id) ?? []])),
      threadsByEnvironment: new Map(),
      runners: pageRunners.map((runner) => ({
        ...runner,
        asleepSince: runner.revokedAt
          ? null
          : runners.asleepSince(runner.id, runner.connectionGeneration),
        agentsStoppedSince: runner.revokedAt
          ? null
          : runners.agentsStoppedSince(runner.id, runner.connectionGeneration),
        modules: runner.moduleDescriptors,
        ownerName: null,
        connected: runners.isRunnerConnected(runner.id),
        readiness: new Map(
          RunnerModuleNameSchema.options.flatMap((module) => {
            const readiness = runners.moduleReadiness(runner.id, module);
            return readiness === undefined
              ? []
              : [[module, { readiness, checkedAt: null, detail: null }] as const];
          }),
        ),
        runtimeVersion: null,
        ownedByViewer: true,
      })),
      devices: scoped.devices.map((device) => {
        const screenDriver = drivers.find(
          (binding) =>
            binding.deviceId === device.id && binding.role === "screen" && !binding.detachedAt,
        );
        const screenRunner = screenDriver && byRunner.get(screenDriver.runnerId);
        return {
          device,
          selfRunnerId:
            drivers.find(
              (binding) =>
                binding.deviceId === device.id && binding.role === "self" && !binding.detachedAt,
            )?.runnerId ?? null,
          drivers: drivers
            .filter((binding) => binding.deviceId === device.id)
            .map((binding) => ({
              role: binding.role,
              runnerId: binding.runnerId,
              generation: binding.generation,
              attached: binding.detachedAt === null,
              runnerName: byRunner.get(binding.runnerId)?.name ?? "Computer",
            })),
          screenAsleep:
            !!screenRunner &&
            !screenRunner.revokedAt &&
            runners.asleepSince(screenRunner.id, screenRunner.connectionGeneration) !== null,
          screenStopped:
            !!screenRunner &&
            !screenRunner.revokedAt &&
            runners.agentsStoppedSince(screenRunner.id) !== null,
          screenConnected:
            !!screenRunner &&
            !screenRunner.revokedAt &&
            runners.identityForRunner(screenRunner.id)?.connectionGeneration ===
              screenRunner.connectionGeneration &&
            hub.attached(device.id),
          screenStatus: hub.deviceStatus(device.id),
          phoneAccess:
            connections.find(
              (entry) =>
                entry.computer?.deviceId === device.id &&
                entry.status !== "revoked" &&
                !entry.computer.blockedAt &&
                isPhoneDisplayDefinitionId(entry.definitionId),
            )?.computer?.access ?? null,
        };
      }),
    });
    return {
      nextCursor: scoped.nextCursor,
      computers: await Promise.all(
        scoped.devices.map(async (device) => {
          const self = drivers.find(
            (driver) =>
              driver.deviceId === device.id && driver.role === "self" && !driver.detachedAt,
          );
          const runner = self ? byRunner.get(self.runnerId) : undefined;
          const environmentId = self ? computers.environmentId(self.runnerId) : undefined;
          const summary = summaries.find((row) => row.id === device.id);
          const access = runner
            ? deviceAccessStates(
                device.accessPolicy,
                runner.allowedModules,
                runner.moduleDescriptors,
                device.kind === "home",
              )
            : {
                browser: "unsupported" as const,
                files: "unsupported" as const,
                apps: device.accessPolicy.apps ? ("enabled" as const) : ("disabled" as const),
              };
          // A selected grant learns only that a granted Device exists and whether it is
          // reachable: nothing of its other apps, drivers, switches, shells or capabilities.
          if (grantedDevices)
            return {
              computerId: device.id,
              name: device.name,
              kind: device.kind,
              selfRunnerId: null,
              drivers: [],
              online: summary?.status === "online",
              asleep: Boolean(summary?.asleepSince),
              hosting: false,
              canRunTasks: false,
              capabilities: [],
              ...(summary?.phoneDisplay && grantedPhones.has(device.id)
                ? { phoneDisplay: summary.phoneDisplay }
                : {}),
              revoked: device.removedAt !== null,
              access: {
                browser: "unsupported" as const,
                files: "unsupported" as const,
                apps: "enabled" as const,
              },
              sessions: [],
            };
          return {
            computerId: device.id,
            ...(self ? { link: formatReferenceLink(self.runnerId, device.name) } : {}),
            name: device.name,
            kind: device.kind,
            selfRunnerId: self?.runnerId ?? null,
            drivers: drivers
              .filter((driver) => driver.deviceId === device.id)
              .map((driver) => ({
                role: driver.role,
                runnerId: driver.runnerId,
                generation: driver.generation,
                attached: driver.detachedAt === null,
                runnerName: byRunner.get(driver.runnerId)?.name ?? "Computer",
              })),
            online: summary?.status === "online",
            asleep: Boolean(summary?.asleepSince),
            ...(summary?.asleepSince ? { asleepSince: summary.asleepSince } : {}),
            hosting: environmentId !== undefined,
            canRunTasks: environmentId !== undefined && this.canExecute(environmentId),
            capabilities: runner?.capabilities ?? [],
            deviceCapabilities: summary?.capabilities,
            ...(summary?.phoneDisplay ? { phoneDisplay: summary.phoneDisplay } : {}),
            revoked: device.removedAt !== null,
            access,
            sessions:
              self && !grantedDevices ? await store.listActiveShellSessions(self.runnerId) : [],
          };
        }),
      ),
    };
  }
  async browser_profile_list({ caller }: ToolCall<"browser_profile_list">) {
    await this.service.actor(caller);
    const { browser, browserSources } = this.service.dependencies;
    const [allProfiles, sources] = await Promise.all([
      browser.listAgentProfiles(caller.userId),
      browserSources.listState({ ownerId: caller.userId }),
    ]);
    // A selected grant sees only the profiles it names, and none of the person's sign-in sites.
    const grant = callerLineage(caller)?.grant;
    const selected = grant?.scope === "selected" ? grant : null;
    const profiles = selected
      ? allProfiles.filter((profile) =>
          agentGrantAllows(selected, { kind: "browser-profile", profileId: profile.id }, "read"),
        )
      : allProfiles;
    return {
      profiles: profiles.map(({ home, ...profile }) => ({
        ...profile,
        home: home && { computerId: home.runnerId, name: home.name, reachable: home.reachable },
      })),
      sites: selected ? [] : sources.sites,
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
    opensteer_messaging_bridge_list: (c) => admin.opensteer_messaging_bridge_list(c),
    opensteer_messaging_bridge_update: mutation((c) => admin.bridgeCommand(c)),
    opensteer_messaging_bridge_remove: mutation((c) => admin.bridgeCommand(c)),
  };
}
