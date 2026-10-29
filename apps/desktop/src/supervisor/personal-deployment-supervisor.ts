import { runShutdownStep, logShutdownError, type ShutdownLog } from "../app/desktop-shutdown.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { throwIfAborted } from "@opensteer/shared/throwIfAborted";
import { delay } from "@opensteer/shared/delay";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { RestartPolicy } from "@opensteer/shared/restartPolicy";
import {
  ComputerAppSetupRequestSchema,
  type ComputerAppSetupRequest,
} from "@opensteer/integration-core";
import { inspectRunnerIdentity } from "@opensteer/runner-client";
import type { ComputerUseRunnerTargetResult } from "./local-runner-authority.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import {
  createId,
  harnessCatalog,
  harnessExecutableEnvironmentVariable,
  shipsHarnessRuntimeBytes,
  HostKeyFingerprintSchema,
  type EnvironmentId,
} from "@opensteer/core";
import {
  DesktopPersonalDeploymentStatusSchema,
  type DesktopPersonalComponentState,
  type DesktopPersonalDeploymentIssue,
  type DesktopPersonalDeploymentStatus,
  type DesktopPersonalDeploymentStep,
} from "@opensteer/protocol/desktop";
import {
  PersonalOwnerClaimRequiredError,
  PersonalHostAuthorityMismatchError,
  type PersonalHostBootstrapResult,
  type PersonalHostControlPort,
} from "./personal-host-control.js";
import type {
  PersonalDeploymentCredentialPort,
  PersonalDeploymentSecrets,
} from "../secrets/personal-deployment-credentials.js";
import {
  defaultPersonalDeploymentName,
  PersonalFilesystemError,
  PersonalDeploymentManifestSchema,
  PersonalRuntimeTransitionError,
  type PersonalDeploymentFilesystemPort,
  type PersonalDeploymentManifest,
  type PersonalDeploymentPreparedPaths,
  type PersonalRuntimeIdentity,
} from "../secrets/personal-deployment-store.js";
import {
  BoundedPersonalLog,
  processSensitiveValues,
  type PersonalChildProcess,
  type PersonalProcessPort,
  type PersonalProcessSpec,
  type PersonalRuntimeComponent,
} from "./personal-process-port.js";
import {
  PersonalRuntimeReleaseError,
  readPersonalRuntimeRelease,
  type VerifiedPersonalRuntimeRelease,
} from "../releases/personal-runtime-release.js";
import {
  ProtectedStateUnreadableError,
  ProtectedStorageUnavailableError,
} from "../secrets/protected-json-file.js";
import {
  deploymentConnectionFromVerifiedEndpoints,
  type DeploymentCatalogStore,
} from "@opensteer/client/connections";
import type { ResolvedConnection, VerifiedHostEndpoint } from "@opensteer/client/connections";
import {
  filterUserEnvironment,
  FixedPersonalUserEnvironment,
  NativePersonalUserEnvironment,
  PersonalUserEnvironmentError,
  type PersonalUserEnvironmentPort,
} from "./personal-user-environment.js";
import {
  PersonalHostRuntimeRecordSchema,
  type PersonalHostRuntimeRecord,
  type PersonalHostRuntimeSource,
} from "./personal-host-runtime.js";
import type {
  PersonalLocalBrowserHandle,
  PersonalLocalRuntimePort,
} from "./personal-local-runtime.js";

const defaultStartupTimeoutMs = 60_000;
const defaultShutdownTimeoutMs = 5_000;
const defaultRestartBackoffMs = 1_000;
const defaultMaximumRestartBackoffMs = 30_000;
const defaultRestartResetAfterMs = 5 * 60_000;

interface PersonalDeploymentSupervisorOptions {
  readonly accountIssuer?: URL | string | null;
  readonly allocatePort?: () => Promise<number>;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  readonly catalog: Pick<DeploymentCatalogStore, "upsertAndSelect">;
  /**
   * The computer-use bridge for this Deployment's Main Runner, or null where
   * computer use does not exist. The Main Runner is this Mac's own Runner, so
   * it reaches the helper the same way a lent slot's Runner does.
   */
  readonly computerUse?: {
    startForSlot(
      deploymentId: string,
    ): Promise<{ readonly token: string; readonly url: URL } | null>;
    stopForSlot(deploymentId: string): Promise<void>;
  };
  readonly credentials: PersonalDeploymentCredentialPort;
  readonly files: PersonalDeploymentFilesystemPort;
  readonly host: PersonalHostControlPort;
  readonly localRuntimes: PersonalLocalRuntimePort;
  readonly loopbackPorts?: PersonalLoopbackPortPort;
  readonly now?: () => Date;
  readonly log?: ShutdownLog;
  readonly onStatus?: (status: DesktopPersonalDeploymentStatus) => void;
  readonly processes: PersonalProcessPort;
  readonly portalOrigin?: URL | string | null;
  readonly release?: () => Promise<VerifiedPersonalRuntimeRelease>;
  readonly releaseDirectory: string;
  readonly restartBackoffMs?: number;
  readonly restartResetAfterMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly userEnvironment?: PersonalUserEnvironmentPort;
  readonly workspaceRoot: string;
}

export interface PersonalLoopbackPortPort {
  assertAvailable(port: number, component: "host" | "postgresql"): Promise<void>;
}

interface RunningChild {
  readonly child: PersonalChildProcess;
  readonly component: PersonalRuntimeComponent;
  readonly exit: Promise<ChildExit>;
  readonly logs: BoundedPersonalLog;
  readonly stderr: BoundedPersonalLog;
  expectedExit: boolean;
}

interface ChildExit {
  readonly code: number | null;
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
}

type StatusListener = (status: DesktopPersonalDeploymentStatus) => void;
type PersonalStatusComponent = PersonalRuntimeComponent | "browser";

/** The services whose absence ends the Deployment. Messaging is not one of them. */
const requiredComponents = ["postgresql", "host", "runner"] as const;

/**
 * Everything one messaging launch needs, kept so a restart replaces that
 * process alone. It is cleared with the stack, so a relaunch that raced a
 * shutdown finds nothing to start.
 */
interface PersonalMessagingLaunch {
  readonly deploymentId: string;
  readonly origin: string;
  readonly paths: PersonalDeploymentPreparedPaths;
  readonly release: VerifiedPersonalRuntimeRelease;
  readonly secrets: PersonalDeploymentSecrets;
}

/**
 * What the running stack's Host was launched from, kept so a Host crash
 * replaces that process alone: the Runner already holds this origin and its
 * enrolled identity, so the next Host must answer at the same port with the
 * same keys and secrets. It is cleared with the stack.
 */
interface PersonalHostLaunch {
  readonly manifest: PersonalDeploymentManifest;
  readonly paths: PersonalDeploymentPreparedPaths;
  readonly release: VerifiedPersonalRuntimeRelease;
  readonly secrets: PersonalDeploymentSecrets;
}

interface PersonalMessagingProcess {
  readonly port: number;
  readonly running: RunningChild;
}

interface PersonalOwnerClaimCapability {
  readonly hostInstanceId: string;
  readonly manifest: PersonalDeploymentManifest;
  readonly origin: string;
  readonly token: string;
}

/**
 * Owns the native Personal service graph. It never resolves another storage
 * driver or executable when a selected component is unavailable.
 */
export class PersonalDeploymentSupervisor implements PersonalHostRuntimeSource {
  readonly #accountIssuer: string | null;
  readonly #allocatePort: () => Promise<number>;
  readonly #baseEnvironment: Readonly<Record<string, string>>;
  readonly #catalog: Pick<DeploymentCatalogStore, "upsertAndSelect">;
  readonly #computerUse: PersonalDeploymentSupervisorOptions["computerUse"];
  readonly #credentials: PersonalDeploymentCredentialPort;
  readonly #files: PersonalDeploymentFilesystemPort;
  readonly #host: PersonalHostControlPort;
  readonly #localRuntimes: PersonalLocalRuntimePort;
  readonly #listeners = new Set<StatusListener>();
  readonly #loopbackPorts: PersonalLoopbackPortPort;
  readonly #now: () => Date;
  readonly #log: ShutdownLog;
  readonly #onStatus: (status: DesktopPersonalDeploymentStatus) => void;
  readonly #processes: PersonalProcessPort;
  readonly #portalOrigin: string | null;
  readonly #release: () => Promise<VerifiedPersonalRuntimeRelease>;
  readonly #restartPolicy: RestartPolicy;
  readonly #messagingRestartPolicy: RestartPolicy;
  readonly #shutdownTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #userEnvironment: PersonalUserEnvironmentPort;
  readonly #workspaceRoot: string;
  #abort: AbortController | undefined;
  #browser: PersonalLocalBrowserHandle | null = null;
  /** The Deployment whose computer-use bridge this stack holds, while it does. */
  #computerUseSlotId: string | null = null;
  #children = new Map<PersonalRuntimeComponent, RunningChild>();
  #diagnosticLogs = new Map<PersonalRuntimeComponent, string>();
  #desiredRunning = false;
  #restartWait: AbortController | undefined;
  #configuredManifestLookup: Promise<PersonalDeploymentManifest | null> | undefined;
  #hostLaunch: PersonalHostLaunch | null = null;
  /**
   * Survives the transition to `ready`, so a messaging service that failed on
   * the way up is still reported once the rest of the stack is up.
   */
  #messagingIssue: DesktopPersonalDeploymentIssue | null = null;
  #messagingLaunch: PersonalMessagingLaunch | null = null;
  #messagingProcess: PersonalMessagingProcess | null = null;
  #messagingReadinessAbort: AbortController | undefined;
  readonly #mutations = new MutationQueue();
  #shutdownRequested = false;
  #startPromise: Promise<DesktopPersonalDeploymentStatus> | undefined;
  #status = initialStatus();
  #stopPromise: Promise<void> | undefined;
  #runtime: PersonalHostRuntimeRecord | null = null;
  #ownerClaim: PersonalOwnerClaimCapability | null = null;

