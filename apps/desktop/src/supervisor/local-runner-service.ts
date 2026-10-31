import { logShutdownError, type ShutdownLog } from "../app/desktop-shutdown.js";
import { RestartPolicy } from "@opensteer/shared/restartPolicy";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { assertRegularFile } from "@opensteer/shared/privateFiles";
import { setPrivateDirectoryMode, setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { desktopDeploymentPaths } from "../app/application-paths.js";
import type { UtilityProcess } from "electron";
import {
  DeploymentIdSchema,
  EnvironmentIdSchema,
  RunnerIdSchema,
  harnessCatalog,
  harnessExecutableEnvironmentVariable,
  shipsHarnessRuntimeBytes,
  type DeploymentId,
  type ShippedHarnessKind,
} from "@opensteer/core";
import {
  DesktopStartLocalRunnerInputSchema,
  type DesktopLocalExecutionStatus,
  type DesktopStartLocalRunnerInput,
} from "@opensteer/protocol/desktop";
import {
  ComputerAppSetupRequestSchema,
  type ComputerAppSetupRequest,
} from "@opensteer/integration-core";
import { inspectRunnerIdentity, type RunnerIdentityDescriptor } from "@opensteer/runner";
import { z } from "zod";
import type { DesktopConfiguration } from "../config.js";
import { computerName } from "./computer-name.js";
import type { PersonalLocalBrowserHandle } from "./personal-local-runtime.js";
import { runnerWorkerSecretsMessage } from "./runner-worker-secrets.js";
import {
  LocalRunnerDeploymentUnavailableError,
  type DesktopLocalRunnerTarget,
  type DesktopLocalRunnerTargetAuthority,
  type ComputerUseRunnerTargetResult,
} from "./local-runner-authority.js";
import { readPersonalRuntimeRelease } from "../releases/personal-runtime-release.js";
import {
  NativePersonalUserEnvironment,
  type PersonalUserEnvironmentPort,
} from "./personal-user-environment.js";
import {
  localExecutionStatus,
  PortableFsSetupService,
  unavailableLocalExecutionStatus,
} from "../releases/portablefs-setup.js";

const startupTimeoutMs = 90_000;
const gracefulStopTimeoutMs = 5_000;
/**
 * A killed worker always exits, so this is a bound on a fault rather than a
 * schedule: past it the slot stops waiting, and anything that would delete the
 * slot's files refuses instead.
 */
const forcedStopTimeoutMs = 2_000;
/** How long removal waits for every worker this slot has forked to be gone. */
const removalExitTimeoutMs = 30_000;
const maxLogTailBytes = 64 * 1_024;
const maxLogTailDetailChars = 240;
const maxPreferenceBytes = 64 * 1_024;
/**
 * A crashed worker with the window closed has nobody to press a switch again,
 * so an enrolled computer would stay stopped until the person reopened
 * Opensteer. The attempts are bounded because a Runner that cannot start is a
 * fault to report, not one to hide behind an endless loop.
 */
const maxRestartAttempts = 5;

const notEnrolledDetail = "This Mac is not in this Deployment.";
const neverEnrolledDetail = "This Mac never finished joining; remove it and add it again.";
const revokedDetail = "This Mac was removed from this Deployment.";
const stoppedDetail = "The Runner is stopped on this Mac.";
const removedBeforeConnectedMessage = "This Mac left the Deployment before its Runner connected.";
const stillRunningMessage =
  "The Runner on this Mac is still running, so nothing was deleted. Try again in a moment.";

/**
 * A slot whose Runner never completed enrollment. Terminal on purpose: the
 * token is gone, so only Remove (and adding this Mac again) can fix it.
 */
export class LocalRunnerNeverEnrolledError extends Error {}

const WorkerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    environmentId: EnvironmentIdSchema,
    runnerId: RunnerIdSchema,
    type: z.literal("runner.worker.connected"),
  }),
  z.strictObject({ type: z.literal("runner.worker.reconnecting") }),
  /**
   * The Host refused this Runner's identity as revoked (close code 4010). The
   * computer is gone from the Deployment whether or not the removal reached
   * this app, so the slot is forgotten rather than retried.
   */
  z.strictObject({ type: z.literal("runner.worker.revoked") }),
  z.strictObject({ type: z.literal("runner.worker.stopped") }),
  z.strictObject({
    message: z.string().min(1).max(2_000),
    type: z.literal("runner.worker.failed"),
  }),
]);

/**
 * One Deployment's slot on this Mac. `enrolled` is membership — while it is
 * true the Runner runs whenever the app runs — and `runAgents` is which module
 * set it runs with. Removing the computer deletes the row entirely, because
 * the identity it names is deleted with it.
 */
const RunnerPreferenceSchema = z.strictObject({
  enrolled: z.boolean(),
  runAgents: z.boolean(),
  runnerName: z.string().trim().min(1).max(120),
});

const PreferenceSchema = z
  .strictObject({
    runners: z.record(DeploymentIdSchema, RunnerPreferenceSchema),
    version: z.literal(4),
  })
  .refine((preference) => Object.keys(preference.runners).length <= 100, {
    message: "A Mac can belong to at most 100 Deployments.",
    path: ["runners"],
  });

type Preference = z.infer<typeof PreferenceSchema>;

/** The lending switch this slot state replaced, kept only to be migrated. */
const LegacyPreferenceSchema = z.strictObject({
  runners: z.record(
    DeploymentIdSchema,
    z.strictObject({ enabled: z.boolean(), runnerName: z.string().trim().min(1).max(120) }),
  ),
  version: z.literal(3),
});

export interface UtilityProcessLike {
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  kill(): boolean;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "message", listener: (message: unknown) => void): this;
  once(event: "spawn", listener: () => void): this;
  postMessage(message: unknown): void;
}

export interface LocalRunnerServiceDependencies {
  readonly log?: ShutdownLog;
  /**
   * Starts this computer's browser for one Deployment it runs agents for. It
   * is optional because a headless desktop build runs agents without a
   * browser; when it is present the Runner carries the browser as one of its
   * modules rather than a second machine appearing beside it.
   */
  readonly browser?: (input: {
    readonly logPath: string;
    readonly profileRoot: string;
    readonly runtimeId: string;
  }) => Promise<PersonalLocalBrowserHandle>;
  /**
   * The computer-use bridge for one slot, or null where computer use does not
   * exist. Unlike the browser it is started for **every** enrolled slot,
   * agents or not: computer use reaches a Mac through the `integrations`
   * module, which a reach-only Runner has, so gating it on `runAgents` would
   * tie the feature to a switch about something else.
   */
  readonly computerUse?: {
    startForSlot(
      deploymentId: string,
    ): Promise<{ readonly token: string; readonly url: URL } | null>;
    stopForSlot(deploymentId: string): Promise<void>;
  };
  /** The OS name of this machine, read once. */
  readonly computerName?: () => Promise<string>;
  readonly fork: (
    modulePath: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly serviceName: string;
      readonly stdio: "pipe";
    },
  ) => UtilityProcessLike;
  readonly homeDirectory?: string;
  readonly inspectIdentity?: (dataDirectory: string) => Promise<RunnerIdentityDescriptor | null>;
  readonly portableFs?: Pick<
    PortableFsSetupService,
    "acknowledgeApproval" | "install" | "openSetup" | "requireReadyBinary" | "status"
  >;
  /** How long to wait before the nth restart of a crashed worker. */
  readonly restartDelayMs?: (attempt: number) => number;
  readonly runtimeRelease?: () => Promise<{
    readonly agentSkillsDirectory: string;
    readonly browserHarnessExecutable: string;
    readonly harnessExecutables: Record<ShippedHarnessKind, string>;
    readonly nodeExecutable: string;
  }>;
  /** Bounds on a worker's shutdown; each defaults to the shipped one. */
  readonly stopTimeouts?: {
    readonly forcedMs?: number;
    readonly gracefulMs?: number;
    readonly removalMs?: number;
  };
  readonly targets: DesktopLocalRunnerTargetAuthority;
  readonly userEnvironment?: PersonalUserEnvironmentPort;
}

