#!/usr/bin/env node

import { startDesktopRunnerControl, type DesktopRunnerReady } from "./runtime/desktop-control.js";

import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRunnerConfig, runnerSecretNames, type RunnerConfig } from "@opensteer/config";
import {
  processSecretsDescriptorVariable,
  readProcessSecrets,
} from "@opensteer/shared/processSecrets";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { ensurePrivateDirectory } from "@opensteer/shared/privateFiles";
import type { EnvironmentId, RunnerId } from "@opensteer/core";
import { harnessRuntimeBoundaryForRunner } from "@opensteer/harness";
import { RunnerBootIdSchema, type RunnerDescriptor } from "@opensteer/protocol";
import {
  consumeRunnerApplicationConfig,
  parseAgentExecutionConfig,
  type RunnerApplicationConfig,
} from "./app-config.js";
import { loadAgentSkillBundle } from "./skills/agent-skills.js";
import { createHarnessRegistry } from "./harness/harness-registry.js";
import { ReconnectingHostConnection, type RunnerAgentsConnection } from "./host/host-connection.js";
import { WorkHomeEnrollmentRefused } from "./host/enrollment-preview.js";
import { AttachmentCache } from "./attachments/attachment-cache.js";
import {
  FileRunnerIdentityStore,
  RunnerDataDirectoryLock,
  providerContinuationIdentityProjector,
  type RunnerIdentity,
} from "@opensteer/runner-client";
import { cacheRunPlugins, prunePluginCache } from "./skills/plugin-cache.js";
import { cleanupPriorAutomationScripts } from "./agent/script-executor.js";
import { JsonRunnerLogger } from "./runtime/logger.js";
import { AgentHomeManager } from "./folders/agent-home.js";
import { verifyNodeExecutable } from "./runtime/node-executable.js";
import {
  RunnerRuntime,
  type RunnerLocalActivity,
  type RunnerRuntimeOptions,
} from "./runtime/runtime.js";
import { ExecutionContainment, type RunnerShutdownProof } from "./runtime/execution-containment.js";
import { RunnerReadinessFile } from "./runtime/readiness-file.js";
import { describeRunnerDevice } from "./device.js";
import { harnessLaunchValidationHook } from "./shell/machine-access-setup.js";
import { HarnessSandbox, harnessSandboxRequired } from "./sandbox/harness-sandbox.js";
import { prepareShellModule, type PreparedShellModule } from "./shell/shell-host-key.js";
import {
  prepareIntegrationsModule,
  type PreparedIntegrationsModule,
} from "./computer-apps/prepare.js";
import { prepareMessagingModule, type PreparedMessagingModule } from "./messaging/prepare.js";
import { shutdownSignals } from "@opensteer/shared/processControl";

import type { PhoneScreenDriver } from "./computer-apps/phone-screen-driver.js";

const RUNTIME_VERSION = "0.0.0";

/**
 * What a started Runner brings to its Host connection, and how to stop it.
 *
 * There are exactly two shapes behind this: a computer that runs agents, and a
 * reach-only computer that offers shell, apps, or both. Which
 * one starts is decided once, here, from the configured module list — nothing
 * downstream asks again.
 */
interface StartedRunner {
  readonly agents?: RunnerAgentsConnection;
  readonly integrationsModule?: PreparedIntegrationsModule;
  readonly messagingModule?: PreparedMessagingModule;
  readonly shellModule?: PreparedShellModule;
  close(): Promise<RunnerShutdownProof | undefined>;
}

/**
 * Parses the Runner's configuration and removes every credential from
 * `environment`.
 *
 * A supervisor that starts this Runner hands it its secrets off its
 * environment — `delivered` for the desktop's utility process, which posts
 * them, or the descriptor `OPENSTEER_SECRETS_FD` names for any process started
 * from a command line — because a startup environment stays readable to every
 * process of the same user for this process's whole life. Secrets another
 * distribution still passes as variables are parsed the same way and then
 * removed, so nothing this process later spawns inherits them. The computer
 * use bridge URL goes with them so nothing names the endpoint the token opens.
 */