  constructor(options: PersonalDeploymentSupervisorOptions) {
    this.#accountIssuer = options.accountIssuer
      ? new URL(String(options.accountIssuer)).origin
      : null;
    this.#allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.#baseEnvironment = options.baseEnvironment ?? filterUserEnvironment(process.env);
    this.#userEnvironment =
      options.userEnvironment ??
      (options.baseEnvironment
        ? new FixedPersonalUserEnvironment(options.baseEnvironment)
        : new NativePersonalUserEnvironment());
    this.#catalog = options.catalog;
    this.#computerUse = options.computerUse;
    this.#credentials = options.credentials;
    this.#files = options.files;
    this.#host = options.host;
    this.#localRuntimes = options.localRuntimes;
    this.#processes = options.processes;
    this.#portalOrigin = options.portalOrigin ? new URL(String(options.portalOrigin)).origin : null;
    this.#release = options.release ?? (() => readPersonalRuntimeRelease(options.releaseDirectory));
    this.#workspaceRoot = normalizedAbsolutePath(options.workspaceRoot, "Personal Workspace root");
    this.#now = options.now ?? (() => new Date());
    this.#log =
      options.log ?? ((event, fields) => console.info(JSON.stringify({ event, ...fields })));
    this.#onStatus = options.onStatus ?? (() => undefined);
    this.#startupTimeoutMs = boundedDuration(
      options.startupTimeoutMs ?? defaultStartupTimeoutMs,
      "Personal startup timeout",
    );
    this.#shutdownTimeoutMs = boundedDuration(
      options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs,
      "Personal shutdown timeout",
    );
    const restartBackoffMs = boundedDuration(
      options.restartBackoffMs ?? defaultRestartBackoffMs,
      "Personal restart backoff",
    );
    const restartPolicyOptions = {
      baseMs: restartBackoffMs,
      maximumAttempts: null,
      maximumMs: Math.max(restartBackoffMs, defaultMaximumRestartBackoffMs),
      resetAfterMs: boundedDuration(
        options.restartResetAfterMs ?? defaultRestartResetAfterMs,
        "Personal restart reset interval",
      ),
    } as const;
    this.#restartPolicy = new RestartPolicy(restartPolicyOptions);
    this.#messagingRestartPolicy = new RestartPolicy(restartPolicyOptions);
    this.#loopbackPorts = options.loopbackPorts ?? new NativePersonalLoopbackPorts();
  }

  get status(): DesktopPersonalDeploymentStatus {
    return this.#status;
  }

  async assertComputerAppSetupTarget(requestInput: ComputerAppSetupRequest): Promise<void> {
    const request = ComputerAppSetupRequestSchema.parse(requestInput);
    const target = await this.checkComputerUseRunnerTarget(request.deploymentId, request.runnerId);
    if (!target.local)
      throw new Error("Computer app setup does not target this enrolled Personal Runner");
  }

  async checkComputerUseRunnerTarget(
    deploymentId: string,
    runnerId: string,
  ): Promise<ComputerUseRunnerTargetResult> {
    const manifest = await this.#files.load();
    if (!manifest || manifest.deploymentId !== deploymentId || manifest.runnerId !== runnerId) {
      return { local: false, reason: "not-local" };
    }
    const identity = await inspectRunnerIdentity(
      (await this.#files.prepare(manifest)).runnerDataDirectory,
    );
    if (!identity?.enrolled || identity.runnerId !== runnerId) {
      return { local: false, reason: "not-local" };
    }
    return { local: true };
  }

  current(): Promise<PersonalHostRuntimeRecord | null> {
    return Promise.resolve(this.#runtime ? structuredClone(this.#runtime) : null);
  }

  /**
   * The identity half of ownership belongs to the resolver — `access: "owner"`
   * already means this Deployment is the live Host this app supervises. What
   * is left here is liveness: a ready stack whose owner claim still matches the
   * running Host.
   */
  ownsHostSession(resolved: Pick<ResolvedConnection, "access">): boolean {
    const runtime = this.#runtime;
    const capability = this.#ownerClaim;
    return Boolean(
      resolved.access === "owner" &&
      this.#status.state === "ready" &&
      runtime &&
      capability &&
      capability.hostInstanceId === runtime.discovery.hostInstanceId &&
      capability.origin === runtime.localOrigin,
    );
  }

  async recoverOwnerSession(resolved: Pick<ResolvedConnection, "access">): Promise<boolean> {
    const capability = this.#ownerClaim;
    if (!capability || !this.ownsHostSession(resolved)) return false;
    await this.#host.claimOwner(
      capability.origin,
      capability.manifest,
      capability.token,
      AbortSignal.timeout(this.#startupTimeoutMs),
    );
    return this.#ownerClaim === capability && this.ownsHostSession(resolved);
  }

  subscribe(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): Promise<DesktopPersonalDeploymentStatus> {
    if (this.#status.state === "ready") return Promise.resolve(this.#status);
    if (this.#startPromise) return this.#startPromise;
    if (this.#shutdownRequested || this.#stopPromise) {
      return Promise.reject(new Error("Personal deployment is stopping."));
    }
    this.#desiredRunning = true;
    this.#restartWait?.abort();
    this.#restartPolicy.reset();
    const operation = (async () => {
      await this.#lookupConfiguredManifest();
      return this.#mutations.run(async () => {
        if (this.#shutdownRequested) throw new Error("Personal deployment is stopping.");
        // A manual Retry may have queued behind automatic crash recovery. If
        // recovery completed, it must not tear down the newly healthy stack
        // and launch a duplicate graph; if recovery gave up, this Retry is the
        // newer wish to keep the stack running.
        if (this.#status.state === "ready") return this.#status;
        this.#desiredRunning = true;
        return this.#startOperation(false);
      });
    })();
    this.#startPromise = operation;
    void operation.then(
      () => {
        if (this.#startPromise === operation) this.#startPromise = undefined;
      },
      () => {
        if (this.#startPromise === operation) this.#startPromise = undefined;
      },
    );
    return operation;
  }

  /** Restart only a deployment the user already chose on an earlier launch. */
  async resumeIfConfigured(): Promise<DesktopPersonalDeploymentStatus> {
    const existing = await this.#lookupConfiguredManifest();
    if (existing === null || this.#shutdownRequested) return this.#status;
    return this.start();
  }

  quiesce(): void {
    this.#shutdownRequested = true;
    this.#desiredRunning = false;
    this.#restartWait?.abort();
    this.#abort?.abort(new Error("Personal deployment is stopping."));
    // A messaging readiness poll can be the only thing the mutation queue is
    // waiting on, and it belongs to no start attempt once messaging restarts on
    // its own. Ending it here is what keeps shutdown prompt.
    this.#messagingReadinessAbort?.abort(new Error("Personal deployment is stopping."));
  }

  stop(signal?: AbortSignal): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.quiesce();
    const force = () => {
      const browser = this.#browser;
      if (browser)
        void browser
          .stop(signal)
          .catch((error: unknown) =>
            logShutdownError(this.#log, "browser", "deadline-close", error),
          );
      for (const [component, running] of this.#children) {
        running.expectedExit = true;
        void running.child
          .terminate("force")
          .catch((error: unknown) => logShutdownError(this.#log, component, "force", error));
      }
    };
    signal?.addEventListener("abort", force, { once: true });
    if (signal?.aborted) force();
    const operation = this.#mutations.run(async () => {
      this.#setStatus({ issue: null, state: "stopping", step: null });
      try {
        await this.#stopChildren(signal);
        this.#setStatus({
          components: stoppedComponents(this.#status.components),
          issue: null,
          state: "stopped",
          step: null,
        });
      } catch (error) {
        this.#setFailure(
          issue("shutdown-incomplete", "desktop", safeErrorDetail(error), "open-diagnostics"),
        );
        throw error;
      }
    });
    void operation
      .finally(() => signal?.removeEventListener("abort", force))
      .catch(() => undefined);
    this.#stopPromise = operation;
    void operation.then(
      () => {
        if (this.#stopPromise === operation) this.#stopPromise = undefined;
      },
      () => {
        if (this.#stopPromise === operation) this.#stopPromise = undefined;
      },
    );
    return operation;
  }

  diagnosticLog(component: PersonalRuntimeComponent): string {
    const child = this.#children.get(component);
    return child?.logs.text ?? this.#diagnosticLogs.get(component) ?? "";
  }

  async #startOperation(recovery: boolean): Promise<DesktopPersonalDeploymentStatus> {
    this.#abort?.abort(new Error("A newer Personal deployment start replaced this attempt."));
    const abort = new AbortController();
    this.#abort = abort;
    this.#setStatus({
      issue: recovery ? this.#status.issue : null,
      state: recovery ? "degraded" : "starting",
      step: "checking-computer",
    });
    try {
      if (this.#children.size || this.#browser) await this.#stopChildren();
      const release = await this.#release();
      // Read every start: an earlier attempt may have advanced the manifest.
      let manifest = await this.#loadOrCreateManifest(release);
      manifest = await this.#reconcileCompatibleRelease(manifest, release);
      this.#setStatus({
        components: componentsWithVersions(release),
        deploymentId: manifest.deploymentId,
        environmentId: manifest.environmentId,
      });
      await this.#loopbackPorts.assertAvailable(manifest.postgresPort, "postgresql");
      await this.#loopbackPorts.assertAvailable(manifest.hostPort, "host");
      const paths = await this.#files.prepare(manifest);
      const secrets = await this.#credentials.ensure(manifest, paths);
      if (manifest.hostKeyFingerprint === null) {
        manifest = await this.#advanceManifest(manifest, {
          hostKeyFingerprint: secrets.hostKeyFingerprint,
        });
      }
      if (manifest.hostKeyFingerprint !== secrets.hostKeyFingerprint) {
        throw new PersonalHostAuthorityMismatchError(
          "Personal Host signing key changed after its authority was recorded.",
        );
      }
      await this.#startStack(release, manifest, paths, secrets, abort.signal);
      if (recovery) this.#restartPolicy.markStarted();
      else this.#restartPolicy.reset();
      this.#setStatus({ issue: this.#messagingIssue, state: "ready", step: "ready" });
      return this.#status;
    } catch (error) {
      if (abort.signal.aborted && !this.#desiredRunning) {
        await this.#stopChildren().catch(() => undefined);
        return this.#status;
      }
      await this.#stopChildren().catch(() => undefined);
      const permanent = permanentStartFailure(error);
      if (permanent) this.#desiredRunning = false;
      // Crash recovery reports a failure that can pass with its next restart.
      if (recovery && !permanent) throw error;
      const failure = classifyFailure(error, this.#status.step);
      this.#setFailure(failure.issue, failure.state);
      throw error;
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
    }
  }

  /**
   * The first lookup is shared by automatic resume and explicit first-run
   * setup. Until it resolves the renderer sees `checking`, so a stale catalog
   * selection can never open a Personal Host that is not running yet. A failed
   * lookup is forgotten, so the next start reads again.
   */
  #lookupConfiguredManifest(): Promise<PersonalDeploymentManifest | null> {
    if (this.#configuredManifestLookup) return this.#configuredManifestLookup;
    const lookup = this.#files.load().then(
      (manifest) => {
        if (this.#shutdownRequested) return manifest;
        if (manifest) {
          this.#setStatus({
            deploymentId: manifest.deploymentId,
            environmentId: manifest.environmentId,
            issue: null,
            state: "checking",
            step: "checking-computer",
          });
        } else if (!this.#desiredRunning) {
          this.#setStatus({
            deploymentId: null,
            environmentId: null,
            issue: null,
            state: "stopped",
            step: null,
          });
        }
        return manifest;
      },
      (error: unknown) => {
        if (this.#configuredManifestLookup === lookup) this.#configuredManifestLookup = undefined;
        if (!this.#shutdownRequested) {
          this.#setFailure(
            issue("directory-invalid", "desktop", safeErrorDetail(error), "restore-permissions"),
          );
        }
        throw error;
      },
    );
    this.#configuredManifestLookup = lookup;
    return lookup;
  }

  async #startStack(
    release: VerifiedPersonalRuntimeRelease,
    manifestInput: PersonalDeploymentManifest,
    paths: PersonalDeploymentPreparedPaths,
    secrets: PersonalDeploymentSecrets,
    signal: AbortSignal,
  ): Promise<void> {
    this.#ownerClaim = null;
    this.#messagingIssue = null;
    let manifest = manifestInput;
    this.#setStatus({
      components: componentState(this.#status.components, "postgresql", "starting"),
      step: "preparing-database",
    });
    manifest = await this.#ensureDatabaseInitialized(release, manifest, paths, secrets, signal);
    const postgres = this.#spawn(postgresSpec(release, manifest, paths));
    await this.#raceChild(
      postgres,
      this.#waitForPostgres(release, manifest, paths, signal),
      signal,
      "PostgreSQL",
    );
    this.#setStatus({
      components: componentState(this.#status.components, "postgresql", "ready"),
      step: "starting-host",
    });

    const launchedHost = await this.#launchHost(release, manifest, paths, secrets, signal);
    const { bootstrap, origin, verifiedHost } = launchedHost;
    manifest = launchedHost.manifest;
    this.#hostLaunch = { manifest, paths, release, secrets };

    // The browser starts first because the Runner is what relays it: the
    // bridge has to exist before the process that reaches it does, and both
    // belong to one machine identity rather than two.
    this.#setStatus({
      components: componentState(this.#status.components, "browser", "starting"),
      step: "connecting-computer",
    });
    let browser: PersonalLocalBrowserHandle;
    try {
      browser = await this.#localRuntimes.startBrowser({ paths, runtimeId: "desktop-browser" });
    } catch (error) {
      throw new PersonalBrowserUnavailableError(safeErrorDetail(error), { cause: error });
    }
    this.#browser = browser;

    this.#setStatus({
      components: componentState(this.#status.components, "runner", "starting"),
      step: "starting-local-agents",
    });
    const userEnvironment = await this.#userEnvironment.resolve();
    // Computer use reaches the Main Runner too: it is this Mac's own Runner,
    // and a Personal Deployment is the shape where that Mac and this app are
    // the same computer.
    const computerUse =
      (await this.#computerUse?.startForSlot(manifest.deploymentId).catch(() => null)) ?? null;
    this.#computerUseSlotId = computerUse ? manifest.deploymentId : null;
    const runner = this.#spawn(
      runnerSpec(
        release,
        manifest,
        paths,
        bootstrap.runnerEnrollmentToken,
        userEnvironment,
        {
          bridgeToken: browser.bridgeToken,
          runtimeId: browser.runtimeId,
          signIn: browser.signIn,
          url: browser.url,
        },
        computerUse,
      ),
    );
    await this.#raceChild(
      runner,
      this.#host.waitForRunner(
        origin,
        manifest.deploymentId,
        manifest.environmentId as EnvironmentId,
        manifest.runnerId,
        signal,
      ),
      signal,
      "Runner",
    );
    this.#setStatus({ step: "creating-main" });
    await withTimeout(
      this.#host.ensureMain(origin, manifest.deploymentId, signal),
      this.#startupTimeoutMs,
      {
        abortFallback: "Personal setup was cancelled.",
        signal,
        timeoutError: () => new Error("Personal Main Workspace creation timed out."),
      },
    );
    this.#assertCompleteStack();
    await this.#catalog.upsertAndSelect(
      deploymentConnectionFromVerifiedEndpoints({
        accountAccess: null,
        endpoints: [verifiedHost],
        kind: "personal",
        name: manifest.name,
        source: { kind: "manual" },
      }),
    );
    this.#assertCompleteStack();
    this.#setStatus({
      components: componentState(this.#status.components, "runner", "ready"),
    });

    // The placement poll gets its own controller so no outcome — success,
    // timeout, or stack teardown — can leave it polling a Host this operation
    // no longer owns.
    const placementAbort = new AbortController();
    const relayAbort = () => placementAbort.abort(signal.reason);
    if (signal.aborted) relayAbort();
    else signal.addEventListener("abort", relayAbort, { once: true });
    try {
      await withTimeout(
        this.#host.waitForBrowserPlacement(
          origin,
          manifest.deploymentId,
          manifest.environmentId as EnvironmentId,
          browser.runtimeId,
          placementAbort.signal,
        ),
        this.#startupTimeoutMs,
        {
          abortFallback: "Personal setup was cancelled.",
          signal,
          timeoutError: () =>
            new Error("This computer's Browser Runtime did not become available in time."),
        },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PersonalBrowserUnavailableError(safeErrorDetail(error), { cause: error });
    } finally {
      signal.removeEventListener("abort", relayAbort);
      placementAbort.abort(new Error("Personal browser placement wait ended."));
    }
    this.#assertCompleteStack();
    this.#setStatus({
      components: componentState(this.#status.components, "browser", "ready"),
    });

    // Last, and never gating: messaging carries Slack, and a Deployment with no
    // messaging account connected is complete without it. Its failures are
    // reported as a component issue on an otherwise ready stack.
    await this.#startMessaging(release, manifest, paths, secrets, origin);
  }

  /**
   * One Host process, from spawn to a claimed owner session. The owner claim
   * token is a capability of this one process, so every launch mints its own;
   * everything else comes from the manifest and protected storage, which is
   * what lets a Runner already pointed at this origin reconnect to it.
   */
  async #launchHost(
    release: VerifiedPersonalRuntimeRelease,
    manifestInput: PersonalDeploymentManifest,
    paths: PersonalDeploymentPreparedPaths,
    secrets: PersonalDeploymentSecrets,
    signal: AbortSignal,
  ): Promise<{
    readonly bootstrap: PersonalHostBootstrapResult;
    readonly manifest: PersonalDeploymentManifest;
    readonly origin: string;
    readonly verifiedHost: VerifiedHostEndpoint;
  }> {
    let manifest = manifestInput;
    const ownerClaimToken = randomBytes(32).toString("base64url");
    const host = this.#spawn(
      hostSpec(
        release,
        manifest,
        paths,
        secrets,
        ownerClaimToken,
        this.#accountIssuer,
        this.#portalOrigin,
      ),
    );
    const origin = `http://127.0.0.1:${manifest.hostPort}`;
    const verifiedHost = await this.#raceChild(
      host,
      this.#host.waitForHost(origin, manifest, signal),
      signal,
      "Host",
    );
    if (!verifiedHost.discoveryEnvelope) {
      throw new Error("Personal Host canonical discovery did not include its signed envelope.");
    }
    this.#runtime = PersonalHostRuntimeRecordSchema.parse({
      discovery: verifiedHost.discovery,
      discoveryEnvelope: verifiedHost.discoveryEnvelope,
      localOrigin: origin,
      observedAt: this.#now().toISOString(),
      ownership: "desktop-personal-host-supervisor",
      schemaVersion: 2,
      state: "ready",
      verification: "signed-loopback-discovery",
    });
    this.#setStatus({
      components: componentState(this.#status.components, "host", "ready"),
      step: "connecting-computer",
    });
    const bootstrap = await withTimeout(
      this.#host.bootstrap(origin, manifest, ownerClaimToken, signal),
      this.#startupTimeoutMs,
      {
        abortFallback: "Personal setup was cancelled.",
        signal,
        timeoutError: () => new Error("Personal owner bootstrap timed out."),
      },
    );
    if (!manifest.ownerInitialized) {
      manifest = await this.#advanceManifest(manifest, { ownerInitialized: true });
    }
    this.#ownerClaim = {
      hostInstanceId: verifiedHost.discovery.hostInstanceId,
      manifest,
      origin,
      token: ownerClaimToken,
    };
    return { bootstrap, manifest, origin, verifiedHost };
  }

  /**
   * Replaces a crashed Host process and nothing else. The Runner keeps
   * executing while its Host connection is down and re-attaches its Runs to the
   * next Host at the same origin, so restarting it too would turn a Host crash
   * into lost Runs. Missing required siblings need a whole-stack restart.
   */
  async #restartHostAlone(): Promise<boolean> {
    const launch = this.#hostLaunch;
    const runner = this.#children.get("runner");
    if (!launch || !runner || !this.#children.has("postgresql") || this.#children.has("host")) {
      return false;
    }
    const abort = new AbortController();
    this.#abort = abort;
    try {
      // Messaging's attachment ended with the Host it was attached to.
      const components = this.#runningMessaging()
        ? componentState(this.#status.components, "messaging", "starting")
        : this.#status.components;
      this.#setStatus({
        components: componentState(components, "host", "starting"),
        step: "starting-host",
      });
      // Re-read so a rename made while running reaches the new Host; anything
      // the running Runner and database were started from must be unchanged.
      const manifest = await this.#files.load();
      if (!manifest || !sameRunningIdentity(manifest, launch.manifest)) {
        throw new PersonalHostAuthorityMismatchError();
      }
      await this.#loopbackPorts.assertAvailable(manifest.hostPort, "host");
      const { origin } = await this.#launchHost(
        launch.release,
        manifest,
        launch.paths,
        launch.secrets,
        abort.signal,
      );
      await this.#raceChild(
        runner,
        this.#host.waitForRunner(
          origin,
          manifest.deploymentId,
          manifest.environmentId as EnvironmentId,
          manifest.runnerId,
          abort.signal,
        ),
        abort.signal,
        "Runner",
      );
    } catch (error) {
      const errors: unknown[] = [];
      await this.#stopProcesses(["host"], errors);
      if (errors.length) throw new AggregateError(errors, "The crashed Host could not stop.");
      throw error;
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
    }
    this.#restartPolicy.markStarted();
    this.#setStatus({ issue: this.#messagingIssue, state: "ready", step: "ready" });
    void this.#reconfirmMessaging().catch(() => undefined);
    return true;
  }

  async #startMessaging(
    release: VerifiedPersonalRuntimeRelease,
    manifest: PersonalDeploymentManifest,
    paths: PersonalDeploymentPreparedPaths,
    secrets: PersonalDeploymentSecrets,
    origin: string,
  ): Promise<void> {
    this.#messagingLaunch = {
      deploymentId: manifest.deploymentId,
      origin,
      paths,
      release,
      secrets,
    };
    this.#messagingRestartPolicy.reset();
    await this.#launchMessaging(false);
  }

  /**
   * One messaging process, from spawn to attached. Nothing here throws: the
   * stack this service rides on is already up, and losing messaging is a
   * component issue rather than a failed Deployment.
   */
  async #launchMessaging(recovery: boolean): Promise<void> {
    const launch = this.#messagingLaunch;
    if (!launch || !this.#desiredRunning || this.#children.has("messaging")) return;
    this.#setStatus({
      components: componentState(this.#status.components, "messaging", "starting"),
    });
    let running: RunningChild;
    let port: number;
    try {
      // The messaging service binds a loopback port only for its own health
      // route, so it is allocated per start rather than pinned in the manifest.
      port = await this.#allocatePort();
      running = this.#spawn(
        messagingSpec(launch.release, launch.paths, launch.secrets, launch.origin, port),
      );
    } catch (error) {
      this.#reportMessagingUnavailable(safeErrorDetail(error));
      return;
    }
    this.#messagingProcess = { port, running };
    if (!(await this.#waitForMessagingAttached(running, launch.deploymentId, port))) return;
    if (recovery) this.#messagingRestartPolicy.markStarted();
    this.#markMessagingReady();
  }

  /**
   * Messaging reconnects to a restarted Host by itself, so its running process
   * is re-proved rather than replaced. One that is not running belongs to its
   * own crash path.
   */
  async #reconfirmMessaging(): Promise<void> {
    const launch = this.#messagingLaunch;
    const messaging = this.#runningMessaging();
    if (!launch || !messaging) return;
    if (
      await this.#waitForMessagingAttached(messaging.running, launch.deploymentId, messaging.port)
    ) {
      this.#markMessagingReady();
    }
  }

  #runningMessaging(): PersonalMessagingProcess | null {
    const messaging = this.#messagingProcess;
    return messaging && this.#children.get("messaging") === messaging.running ? messaging : null;
  }

  #markMessagingReady(): void {
    this.#messagingIssue = null;
    this.#setStatus({
      components: componentState(this.#status.components, "messaging", "ready"),
      ...(this.#status.issue?.component === "messaging" ? { issue: null } : {}),
    });
  }

  /**
   * A spawned messaging service is not a serving one — it is ready when its own
   * readiness route reports the Host connection authenticated. A process that
   * exited instead ends the wait immediately, because the crash path owns that
   * outcome and its bounded restart.
   */
  async #waitForMessagingAttached(
    running: RunningChild,
    deploymentId: string,
    port: number,
  ): Promise<boolean> {
    this.#messagingReadinessAbort?.abort(new Error("A newer messaging readiness check started."));
    const abort = new AbortController();
    this.#messagingReadinessAbort = abort;
    try {
      const outcome = await Promise.race([
        withTimeout(
          this.#host.waitForMessaging(`http://127.0.0.1:${port}`, deploymentId, abort.signal),
          this.#startupTimeoutMs,
          {
            abortFallback: "Personal setup was cancelled.",
            signal: abort.signal,
            timeoutError: () =>
              new Error("Messaging did not attach to this computer's Host in time."),
          },
        ).then(
          () => ({ kind: "attached" }) as const,
          (error: unknown) => ({ error, kind: "unavailable" }) as const,
        ),
        running.exit.then(() => ({ kind: "exited" }) as const),
      ]);
      if (outcome.kind === "attached")
        return (
          !abort.signal.aborted &&
          this.#desiredRunning &&
          this.#children.get("messaging") === running
        );
      // The process is deliberately left running: it may yet attach, and
      // killing it would spend a restart on a service that is still trying.
      if (outcome.kind === "unavailable" && !abort.signal.aborted && this.#desiredRunning) {
        running.logs.flush();
        this.#reportMessagingUnavailable(
          new PersonalReadinessError(outcome.error, running.logs.text).message,
          "degraded",
        );
      }
      return false;
    } finally {
      if (this.#messagingReadinessAbort === abort) this.#messagingReadinessAbort = undefined;
      abort.abort(new Error("Personal messaging readiness wait ended."));
    }
  }

  /**
   * Messaging has its own restart backoff and process: the Host, Runner and browser this
   * Deployment is are never torn down for the one service it survives without.
   * The backoff is awaited outside the mutation queue so a messaging crash
   * cannot hold up a stop or a stack recovery.
   */
  async #recoverMessagingAfterCrash(result: ChildExit, diagnostic: string): Promise<void> {
    if (!this.#desiredRunning || !this.#messagingLaunch) return;
    const detail = childExitDetail("messaging", result, diagnostic);
    const delayMs = this.#messagingRestartPolicy.nextDelayMs()!;
    this.#reportMessagingUnavailable(
      `Restarting Messaging in ${Math.ceil(delayMs / 1_000)} seconds. ${detail}`,
      "degraded",
    );
    await delay(delayMs);
    if (!this.#desiredRunning) return;
    await this.#mutations.run(() => this.#launchMessaging(true));
  }

  #reportMessagingUnavailable(
    detail: string,
    state: DesktopPersonalComponentState = "failed",
  ): void {
    this.#messagingIssue = issue("messaging-unavailable", "messaging", detail, "restart-opensteer");
    this.#setStatus({
      components: componentState(this.#status.components, "messaging", state),
      issue: this.#messagingIssue,
    });
  }

  async #ensureDatabaseInitialized(
    release: VerifiedPersonalRuntimeRelease,
    manifestInput: PersonalDeploymentManifest,
    paths: PersonalDeploymentPreparedPaths,
    secrets: PersonalDeploymentSecrets,
    signal: AbortSignal,
  ): Promise<PersonalDeploymentManifest> {
    let manifest = manifestInput;
    const observed = await this.#files.inspectDatabase(manifest);
    if (manifest.databaseInitialized) {
      if (observed !== "initialized") {
        throw new PersonalDatabaseInitializationError(
          "The Personal database manifest is initialized but its PostgreSQL data directory is missing or incompatible.",
        );
      }
      return manifest;
    }
    if (observed === "inconsistent") {
      throw new PersonalDatabaseInitializationError(
        "The Personal PostgreSQL directory contains an incomplete or incompatible initialization.",
      );
    }
    if (observed === "empty") {
      // initdb has no stdin password mode; the secret is staged as an
      // owner-only file for exactly this call and removed afterwards.
      const passwordFile = await this.#files.stageDatabaseInitPassword(
        manifest,
        secrets.databasePassword,
      );
      let result;
      try {
        result = await this.#processes.run(
          {
            arguments: [
              "--pgdata",
              paths.postgresDataDirectory,
              "--username",
              "opensteer",
              "--auth-local=scram-sha-256",
              "--auth-host=scram-sha-256",
              "--encoding=UTF8",
              "--no-locale",
              `--pwfile=${passwordFile}`,
            ],
            component: "postgresql",
            cwd: paths.rootDirectory,
            environment: postgresEnvironment(this.#baseEnvironment),
            executable: release.entrypoints.initdb,
          },
          { signal, timeoutMs: this.#startupTimeoutMs },
        );
      } finally {
        // Removal must not mask an initdb failure; the staged file is
        // owner-only inside the deployment's private directory and the next
        // initialization attempt re-stages over it.
        await this.#files.discardDatabaseInitPassword(manifest).catch(() => undefined);
      }
      if (result.code !== 0) {
        throw new PersonalDatabaseInitializationError(
          safeErrorDetail(result.stderr || `initdb exited with ${result.code ?? result.signal}`),
        );
      }
      if ((await this.#files.inspectDatabase(manifest)) !== "initialized") {
        throw new PersonalDatabaseInitializationError(
          "PostgreSQL initialization did not produce the pinned data format.",
        );
      }
    }
    manifest = await this.#advanceManifest(manifest, { databaseInitialized: true });
    return manifest;
  }

  async #waitForPostgres(
    release: VerifiedPersonalRuntimeRelease,
    manifest: PersonalDeploymentManifest,
    paths: PersonalDeploymentPreparedPaths,
    signal: AbortSignal,
  ): Promise<void> {
    const operation = (async () => {
      while (true) {
        throwIfAborted(signal, "Personal setup was cancelled.");
        const result = await this.#processes.run(
          {
            arguments: [
              "--host=127.0.0.1",
              `--port=${manifest.postgresPort}`,
              "--username=opensteer",
              "--dbname=postgres",
              "--quiet",
            ],
            component: "postgresql",
            cwd: paths.rootDirectory,
            environment: postgresEnvironment(this.#baseEnvironment),
            executable: release.entrypoints.pgIsReady,
          },
          { signal, timeoutMs: Math.min(this.#startupTimeoutMs, 2_000) },
        );
        if (result.code === 0) return;
        await delay(200, signal);
      }
    })();
    await withTimeout(operation, this.#startupTimeoutMs, {
      abortFallback: "Personal setup was cancelled.",
      signal,
      timeoutError: () => new Error("PostgreSQL did not become ready in time."),
    });
  }

  #spawn(spec: PersonalProcessSpec): RunningChild {
    if (this.#shutdownRequested) throw new Error("Personal deployment is stopping.");
    if (this.#children.has(spec.component)) {
      throw new Error(`Personal ${spec.component} process is already running.`);
    }
    const child = this.#processes.spawn(spec);
    this.#diagnosticLogs.delete(spec.component);
    const logs = new BoundedPersonalLog(undefined, processSensitiveValues(spec));
    const stderr = new BoundedPersonalLog(16 * 1_024, processSensitiveValues(spec));
    logs.attach(child.stdout);
    logs.attach(child.stderr);
    stderr.attach(child.stderr);
    let running: RunningChild;
    const exit = new Promise<ChildExit>((resolvePromise) => {
      let settled = false;
      child.once("error", (error) => finish({ code: null, error, signal: null }));
      child.once("exit", (code, signal) => finish({ code, signal }));
      const finish = (value: ChildExit) => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
    });
    running = { child, component: spec.component, exit, expectedExit: false, logs, stderr };
    this.#children.set(spec.component, running);
    void exit.then((result) => {
      logs.flush();
      stderr.flush();
      this.#diagnosticLogs.set(spec.component, logs.text);
      if (this.#children.get(spec.component) === running) {
        this.#children.delete(spec.component);
      }
      if (running.expectedExit || !this.#desiredRunning) return;
      if (spec.component === "messaging") {
        // Restarting the stack for messaging would trade a Deployment that
        // works for one that does not, so only this process comes back.
        void this.#recoverMessagingAfterCrash(result, logs.text).catch(() => undefined);
        return;
      }
      if (this.#status.state === "ready") {
        this.#messagingReadinessAbort?.abort(new Error("The Personal Host connection ended."));
        void this.#mutations
          .run(() => this.#recoverAfterCrash(spec.component, result, stderr.text))
          .catch(() => undefined);
      }
    });
    return running;
  }

  async #raceChild<T>(
    target: RunningChild,
    readiness: Promise<T>,
    signal: AbortSignal,
    label: string,
  ): Promise<T> {
    this.#assertExpectedStack(target.component);
    let result: T;
    try {
      result = await Promise.race([
        withTimeout(readiness, this.#startupTimeoutMs, {
          abortFallback: "Personal setup was cancelled.",
          signal,
          timeoutError: () => new Error(`${label} did not become ready.`),
        }),
        // Messaging is still running during a Host-only restart, but nothing
        // waits on it and its own crash path owns its exit.
        ...[...this.#children.values()]
          .filter((running) => running.component !== "messaging")
          .map((running) =>
            running.exit.then((exit) => {
              running.logs.flush();
              running.stderr.flush();
              throw new PersonalChildExitedError(
                running.component,
                exit,
                running.stderr.text || running.logs.text,
              );
            }),
          ),
      ]);
    } catch (error) {
      if (signal.aborted || error instanceof PersonalChildExitedError) throw error;
      const diagnostic = [...this.#children.values()]
        .map((running) => {
          running.logs.flush();
          return running.logs.text
            ? `${displayComponent(running.component)}: ${running.logs.text}`
            : "";
        })
        .filter(Boolean)
        .join("\n");
      throw new PersonalReadinessError(error, diagnostic);
    }
    this.#assertExpectedStack(target.component);
    return result;
  }

  #assertExpectedStack(target: PersonalRuntimeComponent): void {
    const expected =
      target === "postgresql"
        ? (["postgresql"] as const)
        : target === "host"
          ? (["postgresql", "host"] as const)
          : (["postgresql", "host", "runner"] as const);
    for (const component of expected) {
      if (!this.#children.has(component)) {
        throw new PersonalChildExitedError(component, { code: null, signal: null });
      }
    }
  }

  #assertCompleteStack(): void {
    for (const component of requiredComponents) {
      if (!this.#children.has(component)) {
        throw new PersonalChildExitedError(component, { code: null, signal: null });
      }
    }
  }

  async #recoverAfterCrash(
    component: PersonalStatusComponent,
    result: ChildExit,
    diagnostic = "",
  ): Promise<void> {
    let detail = childExitDetail(component, result, diagnostic);
    while (this.#desiredRunning) {
      const delayMs = this.#restartPolicy.nextDelayMs()!;
      this.#ownerClaim = null;
      this.#runtime = null;
      this.#setStatus({
        components: componentState(this.#status.components, component, "degraded"),
        issue: issue(
          unavailableIssueCode(component),
          component,
          `Restarting ${displayComponent(component)} in ${Math.ceil(delayMs / 1_000)} seconds. ${detail}`,
          "restart-opensteer",
        ),
        state: "degraded",
        step: null,
      });
      const wait = new AbortController();
      this.#restartWait = wait;
      await delay(delayMs, wait.signal).catch((error: unknown) => {
        if (!wait.signal.aborted) throw error;
      });
      if (this.#restartWait === wait) this.#restartWait = undefined;
      if (!this.#desiredRunning) return;
      try {
        if (component === "host" && this.#hostLaunch && (await this.#restartHostAlone())) return;
        await this.#stopChildren();
        await this.#startOperation(true);
        return;
      } catch (error) {
        if (!this.#desiredRunning) return;
        if (permanentStartFailure(error)) {
          this.#desiredRunning = false;
          const failure = classifyFailure(error, this.#status.step);
          await this.#stopChildren().catch(() => undefined);
          this.#setFailure(failure.issue, failure.state);
          return;
        }
        detail = safeErrorDetail(error);
      }
    }
  }

  async #stopChildren(signal?: AbortSignal): Promise<void> {
    this.#ownerClaim = null;
    this.#hostLaunch = null;
    this.#messagingIssue = null;
    this.#messagingLaunch = null;
    this.#messagingProcess = null;
    this.#messagingReadinessAbort?.abort(new Error("Personal messaging readiness wait ended."));
    this.#runtime = null;
    // Keep the backoff across failed starts; only healthy uptime resets it.
    this.#restartPolicy.dispose();
    this.#messagingRestartPolicy.dispose();
    const errors: unknown[] = [];
    // Reverse start order, so messaging leaves before the Host it attaches to.
    await this.#stopProcesses(["messaging"], errors);
    const browser = this.#browser;
    if (browser) {
      this.#setStatus({
        components: componentState(this.#status.components, "browser", "stopping"),
      });
      try {
        await runShutdownStep(this.#log, "browser", "save-and-close", 18_000, (deadline) =>
          browser.stop(signal ? AbortSignal.any([signal, deadline]) : deadline),
        );
        this.#browser = null;
      } catch (error) {
        errors.push(new Error("Browser save and close failed.", { cause: error }));
      } finally {
        this.#setStatus({
          components: componentState(
            this.#status.components,
            "browser",
            this.#browser ? "failed" : "stopped",
          ),
        });
      }
    } else if (this.#status.components.browser.state !== "stopped") {
      this.#setStatus({
        components: componentState(this.#status.components, "browser", "stopped"),
      });
    }
    // Keep the relay and Host alive until the browser's final profile commit.
    await this.#stopProcesses(["runner"], errors);
    const computerUseSlotId = this.#computerUseSlotId;
    this.#computerUseSlotId = null;
    if (computerUseSlotId) {
      try {
        await runShutdownStep(this.#log, "computer-use", "stop-slot", 2_000, () =>
          this.#computerUse?.stopForSlot(computerUseSlotId),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    await this.#stopProcesses(["host", "postgresql"], errors);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Personal deployment did not stop cleanly.");
    }
  }

  async #stopProcesses(
    components: readonly PersonalRuntimeComponent[],
    errors: unknown[],
  ): Promise<void> {
    for (const component of components) {
      const running = this.#children.get(component);
      if (!running) continue;
      running.expectedExit = true;
      let stopped = false;
      this.#setStatus({
        components: componentState(this.#status.components, component, "stopping"),
      });
      try {
        await runShutdownStep(
          this.#log,
          component,
          "graceful",
          this.#shutdownTimeoutMs,
          async () => {
            await running.child.terminate("graceful");
            await waitForExit(running, this.#shutdownTimeoutMs);
          },
        );
        stopped = true;
      } catch (error) {
        try {
          await runShutdownStep(
            this.#log,
            component,
            "force",
            Math.min(this.#shutdownTimeoutMs, 2_000),
            async () => {
              await running.child.terminate("force");
              await waitForExit(running, Math.min(this.#shutdownTimeoutMs, 2_000));
            },
          );
          stopped = true;
        } catch (killError) {
          errors.push(new AggregateError([error, killError], `${component} could not stop.`));
        }
      } finally {
        if (stopped && this.#children.get(component) === running) this.#children.delete(component);
        this.#setStatus({
          components: componentState(
            this.#status.components,
            component,
            stopped ? "stopped" : "failed",
          ),
        });
      }
    }
  }

  async #loadOrCreateManifest(
    release: VerifiedPersonalRuntimeRelease,
  ): Promise<PersonalDeploymentManifest> {
    const existing = await this.#files.load();
    if (existing) return existing;
    const firstPort = await this.#allocatePort();
    let secondPort = await this.#allocatePort();
    let attempts = 0;
    while (secondPort === firstPort && attempts < 5) {
      secondPort = await this.#allocatePort();
      attempts += 1;
    }
    if (secondPort === firstPort) throw new Error("Could not allocate distinct private ports.");
    const now = this.#now().toISOString();
    return this.#files.create({
      createdAt: now,
      databaseInitialized: false,
      deploymentId: createId("deployment"),
      environmentId: createId("environment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: null,
      hostPort: firstPort,
      name: defaultPersonalDeploymentName(),
      ownerInitialized: false,
      postgresPort: secondPort,
      release: release.identity,
      runnerId: createId("runner"),
      schemaVersion: 3,
      setupIntentId: globalThis.crypto.randomUUID(),
      updatedAt: now,
      workspaceRoot: this.#workspaceRoot,
    });
  }

  async #advanceManifest(
    manifest: PersonalDeploymentManifest,
    updates: Partial<
      Pick<
        PersonalDeploymentManifest,
        "databaseInitialized" | "hostKeyFingerprint" | "ownerInitialized"
      >
    >,
  ): Promise<PersonalDeploymentManifest> {
    return this.#files.save(
      manifest,
      PersonalDeploymentManifestSchema.parse({
        ...manifest,
        ...updates,
        revision: manifest.revision + 1,
        updatedAt: this.#now().toISOString(),
      }),
    );
  }

  async #reconcileCompatibleRelease(
    manifest: PersonalDeploymentManifest,
    release: VerifiedPersonalRuntimeRelease,
  ): Promise<PersonalDeploymentManifest> {
    if (manifest.workspaceRoot !== this.#workspaceRoot) {
      throw new PersonalUpdateRequiredError(
        "This Personal deployment belongs to a different managed Workspace root.",
      );
    }
    if (JSON.stringify(manifest.release) === JSON.stringify(release.identity)) return manifest;
    if (
      manifest.release.operatingSystem !== release.identity.operatingSystem ||
      manifest.release.architecture !== release.identity.architecture ||
      manifest.release.postgresMajor !== release.identity.postgresMajor
    ) {
      throw new PersonalUpdateRequiredError(
        "The bundled Personal runtime requires a platform or PostgreSQL-major migration before this deployment can start.",
      );
    }
    await this.#snapshotDatabase(manifest, release.identity);
    // `#release()` has already verified every byte and the manifest's protocol
    // range. The old release is not edited: committing this one manifest
    // revision is the cutover boundary. A crash before it retries the update;
    // a crash after it starts the exact newly committed release.
    try {
      return await this.#files.commitCompatibleRelease(
        manifest,
        release.identity,
        this.#now().toISOString(),
      );
    } catch (error) {
      if (error instanceof PersonalRuntimeTransitionError) {
        throw new PersonalUpdateRequiredError(error.message);
      }
      throw error;
    }
  }

  /**
   * The children are stopped and the new release has not run yet, so this is
   * the last copy of the data the old release left. A safety net only: a
   * snapshot that cannot be taken never holds the update back.
   */
  async #snapshotDatabase(
    manifest: PersonalDeploymentManifest,
    toRelease: PersonalRuntimeIdentity,
  ): Promise<void> {
    if (!manifest.databaseInitialized) return;
    const started = performance.now();
    try {
      const snapshot = await this.#files.snapshotDatabase(manifest, toRelease, this.#now());
      this.#log("personal-database-snapshot", {
        durationMs: Math.round(performance.now() - started),
        snapshot,
      });
    } catch (error) {
      this.#log("personal-database-snapshot-skipped", { error: safeErrorDetail(error) });
    }
  }

  #setFailure(
    failure: DesktopPersonalDeploymentIssue,
    state: "repair-required" | "update-required" = "repair-required",
  ): void {
    this.#setStatus({ issue: failure, state, step: null });
  }

  #setStatus(update: Partial<DesktopPersonalDeploymentStatus>): void {
    const nextState = update.state ?? this.#status.state;
    const next = DesktopPersonalDeploymentStatusSchema.parse({
      ...this.#status,
      ...update,
      canStart:
        nextState === "stopped" || nextState === "degraded" || nextState === "repair-required",
    });
    this.#status = next;
    try {
      this.#onStatus(next);
    } catch {
      // Status reporting must never alter service ownership.
    }
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch {
        // One renderer listener cannot interrupt the supervisor.
      }
    }
  }
}

class PersonalUpdateRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalUpdateRequiredError";
  }
}

class PersonalDatabaseInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalDatabaseInitializationError";
  }
}

class PersonalBrowserUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersonalBrowserUnavailableError";
  }
}

export class PersonalPrivatePortUnavailableError extends Error {
  readonly component: "host" | "postgresql";

  constructor(component: "host" | "postgresql", options?: ErrorOptions) {
    super(
      `The saved Personal ${component === "host" ? "Host" : "PostgreSQL"} loopback port is already in use by another process.`,
      options,
    );
    this.name = "PersonalPrivatePortUnavailableError";
    this.component = component;
  }
}

export class NativePersonalLoopbackPorts implements PersonalLoopbackPortPort {
  async assertAvailable(port: number, component: "host" | "postgresql"): Promise<void> {
    try {
      await bindAndReleaseLoopbackPort(port);
    } catch (error) {
      throw new PersonalPrivatePortUnavailableError(component, { cause: error });
    }
  }
}

class PersonalChildExitedError extends Error {
  readonly component: PersonalRuntimeComponent;

  constructor(component: PersonalRuntimeComponent, result: ChildExit, diagnostic = "") {
    super(childExitDetail(component, result, diagnostic));
    this.name = "PersonalChildExitedError";
    this.component = component;
  }
}

