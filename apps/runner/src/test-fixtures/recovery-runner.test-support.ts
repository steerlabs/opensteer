import { createPrivateKey } from "node:crypto";
import { join } from "node:path";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import {
  FileRunnerIdentityStore,
  providerContinuationIdentityProjector,
} from "@opensteer/runner-client";
import { AttachmentCache } from "../attachments/attachment-cache.js";
import { ReconnectingHostConnection } from "../host/host-connection.js";
import { RunnerRuntime } from "../runtime/runtime.js";
import { RunnerBootIdSchema } from "@opensteer/protocol";
import type { RunnerConfig } from "@opensteer/config";
import type { AgentSkillBundle } from "../skills/agent-skills.js";
import { ExecutionContainment, executionScopeVariable } from "../runtime/execution-containment.js";

interface Boot {
  readonly bootId: string;
  readonly config: Omit<RunnerConfig, "hostUrl"> & { readonly hostUrl: string };
  readonly engine: { readonly fixture: string; readonly arguments: readonly string[] };
  readonly agentSkills: AgentSkillBundle;
  readonly mountedWorkspacePath: string;
  readonly attachmentRoot: string;
  readonly continuationPrivateKey: string;
}

process.once("message", (message: Boot) => {
  void boot(message).catch((error: unknown) => {
    process.send?.({ error: String(error) });
    process.exit(1);
  });
});

async function boot(input: Boot) {
  const authenticated = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const stop = new AbortController();
  let close: (() => Promise<void>) | undefined;
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "catalog-committed" &&
      "bootId" in message &&
      message.bootId === input.bootId
    ) {
      committed.resolve();
    } else if (message === "close") {
      stop.abort();
      void close?.().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
    }
  });
  const config: RunnerConfig = { ...input.config, hostUrl: new URL(input.config.hostUrl) };
  const containment = new ExecutionContainment({
    bootId: input.bootId,
    dataDirectory: config.dataDirectory,
  });
  const earlierBoots = await containment.reapEarlierBoots();
  const registry = new HarnessRegistry();
  const driver = new CodexHarnessDriver({
    launch: {
      executable: process.execPath,
      arguments: [
        input.engine.fixture,
        ...input.engine.arguments.map((argument) =>
          argument === "--readiness-runner-pid=self"
            ? `--readiness-runner-pid=${process.pid}`
            : argument,
        ),
      ],
    },
  });
  // Preparation happens before any Run exists. Carry the fixture's boot marker
  // through the Runtime's explicit environment allowlist into those engines too.
  Object.defineProperty(driver, "environmentVariables", {
    value: [...driver.environmentVariables, executionScopeVariable],
  });
  registry.registerDriver(driver);
  const logger = { error: () => undefined, info: () => undefined };
  const runtime = new RunnerRuntime({
    bootId: input.bootId,
    dataDirectory: config.dataDirectory,
    environmentId: config.environmentId!,
    agentSkills: input.agentSkills,
    attachmentCache: new AttachmentCache({
      root: input.attachmentRoot,
      transport: { hostOrigin: config.hostUrl, mode: "development" },
    }),
    browserHarnessExecutable: "/opt/opensteer/browser-harness",
    deploymentShape: config.deploymentShape,
    harnesses: registry,
    harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    harnessSandbox: {
      plan: async () => (launch) => launch,
      planProgram: async () => (launch) => launch,
    },
    integrationSkills: async () => ({
      cleanup: async () => undefined,
      digest: "none",
      directory: undefined,
      skills: [],
    }),
    maxConcurrentRuns: 1,
    maxConcurrentTriggerPrograms: 1,
    mode: "development",
    nodeExecutable: process.execPath,
    privateStateDirectory: join(config.dataDirectory, "private", "harness-state"),
    projectContinuationIdentity: providerContinuationIdentityProjector(
      createPrivateKey(input.continuationPrivateKey),
    ),
    workspaceManager: {
      prepare: async () => ({
        cleanup: async () => undefined,
        instructions: "Read the durable workspace before answering.",
        path: input.mountedWorkspacePath,
      }),
      writableRoots: ({ workspacePath }) => [workspacePath],
    },
  });
  const identityStore = new FileRunnerIdentityStore({
    dataDirectory: config.dataDirectory,
    environmentId: config.environmentId!,
    runnerId: config.runnerId!,
  });
  const identity = await identityStore.loadOrCreate();
  const connection = new ReconnectingHostConnection({
    onConnected: () => authenticated.resolve(),
    bootId: RunnerBootIdSchema.parse(input.bootId),
    config,
    identity,
    identityStore,
    logger,
    runtimeVersion: "recovery-child-test",
    agents: {
      earlierBootsContained: earlierBoots === "proven",
      runtime,
      workspaceBackings: config.workspaceBackings,
      workspaceMounts: () => [],
    },
  });
  const task = connection.run(stop.signal);
  close = async () => {
    stop.abort();
    connection.close();
    await task;
    await runtime.close();
    process.disconnect?.();
  };
  if (stop.signal.aborted) {
    await close();
    return;
  }
  await Promise.all([authenticated.promise, committed.promise]);
  process.send?.("ready");
}
