import {
  runnerRunsItsDeployment,
  type DeploymentDisplayKind,
  type Workspace,
} from "@opensteer/core";
import {
  RunnerModuleNameSchema,
  androidPhoneDefinitionId,
  runnerIntegrationsCompatibilityReason,
  type ComputerUsePermissions,
  type ComputerUseSessionSummary,
  type ComputerView,
  type MachineAppStatus,
  type MachineComputerUse,
  type MachineModuleSummary,
  type MachineSummary,
  type RunnerDevice,
  type RunnerModuleName,
  type RunnerModuleReadiness,
  type RunnerModules,
} from "@opensteer/protocol";
import { browserRuntimeCompatibilityReason } from "../browser/browser-runtime-compatibility.js";
import { unlinkedLocalBindingCount } from "../workspace/runner-local-storage-reconciliation.js";

/** The access section of a machine row, as a management viewer sees it. */
export type MachineAccessView = NonNullable<MachineSummary["access"]>;

/**
 * The Machines projection.
 *
 * A machine is a Runner, so this is a direct projection of the runners table
 * plus what each of that Runner's modules last said about itself. There is
 * nothing to merge: the browser relay and the messaging transport are modules
 * of one identity rather than enrollments a person has to recognise as the
 * same computer.
 */

/** The Runner registry row this projection needs. */
export interface MachineRunnerInput {
  readonly deviceProfile: "iphone" | null;
  readonly phoneUpdate?: "downloading" | "installing" | "awaiting-user" | "failed" | null;
  readonly updateRequired?: "agent-phone-outdated" | "runner-outdated" | null;
  /** The enrollment's grant: what this computer may ever advertise. */
  readonly allowedModules: readonly RunnerModuleName[];
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
  readonly computerUsePolicies?: ReadonlyMap<
    string,
    { readonly appApproval: "ask" | "automatic"; readonly approvalKeyId: string | null }
  >;
  readonly computerViews?: ReadonlyMap<
    string,
    { readonly ownerViews: readonly ComputerView[]; readonly ownerViewVersion?: number }
  >;
  readonly computerUseDisplayStreamSupported?: ReadonlyMap<string, boolean>;
  readonly computerUseSessions?: ReadonlyMap<string, readonly ComputerUseSessionSummary[]>;
  readonly deploymentKind: DeploymentDisplayKind;
  /**
   * Every local-directory Workspace these machines' environments own. A row
   * counts the folders its machine advertised that none of these claims — the
   * Runner's own inventory is the other half of that comparison and already
   * travels in its module descriptor.
   */
  readonly localWorkspaces: readonly Workspace[];
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
  deploymentKind: DeploymentDisplayKind,
): boolean {
  return runnerRunsItsDeployment({
    deploymentIsPersonal: deploymentKind === "personal",
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
    if (
      runner.connected &&
      name === "integrations" &&
      (runner.modules.integrations?.platform === "android" ||
        runner.modules.integrations?.computerAppApprovals)
    ) {
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
): { readonly localWorkspaces: number; readonly pinnedThreads: number } {
  const environmentIds = new Set(runner.modules.agents?.environmentIds ?? []);
  let pinnedThreads = 0;
  for (const environmentId of environmentIds) {
    pinnedThreads += input.threadsByEnvironment.get(environmentId) ?? 0;
  }
  return {
    localWorkspaces: input.localWorkspaces.filter(
      (workspace) =>
        workspace.backing.kind === "local-directory" &&
        environmentIds.has(workspace.backing.ownerEnvironmentId),
    ).length,
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
    approvalKeyId: null,
    displayStreamSupported,
    permissions: null,
    sessions: [...sessions],
  };
  const entry = apps?.find(({ definitionId }) => definitionId === androidPhoneDefinitionId);
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
    readonly approvalKeyId: string | null;
  } = { appApproval: "ask", approvalKeyId: null },
  displayStreamSupported = false,
): MachineComputerUse {
  const { appApproval, approvalKeyId } = policy;
  const entry = apps?.find(({ definitionId }) => definitionId === computerUseDefinitionId);
  if (!entry) {
    return {
      detail: "Computer use needs the Opensteer desktop app on this Mac.",
      permissions: null,
      sessions: [...sessions],
      displayStreamSupported,
      appApproval,
      approvalKeyId,
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
      approvalKeyId,
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
      approvalKeyId,
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
    approvalKeyId,
    state: "permission-required",
  };
}

export function projectMachines(input: MachineProjectionInput): readonly MachineSummary[] {
  const machines: MachineSummary[] = [];

  for (const runner of input.runners) {
    if (runner.revokedAt !== null) continue;
    const personalMain = isPersonalMainRunner(runner, input.deploymentKind);
    const stakes = machineStakes(runner, input);
    const apps = input.apps.get(runner.id);
    machines.push({
      access: input.access.get(runner.id) ?? null,
      allowedModules: [...runner.allowedModules],
      apps: apps?.map((app) => ({ ...app })) ?? null,
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
      lastSeenAt: isoOrNull(runner.lastSeenAt),
      localWorkspaces: stakes.localWorkspaces,
      modules: projectModules(runner),
      name: runner.name,
      ownership:
        runner.ownerKind === "user"
          ? runner.ownedByViewer === false
            ? "other"
            : "mine"
          : "deployment",
      ownerName:
        runner.ownerKind === "user" && runner.ownedByViewer === false ? runner.ownerName : null,
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
      unlinkedLocalFolders: unlinkedLocalBindingCount({
        inventory: runner.modules.agents?.localStorage ?? null,
        workspaces: input.localWorkspaces,
      }),
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
      localWorkspaces: 0,
      modules: pendingModules(enrollment.allowedModules),
      name: enrollment.name,
      ownership: enrollment.ownerKind === "user" ? "mine" : "deployment",
      ownerName: null,
      pinnedThreads: 0,
      revocable: false,
      runtimeVersion: null,
      status: "pending",
      // A computer that has not connected yet has reported nothing to compare.
      unlinkedLocalFolders: 0,
    });
  }

  return machines;
}

/** Whether any connected computer can serve this module right now. */
export function machineModuleIsRoutable(readiness: RunnerModuleReadiness | undefined): boolean {
  return readiness !== undefined && readiness !== "unavailable";
}
