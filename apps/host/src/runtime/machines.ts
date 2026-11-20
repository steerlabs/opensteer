import {
  isPhoneDisplayDefinitionId,
  runnerRunsItsDeployment,
  sameStringSet,
} from "@opensteer/core";
import {
  RunnerModuleNameSchema,
  deviceAccess,
  AndroidPhoneNavigationSchema,
  runnerIntegrationsCompatibilityReason,
  type ComputerUsePermissions,
  type ComputerUseSessionSummary,
  type ComputerView,
  type MachineAppStatus,
  type MachineComputerUse,
  type MachineModuleSummary,
  type MachineListSummary,
  type MachineSummary,
  type RunnerDevice,
  type RunnerModuleName,
  type RunnerModuleReadiness,
  type RunnerModules,
} from "@opensteer/protocol";
import { browserRuntimeCompatibilityReason } from "../browser/browser-runtime-compatibility.js";

/** The access section of a machine row, as a management viewer sees it. */
export type MachineAccessView = NonNullable<MachineSummary["access"]>;

/** The Runner registry row this projection needs. */
export interface MachineRunnerInput {
  readonly deviceProfile: "iphone" | null;
  readonly phoneUpdate?: "downloading" | "installing" | "awaiting-user" | "failed" | null;
  readonly updateRequired?: "agent-phone-outdated" | "runner-outdated" | null;
  /** The enrollment's grant: what this computer may ever advertise. */
  readonly allowedModules: readonly RunnerModuleName[];
  /** When this disconnected Runner reported going to sleep, if still within the Home's sleep window. */
  readonly asleepSince?: Date | null;
  /** When the person stopped agents on this computer from the computer itself, while that holds. */
  readonly agentsStoppedSince?: Date | null;
  readonly connected: boolean;
  /** What the computer said it is in its last signed hello. */
  readonly device: RunnerDevice | null;
  readonly ownedByViewer?: boolean;
  readonly enrollmentId: string;
  readonly id: string;
  readonly kind: "main" | "local" | "managed";
  readonly lastSeenAt: Date | null;
  readonly modules: RunnerModules;
  readonly name: string;
  readonly ownerKind: "deployment" | "user";
  /** The owning person's display name, for a user-owned Runner. */
  readonly ownerName: string | null;
  /** What each module last reported, which only a live connection can supply. */
  readonly readiness: ReadonlyMap<RunnerModuleName, MachineModuleSummary>;
  readonly revokedAt: Date | null;
  /** The build the live connection says it runs; null while there is none. */
  readonly runtimeVersion: string | null;
}

export interface MachinePendingRunnerInput {
  readonly deviceProfile: "iphone" | null;
  readonly expiresAt: Date;
  readonly id: string;
  readonly name: string;
  readonly ownerKind: "deployment" | "user";
  readonly allowedModules: readonly RunnerModuleName[];
}

