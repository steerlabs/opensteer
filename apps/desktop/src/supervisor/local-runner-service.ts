import { DesktopBrowserProfileErasure } from "./browser-profile-erasure.js";
import { logShutdownError, type ShutdownLog } from "../app/desktop-shutdown.js";
import { RestartPolicy } from "@opensteer/shared/restartPolicy";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { assertRegularFile } from "@opensteer/shared/privateFiles";
import { setPrivateDirectoryMode } from "@opensteer/shared/privateFiles";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { desktopDeploymentPaths } from "../app/application-paths.js";
import type { UtilityProcess } from "electron";
import {
  DeploymentIdSchema,
  EnvironmentIdSchema,
  RunnerIdSchema,
  AuthSessionIdSchema,
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
import {
  hostKeyFingerprint,
  isSameHost,
  verifyHostDiscoveryEnvelope,
  verifyPersonalHostAccessRouteEnvelope,
  apiVersionHeaders,
} from "@opensteer/deployment-authority";
import { z } from "zod";
import { FileRunnerIdentityStore } from "@opensteer/runner-client";
import {
  createDeviceLeaveSignature,
  createDeviceSessionBindingSignature,
} from "@opensteer/runner-auth";
import {
  RunnerLeaveResponseSchema,
  DevicePreparedIdentitySchema,
  type HostApiCommandInput,
  type HostApiCommandOutput,
  type DeviceSessionBindingProof,
  type DevicePreparedIdentity,
} from "@opensteer/protocol";
import { assertDeviceSessionAllowed } from "@opensteer/client/computers";
import { type AccountDeploymentConnectionSource } from "@opensteer/client/connections";
import { readPrivateFileText } from "@opensteer/shared/atomicPrivateFile";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { syncDirectory } from "@opensteer/shared/privateFiles";
import {
  DeviceMembershipsSchema,
  membershipIntent,
  readMemberships,
  writeMemberships,
  type DeviceMembership,
  type DeviceMemberships,
} from "./device-membership.js";
import type { DesktopConfiguration } from "../config.js";
import { computerName } from "./computer-name.js";
import type { PersonalLocalBrowserHandle } from "./personal-local-runtime.js";
import {
  runnerWorkerEnginesRecheckMessage,
  runnerWorkerSecretsMessage,
} from "./runner-worker-secrets.js";
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
import { localExecutionStatus } from "./local-execution-status.js";

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

/**
 * A crashed worker with the window closed has nobody to press a switch again,
 * so an enrolled computer would stay stopped until the person reopened
 * Opensteer. The attempts are bounded because a Runner that cannot start is a
 * fault to report, not one to hide behind an endless loop.
 */
const maxRestartAttempts = 5;

const notEnrolledDetail = "This Mac is not in this Deployment.";
const neverEnrolledDetail = "Finish setting up this Mac to join this Opensteer.";
const revokedDetail = "This Mac was removed from this Deployment.";
const stoppedDetail = "The Runner is stopped on this Mac.";
const removedBeforeConnectedMessage = "This Mac left the Deployment before its Runner connected.";
const stillRunningMessage =
  "The Runner on this Mac is still running, so nothing was deleted. Try again in a moment.";

/**
 * A slot that needs a fresh enrollment hand-off to finish setup.
 */
export class LocalRunnerNeverEnrolledError extends Error {}

const WorkerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    environmentId: EnvironmentIdSchema.nullable(),
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

type Preference = DeviceMemberships;

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
  readonly assertAccountSource?: (source: AccountDeploymentConnectionSource) => void;
  readonly leaveFetch?: typeof fetch;
  readonly now?: () => number;
  readonly revokeLegacyRunner?: (
    deploymentId: DeploymentId,
    origin: string,
    runnerId: string,
  ) => Promise<void>;
  readonly retireEnrollment?: (
    deploymentId: DeploymentId,
    origin: string,
    enrollmentId: string,
  ) => Promise<"consumed" | "expired" | "retired" | void>;
  readonly readSession?: (
    deploymentId: DeploymentId,
    origin: string,
    sessionId: string,
  ) => Promise<
    NonNullable<DeviceMembership["boundSession"]> & {
      readonly deviceId?: string | null | undefined;
    }
  >;
  /** Fences authentication and client traffic synchronously, before disk or teardown awaits. */
  readonly fenceDeployment?: (deploymentId: DeploymentId) => void;
  readonly clearDeploymentSession?: (deploymentId: DeploymentId) => Promise<void>;
  readonly allowDeployment?: (deploymentId: DeploymentId) => Promise<void>;
  readonly profileErasure?: DesktopBrowserProfileErasure;
  /**
   * Starts this computer's browser for one enrolled Deployment. It
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
   * exist. It is started for every enrolled slot,
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

interface RunnerSlot {
  /** The module set of the running worker, which a changed `runAgents` restarts. */
  activeRunAgents: boolean | undefined;
  confirmationOnly: boolean;
  activeTarget: DesktopLocalRunnerTarget | undefined;
  /** The browser this slot's Runner relays, stopped with it. */
  browser: PersonalLocalBrowserHandle | undefined;
  /** Every browser shutdown asked for so far, chained; never dropped. */
  browserShutdown: Promise<void> | undefined;
  /** A browser whose stop failed may still hold its profiles open. */
  browserHeld: boolean;
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
  waiting: boolean;
  stopPromise: Promise<void> | undefined;
}