class PersonalReadinessError extends Error {
  constructor(error: unknown, diagnostic: string) {
    const summary = safeErrorDetail(error);
    const tail = sanitizedErrorDetail(diagnostic.trim()).slice(-1_200);
    super(tail ? `${summary} ${tail}` : summary, { cause: error });
    this.name = "PersonalReadinessError";
  }
}

function postgresSpec(
  release: VerifiedPersonalRuntimeRelease,
  manifest: PersonalDeploymentManifest,
  paths: PersonalDeploymentPreparedPaths,
): PersonalProcessSpec {
  return {
    arguments: [
      "-D",
      paths.postgresDataDirectory,
      "-h",
      "127.0.0.1",
      "-p",
      String(manifest.postgresPort),
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "password_encryption=scram-sha-256",
      "-c",
      "logging_collector=off",
    ],
    component: "postgresql",
    cwd: paths.rootDirectory,
    environment: postgresEnvironment({}),
    executable: release.entrypoints.postgres,
  };
}

function hostSpec(
  release: VerifiedPersonalRuntimeRelease,
  manifest: PersonalDeploymentManifest,
  paths: PersonalDeploymentPreparedPaths,
  secrets: PersonalDeploymentSecrets,
  ownerClaimToken: string,
  accountIssuer: string | null,
  portalOrigin: string | null,
): PersonalProcessSpec {
  const fingerprint = HostKeyFingerprintSchema.parse(manifest.hostKeyFingerprint);
  const origin = `http://127.0.0.1:${manifest.hostPort}`;
  return {
    arguments: [],
    component: "host",
    cwd: paths.hostDataDirectory,
    environment: {
      LANG: "en_US.UTF-8",
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_BROWSER_PROFILE_KEY_PATH: paths.browserProfileKeyPath,
      OPENSTEER_CANONICAL_ORIGIN: origin,
      OPENSTEER_CREDENTIAL_KEY_PATH: paths.credentialKeyPath,
      OPENSTEER_DEPLOYMENT_ID: manifest.deploymentId,
      OPENSTEER_DEPLOYMENT_NAME: manifest.name,
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_DATA_DIR: paths.hostDataDirectory,
      OPENSTEER_HOST_INSTANCE_ID: manifest.hostInstanceId,
      OPENSTEER_HOST_KEY_FINGERPRINT: fingerprint,
      OPENSTEER_HOST_PRIVATE_KEY_PATH: paths.hostPrivateKeyPath,
      OPENSTEER_HOST_PUBLIC_KEY_PATH: paths.hostPublicKeyPath,
      OPENSTEER_HOST_RELEASE_VERSION: release.assets.webDistribution.hostVersion,
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      // The Host names the machine new Workspaces go to; the co-located Runner
      // owns the directories and the protected registry themselves.
      OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID: manifest.environmentId,
      OPENSTEER_MODE: "production",
      OPENSTEER_NATIVE_OAUTH_ENABLED: "false",
      OPENSTEER_PORT: String(manifest.hostPort),
      ...(accountIssuer ? { OPENSTEER_PERSONAL_ACCOUNT_ISSUER: accountIssuer } : {}),
      ...(portalOrigin ? { OPENSTEER_PORTAL_ORIGIN: portalOrigin } : {}),
      OPENSTEER_RUNTIME_ORIGIN: origin,
      OPENSTEER_SIGNUP_POLICY: "closed",
      OPENSTEER_WEB_DISTRIBUTION_DIRECTORY: release.assets.webDistribution.directory,
      OPENSTEER_WEB_DISTRIBUTION_MANIFEST: release.assets.webDistribution.manifestPath,
    },
    executable: release.entrypoints.host,
    secretEnvironment: {
      OPENSTEER_AUTH_SECRET: secrets.hostAuthSecret,
      OPENSTEER_DATABASE_URL: databaseUrl(manifest, secrets),
      // Pre-registers the enrollment this computer's messaging service redeems,
      // exactly as a managed Deployment configures its own.
      OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: secrets.messagingEnrollmentToken,
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: ownerClaimToken,
    },
  };
}