export interface MachineProjectionInput {
  readonly devices?: readonly MachineDeviceInput[] | undefined;
  /**
   * What each computer permits and who is on it, for the computers this viewer
   * manages. A machine absent from this map gets `access: null`, which is what
   * every non-manager sees: reach is never disclosed beyond a person's own
   * ability to connect.
   */
  readonly access: ReadonlyMap<string, MachineAccessView>;
  /**
   * What each computer's `integrations` module is reporting right now, for the
   * computers this viewer effectively owns. A machine absent from this map gets
   * `apps: null` — it is not attached with the module, or this viewer does not
   * own it, and those are the same answer to someone who cannot act on it.
   */
  readonly apps: ReadonlyMap<string, readonly MachineAppStatus[]>;
  /**
   * The live computer-use session on each computer that has one, for the
   * computers this viewer effectively owns. Like `apps`, absence is the same
   * answer as "not yours to see".
   */
  readonly computerUsePolicies?: ReadonlyMap<string, { readonly appApproval: "ask" | "automatic" }>;
  readonly computerViews?: ReadonlyMap<
    string,
    { readonly ownerViews: readonly ComputerView[]; readonly ownerViewVersion?: number }
  >;
  readonly computerUseDisplayStreamSupported?: ReadonlyMap<string, boolean>;
  readonly computerUseSessions?: ReadonlyMap<string, readonly ComputerUseSessionSummary[]>;
  readonly deploymentOwnsMainComputer: boolean;
  readonly pendingRunners: readonly MachinePendingRunnerInput[];
  readonly runners: readonly MachineRunnerInput[];
  /**
   * Live Threads per Environment. A row sums the Environments its machine
   * advertises, because what removal costs a person is the work placed there.
   */
  readonly threadsByEnvironment: ReadonlyMap<string, number>;
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * The same rule the store enforces when a revocation is actually attempted, so
 * the row a person sees and the answer the command gives cannot disagree.
 */
function isPersonalMainRunner(
  runner: MachineRunnerInput,
  deploymentOwnsMainComputer: boolean,
): boolean {
  return runnerRunsItsDeployment({
    deploymentIsPersonal: deploymentOwnsMainComputer,
    ownerKind: runner.ownerKind,
    runnerKind: runner.kind,
  });
}

/**
 * A module the computer advertises but has said nothing about yet. It is
 * `unavailable` rather than absent: the machine offers it, and a reader should
 * see that the thing exists and is not working, not that it was never there.
 */
function unreportedModule(): MachineModuleSummary {
  return { checkedAt: null, detail: null, readiness: "unavailable" };
}

type MutableMachineModules = {
  -readonly [Name in RunnerModuleName]?: MachineModuleSummary;
};

function projectModules(runner: MachineRunnerInput): MachineSummary["modules"] {
  const modules: MutableMachineModules = {};
  for (const name of RunnerModuleNameSchema.options) {
    if (runner.modules[name] === undefined) continue;
    const browserIncompatibility =
      name === "browser"
        ? browserRuntimeCompatibilityReason(runner.modules.browser?.wireVersion)
        : null;
    if (runner.connected && browserIncompatibility !== null) {
      modules.browser = {
        checkedAt: null,
        detail: browserIncompatibility,
        readiness: "unavailable",
      };
      continue;
    }
    if (runner.connected && name === "integrations" && runner.modules.integrations !== undefined) {
      const detail = runnerIntegrationsCompatibilityReason(runner.modules.integrations);
      if (detail !== null) {
        modules.integrations = { checkedAt: null, detail, readiness: "unavailable" };
        continue;
      }
    }
    modules[name] = runner.connected
      ? (runner.readiness.get(name) ?? unreportedModule())
      : unreportedModule();
  }
  return modules;
}

/** A pending enrollment shows what it will be allowed to do once redeemed. */
function pendingModules(allowedModules: readonly RunnerModuleName[]): MachineSummary["modules"] {
  const modules: MutableMachineModules = {};
  for (const name of allowedModules) modules[name] = unreportedModule();
  return modules;
}

/** What this machine's Environments hold, which removing it takes away. */
function machineStakes(
  runner: MachineRunnerInput,
  input: MachineProjectionInput,
): { readonly pinnedThreads: number } {
  const environmentIds = new Set(runner.modules.agents?.environmentIds ?? []);
  let pinnedThreads = 0;
  for (const environmentId of environmentIds) {
    pinnedThreads += input.threadsByEnvironment.get(environmentId) ?? 0;
  }
  return {
    pinnedThreads,
  };
}

/** The definition whose status entry says whether a Mac can do computer use. */
const computerUseDefinitionId = "macos-app";

/**
 * A phone's computer use, from its `android-phone` status entry. A phone has
 * no macOS grants to report, so `permissions` is always null, and its one
 * thing to turn back on — the accessibility service — is in the detail.
 */
function projectPhoneComputerUse(
  apps: readonly MachineAppStatus[] | undefined,
  sessions: readonly ComputerUseSessionSummary[],
  displayStreamSupported: boolean,
): MachineComputerUse {
  const base = {
    appApproval: null,
    displayStreamSupported,
    permissions: null,
    sessions: [...sessions],
  };
  const entry = apps?.find(({ definitionId }) => isPhoneDisplayDefinitionId(definitionId));
  if (!entry) {
    return {
      ...base,
      detail: "The Opensteer Agent Phone app is not running on this phone.",
      state: "unavailable",
    };
  }
  const blocked = entry.operations.find(({ state }) => state !== "ready");
  if (entry.operations.length > 0 && !blocked) return { ...base, detail: null, state: "ready" };
  return {
    ...base,
    detail: blocked?.detail ?? null,
    state: entry.operations.some(({ state }) => state === "permission-required")
      ? "permission-required"
      : "unavailable",
  };
}

/**
 * What one computer's row says about computer use.
 *
 * The state is read from the `macos-app` status entry the Mac reports, and the
 * permissions from the remedies on it rather than from a second report: the
 * helper is the only holder of the two macOS grants, and `observe` and `act`
 * asking for `screen-recording` or `accessibility` is exactly how it says one
 * is missing. No entry at all is `unavailable` — the Mac has no helper, which
 * is not the same as both grants being denied and is why `permissions` is null
 * there rather than a pair of `denied`.
 */
function projectComputerUse(
  apps: readonly MachineAppStatus[] | undefined,
  sessions: readonly ComputerUseSessionSummary[] = [],
  policy: {
    readonly appApproval: "ask" | "automatic";
  } = { appApproval: "ask" },
  displayStreamSupported = false,
): MachineComputerUse {
  const { appApproval } = policy;
  const entry = apps?.find(({ definitionId }) => definitionId === computerUseDefinitionId);
  if (!entry) {
    return {
      detail: "Computer use needs the Opensteer desktop app on this Mac.",
      permissions: null,
      sessions: [...sessions],
      displayStreamSupported,
      appApproval,
      state: "unavailable",
    };
  }
  if (entry.operations.length > 0 && entry.operations.every(({ state }) => state === "ready")) {
    return {
      detail: null,
      permissions: { accessibility: "granted", screenRecording: "granted" },
      sessions: [...sessions],
      displayStreamSupported,
      appApproval,
      state: "ready",
    };
  }
  // Each operation names the grant it is missing first, and when only one is
  // missing both name that one — so the set of remedies across the entry, not
  // the absence of a remedy on any single operation, is what says which grant
  // is denied. Reading a missing remedy as "granted" per operation is how both
  // being denied used to read as Accessibility being fine.
  const remedies = new Set(
    entry.operations.flatMap(({ remedy, state }) =>
      state === "permission-required" && remedy !== null ? [remedy] : [],
    ),
  );
  const missing = remedies.has("accessibility") || remedies.has("screen-recording");
  if (!missing) {
    // Something else is wrong with the helper — not a grant anybody can give
    // in System Settings — so there is nothing truthful to say about the two.
    return {
      detail: entry.operations.find(({ state }) => state !== "ready")?.detail ?? null,
      permissions: null,
      sessions: [...sessions],
      displayStreamSupported,
      appApproval,
      state: "unavailable",
    };
  }
  const permissions: ComputerUsePermissions = {
    accessibility: remedies.has("accessibility") ? "denied" : "granted",
    screenRecording: remedies.has("screen-recording") ? "denied" : "granted",
  };
  return {
    detail: entry.operations.find(({ state }) => state === "permission-required")?.detail ?? null,
    permissions,
    sessions: [...sessions],
    displayStreamSupported,
    appApproval,
    state: "permission-required",
  };
}

export function projectMachines(input: MachineProjectionInput): readonly MachineListSummary[] {
  if (input.devices) return projectDeviceMachines(input);
  const machines: MachineListSummary[] = [];

  for (const runner of input.runners) {
    if (runner.revokedAt !== null) continue;
    const personalMain = isPersonalMainRunner(runner, input.deploymentOwnsMainComputer);
    const stakes = machineStakes(runner, input);
    const apps = input.apps.get(runner.id);
    const asleepSince =
      !runner.connected && !runner.phoneUpdate && !runner.updateRequired
        ? isoOrNull(runner.asleepSince ?? null)
        : null;
    const agentsStoppedSince = isoOrNull(runner.agentsStoppedSince ?? null);
    machines.push({
      access: input.access.get(runner.id) ?? null,
      allowedModules: [...runner.allowedModules],
      apps: apps?.map((app) => ({ ...app })) ?? null,
      ...(asleepSince ? { asleepSince } : {}),
      ...(agentsStoppedSince ? { agentsStoppedSince } : {}),
      // Policy remains visible to the owner while the Mac is offline and has
      // no live app report. Neither map contains another owner's records.
      computerUse: (() => {
        if (runner.deviceProfile === "iphone") return null;
        const projected =
          apps === undefined && !input.computerUsePolicies?.has(runner.id)
            ? null
            : runner.modules.integrations?.platform === "android"
              ? projectPhoneComputerUse(
                  apps,
                  input.computerUseSessions?.get(runner.id) ?? [],
                  input.computerUseDisplayStreamSupported?.get(runner.id) ?? false,
                )
              : projectComputerUse(
                  apps,
                  input.computerUseSessions?.get(runner.id),
                  input.computerUsePolicies?.get(runner.id),
                  input.computerUseDisplayStreamSupported?.get(runner.id) ?? false,
                );
        const views = input.computerViews?.get(runner.id);
        return projected && views
          ? { ...projected, ...views, ownerViews: [...views.ownerViews] }
          : projected;
      })(),
      detail: runner.phoneUpdate
        ? runner.phoneUpdate === "failed"
          ? `Agent Phone couldn’t update on ${runner.name}. Update over USB to try again.`
          : runner.phoneUpdate === "awaiting-user"
            ? `Tap Update on ${runner.name}.`
            : `Updating Agent Phone on ${runner.name}…`
        : runner.updateRequired
          ? `Update ${runner.updateRequired === "agent-phone-outdated" ? "Agent Phone" : "Opensteer"} on ${runner.name}.`
          : personalMain
            ? "Runs this deployment."
            : null,
      device: runner.device ? { ...runner.device } : null,
      enrollmentId: runner.enrollmentId,
      expiresAt: null,
      fullDiskAccess:
        runner.ownedByViewer === false && runner.ownerKind === "user"
          ? null
          : (runner.modules.shell?.fullDiskAccess ?? null),
      id: runner.id,
      kind: personalMain
        ? "home"
        : sameStringSet(runner.allowedModules, ["browser", "integrations"]) &&
            runner.device?.form === "phone"
          ? runner.device.app === "opensteer"
            ? "phone"
            : runner.device.platform === "android"
              ? "agent-phone"
              : "unknown"
          : runner.device?.app === "opensteer"
            ? "computer"
            : runner.device?.form === "server"
              ? "server"
              : "unknown",
      lastSeenAt: isoOrNull(runner.lastSeenAt),
      modules: projectModules(runner),
      name: runner.name,
      ownership: runner.ownerKind === "user" ? "mine" : "deployment",
      pinnedThreads: stakes.pinnedThreads,
      revocable: !personalMain,
      runtimeVersion: runner.runtimeVersion,
      status:
        runner.phoneUpdate === "awaiting-user"
          ? "update-pending"
          : runner.connected
            ? "online"
            : runner.phoneUpdate === "downloading" || runner.phoneUpdate === "installing"
              ? "updating"
              : runner.phoneUpdate === "failed" || runner.updateRequired
                ? "needs-update"
                : "offline",
    });
  }

  for (const enrollment of input.pendingRunners) {
    machines.push({
      access: null,
      allowedModules: [...enrollment.allowedModules],
      // A computer that has not connected yet reports nothing.
      apps: null,
      computerUse: null,
      detail: null,
      device: enrollment.deviceProfile === "iphone" ? { form: "phone", platform: "ios" } : null,
      enrollmentId: enrollment.id,
      expiresAt: enrollment.expiresAt.toISOString(),
      fullDiskAccess: null,
      id: enrollment.id,
      lastSeenAt: null,
      modules: pendingModules(enrollment.allowedModules),
      name: enrollment.name,
      ownership: enrollment.ownerKind === "user" ? "mine" : "deployment",
      pinnedThreads: 0,
      revocable: false,
      runtimeVersion: null,
      status: "pending",
      // A computer that has not connected yet has reported nothing to compare.
    });
  }

  return machines;
}

/** Whether any connected computer can serve this module right now. */
export function machineModuleIsRoutable(readiness: RunnerModuleReadiness | undefined): boolean {
  return readiness !== undefined && readiness !== "unavailable";
}

export interface MachineDeviceInput {
  readonly device: Pick<
    import("@opensteer/database").DeviceInventoryRecord,
    "id" | "kind" | "platform" | "form" | "name" | "ownerKind" | "removedAt" | "accessPolicy"
  >;
  readonly drivers: readonly import("@opensteer/protocol").DeviceDriverView[];
  readonly selfRunnerId: import("@opensteer/core").RunnerId | null;
  readonly screenStatus: import("@opensteer/protocol").RunnerIntegrationsDeviceStatus | null;
  readonly screenConnected: boolean;
  readonly screenAsleep?: boolean;
  /** The Mac driving this phone's screen had agents stopped by its person. */
  readonly screenStopped?: boolean;
  readonly phoneAccess: "read" | "read-write" | null;
}

function projectDeviceMachines(input: MachineProjectionInput): readonly MachineListSummary[] {
  const legacy = projectMachines({ ...input, devices: undefined });
  const result: MachineListSummary[] = [];
  for (const {
    device,
    drivers,
    selfRunnerId,
    screenStatus,
    screenConnected,
    screenAsleep,
    screenStopped,
    phoneAccess,
  } of input.devices ?? []) {
    if (device.removedAt) continue;
    const self = legacy.find((machine) => machine.id === selfRunnerId);
    const selfAsleep = Boolean(self?.asleepSince);
    // The person stopped agents on this computer itself: nothing it offers is
    // available to an agent until they resume, connected or not.
    const selfStopped = Boolean(self?.agentsStoppedSince);
    const screen = drivers.find((driver) => driver.role === "screen") ?? null;
    const android =
      device.kind === "agent-phone" ||
      (self?.apps?.some((app) => isPhoneDisplayDefinitionId(app.definitionId)) &&
        device.platform === "android");
    const phone = screen !== null || android;
    const selected = screen ? "iphone-screen" : "android-phone";
    const displayStreamSupported = input.computerUseDisplayStreamSupported?.get(device.id) ?? false;
    const phoneComputerUse = projectPhoneComputerUse(
      screen
        ? screenStatus
          ? [{ definitionId: selected, operations: screenStatus.operations }]
          : undefined
        : (self?.apps ?? undefined),
      input.computerUseSessions?.get(device.id) ?? [],
      displayStreamSupported,
    );
    const available = (
      ready: boolean,
      reason: import("@opensteer/protocol").DeviceCapabilityReason["kind"],
    ): import("@opensteer/protocol").DeviceAvailability =>
      ready ? { state: "ready", reason: null } : { state: "unavailable", reason: { kind: reason } };
    const offlineReason = selfAsleep ? ("driver-asleep" as const) : ("driver-offline" as const);
    // Android v4 reports pause only in the operation detail.
    const physical = screen
      ? !screen.attached
        ? available(false, "not-connected")
        : screenStopped
          ? available(false, "driver-stopped")
          : screenAsleep
            ? available(false, "driver-asleep")
            : !screenConnected
              ? available(false, "driver-offline")
              : (screenStatus?.availability ?? available(false, "unreported"))
      : self?.status !== "online"
        ? available(false, offlineReason)
        : !android || phoneComputerUse.state === "ready"
          ? available(true, offlineReason)
          : available(
              false,
              phoneComputerUse.state === "permission-required"
                ? "permission-required"
                : phoneComputerUse.detail?.startsWith("Paused on the phone")
                  ? "paused"
                  : "helper-unavailable",
            );
    const display =
      !screen && physical.state === "ready" && !displayStreamSupported
        ? { state: "unsupported" as const, reason: { kind: "unsupported" as const } }
        : physical;
    const access = deviceAccess(device.accessPolicy);
    const capability = (
      supported: boolean,
      enabled: boolean,
      ready: boolean,
      configurable = true,
    ): import("@opensteer/protocol").DeviceCapability => ({
      supported,
      enabled: supported && enabled,
      configurable: supported && configurable,
      ...(!supported
        ? { state: "unsupported" as const, reason: { kind: "unsupported" as const } }
        : !enabled
          ? { state: "disabled" as const, reason: { kind: "access-off" as const } }
          : selfStopped
            ? available(false, "driver-stopped")
            : available(ready, offlineReason)),
    });
    const phoneDisplay: import("@opensteer/protocol").PhoneDisplayView | null = !phone
      ? null
      : {
          definitionId: selected,
          driver: screen ?? drivers.find((driver) => driver.role === "self") ?? null,
          control: !access.apps
            ? { state: "disabled", reason: { kind: "access-off" } }
            : !phoneAccess
              ? available(false, "approval-required")
              : physical,
          view: !phoneAccess
            ? available(false, "approval-required")
            : screen && screenStatus?.ownerViewVersion !== 1 && physical.state === "ready"
              ? available(false, "helper-unavailable")
              : display,
          input:
            phoneAccess !== "read-write"
              ? available(false, "approval-required")
              : screen && screenStatus?.inputVersion !== 1 && physical.state === "ready"
                ? available(false, "helper-unavailable")
                : display,
          navigationButtons: screen
            ? (screenStatus?.navigationButtons ?? [])
            : AndroidPhoneNavigationSchema.options.map((id) => ({ id, label: id })),
          actions: screen
            ? (screenStatus?.actions ?? [])
            : [
                "tap",
                "longPress",
                "swipe",
                "drag",
                "type",
                "clear",
                "navigate",
                "launch",
                "scroll",
                "wake",
                "wait",
              ],
          wake: screen ? (screenStatus?.wake ?? false) : true,
          lock: screen ? (screenStatus?.lock ?? null) : null,
          setup: screen
            ? {
                location: "driver-mac",
                driverRunnerId: screen.runnerId,
                driverRunnerName: screen.runnerName,
              }
            : { location: "android-usb" },
        };
    result.push({
      ...(self ?? {
        access: input.access.get(device.id) ?? null,
        allowedModules: [],
        apps: null,
        computerUse: null,
        detail: null,
        enrollmentId: null,
        expiresAt: null,
        fullDiskAccess: null,
        lastSeenAt: null,
        modules: {},
        pinnedThreads: 0,
        revocable: true,
        runtimeVersion: null,
        status: screenConnected ? "online" : "offline",
      }),
      id: device.id,
      kind: device.kind,
      name: device.name,
      device:
        self?.device ??
        (device.platform && device.form ? { platform: device.platform, form: device.form } : null),
      ownership: device.ownerKind === "user" ? "mine" : "deployment",
      selfRunnerId,
      drivers: [...drivers],
      phoneDisplay,
      capabilities: {
        browser: capability(
          !!self?.modules.browser,
          access.browser,
          self?.modules.browser?.readiness === "ready",
          device.kind !== "home",
        ),
        apps: phoneDisplay
          ? { supported: true, configurable: true, enabled: access.apps, ...phoneDisplay.control }
          : capability(
              !!self?.modules.integrations,
              access.apps,
              self?.modules.integrations?.readiness === "ready",
            ),
        files: capability(
          !!self?.modules.shell,
          access.files,
          self?.modules.shell?.readiness === "ready",
          device.kind !== "home",
        ),
      },
      ...(phone
        ? {
            apps: screen
              ? screenStatus
                ? [{ definitionId: selected, operations: screenStatus.operations }]
                : null
              : (self?.apps ?? null),
            computerUse: {
              ...phoneComputerUse,
              ownerViews: [...(input.computerViews?.get(device.id)?.ownerViews ?? [])],
            },
          }
        : {}),
    });
  }
  return [...result, ...legacy.filter((machine) => machine.status === "pending")];
}