export function consumeRunnerConfig(
  environment: NodeJS.ProcessEnv,
  delivered?: Readonly<Record<string, string>>,
): RunnerConfig {
  try {
    return parseRunnerConfig(environment, delivered ?? readProcessSecrets(environment));
  } finally {
    for (const name of runnerSecretNames) delete environment[name];
    delete environment.OPENSTEER_RUNNER_ENROLLMENT_TOKEN_FILE;
    delete environment.OPENSTEER_COMPUTER_USE_BRIDGE_URL;
    delete environment[processSecretsDescriptorVariable];
  }
}

export async function runRunnerDaemon(
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  options: {
    /**
     * Hands a supervisor what it may ask of the running daemon: rechecking
     * engines now rather than at the next heartbeat. Called once, before the
     * first connection.
     */
    readonly control?: (control: {
      readonly notifySleeping: () => void;
      readonly notifyAwake: () => void;
      readonly recheckEngines: () => void;
    }) => void;
    /**
     * The Runs this Runner is doing work for, each time that changes and once
     * when the daemon starts. A Runner that runs no agents never calls it.
     */
    readonly onStarted?: (ready: DesktopRunnerReady) => void | Promise<void>;
    readonly onShutdown?: (proof: RunnerShutdownProof) => void | Promise<void>;
    readonly onActivity?: (runs: readonly RunnerLocalActivity[]) => void;
    readonly onConnected?: (identity: {
      readonly environmentId: EnvironmentId | null;
      readonly runnerId: RunnerId;
    }) => void;
    readonly onDisconnected?: () => void;
    readonly enrollmentNotice?: (message: string) => void;
    /**
     * This computer was removed from its Deployment. The daemon stops rather
     * than reconnecting, so a supervisor hears this once and forgets the slot.
     */
    readonly onRevoked?: () => void;
    /** Credentials the supervisor delivered off the environment. */
    readonly secrets?: Readonly<Record<string, string>>;
    readonly phoneScreens?: PhoneScreenDriver;
  } = {},
): Promise<void> {
  const config = consumeRunnerConfig(environment, options.secrets);
  const applicationConfig = consumeRunnerApplicationConfig(environment);
  if (applicationConfig.isolateHarnesses && process.platform !== "linux") {
    throw new Error("OPENSTEER_RUNNER_ISOLATE_HARNESSES requires a Linux Runner.");
  }
  const readiness = applicationConfig.readinessPath
    ? new RunnerReadinessFile(applicationConfig.readinessPath)
    : undefined;
  // A process that has not connected is not ready, whatever a crashed
  // predecessor left behind on the volume; clear the marker before anything
  // else, including the wait for its lease to go stale.
  await readiness?.initialize();
  const logger = new JsonRunnerLogger();
  const lock = await RunnerDataDirectoryLock.acquire(config.dataDirectory);
  const shutdown = new AbortController();
  const externalAbort = () => shutdown.abort(signal?.reason ?? new Error("Runner stopping"));
  if (signal?.aborted) externalAbort();
  else signal?.addEventListener("abort", externalAbort, { once: true });
  // Another process reclaimed the lease, so this Runner no longer owns its data
  // directory. Nothing distinguishes that from being told to stop.
  lock.onLost((reason) => shutdown.abort(reason));

  const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
  let started: StartedRunner | undefined;
  let connection: ReconnectingHostConnection | undefined;
  let desktopControl: Awaited<ReturnType<typeof startDesktopRunnerControl>> | undefined;
  let stopActivity: (() => void) | undefined;
  const agentsStoppedSince = applicationConfig.agentsStoppedSince;
  const containment = new ExecutionContainment({ bootId, dataDirectory: config.dataDirectory });
  try {
    const identityStore = new FileRunnerIdentityStore({
      dataDirectory: config.dataDirectory,
      environmentless: !config.modules.includes("agents"),
      ...(config.environmentId ? { environmentId: config.environmentId } : {}),
      ...(config.runnerId ? { runnerId: config.runnerId } : {}),
    });
    const identity = await identityStore.loadOrCreate();
    const earlierBoots =
      agentsStoppedSince !== undefined || config.modules.includes("agents")
        ? await containment.reapEarlierBoots().catch(() => "unknown" as const)
        : "proven";
    if (earlierBoots === "unknown")
      logger.error("An earlier Runner left processes that could not be ended");
    started = config.modules.includes("agents")
      ? await startAgentsRunner({
          applicationConfig,
          bootId,
          config,
          containment,
          earlierBootsContained: earlierBoots === "proven",
          environment,
          identity,
          logger,
          signal: shutdown.signal,
          ...(options.phoneScreens ? { phoneScreens: options.phoneScreens } : {}),
        })
      : await startReachOnlyRunner({
          applicationConfig,
          config,
          logger,
          ...(options.phoneScreens ? { phoneScreens: options.phoneScreens } : {}),
        });
    const device = await describeRunnerDevice({
      platform: process.platform,
      runnerKind: config.runnerKind,
    });
    connection = new ReconnectingHostConnection({
      ...(agentsStoppedSince === undefined ? {} : { agentsStoppedSince }),
      ...(started.agents ? { agents: started.agents } : {}),
      ...(config.browserBridge ? { browserBridge: config.browserBridge } : {}),
      bootId,
      config,
      containment,
      updateHeld: () => desktopControl?.held() ?? false,
      ...(device ? { device } : {}),
      identity,
      identityStore,
      ...(started.integrationsModule ? { integrationsModule: started.integrationsModule } : {}),
      logger,
      ...(options.enrollmentNotice ? { enrollmentNotice: options.enrollmentNotice } : {}),
      ...(started.messagingModule ? { messagingModule: started.messagingModule } : {}),
      onConnected: async (connected) => {
        await readiness?.connected(bootId);
        options.onConnected?.(connected);
      },
      onDisconnected: async () => {
        await readiness?.disconnected();
        options.onDisconnected?.();
      },
      ...(options.onRevoked ? { onRevoked: options.onRevoked } : {}),
      runtimeVersion: RUNTIME_VERSION,
      ...(started.shellModule ? { shellModule: started.shellModule } : {}),
    });
    const running = connection;
    const runtime = started.agents?.runtime;
    options.control?.({
      notifySleeping: () => {
        void running.notifySleeping();
      },
      notifyAwake: () => running.notifyAwake(),
      recheckEngines: () => running.recheckEngines(),
    });
    const onActivity = options.onActivity;
    if (runtime && onActivity) {
      const watched = runtime;
      stopActivity = watched.subscribeLocalActivity(() => onActivity(watched.localActivity()));
      onActivity(watched.localActivity());
    }
    if (options.onStarted) {
      desktopControl = await startDesktopRunnerControl(
        () => earlierBoots === "proven" && running.idleForUpdate(),
        earlierBoots === "proven",
      );
      await options.onStarted(desktopControl.ready);
    }
    await connection.run(shutdown.signal);
  } finally {
    signal?.removeEventListener("abort", externalAbort);
    stopActivity?.();
    desktopControl?.close();
    connection?.close();
    await readiness?.disconnected();
    const proof = await started?.close();
    if (agentsStoppedSince !== undefined && options.onShutdown)
      await options.onShutdown(proof ?? (await containment.shutdownProof()));
    await readiness?.settle();
    await lock.release();
  }
}