/**
 * The messaging computer this Deployment supervises, wired the way
 * `deploy/self-host/compose.yaml` wires `channel-runtime`: the Host over
 * loopback, its own data directory holding its Runner identity, and the one-use
 * enrollment token the Host was configured with.
 */
function messagingSpec(
  release: VerifiedPersonalRuntimeRelease,
  paths: PersonalDeploymentPreparedPaths,
  secrets: PersonalDeploymentSecrets,
  hostOrigin: string,
  port: number,
): PersonalProcessSpec {
  return {
    arguments: [],
    component: "messaging",
    cwd: paths.messagingDataDirectory,
    environment: {
      LANG: "en_US.UTF-8",
      OPENSTEER_MESSAGING_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_MESSAGING_DATA_DIR: paths.messagingDataDirectory,
      OPENSTEER_MESSAGING_HOST_URL: hostOrigin,
      OPENSTEER_MESSAGING_NAME: "This computer's messaging",
      OPENSTEER_MESSAGING_PORT: String(port),
      OPENSTEER_MODE: "production",
    },
    executable: release.entrypoints.channelRuntime,
    secretInput: {
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: secrets.messagingEnrollmentToken,
    },
  };
}

function runnerSpec(
  release: VerifiedPersonalRuntimeRelease,
  manifest: PersonalDeploymentManifest,
  paths: PersonalDeploymentPreparedPaths,
  enrollmentToken: string | null,
  baseEnvironment: Readonly<Record<string, string>>,
  browser: {
    readonly bridgeToken: string;
    readonly runtimeId: string;
    readonly signIn: boolean;
    readonly url: URL;
  },
  computerUse: { readonly token: string; readonly url: URL } | null,
): PersonalProcessSpec {
  return {
    arguments: [],
    component: "runner",
    cwd: paths.runnerDataDirectory,
    environment: {
      ...baseEnvironment,
      OPENSTEER_AGENT_SKILLS_DIRECTORY: release.assets.agentSkills,
      OPENSTEER_BROWSER_BRIDGE_URL: browser.url.toString(),
      OPENSTEER_BROWSER_HARNESS: release.entrypoints.browserHarness,
      OPENSTEER_BROWSER_RUNTIME_ID: browser.runtimeId,
      // The Runner advertises saved-password sign-ins only for a browser that
      // can run them, so the Host never offers one this Mac cannot finish.
      ...(browser.signIn ? { OPENSTEER_BROWSER_SIGN_IN: "1" } : {}),
      ...(computerUse ? { OPENSTEER_COMPUTER_USE_BRIDGE_URL: computerUse.url.toString() } : {}),
      // Only the engines whose bytes this release ships are named here; an
      // `installed` engine is found by the Runner on the person's own machine.
      ...Object.fromEntries(
        harnessCatalog
          .filter(shipsHarnessRuntimeBytes)
          .map((entry) => [
            harnessExecutableEnvironmentVariable(entry.kind),
            release.harnesses[entry.kind],
          ]),
      ),
      OPENSTEER_DEFAULT_WORKSPACE_BACKING: "local-directory",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_ENVIRONMENT_ID: manifest.environmentId,
      OPENSTEER_HOST_URL: `http://127.0.0.1:${manifest.hostPort}`,
      OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: paths.workspaceRegistryPath,
      OPENSTEER_LOCAL_WORKSPACE_LEGACY_REGISTRY_PATH: path.join(
        paths.hostDataDirectory,
        "workspace-bindings.v1.json",
      ),
      OPENSTEER_LOCAL_WORKSPACE_ROOT: paths.workspaceRoot,
      OPENSTEER_MAX_CONCURRENT_RUNS: "4",
      OPENSTEER_MODE: "production",
      OPENSTEER_NATIVE_FS_HELPER: release.entrypoints.nativeFsHelper,
      OPENSTEER_NODE_EXECUTABLE: release.entrypoints.node,
      OPENSTEER_RUNNER_DATA_DIR: paths.runnerDataDirectory,
      OPENSTEER_RUNNER_ID: manifest.runnerId,
      OPENSTEER_RUNNER_KIND: "main",
      OPENSTEER_RUNNER_NAME: manifest.name,
      OPENSTEER_RUNNER_WORKSPACE_BACKINGS: "local-directory",
    },
    executable: release.entrypoints.runner,
    // Never in the environment: every Runner credential travels on stdin,
    // which the Runner reads once, before it parses its configuration.
    secretInput: {
      OPENSTEER_BROWSER_BRIDGE_TOKEN: browser.bridgeToken,
      ...(computerUse ? { OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: computerUse.token } : {}),
      ...(enrollmentToken ? { OPENSTEER_RUNNER_ENROLLMENT_TOKEN: enrollmentToken } : {}),
    },
  };
}

