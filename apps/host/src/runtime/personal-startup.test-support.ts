import { forkRunnerChild } from "../agents/runner-child.test-support.js";
import { integrationBundleEntry } from "@opensteer/shared/test-support/integrationRunnerBuild";
import { ExecutionContainment, executionScopeVariable } from "@opensteer/runner";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { NetworkPartition } from "../agents/network-partition.test-support.js";
import { RunnerWire } from "../agents/runner-wire.test-support.js";
import type { VerticalStackOptions } from "../agents/vertical-stack.test-support.js";
import type { AgentHomeAccess } from "@opensteer/runner";
import { HarnessIdSchema } from "@opensteer/core";
import type { HarnessInstanceCatalog } from "@opensteer/protocol";
import type { HostApiClient } from "@opensteer/protocol";
import type { EnvironmentId, HarnessInstanceId, RunId } from "@opensteer/core";
import { eventFromRow } from "@opensteer/database";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createId,
  MessageContentSchema,
  type AgentEvent,
  type MessageId,
  type ComputerFolder,
} from "@opensteer/core";
import { parseHostConfig, parseRunnerConfig } from "@opensteer/config";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { FileRunnerIdentityStore, providerContinuationIdentityProjector } from "@opensteer/runner";
import {
  AttachmentCache,
  loadAgentSkillBundle,
  ReconnectingHostConnection,
  RunnerRuntime,
  AgentHomeManager,
} from "@opensteer/runner";
import { RunnerBootIdSchema } from "@opensteer/protocol";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import { createHostRuntime, type PersonalHostRuntime } from "./runtime.js";
import { loadOrCreateHostKeys } from "../identity/host-keys.js";

export interface PersonalRuntime {
  readonly api: HostApiClient;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly sessionCookie: string;
  readonly hostOrigin: URL;
  readonly host: PersonalHostRuntime;
  readonly config: ReturnType<typeof parseHostConfig>;
  readonly directory: string;
  readonly agentHome: ComputerFolder;
  readonly runnerDataDirectory: string;
  readonly runner: RunnerRuntime | undefined;
  readonly network: NetworkPartition | RunnerWire;
  readonly agentHomePreparations: readonly Parameters<AgentHomeAccess["prepare"]>[0][];
  readonly additionalHarnessInstanceIds: readonly HarnessInstanceId[];
  readonly initialCatalog: HarnessInstanceCatalog;
  observe<Value>(
    read: () => Promise<Value | undefined>,
    signal: AbortSignal,
    label: string,
  ): Promise<Value>;

