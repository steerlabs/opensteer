import { projectMachines } from "../../runtime/machines.js";
import { deviceAccessStates } from "@opensteer/database";
import type { z } from "zod";
import {
  OpensteerError,
  agentGrantAllows,
  type AgentGrant,
  type DeviceId,
  formatReferenceLink,
  DeviceIdSchema,
  type ExecutionPreferencesViewSchema,
  type EnvironmentId,
} from "@opensteer/core";
import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import { RunnerModuleNameSchema } from "@opensteer/protocol";
import { AdministrationService } from "../../administration/administration-service.js";
import { callerLineage, type AgentCaller } from "../agent-caller.js";
import { computerIds } from "../computer-ids.js";
import type { ToolCall, AgentToolHandlers } from "./types.js";

type AdministrationToolName = "computer_list" | "browser_profile_list";
export type AdministrationHandlers = Pick<AgentToolHandlers, AdministrationToolName>;

function liveGrantedApps(
  grant: Extract<AgentGrant, { scope: "selected" }>,
  connections: Awaited<
    ReturnType<
      AdministrationService["dependencies"]["integrations"]["devices"]["deviceConnections"]
    >
  >,
) {
  return grant.resources.flatMap((resource) =>
    resource.kind === "computer-app" &&
    connections.some(
      (entry) =>
        entry.id === resource.approvalId &&
        entry.status !== "revoked" &&
        entry.computer?.deviceId === resource.deviceId &&
        !entry.computer.blockedAt,
    )
      ? [resource]
      : [],
  );
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
  /** The person's name and what a new task starts with: opensteer_state's settings area. */
  async settingsView(caller: AgentCaller) {
    const store = this.service.dependencies.store;
    await this.service.actor(caller);
    const [preferences, owner] = await Promise.all([
      store.getExecutionPreferences(caller.userId),
      store.ownerProfile.read(),
    ]);
    return { ...defaultsView(preferences), ownerName: owner?.name ?? null };
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
    const grantedResources =
      grant?.scope === "selected" ? liveGrantedApps(grant, connections) : null;
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
          if (grantedDevices) {
            const display = grantedPhones.has(device.id) ? summary?.phoneDisplay : null;
            const driver = display?.driver;
            const driverVisible =
              driver &&
              drivers.some(
                (binding) =>
                  binding.runnerId === driver.runnerId &&
                  binding.role === "self" &&
                  binding.detachedAt === null &&
                  grantedDevices.has(binding.deviceId),
              );
            const phoneDisplay =
              display && !driverVisible
                ? { ...display, driver: null, setup: { location: display.setup.location } }
                : display;
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
              ...(phoneDisplay ? { phoneDisplay } : {}),
              revoked: device.removedAt !== null,
              access: {
                browser: "unsupported" as const,
                files: "unsupported" as const,
                apps: "enabled" as const,
              },
              sessions: [],
            };
          }
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
    const { browser, browserSources, integrations, store } = this.service.dependencies;
    const grant = callerLineage(caller)?.grant;
    const selected = grant?.scope === "selected" ? grant : null;
    const [allProfiles, sources, connections] = await Promise.all([
      browser.listAgentProfiles(caller.userId),
      selected ? null : browserSources.listState({ ownerId: caller.userId }),
      selected && selected.resources.some((resource) => resource.kind === "computer-app")
        ? integrations.devices.deviceConnections(caller.userId)
        : [],
    ]);
    const grantedDevices = selected
      ? new Set(liveGrantedApps(selected, connections).map((resource) => resource.deviceId))
      : null;
    const profiles = selected
      ? allProfiles.filter((profile) =>
          agentGrantAllows(selected, { kind: "browser-profile", profileId: profile.id }, "read"),
        )
      : allProfiles;
    return {
      profiles: await Promise.all(
        profiles.map(async ({ home, ...profile }) => {
          const deviceId =
            home && grantedDevices?.size ? await store.getSelfDeviceId(home.runnerId) : null;
          const visible = !grantedDevices || (deviceId !== null && grantedDevices.has(deviceId));
          return {
            ...profile,
            home: home && {
              reachable: home.reachable,
              ...(visible ? { computerId: home.runnerId, name: home.name } : {}),
            },
          };
        }),
      ),
      sites: sources?.sites ?? [],
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
  return {
    computer_list: (c) => admin.computer_list(c),
    browser_profile_list: (c) => admin.browser_profile_list(c),
  };
}