/** True when a Host launched from `next` serves the processes started from `running`. */
function sameRunningIdentity(
  next: PersonalDeploymentManifest,
  running: PersonalDeploymentManifest,
): boolean {
  return (
    (
      [
        "deploymentId",
        "environmentId",
        "hostInstanceId",
        "hostKeyFingerprint",
        "hostPort",
        "postgresPort",
        "runnerId",
      ] as const
    ).every((key) => next[key] === running[key]) &&
    JSON.stringify(next.release) === JSON.stringify(running.release)
  );
}

function databaseUrl(
  manifest: PersonalDeploymentManifest,
  secrets: PersonalDeploymentSecrets,
): string {
  return `postgresql://opensteer:${encodeURIComponent(secrets.databasePassword)}@127.0.0.1:${manifest.postgresPort}/postgres?sslmode=disable`;
}

function postgresEnvironment(
  base: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return { ...base, LANG: base.LANG ?? "C", LC_ALL: base.LC_ALL ?? "C" };
}

function initialStatus(): DesktopPersonalDeploymentStatus {
  return DesktopPersonalDeploymentStatusSchema.parse({
    canStart: false,
    components: {
      browser: { state: "stopped", version: null },
      host: { state: "stopped", version: null },
      messaging: { state: "stopped", version: null },
      postgresql: { state: "stopped", version: null },
      runner: { state: "stopped", version: null },
    },
    deploymentId: null,
    environmentId: null,
    issue: null,
    schemaVersion: 1,
    state: "checking",
    step: "checking-computer",
  });
}