  waitForInput(
    messageId: MessageId,
    signal: AbortSignal,
    replacementRunId?: RunId,
  ): Promise<{
    readonly runId: RunId;
    readonly events: readonly AgentEvent[];
    readonly assistantText: string;
  }>;
  crashRunner(beforeRestart?: () => Promise<void>): Promise<void>;
  restartHost(outage?: {
    readonly downForMs?: number;
    readonly whileDown?: () => Promise<void>;
  }): Promise<void>;
  restartRunner(): Promise<void>;
  close(): Promise<void>;
}
export async function startPersonalRuntime(input: {
  readonly databaseUrl: string;
  readonly agentHome: ComputerFolder;
  readonly engineArguments?: readonly string[];
  readonly vertical?: VerticalStackOptions;
  readonly hostLog?: (line: string) => void;
  readonly runnerWire?: import("../agents/runner-wire.test-support.js").RunnerWireOptions;
  readonly maxConcurrentRuns?: number;
  readonly webDistribution?: NonNullable<ReturnType<typeof parseHostConfig>["webDistribution"]>;
  readonly browser?: NonNullable<VerticalStackOptions["browser"]>;
}): Promise<PersonalRuntime> {
  const vertical = input.vertical;
  const browser = vertical?.browser ?? input.browser;
  const hostLog = vertical?.hostLog ?? input.hostLog;
  const lifetime = new AbortController();
  const changes = new Set<() => void>();
  const directory = await mkdtemp(join(tmpdir(), "personal-runtime-"));
  await mkdir(input.agentHome.path, { recursive: true });
  const port = await freePort(),
    origin = new URL(`http://127.0.0.1:${port}`),
    environmentId = createId("environment"),
    claim = randomBytes(32).toString("base64url");
  const config = {
    ...parseHostConfig({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_DATABASE_URL: input.databaseUrl,
      OPENSTEER_AUTH_SECRET: randomBytes(48).toString("base64url"),
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: claim,
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      OPENSTEER_HOST_DATA_DIR: join(directory, "host"),
      OPENSTEER_PORT: String(port),
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_CANONICAL_ORIGIN: origin.origin,
      OPENSTEER_HOSTING_ENVIRONMENT_ID: environmentId,
      OPENSTEER_AGENT_HOME: input.agentHome.path,
      ...(vertical?.executionLeaseMs
        ? { OPENSTEER_EXECUTION_LEASE_SECONDS: String(vertical.executionLeaseMs / 1000) }
        : {}),
      OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
    }),
    ...(vertical?.personalAccountIssuer
      ? { personalAccountIssuer: vertical.personalAccountIssuer }
      : {}),
    ...(input.webDistribution
      ? { mode: "production" as const, webDistribution: input.webDistribution }
      : {}),
  };
  let network: NetworkPartition | RunnerWire | undefined;
  let child: ReturnType<typeof forkRunnerChild> | undefined;
  const childStops = new Set<() => Promise<void>>();
  const agentHomePreparations: Parameters<AgentHomeAccess["prepare"]>[0][] = [];
  const accountIds: HarnessInstanceId[] = [];
  let runnerIntegrations: ReturnType<NonNullable<VerticalStackOptions["integrations"]>> | undefined;
  let initialCatalog: HarnessInstanceCatalog | undefined;
  let host: PersonalHostRuntime | undefined,
    runner: RunnerRuntime | undefined,
    connection: ReconnectingHostConnection | undefined,
    connecting: Promise<void> | undefined,
    runnerStop: AbortController | undefined;
  let catalogs = Promise.withResolvers<void>();
  let catalogState = "not received";
  let cookie = "",
    closed = false;
  const events = new Set<(event: AgentEvent) => void>();
  async function startHost() {
    const runtime = await createHostRuntime(
      { ...config, ...(vertical?.account ? { account: vertical.account } : {}) },
      {
        ...(hostLog
          ? {
              logger: {
                level: "info",
                redact: [
                  "req.headers.authorization",
                  "req.headers.cookie",
                  "res.headers.set-cookie",
                ],
                stream: new Writable({
                  write(chunk: Buffer | string, _encoding, done) {
                    hostLog(chunk.toString().trimEnd());
                    done();
                  },
                }),
              },
            }
          : {}),
        ...(vertical?.executionClock ? { executionClock: vertical.executionClock } : {}),
        ...(vertical?.notificationTiming
          ? { notificationTiming: vertical.notificationTiming }
          : {}),
        ...(vertical?.browserActivityClock
          ? { browserActivityClock: vertical.browserActivityClock }
          : {}),
        ...(vertical?.runCapabilityLifetimeSeconds
          ? { runCapabilityLifetimeSeconds: vertical.runCapabilityLifetimeSeconds }
          : {}),
        ...(vertical?.runCapabilityNow ? { runCapabilityNow: vertical.runCapabilityNow } : {}),
        ...(vertical?.accountDirectoryFetch
          ? { accountDirectoryFetch: vertical.accountDirectoryFetch }
          : {}),
        onRunnerCatalogsCommitted: (_identity, _environment, captured) => {
          for (const notify of changes) notify();
          catalogState = captured
            .map((catalog) => `${catalog.status}: ${catalog.detail ?? ""}`)
            .join("; ");
          if (
            captured.some((catalog) =>
              accountIds.length
                ? catalog.harnessInstanceId === accountIds[0] && catalog.status !== "preparing"
                : catalog.status === "ready",
            )
          )
            catalogs.resolve();
        },
        onDeploymentEvent: (event) => {
          for (const listener of events) listener(event);
          for (const notify of changes) notify();
        },
      },
    );
    if (runtime.kind !== "personal") throw new Error("Personal fixture constructed a team Host");
    host = runtime;
    await host.listen();
    const signedIn = await host.app.inject({
      method: "POST",
      url: "/v1/rpc/auth.setup.claim",
      headers: {
        origin: origin.origin,
        "x-opensteer-api-version": String(
          (await import("@opensteer/deployment-authority")).hostApiVersion,
        ),
      },
      payload: { kind: "local-machine-owner", token: claim },
    });
    if (signedIn.statusCode !== 200)
      throw new Error(`Local owner claim failed (${signedIn.statusCode})`);
    cookie = signedIn.cookies.map((value) => `${value.name}=${value.value}`).join("; ");
  }
  async function stopRunner(disconnectFirst = false) {
    if (disconnectFirst) {
      runnerStop?.abort();
      connection?.close();
      await connecting;
    }
    try {
      await child?.close();
      await runner?.close();
    } finally {
      child = undefined;
      runner = undefined;
      runnerStop?.abort();
      connection?.close();
      await connecting;
      runnerIntegrations?.close?.();
    }
  }
  async function startRunner() {
    lifetime.signal.throwIfAborted();
    catalogs = Promise.withResolvers<void>();
    const bootstrap = await host!.app.inject({
      method: "GET",
      url: "/v1/local-bootstrap",
      headers: { authorization: `Bearer ${claim}` },
    });
    const enrollment = bootstrap.json<{ runnerEnrollmentToken: string }>().runnerEnrollmentToken;
    const parsed = parseRunnerConfig({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_URL: network!.url.origin,
      OPENSTEER_ENVIRONMENT_ID: environmentId,
      OPENSTEER_RUNNER_ID: input.agentHome.computerId,
      OPENSTEER_RUNNER_DATA_DIR: join(directory, "runner"),
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: enrollment,
      OPENSTEER_RUNNER_MODULES: [
        "agents",
        ...(vertical?.integrations ? ["integrations"] : []),
        ...(browser ? ["browser"] : []),
      ].join(","),
      OPENSTEER_MAX_CONCURRENT_RUNS: String(
        vertical?.maxConcurrentRuns ?? input.maxConcurrentRuns ?? 1,
      ),
    });
    const config = {
      ...parsed,
      ...(browser ? { browserBridge: { ...browser, signIn: false, personFill: false } } : {}),
    };
    const registry = vertical
      ? typeof vertical.harnesses === "function"
        ? vertical.harnesses()
        : vertical.harnesses
      : new HarnessRegistry();
    if (!vertical)
      registry.registerDriver(
        new CodexHarnessDriver({
          launch: {
            executable: process.execPath,
            arguments: [
              resolve("packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs"),
              ...(input.engineArguments ?? []),
            ],
          },
        }),
      );
    const keys = await loadOrCreateHostKeys({ dataDirectory: join(directory, "host") });
    const bootId = RunnerBootIdSchema.parse(`rbt_${crypto.randomUUID()}`);
    const agentHome = new AgentHomeManager(input.agentHome.computerId);
    runnerIntegrations = vertical?.integrations?.();
    const containment = new ExecutionContainment({ bootId, dataDirectory: config.dataDirectory });
    const earlierBoots = await containment.reapEarlierBoots();
    lifetime.signal.throwIfAborted();
    runner = new RunnerRuntime({
      containment,
      ...(vertical?.executionClock ? { executionClock: vertical.executionClock } : {}),
      ...(vertical?.credentialRefreshClock
        ? { credentialRefreshClock: vertical.credentialRefreshClock }
        : {}),
      ...(vertical?.machineAccess ? { machineAccess: vertical.machineAccess } : {}),
      ...(vertical?.runnerLogger ? { logger: vertical.runnerLogger } : {}),
      bootId,
      dataDirectory: config.dataDirectory,
      environmentId,
      agentSkills: await loadAgentSkillBundle(resolve("apps/runner/agent-skills")),
      attachmentCache: new AttachmentCache({
        root: join(directory, "attachments"),
        transport: { hostOrigin: origin, mode: "development" },
      }),
      browserHarnessExecutable:
        vertical?.browserHarnessExecutable ??
        resolve("apps/runner/browser-harness/browser-harness.mjs"),
      deploymentShape: { kind: "personal" },
      harnesses: registry,
      harnessRuntimeBoundary:
        vertical?.harnessRuntimeBoundary ?? isolatedServiceHarnessRuntimeBoundary,
      harnessSandbox: {
        plan: async () => (launch) => launch,
        planProgram: async () => (launch) => launch,
      },
      modelServerHome: vertical?.modelServerHome ?? directory,
      plugins: async () => ({
        cleanup: async () => {},
        digest: "none",
        directories: [],
        skills: [],
      }),
      maxConcurrentRuns: vertical?.maxConcurrentRuns ?? input.maxConcurrentRuns ?? 1,
      maxConcurrentTriggerPrograms: 1,
      mode: "development",
      nativeFsHelperBinary: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
      nodeExecutable: process.execPath,
      privateStateDirectory: join(directory, "private", "harness-state"),
      projectContinuationIdentity: providerContinuationIdentityProjector(keys.privateKey),
      agentHome: {
        prepare: async (input) => {
          agentHomePreparations.push(input);
          return agentHome.prepare(input);
        },
        folder: (folder, home) => agentHome.folder(folder, home),
      },
    });
    const identityStore = new FileRunnerIdentityStore({
        dataDirectory: config.dataDirectory,
        environmentId,
        runnerId: input.agentHome.computerId,
      }),
      identity = await identityStore.loadOrCreate();
    lifetime.signal.throwIfAborted();
    if (network instanceof RunnerWire)
      network.useKey(identity.privateKey, input.agentHome.computerId);
    if (vertical?.runnerChild) {
      await runner.close();
      runner = undefined;
      const entry = await integrationBundleEntry(
        fileURLToPath(new URL("../../../../", import.meta.url)),
        "recovery",
      );
      lifetime.signal.throwIfAborted();
      const owned = forkRunnerChild(
        entry,
        {
          execArgv: [],
          environment: { [executionScopeVariable]: containment.scope("fixture-runner") },
          afterStop: async () => {
            if ((await containment.reapBoot()) !== "proven")
              throw new Error("Runner child processes did not stop");
          },
        },
        (stop) => childStops.add(stop),
      );
      child = owned;
      const ready = Promise.withResolvers<void>();
      owned.child.on("message", (message) => {
        if (message === "ready") ready.resolve();
        else if (message && typeof message === "object" && "error" in message)
          ready.reject(new Error(String(message.error)));
      });
      owned.child.once("error", (error) => ready.reject(error));
      const closed = owned.exited.then(() => {
        throw new Error("Runner child exited before readiness");
      });
      void closed.catch(() => undefined);
      void ready.promise.catch(() => undefined);
      owned.child.send({
        nativeFsHelperBinary: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
        bootId,
        config: { ...config, hostUrl: config.hostUrl.toString() },
        engine: vertical.runnerChild,
        harnessInstance: vertical.harnessInstance,
        mountedWorkspacePath: input.agentHome.path,
        attachmentRoot: join(directory, "attachments"),
        agentSkills: await loadAgentSkillBundle(resolve("apps/runner/agent-skills")),
        continuationPrivateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      });
      await withTimeout(Promise.race([catalogs.promise, closed]), vertical.catalogTimeoutMs, {
        signal: lifetime.signal,
        timeoutError: () => new Error(`Runner child never committed its catalog: ${catalogState}`),
      });
      owned.child.send({ type: "catalog-committed", bootId });
      await withTimeout(Promise.race([ready.promise, closed]), vertical.catalogTimeoutMs, {
        signal: lifetime.signal,
        timeoutError: () => new Error("Runner child never acknowledged readiness"),
      });
      return;
    }
    connection = new ReconnectingHostConnection({
      ...(vertical?.executionClock ? { executionClock: vertical.executionClock } : {}),
      ...(runnerIntegrations ? { integrationsModule: runnerIntegrations } : {}),
      browserBridge: config.browserBridge,
      bootId,
      config,
      identity,
      identityStore,
      logger: vertical?.runnerLogger ?? { error: () => {}, info: () => {} },
      runtimeVersion: "integration-fake-codex",
      agents: { earlierBootsContained: earlierBoots === "proven", runtime: runner },
    });
    runnerStop = new AbortController();
    connecting = connection.run(AbortSignal.any([runnerStop.signal, lifetime.signal]));
    await withTimeout(
      Promise.race([
        catalogs.promise,
        connecting.then(() => {
          lifetime.signal.throwIfAborted();
          throw new Error("Runner closed before catalog commit");
        }),
      ]),
      vertical?.catalogTimeoutMs ?? 15000,
      {
        timeoutError: () =>
          new Error(`Personal Runner did not commit a ready catalog: ${catalogState}`),
      },
    );
  }
  try {
    await startHost();
    network =
      (vertical?.runnerWire ?? input.runnerWire)
        ? await RunnerWire.start(port, (vertical?.runnerWire ?? input.runnerWire)!)
        : await NetworkPartition.start(port);
    if (vertical) {
      await host!.store.createEnvironment({
        id: environmentId,
        kind: "main",
        name: "Hosting computer",
      });
      for (const [index, definition] of [
        vertical.harnessInstance,
        ...(vertical.additionalHarnessInstances ?? []),
      ].entries()) {
        const account = await host!.store.createHarnessInstance({
          config: definition.config,
          driverKind: HarnessIdSchema.parse(definition.driverKind),
          environmentId,
          name: `Account ${index + 1}`,
          sourceId: definition.sourceId,
          stateKind: definition.stateKind,
        });
        accountIds.push(account.id);
      }
    }
    await startRunner();
    const harness = (
      await host!.store.listHarnessInstances({ environmentIds: [environmentId] })
    ).find((row) => (vertical ? row.id === accountIds[0] : row.driverKind === "codex"));
    if (!harness) throw new Error("Fake Codex account was not seeded");
    const api = createHttpHostApiClient({
      baseUrl: origin,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            origin: origin.origin,
            cookie,
          },
        }),
      onAuthenticationRequired: () => {
        throw new Error("Personal session expired");
      },
    });
    const observe = async <Value>(
      read: () => Promise<Value | undefined>,
      signal: AbortSignal,
      label: string,
    ): Promise<Value> => {
      signal = AbortSignal.any([signal, lifetime.signal]);
      let wake = Promise.withResolvers<void>();
      const listener = () => wake.resolve();
      changes.add(listener);
      try {
        for (;;) {
          signal.throwIfAborted();
          const changed = wake.promise;
          const result = await read();
          if (result !== undefined) return result;
          await withTimeout(changed, vertical?.runTimeoutMs ?? 15000, {
            signal,
            timeoutError: () => new Error(label),
          });
          wake = Promise.withResolvers<void>();
        }
      } finally {
        changes.delete(listener);
      }
    };
    initialCatalog = (await host!.store.getHarnessCatalog(environmentId, harness.id)) ?? undefined;
    if (!initialCatalog) throw new Error("Runner published no catalog");
    const waitForInput = async (
      messageId: MessageId,
      signal: AbortSignal,
      replacementRunId?: RunId,
    ) => {
      signal = AbortSignal.any([signal, lifetime.signal]);
      let wake = Promise.withResolvers<void>();
      const observe = () => wake.resolve();
      events.add(observe);
      try {
        for (;;) {
          signal.throwIfAborted();
          const inputRow = await host!.store.database
            .selectFrom("threadInputs")
            .select(["runId", "threadId"])
            .where("messageId", "=", messageId)
            .executeTakeFirstOrThrow();
          if (inputRow.runId || replacementRunId) {
            const run = await host!.store.database
              .selectFrom("runs")
              .select(["id", "status"])
              .where("id", "=", replacementRunId ?? inputRow.runId!)
              .executeTakeFirstOrThrow();
            if (["completed", "failed", "interrupted"].includes(run.status)) {
              const selected = (
                await host!.store.database
                  .selectFrom("deploymentEvents")
                  .selectAll()
                  .where("runId", "=", run.id)
                  .orderBy("sequence")
                  .execute()
              ).map(eventFromRow);
              const messages = await host!.store.database
                .selectFrom("messages")
                .select("content")
                .where("runId", "=", run.id)
                .where("kind", "=", "assistant")
                .orderBy("sequence")
                .execute();
              return {
                runId: run.id,
                events: selected,
                assistantText: messages
                  .flatMap((row) => MessageContentSchema.parse(row.content))
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\\n"),
              };
            }
          }
          const changed = wake.promise;
          await withTimeout(changed, Math.max(1, 15000), {
            signal,
            timeoutError: () => new Error("Input never reached a terminal consuming Run"),
          });
          wake = Promise.withResolvers<void>();
        }
      } catch (error) {
        const rows = await host!.store.database
          .selectFrom("runs")
          .select(["id", "status", "failure"])
          .execute();
        throw new Error(`Input observation failed: ${JSON.stringify(rows)}`, { cause: error });
      } finally {
        events.delete(observe);
      }
    };
    return {
      config,
      directory,
      agentHome: input.agentHome,
      runnerDataDirectory: join(directory, "runner"),
      network,
      get runner() {
        return runner;
      },
      agentHomePreparations,
      additionalHarnessInstanceIds: accountIds.slice(1),
      initialCatalog,
      observe,
      api,
      environmentId,
      harnessInstanceId: harness.id,
      get sessionCookie() {
        return cookie;
      },
      hostOrigin: origin,
      waitForInput,
      get host() {
        return host!;
      },
      async crashRunner(beforeRestart) {
        if (!child) throw new Error("A Runner crash requires runnerChild");
        await child.crash();
        await beforeRestart?.();
        await startRunner();
      },
      async restartHost(outage) {
        catalogs = Promise.withResolvers<void>();
        await host!.close();
        await outage?.whileDown?.();
        if (outage?.downForMs)
          // oxlint-disable-next-line opensteer/no-real-time-wait-in-tests -- The recovery fixture deliberately holds a real network outage for its requested duration.
          await delay(outage.downForMs, undefined, { signal: lifetime.signal });
        lifetime.signal.throwIfAborted();
        await startHost();
        await withTimeout(catalogs.promise, 15000, {
          timeoutError: () => new Error("Runner did not reattach after Host restart"),
        });
      },
      async restartRunner() {
        await stopRunner(true);
        await startRunner();
      },
      async close() {
        if (closed) return;
        closed = true;
        lifetime.abort(new Error("Vertical stack closed"));
        const hadRunner = runner !== undefined || child !== undefined;
        try {
          await stopRunner();
          for (const stop of childStops) await stop();
          if (hadRunner && host) await vertical?.beforeHostClose?.(host);
        } finally {
          try {
            await host?.close();
          } finally {
            await network?.close();
            await rm(directory, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    const hadRunner = runner !== undefined || child !== undefined;
    try {
      await stopRunner();
      if (hadRunner && host) await vertical?.beforeHostClose?.(host);
    } finally {
      try {
        await host?.close();
      } finally {
        await network?.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    throw error;
  }
}