export interface LocalRunnerSummary {
  readonly deploymentId: DeploymentId;
  readonly runAgents: boolean;
  readonly runnerName: string;
  readonly state: DesktopLocalExecutionStatus["runner"]["state"];
}

interface RunnerSlot {
  /** The module set of the running worker, which a changed `runAgents` restarts. */
  activeRunAgents: boolean | undefined;
  activeTarget: DesktopLocalRunnerTarget | undefined;
  /** The browser this slot's Runner relays, stopped with it. */
  browser: PersonalLocalBrowserHandle | undefined;
  /** Every browser shutdown asked for so far, chained; never dropped. */
  browserShutdown: Promise<void> | undefined;
  child: UtilityProcessLike | undefined;
  /**
   * The Deployment whose computer-use bridge this slot holds, while it holds
   * one. It is kept on the slot rather than read from the active target so a
   * cancelled launch can still give the bridge back: computer use is started
   * for every enrolled slot, and a listener nobody stops is a listener.
   */
  computerUseSlotId: DeploymentId | undefined;
  /** Every computer-use shutdown asked for so far, chained; never dropped. */
  computerUseShutdown: Promise<void> | undefined;
  /** The exit of {@link RunnerSlot.child}, resolved by its exit event alone. */
  childExit: Promise<void> | undefined;
  detail: string;
  desiredEnabled: boolean;
  enrolled: boolean;
  environmentId: DesktopLocalExecutionStatus["runner"]["environmentId"];
  runnerId: DesktopLocalExecutionStatus["runner"]["runnerId"];
  intentGeneration: number;
  mayRunAgents: boolean;
  /**
   * Every worker this slot has forked that has not been seen to exit. A killed
   * child leaves `child` at once so its late messages are ignored, but stays
   * here until its exit event: nothing may delete this slot's identity, host
   * key or browser profiles while one of these is still pending.
   */
  pendingExits: Set<Promise<void>>;
  runAgents: boolean;
  startPromise: Promise<DesktopLocalExecutionStatus> | undefined;
  state: DesktopLocalExecutionStatus["runner"]["state"];
  stopPromise: Promise<void> | undefined;
}

export class LocalRunnerService {
  readonly #log: ShutdownLog;
  readonly #config: DesktopConfiguration;
  readonly #browser: LocalRunnerServiceDependencies["browser"];
  readonly #computerUse: LocalRunnerServiceDependencies["computerUse"];
  readonly #computerName: NonNullable<LocalRunnerServiceDependencies["computerName"]>;
  readonly #fork: LocalRunnerServiceDependencies["fork"];
  readonly #homeDirectory: string;
  readonly #inspectIdentity: NonNullable<LocalRunnerServiceDependencies["inspectIdentity"]>;
  readonly #listeners = new Set<() => void>();
  readonly #portableFs: NonNullable<LocalRunnerServiceDependencies["portableFs"]>;
  readonly #preferenceMutations = new MutationQueue();
  readonly #preferencePath: string;
  /** Failed starts since this Deployment's Runner last connected healthily. */
  readonly #restartPolicies = new Map<DeploymentId, RestartPolicy>();
  readonly #restartDelayMs: LocalRunnerServiceDependencies["restartDelayMs"];
  readonly #restartTimers = new Map<DeploymentId, ReturnType<typeof setTimeout>>();
  readonly #runners = new Map<DeploymentId, RunnerSlot>();
  readonly #runtimeRelease: NonNullable<LocalRunnerServiceDependencies["runtimeRelease"]>;
  readonly #stopTimeouts: Required<NonNullable<LocalRunnerServiceDependencies["stopTimeouts"]>>;
  readonly #targets: DesktopLocalRunnerTargetAuthority;
  readonly #unsubscribeTargets: () => void;
  readonly #userEnvironment: PersonalUserEnvironmentPort;
  #reconcileTail: Promise<void> = Promise.resolve();
  #shuttingDown = false;