export class LocalRunnerService {
  readonly #log: ShutdownLog;
  readonly #assertAccountSource: NonNullable<LocalRunnerServiceDependencies["assertAccountSource"]>;
  #accountGeneration = 0;
  readonly #leaveFetch: typeof fetch;
  readonly #now: () => number;
  readonly #pendingEnrollments = new Map<
    string,
    { deploymentId: DeploymentId; id: string; expiresAt: string }
  >();
  readonly #pendingBindings = new Map<
    DeploymentId,
    {
      generation: number;
      signature: string;
      session: NonNullable<DeviceMembership["boundSession"]>;
    }
  >();
  readonly #revokeLegacyRunner: LocalRunnerServiceDependencies["revokeLegacyRunner"];
  readonly #retireEnrollment: LocalRunnerServiceDependencies["retireEnrollment"];
  readonly #readSession: LocalRunnerServiceDependencies["readSession"];
  readonly #fenceDeployment: NonNullable<LocalRunnerServiceDependencies["fenceDeployment"]>;
  readonly #clearDeploymentSession: NonNullable<
    LocalRunnerServiceDependencies["clearDeploymentSession"]
  >;
  readonly #allowDeployment: NonNullable<LocalRunnerServiceDependencies["allowDeployment"]>;
  readonly #starts = new Map<
    DeploymentId,
    { input: DesktopStartLocalRunnerInput; promise: Promise<DesktopLocalExecutionStatus> }
  >();
  readonly #sessionCleanups = new Map<DeploymentId, Promise<void>>();
  readonly #obligations = new Map<DeploymentId, Promise<void>>();
  readonly #leaveTimers = new Map<DeploymentId, ReturnType<typeof setTimeout>>();
  readonly #fenced = new Set<DeploymentId>();
  readonly #profileErasure: DesktopBrowserProfileErasure;
  readonly #config: DesktopConfiguration;
  readonly #browser: LocalRunnerServiceDependencies["browser"];
  readonly #computerUse: LocalRunnerServiceDependencies["computerUse"];
  readonly #computerName: NonNullable<LocalRunnerServiceDependencies["computerName"]>;
  readonly #fork: LocalRunnerServiceDependencies["fork"];
  readonly #homeDirectory: string;
  readonly #inspectIdentity: NonNullable<LocalRunnerServiceDependencies["inspectIdentity"]>;
  readonly #listeners = new Set<() => void>();
  readonly #preferenceMutations = new MutationQueue();
  readonly #setupIssuances = new MutationQueue();
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
    this.#assertAccountSource = dependencies.assertAccountSource ?? (() => undefined);
    this.#leaveFetch = dependencies.leaveFetch ?? fetch;
    this.#now = dependencies.now ?? (() => Date.now());
    this.#retireEnrollment = dependencies.retireEnrollment;
    this.#revokeLegacyRunner = dependencies.revokeLegacyRunner;
    this.#readSession = dependencies.readSession;
    this.#fenceDeployment = dependencies.fenceDeployment ?? (() => undefined);
    this.#clearDeploymentSession = dependencies.clearDeploymentSession ?? (async () => undefined);
    this.#allowDeployment = dependencies.allowDeployment ?? (async () => undefined);
    this.#browser = dependencies.browser;
    this.#profileErasure =
      dependencies.profileErasure ?? new DesktopBrowserProfileErasure(config.dataDirectory);
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
    this.#preferencePath = path.join(config.localExecution.dataDirectory, "desktop-runner.json");
    this.#restartDelayMs = dependencies.restartDelayMs;
    this.#stopTimeouts = {
      forcedMs: dependencies.stopTimeouts?.forcedMs ?? forcedStopTimeoutMs,
      gracefulMs: dependencies.stopTimeouts?.gracefulMs ?? gracefulStopTimeoutMs,
      removalMs: dependencies.stopTimeouts?.removalMs ?? removalExitTimeoutMs,
    };
    this.#targets = dependencies.targets;
    this.#userEnvironment = dependencies.userEnvironment ?? new NativePersonalUserEnvironment();
    this.#unsubscribeTargets = this.#targets.subscribe(() => void this.reconcile());
  }

  async assertComputerAppSetupTarget(requestInput: ComputerAppSetupRequest): Promise<void> {
    const request = ComputerAppSetupRequestSchema.parse(requestInput);
    const target = await this.checkComputerUseRunnerTarget(request.deploymentId, request.runnerId);
    if (!target.local)
      throw new Error("Computer app setup does not target this Mac's current enrolled Runner");
  }

  async checkComputerUseRunnerTarget(
    deploymentId: string,
    runnerId: string,
  ): Promise<ComputerUseRunnerTargetResult> {
    const parsedDeploymentId = DeploymentIdSchema.parse(deploymentId);
    const membership = (await readMemberships(this.#preferencePath)).runners[parsedDeploymentId];
    if (this.#fenced.has(parsedDeploymentId) || membership?.state !== "active")
      return { local: false, reason: "not-local" };
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
    const slot = this.#slot(deploymentId);
    const stored = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    if (!slot.child && !slot.stopPromise && slot.state !== "failed") {
      let target: DesktopLocalRunnerTarget | null = null;
      try {
        target = await this.#targets.resolve(deploymentId);
        slot.waiting = false;
      } catch (error) {
        target = null;
        slot.waiting = error instanceof LocalRunnerDeploymentUnavailableError;
      }
      slot.mayRunAgents = target?.mayRunAgents ?? false;
      // With no worker running, the durable slot is what this Deployment will
      // get when one starts, so the status reads it rather than the last
      // in-memory guess.
      slot.runAgents = stored?.state === "active" && stored.runAgents;
      const identity =
        stored?.state === "active"
          ? await this.#inspectIdentity(this.#deploymentDataDirectory(deploymentId))
          : null;
      if (identity && (!target || (await this.#targets.isCurrent(target)))) {
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
    if (stored?.state === "active" && !slot.child) {
      const identity = await this.#inspectIdentity(this.#deploymentDataDirectory(deploymentId));
      if (identity) {
        slot.enrolled = identity.enrolled;
        slot.runnerId = identity.runnerId;
        slot.environmentId = identity.environmentId;
      }
    }
    const computer = await this.#computerName();
    const status = localExecutionStatus(deploymentId, this.#runnerSnapshot(slot), {
      computerName: computer,
      mayRunAgents: slot.mayRunAgents,
      runAgents: slot.runAgents,
    });
    return {
      ...status,
      membership: {
        state: stored?.state === "active" && slot.waiting ? "waiting" : (stored?.state ?? "none"),
        runnerId: stored?.runnerId ?? slot.runnerId,
        generation: stored?.generation ?? 0,
        leaveUnconfirmed: stored?.state === "leaving" || (stored?.legacyLeaves.length ?? 0) > 0,
        enrolled: slot.enrolled,
        sessionState: stored?.confirmingSession
          ? "confirming"
          : stored?.needsSignIn
            ? "sign-in-again"
            : "ready",
      },
    };
  }

  /**
   * Enrols this Mac in a Deployment, and is equally the way its module set is
   * changed afterwards: starting an enrolled slot with the other `runAgents`
   * restarts the Runner, leaving the identity, data directory and host key
   * exactly where they are.
   */
  start(input: DesktopStartLocalRunnerInput): Promise<DesktopLocalExecutionStatus> {
    const parsed = DesktopStartLocalRunnerInputSchema.parse(input);
    const current = this.#starts.get(parsed.deploymentId);
    if (current) {
      if (JSON.stringify(current.input) === JSON.stringify(parsed)) return current.promise;
      return Promise.reject(
        new Error("This Mac's setup is already connecting. Wait for it to finish."),
      );
    }
    const promise = this.#startNow(parsed);
    this.#starts.set(parsed.deploymentId, { input: parsed, promise });
    const done = () => {
      if (this.#starts.get(parsed.deploymentId)?.promise === promise)
        this.#starts.delete(parsed.deploymentId);
    };
    void promise.then(done, done);
    return promise;
  }

  async prepareDeviceSetup(input: DesktopStartLocalRunnerInput): Promise<DevicePreparedIdentity> {
    const parsed = DesktopStartLocalRunnerInputSchema.parse(input);
    if (parsed.enrollmentToken)
      throw new Error("Prepare this Mac before requesting its enrollment.");
    const accountGeneration = this.#accountGeneration;
    const slot = this.#slot(parsed.deploymentId);
    const generation = slot.intentGeneration;
    const target = await this.#targets.resolve(parsed.deploymentId);
    const assertCurrent = () => {
      if (
        this.#shuttingDown ||
        accountGeneration !== this.#accountGeneration ||
        generation !== slot.intentGeneration ||
        this.#fenced.has(parsed.deploymentId)
      )
        throw new Error("Device setup was cancelled by sign-out or removal.");
      if (target.source.kind === "account") this.#assertAccountSource(target.source);
    };
    assertCurrent();
    let prepared: DevicePreparedIdentity | undefined;
    await this.#mutatePreference(async (preference) => {
      assertCurrent();
      const current = preference.runners[parsed.deploymentId];
      if (
        current &&
        (current.state !== "active" || current.confirmingSession || current.needsSignIn)
      )
        throw new Error("Resume this Mac's sign-in before setting it up.");
      if (current?.hostAuthority && !isSameHost(current.hostAuthority, target.authority))
        throw new Error("This Deployment's Host identity changed.");
      const identity = await new FileRunnerIdentityStore({
        dataDirectory: this.#deploymentDataDirectory(parsed.deploymentId),
        environmentless: true,
      }).loadOrCreate();
      assertCurrent();
      prepared = { runnerId: identity.runnerId, publicKeyPem: identity.publicKeyPem };
      return {
        ...preference,
        runners: {
          ...preference.runners,
          [parsed.deploymentId]: {
            ...(current ?? membershipIntent(parsed.runnerName, parsed.runAgents)),
            runnerId: identity.runnerId,
            deploymentName: target.name ?? current?.deploymentName ?? null,
            runnerName: parsed.runnerName,
            runAgents: parsed.runAgents,
            prepared: true,
            provenance: current?.provenance ?? target.source,
            hostAuthority: target.authority,
            devicesAvailable: target.devicesAvailable === true,
            lastVerifiedRoute: { origin: target.hostUrl, accessRoute: target.accessRoute },
          },
        },
      };
    });
    assertCurrent();
    if (!prepared) throw new Error("Device setup was not prepared.");
    return prepared;
  }

  withPreparedEnrollment<T>(
    deploymentId: DeploymentId,
    command: HostApiCommandInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (command.type !== "runner.enrollment.createLocal" || !command.preparedIdentity)
      return operation();
    const prepared = DevicePreparedIdentitySchema.parse(command.preparedIdentity);
    const accountGeneration = this.#accountGeneration;
    return this.#setupIssuances.run(async () => {
      const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
      if (
        accountGeneration !== this.#accountGeneration ||
        row?.state !== "active" ||
        !row.prepared ||
        row.runnerId !== prepared.runnerId ||
        this.#fenced.has(deploymentId)
      )
        throw new Error("Device setup was cancelled before enrollment issuance.");
      if (row.provenance?.kind === "account") this.#assertAccountSource(row.provenance);
      const identity = await this.#signingIdentity(
        deploymentId,
        RunnerIdSchema.parse(prepared.runnerId),
      );
      if (
        createPublicKey(identity.privateKey).export({ format: "pem", type: "spki" }).toString() !==
        prepared.publicKeyPem
      )
        throw new Error("Enrollment does not match this Mac's prepared key.");
      await this.#mutatePreference((preference) => {
        const current = preference.runners[deploymentId];
        if (current?.state !== "active" || this.#fenced.has(deploymentId))
          throw new Error("Device setup was cancelled before enrollment issuance.");
        return {
          ...preference,
          runners: { ...preference.runners, [deploymentId]: { ...current, issuanceStarted: true } },
        };
      });
      return operation();
    });
  }

  async #accountMembershipInventory(): Promise<DeviceMemberships> {
    await this.#discoverMemberships();
    const preference = await readMemberships(this.#preferencePath);
    for (const [idValue, row] of Object.entries(preference.runners)) {
      const id = DeploymentIdSchema.parse(idValue);
      if (row.state !== "active" || row.provenance) continue;
      let target: DesktopLocalRunnerTarget;
      try {
        target = await this.#targets.resolve(id);
      } catch (error) {
        if (error instanceof LocalRunnerDeploymentUnavailableError) continue;
        throw error;
      }
      await this.#mutatePreference((current) => {
        const stored = current.runners[id];
        if (stored?.state !== "active" || stored.provenance) return current;
        return {
          ...current,
          runners: {
            ...current.runners,
            [id]: {
              ...stored,
              provenance: target.source,
              deploymentName: target.name ?? stored.deploymentName,
              hostAuthority: target.authority,
              devicesAvailable: target.devicesAvailable === true,
              lastVerifiedRoute: { origin: target.hostUrl, accessRoute: target.accessRoute },
            },
          },
        };
      });
    }
    return readMemberships(this.#preferencePath);
  }

  async accountSignOutPreview(): Promise<readonly { deploymentId: string; name: string }[]> {
    const preference = await this.#accountMembershipInventory();
    if (Object.values(preference.runners).some((row) => row.state === "active" && !row.provenance))
      throw new Error("Reconnect the waiting Opensteers to identify this Mac's memberships.");
    return Object.entries(preference.runners)
      .filter(([, row]) => row.state === "active" && row.provenance?.kind === "account")
      .map(([deploymentId, row]) => ({ deploymentId, name: row.deploymentName ?? "an Opensteer" }));
  }

  async #startNow(parsed: DesktopStartLocalRunnerInput): Promise<DesktopLocalExecutionStatus> {
    await this.#finishLegacyLeaves(parsed.deploymentId);
    const membership = (await readMemberships(this.#preferencePath)).runners[parsed.deploymentId];
    if (this.#fenced.has(parsed.deploymentId) || (membership && membership.state !== "active"))
      throw new Error("This Mac was removed. Choose Set up again before joining this Deployment.");
    this.#cancelRestart(parsed.deploymentId);
    const slot = this.#slot(parsed.deploymentId);
    const intentGeneration = this.#enableIntent(slot);
    try {
      await this.#reconcileTail;
      this.#assertCurrentIntent(slot, intentGeneration);
      const target = await this.#targets.resolve(parsed.deploymentId);
      if (target.source.kind === "account") this.#assertAccountSource(target.source);
      if (
        membership?.prepared &&
        parsed.enrollmentToken &&
        membership.pendingEnrollment?.tokenHash !==
          createHash("sha256").update(parsed.enrollmentToken).digest("hex")
      )
        throw new Error("This enrollment does not belong to the prepared setup attempt.");
      if (membership?.hostAuthority && !isSameHost(membership.hostAuthority, target.authority))
        throw new Error("This Deployment's Host identity changed. Set up this Mac again.");
      slot.waiting = false;
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
      const identity = await new FileRunnerIdentityStore({
        dataDirectory: this.#deploymentDataDirectory(parsed.deploymentId),
        environmentless: true,
      }).loadOrCreate();
      this.#assertCurrentIntent(slot, intentGeneration);
      await this.#mutatePreference((preference) => {
        this.#assertCurrentIntent(slot, intentGeneration);
        const current = preference.runners[parsed.deploymentId];
        if (current && current.state !== "active")
          throw new Error("Device setup was cancelled by removal.");
        if (target.source.kind === "account") this.#assertAccountSource(target.source);
        return {
          ...preference,
          runners: {
            ...preference.runners,
            [parsed.deploymentId]: {
              ...(current ?? membershipIntent(parsed.runnerName, parsed.runAgents)),
              runnerId: identity.runnerId,
              pendingEnrollment: current?.prepared
                ? current.pendingEnrollment
                : parsed.enrollmentToken
                  ? this.#enrollmentForToken(parsed.deploymentId, parsed.enrollmentToken)
                  : (current?.pendingEnrollment ?? null),
              runnerName: parsed.runnerName,
              deploymentName: target.name ?? current?.deploymentName ?? null,
              runAgents: parsed.runAgents,
              provenance: current?.provenance ?? target.source,
              hostAuthority: target.authority,
              devicesAvailable: target.devicesAvailable === true,
              lastVerifiedRoute: { origin: target.hostUrl, accessRoute: target.accessRoute },
            },
          },
        };
      });
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

  /**
   * Asks every running worker that runs agents to look for engines now; each
   * Runner tells its Host only when what it can run changed.
   */
  recheckEngines(): void {
    for (const slot of this.#runners.values()) {
      if (slot.child && slot.activeRunAgents)
        slot.child.postMessage(runnerWorkerEnginesRecheckMessage);
    }
  }

  async reconcileBoundSession(deploymentIdInput: string): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    if (!this.#readSession) return;
    const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    if (
      row?.state !== "active" ||
      !row.runnerId ||
      row.confirmingSession ||
      this.#fenced.has(deploymentId)
    )
      return;
    const target = await this.#targets.resolve(deploymentId);
    const session = await this.#readSession(deploymentId, target.hostUrl, "");
    if (session.deviceId !== row.runnerId) return;
    await this.#mutatePreference((preference) => {
      const current = preference.runners[deploymentId];
      if (
        current?.state !== "active" ||
        current.generation !== row.generation ||
        current.confirmingSession ||
        this.#fenced.has(deploymentId)
      )
        return preference;
      return {
        ...preference,
        runners: {
          ...preference.runners,
          [deploymentId]: {
            ...current,
            boundSession: {
              id: session.id,
              expiresAt: session.expiresAt,
              absoluteExpiresAt: session.absoluteExpiresAt,
            },
          },
        },
      };
    });
  }

  async startIfEnabled(): Promise<void> {
    await this.#preferenceMutations.run(async () => {
      await writeMemberships(this.#preferencePath, await readMemberships(this.#preferencePath));
    });
    await this.reconcile();
    const rows = await readMemberships(this.#preferencePath);
    await Promise.all(
      Object.keys(rows.runners).map((id) => this.reconcileBoundSession(id).catch(() => undefined)),
    );
    await this.#profileErasure.finishPending();
  }

  async setUpDevice(input: DesktopStartLocalRunnerInput): Promise<DesktopLocalExecutionStatus> {
    const parsed = DesktopStartLocalRunnerInputSchema.parse(input);
    const existing = (await readMemberships(this.#preferencePath)).runners[parsed.deploymentId];
    const slot = this.#slot(parsed.deploymentId);
    const generation = slot.intentGeneration;
    const assertSetupCurrent = () => {
      if (slot.intentGeneration !== generation)
        throw new Error("Device setup was cancelled before authorization resumed.");
    };
    if (parsed.enrollmentToken && existing && existing.state !== "active")
      throw new Error("Resume device setup before handing off an enrollment.");
    if (existing?.confirmingSession)
      throw new Error("Waiting for the Runner to confirm this Mac is still a device.");
    if (existing?.state === "leaving") throw new Error("This Mac's leave is still unconfirmed.");
    if (existing?.state === "removed") {
      await this.#finishObligation(parsed.deploymentId);
      await this.#profileErasure.prepare(parsed.deploymentId);
      await this.#mutatePreference((preference) => {
        assertSetupCurrent();
        const current = preference.runners[parsed.deploymentId];
        if (current?.state !== "removed" || current.generation !== existing.generation)
          throw new Error("Device membership changed during setup.");
        return {
          ...preference,
          runners: {
            ...preference.runners,
            [parsed.deploymentId]: {
              ...membershipIntent(parsed.runnerName, parsed.runAgents),
              generation: existing.generation + 1,
              legacyLeaves: current.legacyLeaves,
            },
          },
        };
      });
    }
    assertSetupCurrent();
    await this.#sessionCleanups.get(parsed.deploymentId);
    assertSetupCurrent();
    await this.#allowDeployment(parsed.deploymentId);
    assertSetupCurrent();
    await this.#mutatePreference((preference) => {
      assertSetupCurrent();
      const row = preference.runners[parsed.deploymentId];
      if (!row?.needsSignIn) return preference;
      return {
        ...preference,
        runners: { ...preference.runners, [parsed.deploymentId]: { ...row, needsSignIn: false } },
      };
    });
    assertSetupCurrent();
    this.#fenced.delete(parsed.deploymentId);
    if (existing?.needsSignIn && slot.confirmationOnly) void this.reconcile();
    return parsed.enrollmentToken ? this.start(parsed) : this.status(parsed.deploymentId);
  }

  async signDeviceSessionBinding(input: {
    deploymentId: string;
    sessionId: string;
  }): Promise<DeviceSessionBindingProof> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    const sessionId = AuthSessionIdSchema.parse(input.sessionId);
    const membership = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    const slot = this.#slot(deploymentId);
    const generation = slot.intentGeneration;
    if (this.#fenced.has(deploymentId) || membership?.state !== "active" || !membership.runnerId)
      throw new Error("This Mac is not an active device in this Deployment.");
    await this.assertSessionAllowed(deploymentId);
    const identity = await this.#signingIdentity(deploymentId, membership.runnerId);
    const target = await this.#targets.resolve(deploymentId);
    if (membership.hostAuthority && !isSameHost(membership.hostAuthority, target.authority))
      throw new Error("This Deployment's Host identity changed. Set up this Mac again.");
    if (!this.#readSession) throw new Error("This Mac cannot verify the session being bound.");
    const session = await this.#readSession(deploymentId, target.hostUrl, sessionId);
    if (
      session.id !== sessionId ||
      Date.parse(session.expiresAt) <= Date.now() ||
      Date.parse(session.absoluteExpiresAt) <= Date.now()
    )
      throw new Error("The session being bound has ended.");
    const issuedAt = new Date().toISOString();
    if (this.#fenced.has(deploymentId) || slot.intentGeneration !== generation)
      throw new Error("This Mac left before session binding completed.");
    const signature = createDeviceSessionBindingSignature(identity.privateKey, {
      deploymentId,
      runnerId: identity.runnerId,
      sessionId,
      issuedAt,
    });
    this.#pendingBindings.set(deploymentId, {
      generation: membership.generation,
      signature,
      session: {
        id: session.id,
        expiresAt: session.expiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      },
    });
    return { issuedAt, signature };
  }

  async observeHostCommand(
    deploymentId: DeploymentId,
    command: HostApiCommandInput,
    result: HostApiCommandOutput,
  ): Promise<void> {
    if (command.type === "runner.enrollment.createLocal" && result.type === command.type) {
      if (command.preparedIdentity) {
        const prepared = command.preparedIdentity;
        let accepted = false;
        await this.#mutatePreference((preference) => {
          const row = preference.runners[deploymentId];
          if (!row?.prepared || row.runnerId !== prepared.runnerId) return preference;
          accepted = row.state === "active" && !this.#fenced.has(deploymentId);
          return {
            ...preference,
            runners: {
              ...preference.runners,
              [deploymentId]: {
                ...row,
                issuanceStarted: true,
                pendingEnrollment: {
                  id: result.enrollmentId,
                  expiresAt: result.expiresAt,
                  tokenHash: createHash("sha256").update(result.token).digest("hex"),
                },
              },
            },
          };
        });
        if (!accepted) {
          await this.#finishObligation(deploymentId);
          throw new Error("Device setup was cancelled before token hand-off.");
        }
        return;
      }
      for (const [key, pending] of this.#pendingEnrollments)
        if (Date.parse(pending.expiresAt) <= Date.now()) this.#pendingEnrollments.delete(key);
      if (this.#pendingEnrollments.size >= 100)
        this.#pendingEnrollments.delete(this.#pendingEnrollments.keys().next().value ?? "");
      this.#pendingEnrollments.set(createHash("sha256").update(result.token).digest("hex"), {
        deploymentId,
        id: result.enrollmentId,
        expiresAt: result.expiresAt,
      });
    }
    if (command.type !== "machine.session.bind" || result.type !== command.type) return;
    const pending = this.#pendingBindings.get(deploymentId);
    if (!pending || pending.signature !== command.proof.signature || this.#fenced.has(deploymentId))
      return;
    await this.#mutatePreference((preference) => {
      const row = preference.runners[deploymentId];
      if (
        row?.state !== "active" ||
        row.runnerId !== command.machineId ||
        row.generation !== pending.generation ||
        this.#fenced.has(deploymentId)
      )
        return preference;
      return {
        ...preference,
        runners: {
          ...preference.runners,
          [deploymentId]: { ...row, boundSession: pending.session },
        },
      };
    });
    if (this.#pendingBindings.get(deploymentId) === pending)
      this.#pendingBindings.delete(deploymentId);
  }

  #enrollmentForToken(
    deploymentId: DeploymentId,
    token: string,
  ): DeviceMembership["pendingEnrollment"] {
    const key = createHash("sha256").update(token).digest("hex");
    const pending = this.#pendingEnrollments.get(key);
    if (!pending || pending.deploymentId !== deploymentId) return null;
    this.#pendingEnrollments.delete(key);
    return { id: pending.id, expiresAt: pending.expiresAt };
  }

  async leaveDeployment(input: { deploymentId: string }): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    const slot = this.#slot(deploymentId);
    if (this.#fenced.has(deploymentId)) this.#disableIntent(slot);
    this.#fence(deploymentId);
    await this.#setupIssuances.run(() => this.#prepareLeave(deploymentId));
    await this.#refreshLeaveRoute(deploymentId);
    await this.#finishObligation(deploymentId);
    const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    if (row?.state === "removed")
      slot.detail = row.legacyLeaves.length
        ? "Signed out here. This older Host still needs removal confirmed after you sign in again."
        : "This Mac has left this Deployment.";
  }

  async #prepareLeave(deploymentId: DeploymentId): Promise<void> {
    await this.#mutatePreference(async (preference) => {
      const stored = preference.runners[deploymentId];
      if (stored && stored.state !== "active") return preference;
      let target: DesktopLocalRunnerTarget | null = null;
      try {
        target = await this.#targets.resolve(deploymentId);
      } catch {
        /* The saved authority still owns offline leave. */
      }
      if (stored?.hostAuthority && target && !isSameHost(stored.hostAuthority, target.authority))
        throw new Error("This Deployment's Host identity changed.");
      const current = target
        ? {
            ...(stored ?? membershipIntent(await this.#computerName(), false)),
            hostAuthority: target.authority,
            devicesAvailable: target.devicesAvailable === true,
            lastVerifiedRoute: { origin: target.hostUrl, accessRoute: target.accessRoute },
            provenance: stored?.provenance ?? target.source,
          }
        : stored;
      const descriptor = await this.#inspectIdentity(this.#deploymentDataDirectory(deploymentId));
      const runnerId = current?.runnerId ?? descriptor?.runnerId ?? null;
      let leaveProof = null;
      const localOnly =
        !descriptor?.enrolled &&
        !current?.pendingEnrollment &&
        (current?.prepared ? !current.issuanceStarted : !stored);
      const modern = current?.devicesAvailable === true;
      if (runnerId && !localOnly && modern) {
        const identity = await this.#signingIdentity(deploymentId, runnerId);
        const context = { deploymentId, runnerId, issuedAt: new Date().toISOString() };
        leaveProof = {
          ...context,
          signature: createDeviceLeaveSignature(identity.privateKey, context),
          ...(current?.prepared
            ? {
                preparedIdentity: {
                  runnerId,
                  publicKeyPem: createPublicKey(identity.privateKey)
                    .export({ format: "pem", type: "spki" })
                    .toString(),
                },
              }
            : {}),
        };
      }
      if (
        !modern &&
        !localOnly &&
        (descriptor?.enrolled || current?.pendingEnrollment) &&
        (!current?.hostAuthority || !current.lastVerifiedRoute)
      )
        throw new Error(
          "Reconnect this Opensteer to pin its Host before leaving this older membership.",
        );
      const legacyLeaves = [...(current?.legacyLeaves ?? [])];
      if (
        !modern &&
        !localOnly &&
        current?.lastVerifiedRoute &&
        current.hostAuthority &&
        (descriptor?.enrolled || current.pendingEnrollment)
      ) {
        legacyLeaves.push({
          runnerId,
          enrollmentId: current.pendingEnrollment?.id ?? null,
          authority: current.hostAuthority,
        });
      }
      return {
        ...preference,
        runners: {
          ...preference.runners,
          [deploymentId]: {
            ...(current ?? membershipIntent(await this.#computerName(), false)),
            state: leaveProof ? "leaving" : "removed",
            generation: (current?.generation ?? 0) + 1,
            runnerId,
            leaveProof,
            legacyLeaves,
            erasePending: true,
          },
        },
      };
    });
  }

  async leaveAccountMemberships(next?: AccountDeploymentConnectionSource): Promise<void> {
    ++this.#accountGeneration;
    await this.#setupIssuances.run(async () => undefined);
    const preference = await this.#accountMembershipInventory();
    if (
      !next &&
      Object.values(preference.runners).some(
        (row) => row.state === "active" && row.provenance === null,
      )
    )
      throw new Error(
        "Reconnect the waiting Deployments before signing out so this Mac can identify their Account memberships.",
      );
    await Promise.all(
      Object.entries(preference.runners)
        .filter(
          ([, row]) =>
            row.state === "active" &&
            row.provenance?.kind === "account" &&
            (!next ||
              row.provenance.issuer !== next.issuer ||
              row.provenance.subject !== next.subject),
        )
        .map(([deploymentId]) => this.leaveDeployment({ deploymentId })),
    );
  }

  async sessionLost(deploymentIdInput: string): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    if (row?.state !== "active" || !row.runnerId || row.confirmingSession) return;
    this.#fenceDeployment(deploymentId);
    await this.#mutatePreference((preference) => {
      const current = preference.runners[deploymentId];
      if (current?.state !== "active" || current.generation !== row.generation) return preference;
      return {
        ...preference,
        runners: {
          ...preference.runners,
          [deploymentId]: {
            ...current,
            needsSignIn:
              !current.boundSession ||
              Math.min(
                Date.parse(current.boundSession.expiresAt),
                Date.parse(current.boundSession.absoluteExpiresAt),
              ) <= this.#now(),
            confirmingSession: true,
          },
        },
      };
    });
    await this.#clearSession(deploymentId);
    this.#slot(deploymentId).detail = "Confirming this Mac’s membership with the Runner…";
    await this.#stop(this.#slot(deploymentId));
    void this.reconcile();
    this.#emit();
  }

  async retryDeviceConnection(input: { deploymentId: string }): Promise<void> {
    const id = DeploymentIdSchema.parse(input.deploymentId);
    const row = (await readMemberships(this.#preferencePath)).runners[id];
    if (row?.state !== "active" || !row.confirmingSession)
      throw new Error("This Mac is not awaiting membership confirmation.");
    this.#cancelRestart(id);
    await this.#stop(this.#slot(id));
    void this.reconcile();
  }

  async markRemoved(deploymentIdInput: string): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    if (this.#fenced.has(deploymentId)) this.#disableIntent(this.#slot(deploymentId));
    this.#fence(deploymentId);
    await this.#mutatePreference((preference) => {
      const current = preference.runners[deploymentId];
      if (current?.state === "removed") return preference;
      return {
        ...preference,
        runners: {
          ...preference.runners,
          [deploymentId]: {
            ...(current ?? membershipIntent("This Mac", false)),
            state: "removed",
            generation: (current?.generation ?? 0) + 1,
            erasePending: true,
          },
        },
      };
    });
    await this.#finishObligation(deploymentId);
  }

  async assertSessionAllowed(deploymentIdInput: string): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    if (this.#fenced.has(deploymentId) || (row && row.state !== "active"))
      throw new Error("This Mac was removed. Choose Set up again to reconnect.");
    assertDeviceSessionAllowed(
      row
        ? {
            state: row.state,
            runnerId: row.runnerId,
            generation: row.generation,
            sessionState: row.confirmingSession
              ? "confirming"
              : row.needsSignIn
                ? "sign-in-again"
                : "ready",
          }
        : null,
    );
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    this.#shuttingDown = true;
    for (const timer of this.#leaveTimers.values()) clearTimeout(timer);
    this.#leaveTimers.clear();
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
      await exitedWithin(
        Promise.allSettled([...this.#obligations.values(), ...this.#sessionCleanups.values()]),
        this.#stopTimeouts.removalMs,
      );
    } finally {
      signal?.removeEventListener("abort", force);
    }
  }

  async reconcile(): Promise<void> {
    if (this.#shuttingDown) return;
    const operation = this.#reconcileTail.then(() => this.#reconcileEnabled());
    this.#reconcileTail = operation.catch(async (error: unknown) => {
      this.#log("desktop.device.reconcile-failed", { message: safeDetail(error) });
      for (const [id, slot] of this.#runners) {
        if (!slot.child && !slot.startPromise) continue;
        this.#fence(id);
        await this.#stop(slot);
        slot.state = "failed";
        slot.detail = safeDetail(error);
      }
      this.#emit();
    });
    return this.#reconcileTail;
  }

  async hasEnrolledRunners(): Promise<boolean> {
    const preference = await readMemberships(this.#preferencePath);
    return Object.values(preference.runners).some(
      ({ state }) => state === "active" || state === "leaving",
    );
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#shuttingDown = true;
    for (const timer of this.#leaveTimers.values()) clearTimeout(timer);
    this.#leaveTimers.clear();
    this.#unsubscribeTargets();
    for (const deploymentId of this.#restartPolicies.keys()) this.#cancelRestart(deploymentId);
    this.#listeners.clear();
  }

  async #reconcileEnabled(): Promise<void> {
    await this.#discoverMemberships();
    const preference = await readMemberships(this.#preferencePath);
    await Promise.all(
      Object.entries(preference.runners).map(async ([deploymentIdValue, runner]) => {
        if (this.#shuttingDown) return;
        const deploymentId = DeploymentIdSchema.parse(deploymentIdValue);
        if (runner.state === "active" && runner.legacyLeaves.length)
          await this.#finishLegacyLeaves(deploymentId);
        if (runner.state !== "active") {
          let current = false;
          await this.#mutatePreference((preference) => {
            const row = preference.runners[deploymentId];
            if (row?.generation !== runner.generation || row.state !== runner.state)
              return preference;
            this.#fence(deploymentId);
            current = true;
            return preference;
          });
          if (current) await this.#finishObligation(deploymentId);
          return;
        }
        if (this.#fenced.has(deploymentId)) return;
        const slot = this.#slot(deploymentId);
        const intentGeneration = this.#enableIntent(slot);
        let target: DesktopLocalRunnerTarget;
        try {
          target = await this.#targets.resolve(deploymentId);
        } catch (error) {
          await this.#stop(slot);
          if (error instanceof LocalRunnerDeploymentUnavailableError) {
            this.#cancelRestart(deploymentId);
            slot.waiting = true;
            slot.detail = "Waiting for this Deployment's verified route.";
            slot.state = "disabled";
          } else {
            slot.detail = safeDetail(error);
            slot.state = "failed";
          }
          this.#emit();
          return;
        }
        slot.waiting = false;
        if (runner.hostAuthority && !isSameHost(runner.hostAuthority, target.authority)) {
          this.#disableIntent(slot);
          await this.#stop(slot);
          slot.state = "failed";
          slot.detail = "This Deployment's Host identity changed. Set up this Mac again.";
          this.#emit();
          return;
        }
        await this.#mutatePreference((current) => {
          const row = current.runners[deploymentId];
          if (row?.state !== "active" || !this.#intentIsCurrent(slot, intentGeneration))
            return current;
          return {
            ...current,
            runners: {
              ...current.runners,
              [deploymentId]: {
                ...row,
                provenance: row.provenance ?? target.source,
                deploymentName: target.name ?? row.deploymentName,
                hostAuthority: target.authority,
                devicesAvailable: target.devicesAvailable === true,
                lastVerifiedRoute: { origin: target.hostUrl, accessRoute: target.accessRoute },
              },
            },
          };
        });
        if (!this.#intentIsCurrent(slot, intentGeneration)) return;
        slot.mayRunAgents = target.mayRunAgents;
        // A grant that no longer allows agents wins over the stored intent:
        // the Runner still runs, reach-only, rather than being refused.
        const runAgents = runner.runAgents && target.mayRunAgents;
        slot.runAgents = runAgents;
        if (
          slot.activeTarget?.key === target.key &&
          slot.activeRunAgents === runAgents &&
          (!slot.confirmationOnly ||
            runner.confirmingSession ||
            runner.needsSignIn ||
            (!this.#browser && !this.#computerUse)) &&
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
          // Unredeemed identities need an explicit fresh enrollment, not a worker restart.
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
    const descriptor = await this.#inspectIdentity(runnerDataDirectory);
    const membership = (await readMemberships(this.#preferencePath)).runners[target.deploymentId];
    if (membership?.runnerId && descriptor && membership.runnerId !== descriptor.runnerId)
      throw new Error("This Mac's stored device identity changed.");
    if (!enrollmentToken && !descriptor?.enrolled) {
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
    await this.#profileErasure.prepare(target.deploymentId);
    this.#assertCurrentIntent(slot, intentGeneration);
    const browser =
      this.#browser && !membership?.confirmingSession
        ? await this.#browser({
            logPath: path.join(runnerDataDirectory, "browser.log"),
            profileRoot: desktopDeploymentPaths(this.#config.dataDirectory, target.deploymentId)
              .browserProfilesDirectory,
            runtimeId: `desktop-browser:${target.deploymentId}`,
          })
        : undefined;
    slot.browser = browser;
    if (!this.#intentIsCurrent(slot, intentGeneration)) {
      await stopSlotBrowser(slot, this.#log);
      this.#assertCurrentIntent(slot, intentGeneration);
    }
    // Computer use is started for this slot whether or not it runs agents:
    // the `integrations` module a reach-only Runner already has is what
    // carries the computer-use frame.
    const computerUse = membership?.confirmingSession
      ? undefined
      : ((await this.#computerUse?.startForSlot(target.deploymentId)) ?? undefined);
    slot.computerUseSlotId = computerUse ? target.deploymentId : undefined;
    if (!this.#intentIsCurrent(slot, intentGeneration)) {
      await stopSlotBrowser(slot, this.#log);
      await this.#stopSlotComputerUse(slot);
      this.#assertCurrentIntent(slot, intentGeneration);
    }
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
    slot.confirmationOnly = membership?.confirmingSession === true;
    slot.activeTarget = target;

    /**
     * Two lifetimes run through this worker and only one of them ends. The
     * start call is answered once — connected, cancelled, or failed — while the
     * child keeps reporting for as long as it lives. Settling the startup
     * promise therefore must not stop the slot from following the child: a
     * reconnect after a disconnect has to read as running again, and a failure
     * reported long after startup still has to mark the slot failed.
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
                  await this.#mutatePreference((preference) => {
                    const row = preference.runners[target.deploymentId];
                    if (row?.state !== "active" || !this.#intentIsCurrent(slot, intentGeneration))
                      return preference;
                    return {
                      ...preference,
                      runners: {
                        ...preference.runners,
                        [target.deploymentId]: {
                          ...row,
                          pendingEnrollment: null,
                          runnerId:
                            parsed.data.type === "runner.worker.connected"
                              ? parsed.data.runnerId
                              : row.runnerId,
                        },
                      },
                    };
                  });
                  if (!this.#intentIsCurrent(slot, intentGeneration)) {
                    cancel();
                    return;
                  }
                  await this.#sessionCleanups.get(target.deploymentId);
                  await this.#mutatePreference((preference) => {
                    const row = preference.runners[target.deploymentId];
                    if (row?.state !== "active" || !this.#intentIsCurrent(slot, intentGeneration))
                      return preference;
                    return {
                      ...preference,
                      runners: {
                        ...preference.runners,
                        [target.deploymentId]: {
                          ...row,
                          confirmingSession: false,
                        },
                      },
                    };
                  });
                  if (
                    !(await readMemberships(this.#preferencePath)).runners[target.deploymentId]
                      ?.needsSignIn
                  )
                    await this.#allowDeployment(target.deploymentId);
                  if (!this.#intentIsCurrent(slot, intentGeneration)) {
                    cancel();
                    return;
                  }
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
                  if (
                    membership?.confirmingSession &&
                    status.membership?.sessionState === "ready" &&
                    (this.#browser || this.#computerUse)
                  )
                    void this.reconcile();
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
                  await this.markRemoved(target.deploymentId);
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
    await this.#profileErasure.erase(deploymentId, slot.browserHeld ? "held" : "stopped");
    await rm(this.#deploymentDataDirectory(deploymentId), { force: true, recursive: true });
    await syncDirectory(path.dirname(this.#deploymentDataDirectory(deploymentId)));
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
      confirmationOnly: false,
      activeTarget: undefined,
      browser: undefined,
      browserShutdown: undefined,
      browserHeld: false,
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
      waiting: false,
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

  #fence(deploymentId: DeploymentId): void {
    if (this.#fenced.has(deploymentId)) return;
    this.#fenced.add(deploymentId);
    this.#pendingBindings.delete(deploymentId);
    this.#disableIntent(this.#slot(deploymentId));
    this.#cancelRestart(deploymentId);
    this.#fenceDeployment(deploymentId);
  }

  async #signingIdentity(deploymentId: DeploymentId, runnerId: string) {
    const directory = this.#deploymentDataDirectory(deploymentId);
    const descriptor = await this.#inspectIdentity(directory);
    if (!descriptor || descriptor.runnerId !== runnerId)
      throw new Error("This Mac's device key is missing.");
    const identity = await readDeviceSigningIdentity(directory);
    if (identity.runnerId !== runnerId) throw new Error("This Mac's device identity changed.");
    return identity;
  }

  async #discoverMemberships(): Promise<void> {
    // Read first: a corrupt intent file must never turn into permission to heal identities.
    await readMemberships(this.#preferencePath);
    const directory = path.join(this.#config.localExecution.dataDirectory, "deployments");
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const id = DeploymentIdSchema.safeParse(entry.name);
      if (!id.success || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      await this.#mutatePreference(async (preference) => {
        const stored = preference.runners[id.data];
        if (stored && stored.state !== "active") return preference;
        const removing = await this.#profileErasure.hasPending(id.data);
        if (stored?.runnerId && !removing) return preference;
        const identity = await this.#inspectIdentity(this.#deploymentDataDirectory(id.data));
        if (!identity?.enrolled && !removing) return preference;
        let target: DesktopLocalRunnerTarget | null = null;
        try {
          target = await this.#targets.resolve(id.data);
        } catch (error) {
          if (!(error instanceof LocalRunnerDeploymentUnavailableError)) throw error;
        }
        return {
          ...preference,
          runners: {
            ...preference.runners,
            [id.data]: {
              ...(stored ?? membershipIntent(await this.#computerName(), false)),
              runnerId: identity?.runnerId ?? stored?.runnerId ?? null,
              state: removing ? "removed" : "active",
              erasePending: removing,
              provenance: stored?.provenance ?? target?.source ?? null,
              deploymentName: stored?.deploymentName ?? target?.name ?? null,
              hostAuthority: stored?.hostAuthority ?? target?.authority ?? null,
              devicesAvailable: stored?.devicesAvailable ?? target?.devicesAvailable ?? null,
              lastVerifiedRoute:
                stored?.lastVerifiedRoute ??
                (target ? { origin: target.hostUrl, accessRoute: target.accessRoute } : null),
            },
          },
        };
      });
    }
  }

  #clearSession(deploymentId: DeploymentId): Promise<void> {
    const existing = this.#sessionCleanups.get(deploymentId);
    if (existing) return existing;
    const operation = this.#clearDeploymentSession(deploymentId);
    this.#sessionCleanups.set(deploymentId, operation);
    const done = () => {
      if (this.#sessionCleanups.get(deploymentId) === operation)
        this.#sessionCleanups.delete(deploymentId);
    };
    void operation.then(done, done);
    return operation;
  }

  #finishObligation(deploymentId: DeploymentId): Promise<void> {
    const existing = this.#obligations.get(deploymentId);
    if (existing) return existing;
    const operation = this.#finishObligationNow(deploymentId);
    this.#obligations.set(deploymentId, operation);
    const done = () => {
      if (this.#obligations.get(deploymentId) === operation) this.#obligations.delete(deploymentId);
    };
    void operation.then(done, done);
    return operation;
  }

  async #refreshLeaveRoute(deploymentId: DeploymentId): Promise<void> {
    const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    if (row?.state !== "leaving") return;
    let target: DesktopLocalRunnerTarget;
    try {
      target = await this.#targets.resolve(deploymentId);
    } catch {
      return;
    }
    if (row.hostAuthority && !isSameHost(row.hostAuthority, target.authority)) return;
    await this.#mutatePreference((preference) => {
      const current = preference.runners[deploymentId];
      if (current?.state !== "leaving" || current.generation !== row.generation) return preference;
      return {
        ...preference,
        runners: {
          ...preference.runners,
          [deploymentId]: {
            ...current,
            hostAuthority: target.authority,
            devicesAvailable: target.devicesAvailable === true,
            provenance: current.provenance ?? target.source,
            lastVerifiedRoute: { origin: target.hostUrl, accessRoute: target.accessRoute },
          },
        },
      };
    });
  }

  async #retirePendingEnrollment(deploymentId: DeploymentId): Promise<void> {
    const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    if (!row?.pendingEnrollment || row.prepared || row.devicesAvailable !== true) return;
    let retired = Date.parse(row.pendingEnrollment.expiresAt) <= Date.now();
    if (!retired && row.lastVerifiedRoute && this.#retireEnrollment) {
      try {
        await this.#retireEnrollment(
          deploymentId,
          row.lastVerifiedRoute.origin,
          row.pendingEnrollment.id,
        );
        retired = true;
      } catch {
        /* The expiry and signed leave remain durable when the session cannot retire issuance. */
      }
    }
    if (!retired) return;
    await this.#mutatePreference((preference) => {
      const current = preference.runners[deploymentId];
      if (current?.generation !== row.generation) return preference;
      return {
        ...preference,
        runners: { ...preference.runners, [deploymentId]: { ...current, pendingEnrollment: null } },
      };
    });
  }

  async #finishLegacyLeaves(deploymentId: DeploymentId): Promise<void> {
    const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    for (const leave of row?.legacyLeaves ?? []) {
      try {
        const target = await this.#targets.resolve(deploymentId);
        if (!isSameHost(leave.authority, target.authority))
          throw new Error("The legacy removal belongs to another Host.");
        let consumed = leave.enrollmentId === null;
        if (leave.enrollmentId) {
          if (!this.#retireEnrollment) throw new Error("Enrollment retirement unavailable");
          const state = await this.#retireEnrollment(
            deploymentId,
            target.hostUrl,
            leave.enrollmentId,
          );
          if (!state) throw new Error("Enrollment retirement was not confirmed.");
          consumed = state === "consumed";
        }
        if (leave.runnerId && consumed) {
          if (!this.#revokeLegacyRunner) throw new Error("Legacy removal unavailable");
          await this.#revokeLegacyRunner(deploymentId, target.hostUrl, leave.runnerId);
        }
        await this.#mutatePreference((preference) => {
          const current = preference.runners[deploymentId];
          if (!current) return preference;
          return {
            ...preference,
            runners: {
              ...preference.runners,
              [deploymentId]: {
                ...current,
                pendingEnrollment:
                  current.pendingEnrollment?.id === leave.enrollmentId
                    ? null
                    : current.pendingEnrollment,
                legacyLeaves: current.legacyLeaves.filter(
                  (item) => JSON.stringify(item) !== JSON.stringify(leave),
                ),
              },
            },
          };
        });
      } catch {
        this.#slot(deploymentId).detail =
          "Signed out here. This older Host still needs removal confirmed after you sign in again.";
        this.#scheduleLeave(deploymentId);
      }
    }
  }

  async #finishObligationNow(deploymentId: DeploymentId): Promise<void> {
    await this.#finishLegacyLeaves(deploymentId);
    await this.#refreshLeaveRoute(deploymentId);
    await this.#retirePendingEnrollment(deploymentId);
    const row = (await readMemberships(this.#preferencePath)).runners[deploymentId];
    if (!row || row.state === "active") return;
    let sessionError: unknown;
    const clearing = this.#clearSession(deploymentId).catch((error: unknown) => {
      sessionError = error;
    });
    let erasureError: unknown;
    try {
      if (row.erasePending) {
        await this.#forgetSlot(deploymentId, this.#slot(deploymentId), revokedDetail);
        await this.#mutatePreference((preference) => {
          const current = preference.runners[deploymentId];
          if (!current || current.generation !== row.generation) return preference;
          return {
            ...preference,
            runners: { ...preference.runners, [deploymentId]: { ...current, erasePending: false } },
          };
        });
      }
    } catch (error) {
      erasureError = error;
    }
    if (row.state === "leaving") {
      try {
        await this.#deliverLeave(deploymentId, row);
        await this.#mutatePreference((preference) => {
          const current = preference.runners[deploymentId];
          if (current?.generation !== row.generation || current.state !== "leaving")
            return preference;
          return {
            ...preference,
            runners: {
              ...preference.runners,
              [deploymentId]: {
                ...current,
                state: "removed",
                leaveProof: null,
                pendingEnrollment: null,
              },
            },
          };
        });
      } catch {
        this.#scheduleLeave(deploymentId);
        this.#slot(deploymentId).detail =
          "Signed out on this Mac. Removal from the Host is unconfirmed.";
        this.#emit();
      }
    }
    await clearing;
    if (erasureError) throw erasureError;
    if (sessionError) throw sessionError;
  }

  async #deliverLeave(deploymentId: DeploymentId, row: DeviceMembership): Promise<void> {
    if (row.pendingEnrollment && !row.prepared)
      throw new Error("Waiting for this Mac's pending setup enrollment to retire or expire.");
    if (!row.leaveProof || !row.hostAuthority || !row.lastVerifiedRoute)
      throw new Error("Waiting for the pinned Host route to confirm removal.");
    if (row.leaveProof.deploymentId !== deploymentId || row.leaveProof.runnerId !== row.runnerId)
      throw new Error("This Mac's leave obligation has inconsistent identity.");
    const authority = verifyHostDiscoveryEnvelope(row.hostAuthority);
    if (authority.deploymentId !== deploymentId)
      throw new Error("The leave proof belongs to another Host.");
    const route = row.lastVerifiedRoute;
    if (!route.accessRoute)
      throw new Error("Device leave requires a verified Personal Host route.");
    verifyPersonalHostAccessRouteEnvelope(route.accessRoute);
    if (
      !isSameHost(row.hostAuthority, {
        deploymentId: route.accessRoute.document.authority.deploymentId,
        hostInstanceId: route.accessRoute.document.authority.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(route.accessRoute.publicKey.spki),
      })
    )
      throw new Error("The leave route belongs to another Host.");
    if (route.accessRoute.document.route.origin !== route.origin)
      throw new Error("The leave route changed.");
    const endpoint = new URL("/v1/runner/leave", route.origin).toString();
    const response = await this.#leaveFetch(endpoint, {
      method: "POST",
      body: JSON.stringify(row.leaveProof),
      credentials: "omit",
      redirect: "error",
      headers: { "content-type": "application/json", ...apiVersionHeaders("personal") },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || response.redirected || (response.url !== "" && response.url !== endpoint)) {
      await response.body?.cancel();
      throw new Error("This Mac's leave has not been confirmed.");
    }
    RunnerLeaveResponseSchema.parse(
      await readBoundedJson(response, {
        maximumBytes: 4096,
        sizeError: () => new Error("Invalid leave confirmation."),
      }),
    );
  }

  #scheduleLeave(deploymentId: DeploymentId): void {
    if (this.#shuttingDown || this.#leaveTimers.has(deploymentId)) return;
    const timer = setTimeout(() => {
      this.#leaveTimers.delete(deploymentId);
      void this.reconcile();
    }, 30_000);
    timer.unref();
    this.#leaveTimers.set(deploymentId, timer);
  }

  async #mutatePreference(
    mutate: (preference: Preference) => Preference | Promise<Preference>,
  ): Promise<void> {
    await this.#preferenceMutations.run(async () => {
      const current = await readMemberships(this.#preferencePath);
      const next = DeviceMembershipsSchema.parse(await mutate(current));
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      await writeMemberships(this.#preferencePath, next);
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
 * backings, no harnesses or agent skills. The browser is independent of execution.
 */
interface RunnerExecutionEnvironment {
  readonly agentSkillsDirectory: string;
  readonly browserHarnessExecutable: string;
  readonly harnessExecutables: Record<ShippedHarnessKind, string>;
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
            OPENSTEER_MAX_CONCURRENT_RUNS: "2",
          }
        : {}),
      OPENSTEER_DEPLOYMENT_KIND: input.deploymentShape.kind,
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
 * What this process runs, independently of its fixed enrollment grant.
 * `messaging` carries the transports only this Mac can hold, through the
 * helper computer use already runs; a Host this desktop reaches speaks its
 * protocol epoch exactly, so it accepts the module.
 */
function runnerModules(runAgents: boolean, hasBrowser: boolean, hasComputerUse: boolean): string {
  const modules = [
    ...(runAgents ? ["agents"] : []),
    ...(hasBrowser ? ["browser"] : []),
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
    browser.stop().catch((error: unknown) => {
      slot.browserHeld = true;
      logShutdownError(log, "local-browser", browser.runtimeId, error);
    }),
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

async function readDeviceSigningIdentity(directory: string) {
  const invalid = () => new Error("This Mac's device signing identity is unavailable.");
  const contents = await readPrivateFileText(path.join(directory, "identity.json"), 48 * 1024, {
    invalid,
    exposed: invalid,
  });
  if (!contents) throw invalid();
  const file = z
    .object({
      runnerId: RunnerIdSchema,
      privateKeyPem: z.string().max(16384),
      publicKeyPem: z.string().max(16384),
    })
    .parse(JSON.parse(contents));
  const privateKey = createPrivateKey(file.privateKeyPem);
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    createPublicKey(privateKey).export({ type: "spki", format: "pem" }) !== file.publicKeyPem
  )
    throw invalid();
  return { runnerId: file.runnerId, privateKey };
}
