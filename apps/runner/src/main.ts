#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRunnerConfig, runnerSecretNames, type RunnerConfig } from "@opensteer/config";
import {
  processSecretsDescriptorVariable,
  readProcessSecrets,
} from "@opensteer/shared/processSecrets";
import { ensurePrivateDirectory } from "@opensteer/shared/privateFiles";
import { sameStringSet } from "@opensteer/core";
import type { EnvironmentId, RunnerId } from "@opensteer/core";
import { harnessRuntimeBoundaryForRunner } from "@opensteer/harness";
import { RunnerBootIdSchema, type RunnerDescriptor } from "@opensteer/protocol";
import { LocalWorkspaceAuthority } from "@opensteer/workspace-local";
import { PortableFsCliRunner } from "@opensteer/workspace-portablefs";
import {
  consumeRunnerApplicationConfig,
  parseAgentExecutionConfig,
  type RunnerApplicationConfig,
} from "./app-config.js";
import { loadAgentSkillBundle } from "./skills/agent-skills.js";
import { createHarnessRegistry } from "./harness/harness-registry.js";
import { ReconnectingHostConnection, type RunnerAgentsConnection } from "./host/host-connection.js";
import { AttachmentCache } from "./attachments/attachment-cache.js";
import {
  FileRunnerIdentityStore,
  RunnerDataDirectoryLock,
  providerContinuationIdentityProjector,
  type RunnerIdentity,
} from "@opensteer/runner-client";
import { materializeIntegrationSkills } from "./skills/integration-skills.js";
import { JsonRunnerLogger } from "./runtime/logger.js";
import { RunWorkspaceManager, type RunWorkspaceManagerOptions } from "./workspace/mount-manager.js";
import { LocalWorkspaceService } from "./workspace/local-workspace-service.js";
import {
  OpenSslMountIdentityIssuer,
  WorkspaceMountRegistry,
} from "./workspace/workspace-mount-registry.js";
import { NativeFsHelper } from "./runtime/native-fs-helper.js";
import { verifyNodeExecutable } from "./runtime/node-executable.js";
import { RunnerRuntime, type RunnerRuntimeOptions } from "./runtime/runtime.js";
import { ExecutionContainment } from "./runtime/execution-containment.js";
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

const RUNTIME_VERSION = "0.0.0";

/**
 * What a started Runner brings to its Host connection, and how to stop it.
 *
 * There are exactly two shapes behind this: a computer that runs agents, and a
 * reach-only computer that offers shell, apps, or both (`docs/computers.md` §2). Which
 * one starts is decided once, here, from the configured module list — nothing
 * downstream asks again.
 */