/**
 * A computer that runs agents: Agent home, harnesses
 * and skills, plus the shell it offers.
 *
 * Shell degrades here rather than stopping the Runner, because a machine that
 * still runs threads is worth having even when nobody can `ssh` to it.
 */
async function startAgentsRunner(input: {
  readonly applicationConfig: RunnerApplicationConfig;
  readonly phoneScreens?: PhoneScreenDriver;
  readonly bootId: RunnerDescriptor["bootId"];
  readonly config: RunnerConfig;
  readonly containment: ExecutionContainment;
  readonly earlierBootsContained: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly identity: RunnerIdentity;
  readonly logger: JsonRunnerLogger;
  readonly signal: AbortSignal;
}): Promise<StartedRunner> {
  const { applicationConfig, bootId, config, containment, environment, identity, logger } = input;
  await verifyNodeExecutable(config.nodeExecutable, { environment });
  const shellModule = config.modules.includes("shell")
    ? await prepareShellModule({
        dataDirectory: config.dataDirectory,
        helperBinary: applicationConfig.nativeFsHelperBinary,
      }).catch((error: unknown) => {
        logger.error("This machine cannot offer shell access", {
          error: error instanceof Error ? error.message : "Shell host-key setup failed",
        });
        return undefined;
      })
    : undefined;
  const integrationsModule = config.modules.includes("integrations")
    ? await prepareIntegrationsModule({
        helperBinary: applicationConfig.nativeFsHelperBinary,
        ...(config.computerUseBridge ? { computerUseBridge: config.computerUseBridge } : {}),
        dataDirectory: config.dataDirectory,
        platform: process.platform,
        ...(input.phoneScreens ? { phoneScreens: input.phoneScreens } : {}),
      })
    : undefined;
  const messagingModule =
    !applicationConfig.agentsStoppedSince && config.modules.includes("messaging")
      ? prepareMessagingModule({
          computerUse: integrationsModule?.computerUse,
          dataDirectory: config.dataDirectory,
          platform: process.platform,
        })
      : undefined;
  // Execution assigns a work location once, preserving it through module changes.
  const environmentId = identity.environmentId;
  if (!environmentId) {
    throw new Error("This Runner's saved identity has no work location");
  }
  const agentHome = new AgentHomeManager(identity.runnerId);
  const execution = parseAgentExecutionConfig(environment);
  const attachmentBase = join(homedir(), ".cache", "opensteer", "runner-attachments");
  await ensurePrivateDirectory(attachmentBase);
  const privateRoot = await realpath(config.dataDirectory);
  const cacheRoot = join(
    await realpath(attachmentBase),
    createHash("sha256").update(privateRoot).digest("hex"),
  );
  const overlaps = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  const excludedRoots = [privateRoot, await realpath(tmpdir())];
  if (excludedRoots.some((root) => overlaps(root, cacheRoot) || overlaps(cacheRoot, root))) {
    throw new Error("Runner attachment cache must be outside private and temporary roots");
  }
  const attachmentCache = new AttachmentCache({
    root: cacheRoot,
    transport: {
      ...(config.controlCaPath ? { controlCaPath: config.controlCaPath } : {}),
      hostOrigin: config.hostUrl,
      mode: config.mode,
    },
  });
  await attachmentCache.reset();
  const agentSkills = await loadAgentSkillBundle(execution.agentSkillsDirectory);
  const harnessRuntimeBoundary = harnessRuntimeBoundaryForRunner({
    isolateHarnesses: applicationConfig.isolateHarnesses,
    deploymentKind: config.deploymentShape.kind,
    runnerKind: config.runnerKind,
  });
  const harnessSandbox = harnessSandboxRequired(process.platform, harnessRuntimeBoundary)
    ? await HarnessSandbox.create({
        attachmentRoot: attachmentCache.root,
        dataDirectory: config.dataDirectory,
        environment: Object.fromEntries(
          ["HOME", "PATH", "TMPDIR"].flatMap((name) =>
            environment[name] ? [[name, environment[name]]] : [],
          ),
        ),
        requireFreshProc: applicationConfig.isolateHarnesses,
        stateDirectory: resolve(config.dataDirectory, "private", "harness-state"),
        workspaceRoots: [],
      })
    : undefined;
  if (harnessSandbox)
    logger.info("Runner harness sandbox verified", {
      freshProc: harnessSandbox.layout.freshProc,
      runnerId: identity.runnerId,
    });
  // The data directory is this process's now, so a Run another boot of it
  // left running is a dead Runner's: it ends before this one takes work.
  const privateStateDirectory = resolve(config.dataDirectory, "private", "harness-state");
  await prunePluginCache(privateStateDirectory);
  if (input.earlierBootsContained) {
    await cleanupPriorAutomationScripts(privateStateDirectory);
  }
  const pluginPruner = setInterval(
    () => {
      void prunePluginCache(resolve(config.dataDirectory, "private", "harness-state")).catch(
        (error: unknown) =>
          logger.error("Plugin cache pruning failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    24 * 60 * 60 * 1000,
  );
  pluginPruner.unref();
  const runtime = new RunnerRuntime({
    agentSkills,
    attachmentCache,
    browserHarnessExecutable: execution.browserHarnessExecutable,
    bootId,
    containment,
    dataDirectory: config.dataDirectory,
    deploymentShape: config.deploymentShape,
    environmentId,
    harnesses: createHarnessRegistry(
      execution.harnessExecutables,
      {
        nodeExecutable: config.nodeExecutable,
        runtimeCacheDirectory: resolve(config.dataDirectory, "runtime-cache"),
      },
      logger,
    ),
    harnessRuntimeBoundary,
    ...(harnessSandbox ? { harnessSandbox } : {}),
    plugins: cacheRunPlugins,
    logger,
    maxConcurrentRuns: config.maxConcurrentRuns,
    maxConcurrentTriggerPrograms: config.maxConcurrentTriggerPrograms,
    machineAccess: machineAccessRuntimeOptions(config, applicationConfig.nativeFsHelperBinary),
    mode: config.mode,
    nativeFsHelperBinary: applicationConfig.nativeFsHelperBinary,
    nodeExecutable: config.nodeExecutable,
    privateStateDirectory: resolve(config.dataDirectory, "private", "harness-state"),
    projectContinuationIdentity: providerContinuationIdentityProjector(identity.privateKey),
    agentHome,
  });
  return {
    agents: {
      earlierBootsContained: input.earlierBootsContained,
      runtime,
      runFileOptions: {
        dataDirectory: config.dataDirectory,
        helperBinary: applicationConfig.nativeFsHelperBinary,
      },
    },
    close: async () => {
      clearInterval(pluginPruner);
      await messagingModule?.module.close();
      await integrationsModule?.close?.();
      return await runtime.close(applicationConfig.agentsStoppedSince !== undefined);
    },
    ...(integrationsModule ? { integrationsModule } : {}),
    ...(messagingModule ? { messagingModule } : {}),
    ...(shellModule ? { shellModule } : {}),
  };
}

/**
 * A reach-only computer has only the auxiliary modules its platform can
 * actually serve. Nothing else starts — no Agent home,
 * harnesses or skills.
 *
 * Preparation cannot degrade every requested module away: that Runner would
 * connect and do nothing at all.
 */
async function startReachOnlyRunner(input: {
  readonly applicationConfig: RunnerApplicationConfig;
  readonly phoneScreens?: PhoneScreenDriver;
  readonly config: RunnerConfig;
  readonly logger: JsonRunnerLogger;
}): Promise<StartedRunner> {
  const shellModule = input.config.modules.includes("shell")
    ? await prepareShellModule({
        dataDirectory: input.config.dataDirectory,
        helperBinary: input.applicationConfig.nativeFsHelperBinary,
      }).catch((error: unknown) => {
        input.logger.error("This machine cannot offer shell access", {
          error: error instanceof Error ? error.message : "Shell host-key setup failed",
        });
        return undefined;
      })
    : undefined;
  const integrationsModule = input.config.modules.includes("integrations")
    ? await prepareIntegrationsModule({
        helperBinary: input.applicationConfig.nativeFsHelperBinary,
        ...(input.config.computerUseBridge
          ? { computerUseBridge: input.config.computerUseBridge }
          : {}),
        dataDirectory: input.config.dataDirectory,
        platform: process.platform,
        ...(input.phoneScreens ? { phoneScreens: input.phoneScreens } : {}),
      })
    : undefined;
  const messagingModule =
    !input.applicationConfig.agentsStoppedSince && input.config.modules.includes("messaging")
      ? prepareMessagingModule({
          computerUse: integrationsModule?.computerUse,
          dataDirectory: input.config.dataDirectory,
          platform: process.platform,
        })
      : undefined;
  if (!shellModule && !integrationsModule && !input.config.browserBridge) {
    throw new Error(
      "This computer runs no agents and cannot offer a browser, shell access or apps on this platform",
    );
  }
  return {
    close: async () => {
      await messagingModule?.module.close();
      await integrationsModule?.close?.();
    },
    ...(integrationsModule ? { integrationsModule } : {}),
    ...(messagingModule ? { messagingModule } : {}),
    ...(shellModule ? { shellModule } : {}),
  };
}

/**
 * Machine access as this program runs it. Setup validates its own launch
 * surface before a Run may use it, and the probe is the same on every Runner
 * kind (v3.2), so production names the hook here rather than leaving Runners
 * whose harness is sandboxed with a prerequisite nothing can satisfy. Only the
 * test harness substitutes another hook.
 */
export function machineAccessRuntimeOptions(
  config: Pick<ReturnType<typeof parseRunnerConfig>, "controlCaPath" | "hostUrl">,
  helperBinary: string,
): NonNullable<RunnerRuntimeOptions["machineAccess"]> {
  return {
    ...(config.controlCaPath ? { controlCaPath: config.controlCaPath } : {}),
    helperBinary,
    hostUrl: config.hostUrl,
    validationHook: harnessLaunchValidationHook,
  };
}

async function main(): Promise<void> {
  const shutdown = new AbortController();
  const receipt = process.env.OPENSTEER_RUNNER_SHUTDOWN_RECEIPT;
  delete process.env.OPENSTEER_RUNNER_SHUTDOWN_RECEIPT;
  let receivedSignal = false;
  const stop = (name: string): void => {
    if (receivedSignal) {
      process.stderr.write("Opensteer Runner received a second shutdown signal; exiting now\n");
      process.exit(1);
    }
    receivedSignal = true;
    if (receipt)
      void readFile(receipt, "utf8")
        .catch(() => null)
        .then((request) =>
          shutdown.abort(
            new Error(request === "restarting" ? "device-restarting" : `Received ${name}`),
          ),
        );
    else shutdown.abort(new Error(`Received ${name}`));
  };
  const handlers = shutdownSignals.map((name) => [name, () => stop(name)] as const);
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    await runRunnerDaemon(process.env, shutdown.signal, {
      enrollmentNotice: (message) => process.stderr.write(`${message}\n`),
      ...(receipt
        ? {
            onStarted: (ready) => replacePrivateFileAtomically(receipt, JSON.stringify(ready)),
            onShutdown: (proof) => replacePrivateFileAtomically(receipt, JSON.stringify(proof)),
          }
        : {}),
    });
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}

export { resolveAutomationCliPaths } from "./agent/script-executor.js";
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof WorkHomeEnrollmentRefused) {
      process.stderr.write(`${error.message}\n`);
      return;
    }
    const message = error instanceof Error ? error.message : "Runner failed";
    process.stderr.write(
      `${JSON.stringify({
        error: message
          .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
          .replace(/os_secret_[A-Za-z0-9_-]+/g, "os_secret_[redacted]")
          .slice(0, 2_000),
        level: "fatal",
        service: "opensteer-runner",
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  });
}