function componentsWithVersions(
  release: VerifiedPersonalRuntimeRelease,
): DesktopPersonalDeploymentStatus["components"] {
  return {
    browser: { state: "stopped", version: null },
    host: { state: "stopped", version: release.identity.hostVersion },
    // The release pins one version per independently versioned service; the
    // messaging service ships out of the Host's own tree and declares none.
    messaging: { state: "stopped", version: null },
    postgresql: { state: "stopped", version: release.identity.postgresVersion },
    runner: { state: "stopped", version: release.identity.runnerVersion },
  };
}

function componentState(
  components: DesktopPersonalDeploymentStatus["components"],
  component: PersonalStatusComponent,
  state: DesktopPersonalComponentState,
): DesktopPersonalDeploymentStatus["components"] {
  const key = component === "postgresql" ? "postgresql" : component;
  return { ...components, [key]: { ...components[key], state } };
}

function stoppedComponents(
  components: DesktopPersonalDeploymentStatus["components"],
): DesktopPersonalDeploymentStatus["components"] {
  return {
    browser: { ...components.browser, state: "stopped" },
    host: { ...components.host, state: "stopped" },
    messaging: { ...components.messaging, state: "stopped" },
    postgresql: { ...components.postgresql, state: "stopped" },
    runner: { ...components.runner, state: "stopped" },
  };
}