interface StartedRunner {
  readonly agents?: RunnerAgentsConnection;
  readonly integrationsModule?: PreparedIntegrationsModule;
  readonly messagingModule?: PreparedMessagingModule;
  readonly shellModule?: PreparedShellModule;
  close(): Promise<void>;
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
    readonly onConnected?: (identity: {
      readonly environmentId: EnvironmentId;
      readonly runnerId: RunnerId;
    }) => void;
    readonly onDisconnected?: () => void;
    /**
     * This computer was removed from its Deployment. The daemon stops rather
     * than reconnecting, so a supervisor hears this once and forgets the slot.
     */
    readonly onRevoked?: () => void;
    /** Credentials the supervisor delivered off the environment. */
    readonly secrets?: Readonly<Record<string, string>>;
  } = {},
): Promise<void> {
  const config = consumeRunnerConfig(environment, options.secrets);
  const applicationConfig = consumeRunnerApplicationConfig(environment);
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
  try {
    const identityStore = new FileRunnerIdentityStore({
      dataDirectory: config.dataDirectory,
      ...(config.environmentId ? { environmentId: config.environmentId } : {}),
      ...(config.runnerId ? { runnerId: config.runnerId } : {}),
    });
    const identity = await identityStore.loadOrCreate();
    started = config.modules.includes("agents")
      ? await startAgentsRunner({
          applicationConfig,
          bootId,
          config,
          environment,
          identity,
          logger,
          signal: shutdown.signal,
        })
      : await startReachOnlyRunner({ applicationConfig, config, logger });
    const device = await describeRunnerDevice({
      platform: process.platform,
      runnerKind: config.runnerKind,
    });
    connection = new ReconnectingHostConnection({
      ...(started.agents ? { agents: started.agents } : {}),
      bootId,
      config,
      ...(device ? { device } : {}),
      identity,
      identityStore,
      ...(started.integrationsModule ? { integrationsModule: started.integrationsModule } : {}),
      logger,
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
    await connection.run(shutdown.signal);
  } finally {
    signal?.removeEventListener("abort", externalAbort);
    connection?.close();
    await readiness?.disconnected();
    await started?.close();
    await readiness?.settle();
    await lock.release();
  }
}

/**
 * A computer that runs agents: its work location, Workspace storage, harnesses
 * and skills, plus the browser it relays and the shell it offers.
 *
 * Shell degrades here rather than stopping the Runner, because a machine that
 * still runs threads is worth having even when nobody can `ssh` to it.
 */
async function startAgentsRunner(input: {
  readonly applicationConfig: RunnerApplicationConfig;
  readonly bootId: RunnerDescriptor["bootId"];
  readonly config: RunnerConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly identity: RunnerIdentity;
  readonly logger: JsonRunnerLogger;
  readonly signal: AbortSignal;
}): Promise<StartedRunner> {
  const { applicationConfig, bootId, config, environment, identity, logger, signal } = input;
  await verifyNodeExecutable(config.nodeExecutable, { environment });
  const runtimeDirectory = config.dataDirectory;
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
    ? prepareIntegrationsModule({
        ...(config.computerUseBridge ? { computerUseBridge: config.computerUseBridge } : {}),
        dataDirectory: config.dataDirectory,
        platform: process.platform,
      })
    : undefined;
  const messagingModule = config.modules.includes("messaging")
    ? prepareMessagingModule({
        computerUse: integrationsModule?.computerUse,
        dataDirectory: config.dataDirectory,
        platform: process.platform,
      })
    : undefined;
  // This process runs agents, so its identity always names a work location;
  // a browser- or messaging-only Runner is a different program.
  const environmentId = identity.environmentId;
  if (!environmentId) {
    throw new Error("This Runner's saved identity has no work location");
  }
  if (config.portableFsUnavailableReason) {
    logger.info(config.portableFsUnavailableReason, { runnerId: identity.runnerId });
  }
  const localWorkspace = config.workspaceBackings.includes("local-directory")
    ? localWorkspaceAccess(
        config,
        environmentId,
        applicationConfig.nativeFsHelperBinary,
        applicationConfig.localWorkspaceLegacyRegistryPath,
        logger,
      )
    : undefined;
  // A machine that can hold its own directories stays useful when its
  // PortableFS mount is missing or unready, so that failure degrades the
  // advertised capability instead of stopping the Runner.
  let portableFsWorkspace = config.workspaceBackings.includes("portablefs")
    ? await portableFsWorkspaceAccess({
        binary: required(config.mountBinary, "PortableFS mount binary"),
        dataDirectory: runtimeDirectory,
        environment,
        helperBinary: applicationConfig.nativeFsHelperBinary,
        identityIssuer: new OpenSslMountIdentityIssuer(applicationConfig.opensslBinary),
        logger,
        mode: config.mode,
        namespace: config.workspaceNamespace,
        root: required(config.workspaceRoot, "PortableFS Workspace root"),
        runnerId: identity.runnerId,
        signal,
      }).catch((error: unknown) => {
        if (!localWorkspace) throw error;
        logger.error("PortableFS is not ready on this machine; offering only its own directories", {
          error: error instanceof Error ? error.message : "unknown failure",
        });
        return undefined;
      })
    : undefined;
  let workspaceManager = new RunWorkspaceManager({
    ...(localWorkspace ? { local: localWorkspace } : {}),
    ...(portableFsWorkspace ? { portableFs: portableFsWorkspace.access } : {}),
  });
  const preflight = await workspaceManager.preflight(signal).catch(async (error: unknown) => {
    if (!localWorkspace || !portableFsWorkspace) throw error;
    logger.error("PortableFS storage failed its preflight; offering only local directories", {
      error: error instanceof Error ? error.message : "unknown failure",
    });
    portableFsWorkspace = undefined;
    workspaceManager = new RunWorkspaceManager({ local: localWorkspace });
    return workspaceManager.preflight(signal);
  });
  const advertisedBackings = preflight.workspaceBackings;
  if (advertisedBackings.length === 0) {
    throw new Error("Runner Workspace preflight advertised no storage at all");
  }
  if (!sameStringSet(config.workspaceBackings, advertisedBackings)) {
    logger.info("Advertising the Workspace storage this machine can actually reach", {
      advertised: advertisedBackings,
      configured: config.workspaceBackings,
    });
  }
  logger.info("Workspace storage preflight passed", {
    backings: advertisedBackings,
    ...(preflight.portableFsVersion ? { portableFsVersion: preflight.portableFsVersion } : {}),
  });
  await portableFsWorkspace?.registry.adoptExisting();
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
  const excludedRoots = [
    privateRoot,
    await realpath(tmpdir()),
    ...(await Promise.all(
      [config.workspaceRoot, config.localWorkspaceRoot]
        .filter((root): root is string => root !== undefined)
        .map((root) => realpath(root)),
    )),
  ];
  if (excludedRoots.some((root) => overlaps(root, cacheRoot) || overlaps(cacheRoot, root))) {
    throw new Error(
      "Runner attachment cache must be outside private, Workspace and temporary roots",
    );
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
    deploymentKind: config.deploymentShape.kind,
    runnerKind: config.runnerKind,
  });
  // A shared Linux Runner does not run agents without the boundary that keeps
  // one user's Run out of the Runner's keys and every other profile's state.
  const harnessSandbox = harnessSandboxRequired(process.platform, harnessRuntimeBoundary)
    ? await HarnessSandbox.create({
        attachmentRoot: attachmentCache.root,
        dataDirectory: config.dataDirectory,
        environment: Object.fromEntries(
          ["HOME", "PATH", "TMPDIR"].flatMap((name) =>
            environment[name] ? [[name, environment[name]]] : [],
          ),
        ),
        stateDirectory: resolve(config.dataDirectory, "private", "harness-state"),
        workspaceRoots: [
          config.workspaceRoot,
          config.workspaceNamespace === "owner-scoped" ? config.localWorkspaceRoot : undefined,
        ].filter((root): root is string => root !== undefined),
      })
    : undefined;
  if (harnessSandbox)
    logger.info("Runner harness sandbox verified", {
      freshProc: harnessSandbox.layout.freshProc,
      runnerId: identity.runnerId,
    });
  // The data directory is this process's now, so a Run another boot of it
  // left running is a dead Runner's: it ends before this one takes work.
  const containment = new ExecutionContainment({ bootId, dataDirectory: config.dataDirectory });
  const earlierBoots = await containment.reapEarlierBoots();
  if (earlierBoots === "unknown") {
    logger.error("An earlier Runner left processes that could not be ended");
  }
  const runtime = new RunnerRuntime({
    agentSkills,
    attachmentCache,
    browserHarnessExecutable: execution.browserHarnessExecutable,
    bootId,
    containment,
    dataDirectory: config.dataDirectory,
    deploymentShape: config.deploymentShape,
    environmentId,
    harnesses: createHarnessRegistry(execution.harnessExecutables, {
      nodeExecutable: config.nodeExecutable,
      runtimeCacheDirectory: resolve(config.dataDirectory, "runtime-cache"),
    }),
    harnessRuntimeBoundary,
    ...(harnessSandbox ? { harnessSandbox } : {}),
    integrationSkills: materializeIntegrationSkills,
    logger,
    maxConcurrentRuns: config.maxConcurrentRuns,
    maxConcurrentTriggerPrograms: config.maxConcurrentTriggerPrograms,
    machineAccess: machineAccessRuntimeOptions(config, applicationConfig.nativeFsHelperBinary),
    mode: config.mode,
    nodeExecutable: config.nodeExecutable,
    privateStateDirectory: resolve(config.dataDirectory, "private", "harness-state"),
    projectContinuationIdentity: providerContinuationIdentityProjector(identity.privateKey),
    workspaceManager,
    ...(portableFsWorkspace ? { workspaceMountRegistry: portableFsWorkspace.registry } : {}),
  });
  return {
    agents: {
      earlierBootsContained: earlierBoots === "proven",
      ...(config.browserBridge ? { browserBridge: config.browserBridge } : {}),
      ...(localWorkspace
        ? {
            localWorkspaces: {
              // Re-read on every connect, so a reconnect reconciles against
              // what the disk holds now rather than what it held at startup.
              inventory: () => localWorkspace.authority.inventory(signal),
              service: new LocalWorkspaceService({
                authority: localWorkspace.authority,
                filesystem: localWorkspace.filesystem,
              }),
            },
          }
        : {}),
      runtime,
      workspaceBackings: advertisedBackings,
      workspaceMounts: () => portableFsWorkspace?.registry.inventory() ?? [],
    },
    close: async () => {
      await messagingModule?.module.close();
      integrationsModule?.close?.();
      await runtime.close();
    },
    ...(integrationsModule ? { integrationsModule } : {}),
    ...(messagingModule ? { messagingModule } : {}),
    ...(shellModule ? { shellModule } : {}),
  };
}

/**
 * A reach-only computer has only the auxiliary modules its platform can
 * actually serve. Nothing else starts — no work location, Workspace storage,
 * harnesses, skills or browser.
 *
 * Preparation cannot degrade every requested module away: that Runner would
 * connect and do nothing at all.
 */
async function startReachOnlyRunner(input: {
  readonly applicationConfig: RunnerApplicationConfig;
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
    ? prepareIntegrationsModule({
        ...(input.config.computerUseBridge
          ? { computerUseBridge: input.config.computerUseBridge }
          : {}),
        dataDirectory: input.config.dataDirectory,
        platform: process.platform,
      })
    : undefined;
  const messagingModule = input.config.modules.includes("messaging")
    ? prepareMessagingModule({
        computerUse: integrationsModule?.computerUse,
        dataDirectory: input.config.dataDirectory,
        platform: process.platform,
      })
    : undefined;
  if (!shellModule && !integrationsModule) {
    throw new Error(
      "This computer runs no agents and cannot offer shell access or apps on this platform",
    );
  }
  return {
    close: async () => {
      await messagingModule?.module.close();
      integrationsModule?.close?.();
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

function localWorkspaceAccess(
  config: ReturnType<typeof parseRunnerConfig>,
  environmentId: EnvironmentId,
  helperBinary: string,
  legacyRegistryFilePath: string | undefined,
  logger: JsonRunnerLogger,
): NonNullable<RunWorkspaceManagerOptions["local"]> & {
  readonly authority: LocalWorkspaceAuthority;
  readonly filesystem: NativeFsHelper;
} {
  const visibleRootPath = required(config.localWorkspaceRoot, "local Workspace root");
  const registryFilePath = required(
    config.localWorkspaceRegistryPath,
    "local Workspace registry path",
  );
  const workspaceInstructionReader = new NativeFsHelper({
    binary: helperBinary,
    rootPolicy: "managed-local",
  });
  const authority = new LocalWorkspaceAuthority({
    filesystemAuthority: workspaceInstructionReader,
    ...(legacyRegistryFilePath ? { legacyRegistryFilePath } : {}),
    namespace:
      config.workspaceNamespace === "single-owner"
        ? { kind: "single-owner", ownerEnvironmentId: environmentId }
        : { kind: "owner-scoped" },
    registryFilePath,
    visibleRootPath,
  });
  return {
    authority,
    environmentId,
    filesystem: workspaceInstructionReader,
    namespace: config.workspaceNamespace,
    preflight: async (signal) => {
      const result = await workspaceInstructionReader.preflight(
        visibleRootPath,
        signal ?? new AbortController().signal,
      );
      logger.info("Managed local filesystem containment preflight passed", {
        containment: result.containment,
        helperVersion: result.binaryVersion,
      });
    },
    resolver: authority,
    root: visibleRootPath,
    workspaceInstructionReader,
  };
}

async function portableFsWorkspaceAccess(input: {
  readonly binary: string;
  readonly dataDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly helperBinary: string;
  readonly identityIssuer: OpenSslMountIdentityIssuer;
  readonly logger: JsonRunnerLogger;
  readonly mode: ReturnType<typeof parseRunnerConfig>["mode"];
  readonly namespace: ReturnType<typeof parseRunnerConfig>["workspaceNamespace"];
  readonly root: string;
  readonly runnerId: RunnerId;
  readonly signal: AbortSignal;
}): Promise<{
  readonly access: NonNullable<RunWorkspaceManagerOptions["portableFs"]>;
  readonly registry: WorkspaceMountRegistry;
}> {
  const workspaceInstructionReader = new NativeFsHelper({
    binary: input.helperBinary,
    rootPolicy: "isolated-mount",
  });
  const result = await workspaceInstructionReader.preflight(input.dataDirectory, input.signal);
  input.logger.info("Mounted filesystem containment preflight passed", {
    containment: result.containment,
    helperVersion: result.binaryVersion,
  });
  const registry = new WorkspaceMountRegistry({
    identityIssuer: input.identityIssuer,
    mode: input.mode,
    namespace: input.namespace,
    portableFs: new PortableFsCliRunner({ binary: input.binary, environment: input.environment }),
    root: input.root,
    runnerId: input.runnerId,
    runtimeDirectory: input.dataDirectory,
  });
  return {
    access: {
      ensureMounted: registry.ensureMounted.bind(registry),
      namespaceRoot: registry.namespaceRoot.bind(registry),
      preflight: registry.preflight.bind(registry),
      workspaceInstructionReader,
    },
    registry,
  };
}

function required<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw new Error(`Runner configuration is missing ${label}`);
  return value;
}

async function main(): Promise<void> {
  const shutdown = new AbortController();
  let receivedSignal = false;
  const stop = (name: string): void => {
    if (receivedSignal) {
      process.stderr.write("Opensteer Runner received a second shutdown signal; exiting now\n");
      process.exit(1);
    }
    receivedSignal = true;
    shutdown.abort(new Error(`Received ${name}`));
  };
  const interrupt = () => stop("SIGINT");
  const breakSignal = () => stop("SIGBREAK");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGBREAK", breakSignal);
  process.on("SIGTERM", terminate);
  try {
    await runRunnerDaemon(process.env, shutdown.signal);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGBREAK", breakSignal);
    process.off("SIGTERM", terminate);
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
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
    process.exitCode = 1;
  });
}