  constructor(config: DesktopConfiguration, dependencies: LocalRunnerServiceDependencies) {
    this.#log =
      dependencies.log ?? ((event, fields) => console.info(JSON.stringify({ event, ...fields })));
    this.#config = config;
    this.#browser = dependencies.browser;
    this.#computerUse = dependencies.computerUse;
    this.#computerName = dependencies.computerName ?? computerName;
    this.#fork = dependencies.fork;
    this.#homeDirectory = path.resolve(dependencies.homeDirectory ?? homedir());
    this.#inspectIdentity = dependencies.inspectIdentity ?? inspectRunnerIdentity;
    this.#runtimeRelease =
      dependencies.runtimeRelease ??
      (async () => {
        try {
          const release = await readPersonalRuntimeRelease(config.personal.releaseDirectory);
          return {
            agentSkillsDirectory: release.assets.agentSkills,
            browserHarnessExecutable: release.entrypoints.browserHarness,
            harnessExecutables: release.harnesses,
            nodeExecutable: release.entrypoints.node,
          };
        } catch (error) {
          throw new Error(
            "The bundled Personal agent runtime is unavailable. Repair or reinstall Opensteer before enabling local agents.",
            { cause: error },
          );
        }
      });
    this.#portableFs = dependencies.portableFs ?? new PortableFsSetupService(config.localExecution);
    this.#preferencePath = path.join(config.localExecution.dataDirectory, "desktop-runner.json");
    this.#restartDelayMs = dependencies.restartDelayMs;
    this.#stopTimeouts = {
      forcedMs: dependencies.stopTimeouts?.forcedMs ?? forcedStopTimeoutMs,
      gracefulMs: dependencies.stopTimeouts?.gracefulMs ?? gracefulStopTimeoutMs,
      removalMs: dependencies.stopTimeouts?.removalMs ?? removalExitTimeoutMs,
    };
    this.#targets = dependencies.targets;
    this.#userEnvironment = dependencies.userEnvironment ?? new NativePersonalUserEnvironment();
    this.#unsubscribeTargets = config.localExecution.enabled
      ? this.#targets.subscribe(() => void this.reconcile())
      : () => undefined;
  }

  async assertComputerAppSetupTarget(requestInput: ComputerAppSetupRequest): Promise<void> {
    this.#assertEnabled();
    const request = ComputerAppSetupRequestSchema.parse(requestInput);
    const target = await this.checkComputerUseRunnerTarget(request.deploymentId, request.runnerId);
    if (!target.local)
      throw new Error("Computer app setup does not target this Mac's current enrolled Runner");
  }

  async checkComputerUseRunnerTarget(
    deploymentId: string,
    runnerId: string,
  ): Promise<ComputerUseRunnerTargetResult> {
    if (!this.#config.localExecution.enabled) return { local: false, reason: "not-local" };
    const parsedDeploymentId = DeploymentIdSchema.parse(deploymentId);
    let target: DesktopLocalRunnerTarget;
    try {
      target = await this.#targets.resolve(parsedDeploymentId);
    } catch (error) {
      if (error instanceof LocalRunnerDeploymentUnavailableError)
        return { local: false, reason: "deployment-changed" };
      throw error;
    }
    const identity = await this.#inspectIdentity(this.#deploymentDataDirectory(parsedDeploymentId));
    if (!identity?.enrolled || identity.runnerId !== runnerId) {
      return { local: false, reason: "not-local" };
    }
    if (!(await this.#targets.isCurrent(target))) {
      return { local: false, reason: "deployment-changed" };
    }
    return { local: true };
  }

  async status(deploymentIdInput: DeploymentId | string): Promise<DesktopLocalExecutionStatus> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    if (!this.#config.localExecution.enabled) {
      return unavailableLocalExecutionStatus(deploymentId, await this.#computerName());
    }
    const slot = this.#slot(deploymentId);
    if (!slot.child && !slot.stopPromise && slot.state !== "failed") {
      let target: DesktopLocalRunnerTarget | null = null;
      try {
        target = await this.#targets.resolve(deploymentId);
      } catch {
        target = null;
      }
      slot.mayRunAgents = target?.mayRunAgents ?? false;
      // With no worker running, the durable slot is what this Deployment will
      // get when one starts, so the status reads it rather than the last
      // in-memory guess.
      const preference = await readPreference(this.#preferencePath);
      const stored = preference.runners[deploymentId];
      slot.runAgents = (stored?.enrolled ?? false) && stored?.runAgents === true;
      const identity = target
        ? await this.#inspectIdentity(this.#deploymentDataDirectory(deploymentId))
        : null;
      if (target && (await this.#targets.isCurrent(target)) && identity) {
        slot.enrolled = identity.enrolled;
        slot.environmentId = identity.environmentId;
        slot.runnerId = identity.runnerId;
      } else {
        this.#resetIdentity(slot);
      }
      if (target && !(await this.#targets.isCurrent(target))) {
        throw new Error("The deployment route changed while this computer's status was read.");
      }
    }
    const [computer, portableFs] = await Promise.all([
      this.#computerName(),
      this.#portableFs.status(),
    ]);
    return localExecutionStatus(deploymentId, portableFs, this.#runnerSnapshot(slot), {
      computerName: computer,
      mayRunAgents: slot.mayRunAgents,
      runAgents: slot.runAgents,
    });
  }

  /**
   * Enrols this Mac in a Deployment, and is equally the way its module set is
   * changed afterwards: starting an enrolled slot with the other `runAgents`
   * restarts the Runner, leaving the identity, data directory and host key
   * exactly where they are.
   */
  async start(input: DesktopStartLocalRunnerInput): Promise<DesktopLocalExecutionStatus> {
    this.#assertEnabled();
    const parsed = DesktopStartLocalRunnerInputSchema.parse(input);
    this.#cancelRestart(parsed.deploymentId);
    const slot = this.#slot(parsed.deploymentId);
    const intentGeneration = this.#enableIntent(slot);
    try {
      await this.#reconcileTail;
      this.#assertCurrentIntent(slot, intentGeneration);
      const target = await this.#targets.resolve(parsed.deploymentId);
      this.#assertCurrentIntent(slot, intentGeneration);
      if (parsed.runAgents && !target.mayRunAgents) {
        throw new Error("A Personal Deployment runs agents only on the Mac that hosts it.");
      }
      slot.mayRunAgents = target.mayRunAgents;
      slot.runAgents = parsed.runAgents;
      // Membership is durable before the worker exists. A crash between the
      // Runner saving its enrolled identity and this app hearing about it
      // would otherwise leave a computer the Deployment lists and this Mac
      // never starts again — and, on Personal, with no switch to press.
      await this.#mutatePreference((preference) => ({
        ...preference,
        runners: {
          ...preference.runners,
          [parsed.deploymentId]: {
            enrolled: true,
            runAgents: parsed.runAgents,
            runnerName: parsed.runnerName,
          },
        },
      }));
      this.#assertCurrentIntent(slot, intentGeneration);
      return await this.#start(
        target,
        parsed.runnerName,
        parsed.enrollmentToken,
        parsed.runAgents,
        intentGeneration,
      );
    } catch (error) {
      if (this.#intentIsCurrent(slot, intentGeneration)) this.#disableIntent(slot);
      throw error;
    }
  }

  async startIfEnabled(): Promise<void> {
    if (!this.#config.localExecution.enabled) return;
    await this.reconcile();
  }

  /**
   * The removal path, called when a person takes this Mac out of a Deployment:
   * the Runner stops and the slot is forgotten, identity and SSH host key
   * included, so re-adding it later is a new computer rather than a revived
   * one.
   */
  async remove(deploymentIdInput: DeploymentId | string): Promise<DesktopLocalExecutionStatus> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    if (!this.#config.localExecution.enabled) return this.status(deploymentId);
    const slot = this.#slot(deploymentId);
    this.#disableIntent(slot);
    this.#cancelRestart(deploymentId);
    await this.#reconcileTail;
    await this.#forgetSlot(deploymentId, slot, notEnrolledDetail);
    return this.status(deploymentId);
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    this.#shuttingDown = true;
    for (const deploymentId of this.#restartPolicies.keys()) this.#cancelRestart(deploymentId);
    for (const slot of this.#runners.values()) this.#disableIntent(slot);
    const force = () => {
      for (const slot of this.#runners.values()) slot.child?.kill();
    };
    signal?.addEventListener("abort", force, { once: true });
    if (signal?.aborted) force();
    try {
      await this.#reconcileTail;
      await Promise.all([...this.#runners.values()].map((slot) => this.#stop(slot)));
    } finally {
      signal?.removeEventListener("abort", force);
    }
  }

  async reconcile(): Promise<void> {
    if (this.#shuttingDown || !this.#config.localExecution.enabled) return;
    const operation = this.#reconcileTail.then(() => this.#reconcileEnabled());
    this.#reconcileTail = operation.catch((error: unknown) => {
      for (const slot of this.#runners.values()) {
        if (!slot.child && !slot.startPromise) continue;
        slot.state = "failed";
        slot.detail = safeDetail(error);
      }
      this.#emit();
    });
    return this.#reconcileTail;
  }

  async enrolledRunners(): Promise<readonly LocalRunnerSummary[]> {
    const preference = await readPreference(this.#preferencePath);
    return Object.entries(preference.runners)
      .filter((entry) => entry[1].enrolled)
      .map(([deploymentId, runner]) => ({
        deploymentId: DeploymentIdSchema.parse(deploymentId),
        runAgents: runner.runAgents,
        runnerName: runner.runnerName,
        state: this.#runners.get(DeploymentIdSchema.parse(deploymentId))?.state ?? "disabled",
      }));
  }

  async hasEnrolledRunners(): Promise<boolean> {
    const preference = await readPreference(this.#preferencePath);
    return Object.values(preference.runners).some(({ enrolled }) => enrolled);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#shuttingDown = true;
    this.#unsubscribeTargets();
    for (const deploymentId of this.#restartPolicies.keys()) this.#cancelRestart(deploymentId);
    this.#listeners.clear();
  }

  portableFs(): NonNullable<LocalRunnerServiceDependencies["portableFs"]> {
    this.#assertEnabled();
    return this.#portableFs;
  }

  #assertEnabled(): void {
    if (!this.#config.localExecution.enabled) {
      throw new Error("This Opensteer release does not include local agent support.");
    }
  }

  async #reconcileEnabled(): Promise<void> {
    const preference = await readPreference(this.#preferencePath);
    await Promise.all(
      Object.entries(preference.runners).map(async ([deploymentIdValue, runner]) => {
        if (!runner.enrolled || this.#shuttingDown) return;
        const deploymentId = DeploymentIdSchema.parse(deploymentIdValue);
        const slot = this.#slot(deploymentId);
        const intentGeneration = this.#enableIntent(slot);
        let target: DesktopLocalRunnerTarget;
        try {
          target = await this.#targets.resolve(deploymentId);
        } catch (error) {
          await this.#stop(slot);
          if (error instanceof LocalRunnerDeploymentUnavailableError) {
            await this.#removePreference(deploymentId);
            this.#disableIntent(slot);
            this.#cancelRestart(deploymentId);
            slot.detail = "The Deployment was removed from this computer.";
            slot.state = "disabled";
          } else {
            slot.detail = safeDetail(error);
            slot.state = "failed";
          }
          this.#emit();
          return;
        }
        slot.mayRunAgents = target.mayRunAgents;
        // A grant that no longer allows agents wins over the stored intent:
        // the Runner still runs, reach-only, rather than being refused.
        const runAgents = runner.runAgents && target.mayRunAgents;
        slot.runAgents = runAgents;
        if (
          slot.activeTarget?.key === target.key &&
          slot.activeRunAgents === runAgents &&
          (slot.child || slot.startPromise) &&
          slot.state !== "failed"
        ) {
          return;
        }
        if (slot.child || slot.startPromise) {
          const starting = slot.startPromise;
          await this.#stop(slot);
          await starting?.catch(() => undefined);
        }
        try {
          await this.#start(target, runner.runnerName, undefined, runAgents, intentGeneration);
        } catch (error) {
          slot.detail = safeDetail(error);
          slot.state = "failed";
          this.#emit();
          // A slot that never finished joining holds no identity and no token
          // — the token is never written down — so retrying is a loop with a
          // dead credential. It waits for Remove instead.
          if (error instanceof LocalRunnerNeverEnrolledError) {
            this.#disableIntent(slot);
            this.#cancelRestart(deploymentId);
          } else {
            this.#scheduleRestart(deploymentId);
          }
        }
      }),
    );
  }

  async #start(
    target: DesktopLocalRunnerTarget,
    runnerName: string,
    enrollmentToken: string | undefined,
    runAgents: boolean,
    intentGeneration: number,
  ): Promise<DesktopLocalExecutionStatus> {
    const slot = this.#slot(target.deploymentId);
    this.#assertCurrentIntent(slot, intentGeneration);
    if (slot.startPromise) {
      if (slot.activeTarget?.key !== target.key) {
        throw new Error("The deployment route changed while this computer connected.");
      }
      if (slot.activeRunAgents === runAgents) return slot.startPromise;
      // The module set is settled by the worker that is already coming up, so
      // the switch waits for it rather than racing two launches.
      await slot.startPromise.catch(() => undefined);
      this.#assertCurrentIntent(slot, intentGeneration);
    }
    if (slot.stopPromise) await slot.stopPromise;
    if (slot.child && (slot.state === "running" || slot.state === "starting")) {
      if (slot.activeTarget?.key === target.key && slot.activeRunAgents === runAgents) {
        return this.status(target.deploymentId);
      }
      await this.#stop(slot);
    }
    const operation = this.#launch(
      slot,
      target,
      runnerName,
      enrollmentToken,
      runAgents,
      intentGeneration,
    );
    slot.startPromise = operation;
    void operation.then(
      () => {
        if (slot.startPromise === operation) slot.startPromise = undefined;
      },
      () => {
        if (slot.startPromise === operation) slot.startPromise = undefined;
      },
    );
    return operation;
  }

  async #launch(
    slot: RunnerSlot,
    target: DesktopLocalRunnerTarget,
    runnerName: string,
    enrollmentToken: string | undefined,
    runAgents: boolean,
    intentGeneration: number,
  ): Promise<DesktopLocalExecutionStatus> {
    this.#assertCurrentIntent(slot, intentGeneration);
    if (!(await this.#targets.isCurrent(target))) {
      slot.state = "failed";
      slot.detail = "The deployment route changed before this computer could connect.";
      throw new Error(slot.detail);
    }
    this.#assertCurrentIntent(slot, intentGeneration);
    // Local directories are the baseline a machine that runs agents always
    // offers. PortableFS is added only when it is genuinely ready, so a
    // computer with no FUSE or FSKit can still run agents and still do work. A
    // reach-only Runner mounts nothing at all, so it asks for neither.
    const mountBinary = runAgents
      ? await this.#portableFs
          .requireReadyBinary()
          .then((binary) => binary as string | null)
          .catch(() => null)
      : null;
    const [runtimeRelease, userEnvironment] = await Promise.all([
      this.#runtimeRelease(),
      this.#userEnvironment.resolve(),
    ]);
    this.#assertCurrentIntent(slot, intentGeneration);
    // Reach-only needs the SSH helper, the interpreter, and the worker; the
    // execution assets are neither started nor checked, so a computer whose
    // agent runtime is missing is still reachable.
    await Promise.all([
      assertRegularExecutable(
        this.#config.localExecution.nativeFsHelperBinary,
        "Native filesystem helper",
      ),
      assertRegularExecutable(runtimeRelease.nodeExecutable, "Bundled Node interpreter"),
      assertRegularFile(this.#config.localExecution.runnerWorkerPath, "Agent worker"),
      ...(runAgents
        ? [
            assertRegularDirectory(runtimeRelease.agentSkillsDirectory, "Bundled agent skills"),
            assertRegularExecutable(runtimeRelease.browserHarnessExecutable, "Browser Harness"),
            // An engine the person installs themselves has no bytes in this
            // release to check; its driver reports what it finds on the machine.
            ...harnessCatalog
              .filter(shipsHarnessRuntimeBytes)
              .map((entry) =>
                entry.runtime.shape === "script"
                  ? assertRegularFile(
                      runtimeRelease.harnessExecutables[entry.kind],
                      `${entry.label} harness`,
                    )
                  : assertRegularExecutable(
                      runtimeRelease.harnessExecutables[entry.kind],
                      `${entry.label} harness`,
                    ),
              ),
          ]
        : []),
    ]);
    const runnerDataDirectory = this.#deploymentDataDirectory(target.deploymentId);
    // The enrollment token is handed over once and never written down, so a
    // slot with no enrolled identity and no token in hand cannot become a
    // computer by being started again.
    if (!enrollmentToken && !(await this.#inspectIdentity(runnerDataDirectory))?.enrolled) {
      slot.state = "failed";
      slot.detail = neverEnrolledDetail;
      this.#emit();
      throw new LocalRunnerNeverEnrolledError(neverEnrolledDetail);
    }
    await mkdir(runnerDataDirectory, { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(runnerDataDirectory);
    slot.state = "starting";
    slot.detail = "Connecting this Mac to Opensteer…";
    slot.environmentId = null;
    slot.runnerId = null;
    this.#emit();
    // The browser starts before the Runner that relays it, and belongs to the
    // same machine identity: one computer, two modules.
    const browser =
      runAgents && this.#browser
        ? await this.#browser({
            logPath: path.join(runnerDataDirectory, "browser.log"),
            profileRoot: desktopDeploymentPaths(this.#config.dataDirectory, target.deploymentId)
              .browserProfilesDirectory,
            runtimeId: `desktop-browser:${target.deploymentId}`,
          })
        : undefined;
    slot.browser = browser;
    // Computer use is started for this slot whether or not it runs agents:
    // the `integrations` module a reach-only Runner already has is what
    // carries the computer-use frame.
    const computerUse = (await this.#computerUse?.startForSlot(target.deploymentId)) ?? undefined;
    slot.computerUseSlotId = computerUse ? target.deploymentId : undefined;
    const environment = runnerEnvironment({
      ...(browser ? { browser } : {}),
      ...(computerUse ? { computerUse } : {}),
      baseEnvironment: userEnvironment,
      config: this.#config,
      deploymentShape: target.deploymentShape,
      hostUrl: target.hostUrl,
      homeDirectory: this.#homeDirectory,
      nodeExecutable: runtimeRelease.nodeExecutable,
      runnerDataDirectory,
      runnerName,
      ...(runAgents
        ? {
            execution: {
              agentSkillsDirectory: runtimeRelease.agentSkillsDirectory,
              browserHarnessExecutable: runtimeRelease.browserHarnessExecutable,
              harnessExecutables: runtimeRelease.harnessExecutables,
              // One managed root per Deployment under the user's own home,
              // mirroring the Personal convention, so a person can find their
              // agents' files where they would look for any other folder.
              localWorkspaceRoot: path.join(
                this.#homeDirectory,
                "Opensteer",
                "Workspaces",
                target.deploymentId,
              ),
              mountBinary,
            },
          }
        : {}),
    });
    const child = this.#fork(this.#config.localExecution.runnerWorkerPath, [], {
      cwd: runnerDataDirectory,
      env: environment,
      serviceName: `Opensteer (${runnerName})`,
      stdio: "pipe",
    });
    // Record the exit before sending credentials or checking the route: every
    // failure after fork must still be able to reap this worker.
    const exit = Promise.withResolvers<void>();
    const exited = exit.promise;
    slot.pendingExits.add(exited);
    void exited.then(() => slot.pendingExits.delete(exited));
    slot.child = child;
    slot.childExit = exited;
    slot.activeRunAgents = runAgents;
    slot.activeTarget = target;

    /**
     * Two lifetimes run through this worker and only one of them ends. The
     * start call is answered once — connected, cancelled, or failed — while the
     * child keeps reporting for as long as it lives. Settling the startup
     * promise therefore must not stop the slot and the tray from following the
     * child: a reconnect after a disconnect has to read as running again, and a
     * failure reported long after startup still has to mark the slot failed.
     */
    return new Promise<DesktopLocalExecutionStatus>((resolvePromise, rejectPromise) => {
      let statusGeneration = 0;
      let startupSettled = false;
      const timer = setTimeout(() => {
        fail(new Error("This Mac could not connect to the Host in time."));
      }, startupTimeoutMs);
      timer.unref();
      /** True the one time it closes the startup window. */
      const settleStartup = (): boolean => {
        if (startupSettled) return false;
        startupSettled = true;
        clearTimeout(timer);
        return true;
      };
      let logTail = (): string => "";
      let tearingDown = false;
      const verified = Promise.withResolvers<void>();
      void verified.promise.catch(() => undefined);
      const teardown = (error: unknown, cancelled: boolean): void => {
        if (slot.child !== child || tearingDown) return;
        tearingDown = true;
        const startupPending = settleStartup();
        ++statusGeneration;
        verified.reject(error);
        child.kill();
        this.#dropChild(slot, child);
        // Startup owns these resources until all three have ended. Its caller
        // must not receive the error, or start a replacement, before then.
        const cleanup = Promise.all([
          exited,
          stopSlotBrowser(slot, this.#log),
          this.#stopSlotComputerUse(slot),
        ]).then(() => {
          if (slot.activeTarget?.key === target.key) {
            slot.activeRunAgents = undefined;
            slot.activeTarget = undefined;
          }
          slot.state = cancelled ? "disabled" : "failed";
          slot.detail = cancelled ? notEnrolledDetail : withLogTail(safeDetail(error), logTail());
          this.#emit();
          if (startupPending) rejectPromise(error);
          else if (!cancelled) this.#scheduleRestart(target.deploymentId);
        });
        slot.stopPromise = cleanup;
        void cleanup.then(() => {
          if (slot.stopPromise === cleanup) slot.stopPromise = undefined;
        });
      };
      const fail = (error: unknown): void => teardown(error, false);
      const cancel = (): void => teardown(new Error(removedBeforeConnectedMessage), true);

      void (async () => {
        try {
          child.on("exit", () => exit.resolve());
          logTail = boundedLogTail([child.stdout, child.stderr]);
          child.on("message", (value) => {
            void (async () => {
              const parsed = WorkerMessageSchema.safeParse(value);
              if (!parsed.success || slot.child !== child) return;
              if (parsed.data.type === "runner.worker.stopped" && slot.state === "stopping") {
                // Daemon cleanup has finished. A referenced native handle must
                // not turn this acknowledgement into a fixed graceful wait.
                child.kill();
                return;
              }
              await verified.promise;
              if (slot.child !== child) return;
              const messageGeneration = ++statusGeneration;
              switch (parsed.data.type) {
                case "runner.worker.connected": {
                  if (slot.state === "stopping" && startupSettled) return;
                  if (!this.#intentIsCurrent(slot, intentGeneration)) {
                    cancel();
                    return;
                  }
                  const currentTarget = await this.#targets.isCurrent(target);
                  if (messageGeneration !== statusGeneration || slot.child !== child) return;
                  if (!currentTarget) {
                    fail(new Error("The deployment route changed while this computer connected."));
                    return;
                  }
                  if (!this.#intentIsCurrent(slot, intentGeneration)) {
                    cancel();
                    return;
                  }
                  if (slot.child !== child) return;
                  slot.enrolled = true;
                  slot.state = "running";
                  slot.detail = runAgents
                    ? "This Mac is connected and running agents."
                    : "This Mac is connected.";
                  slot.environmentId = parsed.data.environmentId;
                  slot.runnerId = parsed.data.runnerId;
                  this.#restartPolicy(target.deploymentId).markStarted();
                  this.#emit();
                  if (startupSettled) return;
                  if (!this.#intentIsCurrent(slot, intentGeneration)) {
                    cancel();
                    return;
                  }
                  if (!(await this.#targets.isCurrent(target))) {
                    throw new Error("The deployment route changed while this computer connected.");
                  }
                  const status = await this.status(target.deploymentId);
                  if (messageGeneration !== statusGeneration || slot.child !== child) return;
                  if (settleStartup()) resolvePromise(status);
                  break;
                }
                case "runner.worker.reconnecting":
                  if (slot.state === "stopping" && startupSettled) return;
                  if (!this.#intentIsCurrent(slot, intentGeneration)) {
                    cancel();
                    return;
                  }
                  if (slot.child !== child) return;
                  this.#restartPolicies.get(target.deploymentId)?.dispose();
                  slot.state = "starting";
                  slot.detail = "Reconnecting this Mac to the Host…";
                  this.#emit();
                  break;
                case "runner.worker.revoked": {
                  if (slot.child !== child) return;
                  // The web revokes at the Host first and calls this app second.
                  // Either order ends here, so a removal that never reached this
                  // Mac — the app was closed, the call failed — still finishes.
                  this.#disableIntent(slot);
                  this.#cancelRestart(target.deploymentId);
                  // The waiting caller is answered before the slot is torn down,
                  // so the teardown's wait for this launch cannot wait on itself.
                  if (settleStartup()) rejectPromise(new Error(revokedDetail));
                  await this.#forgetSlot(target.deploymentId, slot, revokedDetail);
                  break;
                }
                case "runner.worker.failed":
                  fail(new Error(parsed.data.message));
                  break;
                case "runner.worker.stopped":
                  // A worker that stops on its own, rather than answering the stop
                  // this service sent, has failed whether or not it ever connected.
                  if (slot.state !== "stopping" && slot.state !== "disabled") {
                    fail(new Error("The Runner stopped unexpectedly."));
                  }
                  break;
              }
            })().catch(fail);
          });
          child.on("exit", (code) => {
            if (slot.child !== child || tearingDown) return;
            if (!startupSettled) {
              fail(new Error(`The Runner stopped before it was ready (exit ${code}).`));
              return;
            }
            this.#dropChild(slot, child);
            void stopSlotBrowser(slot, this.#log);
            void this.#stopSlotComputerUse(slot);
            if (slot.activeTarget?.key === target.key) slot.activeTarget = undefined;
            if (slot.state !== "stopping" && slot.state !== "disabled" && slot.state !== "failed") {
              slot.state = "failed";
              slot.detail = withLogTail(
                `The Runner stopped unexpectedly (exit ${code}).`,
                logTail(),
              );
              this.#emit();
              this.#scheduleRestart(target.deploymentId);
            }
          });
          // Credentials are the first message the worker receives, after its
          // entire lifecycle (including failure cleanup) has an owner.
          child.postMessage(
            runnerWorkerSecretsMessage(
              runnerSecrets({
                ...(browser ? { browser } : {}),
                ...(computerUse ? { computerUse } : {}),
                enrollmentToken,
              }),
            ),
          );
          if (!this.#intentIsCurrent(slot, intentGeneration)) {
            cancel();
            return;
          }
          const currentTarget = await this.#targets.isCurrent(target);
          if (!this.#intentIsCurrent(slot, intentGeneration)) {
            cancel();
            return;
          }
          if (!currentTarget) {
            fail(new Error("The deployment route changed while this computer connected."));
            return;
          }
          verified.resolve();
        } catch (error) {
          fail(error);
        }
      })();
    });
  }

  /**
   * Asks the worker to stop and waits for its exit: graceful first, then a
   * kill, and the exit event either way — a killed process always exits, so
   * the bound past it is a fault report, not a schedule. The exit stays on the
   * slot's pending set until it actually happens, so a stop that gave up
   * cannot let anything delete the files that process still holds.
   */
  async #stop(slot: RunnerSlot): Promise<void> {
    if (slot.stopPromise) return slot.stopPromise;
    const child = slot.child;
    const exited = slot.childExit;
    if (!child || !exited) {
      await stopSlotBrowser(slot, this.#log);
      await this.#stopSlotComputerUse(slot);
      return;
    }
    const target = slot.activeTarget;
    slot.state = "stopping";
    slot.detail = "Stopping the Runner on this Mac…";
    this.#emit();
    slot.stopPromise = (async () => {
      await stopSlotBrowser(slot, this.#log);
      child.postMessage({ type: "runner.worker.stop" });
      let gone = await exitedWithin(exited, this.#stopTimeouts.gracefulMs);
      if (!gone) {
        child.kill();
        gone = await exitedWithin(exited, this.#stopTimeouts.forcedMs);
      }
      // A worker that has not been seen to exit is still this slot's worker:
      // dropping the handle here would hide a live process from everything
      // that reads the slot afterwards.
      if (gone) this.#dropChild(slot, child);
      await stopSlotBrowser(slot, this.#log);
      await this.#stopSlotComputerUse(slot);
      if (target && slot.activeTarget?.key === target.key) {
        slot.activeRunAgents = undefined;
        slot.activeTarget = undefined;
      }
      slot.stopPromise = undefined;
      if (slot.state === "stopping") {
        slot.state = "disabled";
        slot.detail = stoppedDetail;
      }
      this.#emit();
    })();
    return slot.stopPromise;
  }

  /**
   * Gives this slot's computer-use bridge back, chained onto the slot so a
   * caller that cannot wait — a cancelled launch, a crash — still leaves
   * something for removal to wait on.
   */
  #stopSlotComputerUse(slot: RunnerSlot): Promise<void> {
    const deploymentId = slot.computerUseSlotId;
    slot.computerUseSlotId = undefined;
    const previous = slot.computerUseShutdown ?? Promise.resolve();
    const service = this.#computerUse;
    if (!deploymentId || !service) return previous;
    const shutdown = previous.then(() =>
      service
        .stopForSlot(deploymentId)
        .catch((error: unknown) =>
          logShutdownError(this.#log, "computer-use", `stop-slot:${deploymentId}`, error),
        ),
    );
    slot.computerUseShutdown = shutdown;
    return shutdown;
  }

  /**
   * Stops following a worker without forgetting that it is still alive: the
   * handle goes, its entry in {@link RunnerSlot.pendingExits} stays until the
   * exit event removes it.
   */
  #dropChild(slot: RunnerSlot, child: UtilityProcessLike): void {
    if (slot.child !== child) return;
    slot.child = undefined;
    slot.childExit = undefined;
  }

  /**
   * Ends this Mac's membership: the pending launch is cancelled and awaited,
   * the worker's exit and its browser's shutdown are awaited, and only then is
   * the slot's identity and SSH host key deleted. Nothing is removed from disk
   * while a process that owns it is still alive.
   */
  async #forgetSlot(deploymentId: DeploymentId, slot: RunnerSlot, detail: string): Promise<void> {
    // Stopping first is what ends a launch in flight: the worker's exit
    // settles the startup promise. The second stop covers the launch that won
    // the race and left a connected worker behind.
    await this.#stop(slot);
    const starting = slot.startPromise;
    // Bounded like every other wait here: a launch whose worker will not die
    // must not hold the removal open until the startup timeout.
    if (starting) {
      await exitedWithin(
        starting.catch(() => undefined),
        this.#stopTimeouts.removalMs,
      );
    }
    await this.#stop(slot);
    const pending = [...slot.pendingExits];
    if (
      pending.length > 0 &&
      !(await exitedWithin(Promise.all(pending), this.#stopTimeouts.removalMs))
    ) {
      // Refusing is the honest answer: deleting an identity and an SSH host
      // key under a process that still holds them is how a computer comes back
      // with half a slot.
      throw new Error(stillRunningMessage);
    }
    await slot.browserShutdown;
    await slot.computerUseShutdown;
    await this.#removePreference(deploymentId);
    await rm(this.#deploymentDataDirectory(deploymentId), { force: true, recursive: true });
    this.#resetIdentity(slot);
    slot.runAgents = false;
    slot.detail = detail;
    slot.state = "disabled";
    this.#emit();
  }

  #slot(deploymentId: DeploymentId): RunnerSlot {
    const existing = this.#runners.get(deploymentId);
    if (existing) return existing;
    const created: RunnerSlot = {
      activeRunAgents: undefined,
      activeTarget: undefined,
      browser: undefined,
      browserShutdown: undefined,
      child: undefined,
      childExit: undefined,
      computerUseShutdown: undefined,
      computerUseSlotId: undefined,
      detail: notEnrolledDetail,
      desiredEnabled: false,
      enrolled: false,
      environmentId: null,
      runnerId: null,
      intentGeneration: 0,
      mayRunAgents: false,
      pendingExits: new Set(),
      runAgents: false,
      startPromise: undefined,
      state: "disabled",
      stopPromise: undefined,
    };
    this.#runners.set(deploymentId, created);
    return created;
  }

  #runnerSnapshot(slot: RunnerSlot): DesktopLocalExecutionStatus["runner"] {
    return {
      detail: slot.detail,
      enrolled: slot.enrolled,
      environmentId: slot.environmentId,
      runnerId: slot.runnerId,
      state: slot.state,
    };
  }

  #deploymentDataDirectory(deploymentId: DeploymentId): string {
    return path.join(this.#config.localExecution.dataDirectory, "deployments", deploymentId);
  }

  /**
   * Brings a crashed worker back while this Mac is still enrolled. `reconcile`
   * is the one path that starts a Runner, so this only decides when to ask it
   * again; a removed computer, a closing app, or a Deployment that left the
   * catalog cancels the attempt there.
   */
  #scheduleRestart(deploymentId: DeploymentId): void {
    if (this.#shuttingDown || this.#restartTimers.has(deploymentId)) return;
    const slot = this.#slot(deploymentId);
    if (!slot.desiredEnabled) return;
    const policy = this.#restartPolicy(deploymentId);
    const delayMs = policy.nextDelayMs();
    if (delayMs === null) {
      slot.detail = `${slot.detail} It has been restarted ${maxRestartAttempts} times without staying connected, so it is left stopped until Opensteer is restarted.`;
      this.#emit();
      return;
    }
    const timer = setTimeout(
      () => {
        this.#restartTimers.delete(deploymentId);
        void this.reconcile();
      },
      this.#restartDelayMs?.(policy.attempt) ?? delayMs,
    );
    timer.unref();
    this.#restartTimers.set(deploymentId, timer);
  }

  #restartPolicy(deploymentId: DeploymentId): RestartPolicy {
    const existing = this.#restartPolicies.get(deploymentId);
    if (existing) return existing;
    const policy = new RestartPolicy({
      baseMs: 1_000,
      maximumAttempts: maxRestartAttempts,
      maximumMs: 30_000,
      resetAfterMs: 60_000,
    });
    this.#restartPolicies.set(deploymentId, policy);
    return policy;
  }

  #cancelRestart(deploymentId: DeploymentId): void {
    const timer = this.#restartTimers.get(deploymentId);
    if (timer) clearTimeout(timer);
    this.#restartTimers.delete(deploymentId);
    this.#restartPolicies.get(deploymentId)?.dispose();
    this.#restartPolicies.delete(deploymentId);
  }

  #resetIdentity(slot: RunnerSlot): void {
    slot.enrolled = false;
    slot.environmentId = null;
    slot.runnerId = null;
  }

  #enableIntent(slot: RunnerSlot): number {
    if (!slot.desiredEnabled) {
      slot.desiredEnabled = true;
      slot.intentGeneration += 1;
    }
    return slot.intentGeneration;
  }

  #disableIntent(slot: RunnerSlot): void {
    slot.desiredEnabled = false;
    slot.intentGeneration += 1;
  }

  #intentIsCurrent(slot: RunnerSlot, generation: number): boolean {
    return slot.desiredEnabled && slot.intentGeneration === generation;
  }

  #assertCurrentIntent(slot: RunnerSlot, generation: number): void {
    if (this.#shuttingDown || !this.#intentIsCurrent(slot, generation)) {
      throw new Error(removedBeforeConnectedMessage);
    }
  }

  async #removePreference(deploymentId: DeploymentId): Promise<void> {
    await this.#mutatePreference((preference) => {
      if (!preference.runners[deploymentId]) return preference;
      const runners = { ...preference.runners };
      delete runners[deploymentId];
      return { ...preference, runners };
    });
  }

  async #mutatePreference(mutate: (preference: Preference) => Preference): Promise<void> {
    await this.#preferenceMutations.run(async () => {
      const current = await readPreference(this.#preferencePath);
      const next = PreferenceSchema.parse(mutate(current));
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      await writePreference(this.#preferencePath, next);
      this.#emit();
    });
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export function electronUtilityProcessFork(
  fork: (typeof import("electron"))["utilityProcess"]["fork"],
): LocalRunnerServiceDependencies["fork"] {
  return (modulePath, args, options) =>
    fork(modulePath, [...args], {
      cwd: options.cwd,
      env: options.env,
      serviceName: options.serviceName,
      stdio: options.stdio,
    }) as UtilityProcess;
}

/**
 * The two shapes of a desktop Runner. Without `execution` the process is
 * reach-only: it holds the identity, the Host connection, the `shell` module
 * and the filesystem helper, and is told about no work location, no workspace
 * backings, no harnesses, no agent skills and no browser, because it starts
 * none of them.
 */
interface RunnerExecutionEnvironment {
  readonly agentSkillsDirectory: string;
  readonly browserHarnessExecutable: string;
  readonly harnessExecutables: Record<ShippedHarnessKind, string>;
  readonly localWorkspaceRoot: string;
  readonly mountBinary: string | null;
}

/**
 * The credentials the local Runner needs, which never enter its environment:
 * they are posted to the worker (see `runner-worker-secrets.ts`).
 */
function runnerSecrets(input: {
  readonly browser?: PersonalLocalBrowserHandle;
  readonly computerUse?: { readonly token: string; readonly url: URL };
  readonly enrollmentToken: string | undefined;
}): Record<string, string> {
  return {
    ...(input.browser ? { OPENSTEER_BROWSER_BRIDGE_TOKEN: input.browser.bridgeToken } : {}),
    ...(input.computerUse ? { OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: input.computerUse.token } : {}),
    ...(input.enrollmentToken ? { OPENSTEER_RUNNER_ENROLLMENT_TOKEN: input.enrollmentToken } : {}),
  };
}

function runnerEnvironment(input: {
  readonly baseEnvironment: Readonly<Record<string, string>>;
  readonly browser?: PersonalLocalBrowserHandle;
  readonly computerUse?: { readonly token: string; readonly url: URL };
  readonly config: DesktopConfiguration;
  readonly deploymentShape: DesktopLocalRunnerTarget["deploymentShape"];
  readonly execution?: RunnerExecutionEnvironment;
  readonly hostUrl: string;
  readonly homeDirectory: string;
  readonly nodeExecutable: string;
  readonly runnerDataDirectory: string;
  readonly runnerName: string;
}): Record<string, string> {
  const execution = input.execution;
  return Object.fromEntries(
    Object.entries({
      ...input.baseEnvironment,
      ...(input.browser
        ? {
            OPENSTEER_BROWSER_BRIDGE_URL: input.browser.url.toString(),
            OPENSTEER_BROWSER_RUNTIME_ID: input.browser.runtimeId,
          }
        : {}),
      // Stated rather than implied: without the URL and its token the Runner's
      // `integrations` handler answers every computer-use frame with
      // `unsupported` and the sentence that names the desktop app.
      ...(input.computerUse
        ? { OPENSTEER_COMPUTER_USE_BRIDGE_URL: input.computerUse.url.toString() }
        : {}),
      HOME: input.homeDirectory,
      ...(execution
        ? {
            OPENSTEER_AGENT_SKILLS_DIRECTORY: execution.agentSkillsDirectory,
            OPENSTEER_BROWSER_HARNESS: execution.browserHarnessExecutable,
            // Nothing names an executable for an `installed` engine: the
            // Runner's variable for it is optional and defaults to the
            // documented install location on the person's own machine.
            ...Object.fromEntries(
              harnessCatalog
                .filter(shipsHarnessRuntimeBytes)
                .map((entry) => [
                  harnessExecutableEnvironmentVariable(entry.kind),
                  execution.harnessExecutables[entry.kind],
                ]),
            ),
            OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: path.join(
              input.runnerDataDirectory,
              "workspace-bindings.v1.json",
            ),
            OPENSTEER_LOCAL_WORKSPACE_ROOT: execution.localWorkspaceRoot,
            OPENSTEER_MAX_CONCURRENT_RUNS: "2",
            // Only the PortableFS mount identity needs OpenSSL, so a local-only
            // machine is never asked for a binary it has no use for.
            ...(execution.mountBinary
              ? {
                  OPENSTEER_OPENSSL_BINARY: "/usr/bin/openssl",
                  OPENSTEER_PORTABLEFS_MOUNT_BINARY: execution.mountBinary,
                }
              : {}),
            OPENSTEER_RUNNER_WORKSPACE_BACKINGS: execution.mountBinary
              ? "local-directory,portablefs"
              : "local-directory",
          }
        : {}),
      OPENSTEER_DEPLOYMENT_KIND: input.deploymentShape.kind,
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: input.deploymentShape.defaultWorkspaceBacking,
      OPENSTEER_HOST_URL: new URL(input.hostUrl).toString(),
      OPENSTEER_MODE: input.config.mode,
      OPENSTEER_NATIVE_FS_HELPER: input.config.localExecution.nativeFsHelperBinary,
      OPENSTEER_NODE_EXECUTABLE: input.nodeExecutable,
      OPENSTEER_RUNNER_DATA_DIR: input.runnerDataDirectory,
      // `main` is the Personal Host's own Runner, which this one never is: a
      // desktop Runner reaches a Personal Deployment over its signed route.
      OPENSTEER_RUNNER_KIND: "local",
      OPENSTEER_RUNNER_MODULES: runnerModules(
        execution !== undefined,
        input.browser !== undefined,
        input.computerUse !== undefined,
      ),
      OPENSTEER_RUNNER_NAME: input.runnerName,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * What this process runs, in the spec's order; `browser` implies `agents`.
 * `messaging` carries the transports only this Mac can hold, through the
 * helper computer use already runs; a Host this desktop reaches speaks its
 * protocol epoch exactly, so it accepts the module.
 */
function runnerModules(runAgents: boolean, hasBrowser: boolean, hasComputerUse: boolean): string {
  const modules = [
    ...(runAgents ? ["agents"] : []),
    ...(runAgents && hasBrowser ? ["browser"] : []),
    "integrations",
    ...(hasComputerUse ? ["messaging"] : []),
    "shell",
  ];
  return modules.join(",");
}

/**
 * A browser outlives nothing: it stops with the Runner that relayed it. The
 * shutdown is chained onto the slot so a caller that cannot wait — a cancelled
 * launch, a crash — still leaves something for removal to wait on before it
 * deletes the profiles underneath it.
 */
function stopSlotBrowser(slot: RunnerSlot, log: ShutdownLog): Promise<void> {
  const browser = slot.browser;
  slot.browser = undefined;
  const previous = slot.browserShutdown ?? Promise.resolve();
  if (!browser) return previous;
  const shutdown = previous.then(() =>
    browser
      .stop()
      .catch((error: unknown) => logShutdownError(log, "local-browser", browser.runtimeId, error)),
  );
  slot.browserShutdown = shutdown;
  return shutdown;
}

/** True when `settled` resolved inside the bound, false when the bound won. */
async function exitedWithin(settled: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<false>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([settled.then(() => true), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyPreference(): Preference {
  return { runners: {}, version: 4 };
}

/**
 * Membership, not a view preference: a file this release cannot read leaves a
 * computer the Deployment still lists with no Runner, so the one shape that
 * came before is migrated rather than discarded. Anything else — absent,
 * corrupt, from a later release — reads as no computers here.
 */
async function readPreference(filePath: string): Promise<Preference> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxPreferenceBytes) {
      return emptyPreference();
    }
    const decoded: unknown = JSON.parse(await readFile(filePath, "utf8"));
    const legacy = LegacyPreferenceSchema.safeParse(decoded);
    if (legacy.success) return migrateLegacyPreference(legacy.data);
    return PreferenceSchema.parse(decoded);
  } catch {
    return emptyPreference();
  }
}

/** Every computer lent by an earlier release was a server one, running agents. */
function migrateLegacyPreference(legacy: z.infer<typeof LegacyPreferenceSchema>): Preference {
  return PreferenceSchema.parse({
    runners: Object.fromEntries(
      Object.entries(legacy.runners).map(([deploymentId, runner]) => [
        deploymentId,
        { enrolled: runner.enabled, runAgents: true, runnerName: runner.runnerName },
      ]),
    ),
    version: 4,
  });
}

async function writePreference(filePath: string, preference: Preference): Promise<void> {
  await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  await setPrivateDirectoryMode(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(PreferenceSchema.parse(preference))}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    await setPrivateFileMode(filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function assertRegularDirectory(directoryPath: string, label: string): Promise<void> {
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function assertRegularExecutable(filePath: string, label: string): Promise<void> {
  await assertRegularFile(filePath, label);
  const metadata = await lstat(filePath);
  if (process.platform !== "win32" && (metadata.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable.`);
  }
}

/**
 * Drains a worker's output and keeps the last {@link maxLogTailBytes} of it, so
 * a crash can say what the worker printed last instead of only its exit code.
 * The output is never stored on disk and never grows without bound.
 */
function boundedLogTail(streams: readonly (NodeJS.ReadableStream | null)[]): () => string {
  let retained = "";
  for (const stream of streams) {
    if (!stream) continue;
    stream.on("data", (value: Buffer | string) => {
      retained = (retained + value.toString()).slice(-maxLogTailBytes);
    });
    stream.resume();
  }
  return () => retained;
}

/** The worker's last line of output, as much of it as a status line can carry. */
function withLogTail(detail: string, tail: string): string {
  const lastLine = tail
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
  if (!lastLine) return detail;
  return `${detail} Last output: ${redactSecrets(lastLine).slice(0, maxLogTailDetailChars)}`;
}

/** Worker output and error messages both carry Host credentials in the clear. */
function redactSecrets(message: string): string {
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

function safeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "The Runner failed on this Mac.";
  return redactSecrets(message).slice(0, 2_000);
}