function classifyFailure(
  error: unknown,
  step: DesktopPersonalDeploymentStep | null,
): {
  readonly issue: DesktopPersonalDeploymentIssue;
  readonly state: "repair-required" | "update-required";
} {
  const detail = safeErrorDetail(error);
  if (error instanceof PersonalUpdateRequiredError) {
    return {
      issue: issue("update-incompatible", "desktop", detail, "update-opensteer"),
      state: "update-required",
    };
  }
  if (error instanceof PersonalFilesystemError) {
    return {
      issue: issue(
        error.code,
        "desktop",
        detail,
        error.code === "disk-space-insufficient" ? "free-disk-space" : "restore-permissions",
      ),
      state: "repair-required",
    };
  }
  if (error instanceof PersonalUserEnvironmentError) {
    return {
      issue: issue("provider-environment-unavailable", "runner", detail, "open-diagnostics"),
      state: "repair-required",
    };
  }
  if (error instanceof ProtectedStorageUnavailableError) {
    return {
      issue: issue("protected-storage-unavailable", "desktop", detail, "restore-permissions"),
      state: "repair-required",
    };
  }
  if (error instanceof ProtectedStateUnreadableError) {
    return {
      issue: issue("protected-state-unreadable", "desktop", detail, "open-diagnostics"),
      state: "repair-required",
    };
  }
  if (error instanceof PersonalRuntimeReleaseError) {
    return {
      issue: issue(`release-${error.kind}`, "desktop", detail, "install-compatible-release"),
      state: error.kind === "incompatible" ? "update-required" : "repair-required",
    };
  }
  if (error instanceof PersonalOwnerClaimRequiredError) {
    return {
      issue: issue("personal-bootstrap-unavailable", "host", detail, "update-opensteer"),
      state: "repair-required",
    };
  }
  if (error instanceof PersonalHostAuthorityMismatchError) {
    return {
      issue: issue("host-authority-mismatch", "host", detail, "open-diagnostics"),
      state: "repair-required",
    };
  }
  if (error instanceof PersonalDatabaseInitializationError) {
    return {
      issue: issue("database-initialization-failed", "postgresql", detail, "open-diagnostics"),
      state: "repair-required",
    };
  }
  if (error instanceof PersonalBrowserUnavailableError) {
    return {
      issue: issue("browser-unavailable", "browser", detail, "open-diagnostics"),
      state: "repair-required",
    };
  }
  if (error instanceof PersonalPrivatePortUnavailableError) {
    return {
      issue: issue("private-port-unavailable", error.component, detail, "open-diagnostics"),
      state: "repair-required",
    };
  }
  if (error instanceof PersonalChildExitedError) {
    return {
      issue: issue(
        unavailableIssueCode(error.component),
        error.component,
        detail,
        "open-diagnostics",
      ),
      state: "repair-required",
    };
  }
  if (nodeErrorCode(error) === "ENOSPC") {
    return {
      issue: issue("disk-space-insufficient", "desktop", detail, "free-disk-space"),
      state: "repair-required",
    };
  }
  const component =
    step === "preparing-database"
      ? "postgresql"
      : step === "starting-host" || step === "creating-main"
        ? "host"
        : step === "starting-local-agents"
          ? "runner"
          : step === "connecting-computer"
            ? "browser"
            : "desktop";
  return {
    issue: issue(
      component === "desktop" ? "unexpected" : unavailableIssueCode(component),
      component,
      detail,
      "open-diagnostics",
    ),
    state: "repair-required",
  };
}

/** The one issue code that says a given service is not running. */
function unavailableIssueCode(
  component: PersonalStatusComponent,
): DesktopPersonalDeploymentIssue["code"] {
  if (component === "postgresql") return "database-unavailable";
  if (component === "host") return "host-unavailable";
  if (component === "runner") return "runner-unavailable";
  if (component === "messaging") return "messaging-unavailable";
  return "browser-unavailable";
}

function issue(
  code: DesktopPersonalDeploymentIssue["code"],
  component: DesktopPersonalDeploymentIssue["component"],
  detail: string,
  repairAction: DesktopPersonalDeploymentIssue["repairAction"],
): DesktopPersonalDeploymentIssue {
  return { code, component, detail: safeErrorDetail(detail), repairAction };
}

function childExitDetail(
  component: PersonalStatusComponent,
  result: ChildExit,
  diagnostic = "",
): string {
  const summary = result.error
    ? `${displayComponent(component)} failed to start: ${result.error.message}`
    : `${displayComponent(component)} stopped unexpectedly (${result.signal ?? `exit ${result.code}`}).`;
  const tail = sanitizedErrorDetail(diagnostic.trim()).slice(-1_200);
  return tail ? `${summary} ${tail}` : summary;
}

function displayComponent(component: PersonalStatusComponent): string {
  if (component === "postgresql") return "PostgreSQL";
  if (component === "host") return "Host";
  if (component === "runner") return "Runner";
  if (component === "messaging") return "Messaging";
  return "Browser Runtime";
}

function safeErrorDetail(error: unknown): string {
  return sanitizedErrorDetail(error).slice(0, 2_000);
}

function sanitizedErrorDetail(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || "Personal setup failed.");
  return message
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/(?:password|token|secret)=([^\s&]+)/giu, "credential=[redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, "$1[redacted]@")
    .replace(/os_secret_[A-Za-z0-9_-]+/gu, "os_secret_[redacted]");
}

async function waitForExit(running: RunningChild, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      running.exit.then(() => undefined),
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(
          () => rejectPromise(new Error(`${displayComponent(running.component)} did not stop.`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Could not allocate a private loopback port."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise(port);
      });
    });
  });
}

async function bindAndReleaseLoopbackPort(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPromise);
    server.listen({ exclusive: true, host: "127.0.0.1", port }, () => {
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  });
}

/**
 * Decided by type alone: an error's text can carry a child's output, and a
 * word in a log line must never stop recovery.
 */
function permanentStartFailure(error: unknown): boolean {
  return (
    error instanceof PersonalFilesystemError ||
    error instanceof PersonalUpdateRequiredError ||
    error instanceof PersonalRuntimeTransitionError ||
    error instanceof PersonalHostAuthorityMismatchError ||
    error instanceof PersonalOwnerClaimRequiredError ||
    error instanceof PersonalDatabaseInitializationError ||
    error instanceof PersonalPrivatePortUnavailableError ||
    error instanceof PersonalUserEnvironmentError ||
    error instanceof PersonalRuntimeReleaseError ||
    error instanceof ProtectedStorageUnavailableError ||
    error instanceof ProtectedStateUnreadableError
  );
}
