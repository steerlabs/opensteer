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
  type TaskFolder,
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
  TaskFolderManager,
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
  waitForInput(
    messageId: MessageId,
    signal: AbortSignal,
  ): Promise<{
    readonly runId: RunId;
    readonly events: readonly AgentEvent[];
    readonly assistantText: string;
  }>;
  restartHost(): Promise<void>;
  restartRunner(): Promise<void>;
  close(): Promise<void>;
}
export async function startPersonalRuntime(input: {
  readonly databaseUrl: string;
  readonly agentHome: TaskFolder;
  readonly engineArguments?: readonly string[];
}): Promise<PersonalRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "personal-runtime-"));
  await mkdir(input.agentHome.path, { recursive: true });
  const port = await freePort(),
    origin = new URL(`http://127.0.0.1:${port}`),
    environmentId = createId("environment"),
    claim = randomBytes(32).toString("base64url");
  const config = parseHostConfig({
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
    OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
  });
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
    const runtime = await createHostRuntime(config, {
      onRunnerCatalogsCommitted: (_identity, _environment, captured) => {
        catalogState = captured
          .map((catalog) => `${catalog.status}: ${catalog.detail ?? ""}`)
          .join("; ");
        if (captured.some((catalog) => catalog.status === "ready")) catalogs.resolve();
      },
      onDeploymentEvent: (event) => {
        for (const listener of events) listener(event);
      },
    });
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
  async function stopRunner() {
    runnerStop?.abort();
    connection?.close();
    await connecting;
    await runner?.close();
    runner = undefined;
  }
  async function startRunner() {
    catalogs = Promise.withResolvers<void>();
    const bootstrap = await host!.app.inject({
      method: "GET",
      url: "/v1/local-bootstrap",
      headers: { authorization: `Bearer ${claim}` },
    });
    const enrollment = bootstrap.json<{ runnerEnrollmentToken: string }>().runnerEnrollmentToken;
    const config = parseRunnerConfig({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_URL: origin.origin,
      OPENSTEER_ENVIRONMENT_ID: environmentId,
      OPENSTEER_RUNNER_ID: input.agentHome.computerId,
      OPENSTEER_RUNNER_DATA_DIR: join(directory, "runner"),
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: enrollment,
      OPENSTEER_RUNNER_MODULES: "agents",
      OPENSTEER_MAX_CONCURRENT_RUNS: "1",
    });
    const registry = new HarnessRegistry();
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
    runner = new RunnerRuntime({
      bootId,
      dataDirectory: config.dataDirectory,
      environmentId,
      agentSkills: await loadAgentSkillBundle(resolve("apps/runner/agent-skills")),
      attachmentCache: new AttachmentCache({
        root: join(directory, "attachments"),
        transport: { hostOrigin: origin, mode: "development" },
      }),
      browserHarnessExecutable: resolve("apps/runner/browser-harness/browser-harness.mjs"),
      deploymentShape: { kind: "personal" },
      harnesses: registry,
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      harnessSandbox: {
        plan: async () => (launch) => launch,
        planProgram: async () => (launch) => launch,
      },
      modelServerHome: directory,
      plugins: async () => ({
        cleanup: async () => {},
        digest: "none",
        directories: [],
        skills: [],
      }),
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      mode: "development",
      nodeExecutable: process.execPath,
      privateStateDirectory: join(directory, "private", "harness-state"),
      projectContinuationIdentity: providerContinuationIdentityProjector(keys.privateKey),
      folderManager: new TaskFolderManager(input.agentHome.computerId),
    });
    const identityStore = new FileRunnerIdentityStore({
        dataDirectory: config.dataDirectory,
        environmentId,
        runnerId: input.agentHome.computerId,
      }),
      identity = await identityStore.loadOrCreate();
    connection = new ReconnectingHostConnection({
      bootId,
      config,
      identity,
      identityStore,
      logger: { error: () => {}, info: () => {} },
      runtimeVersion: "integration-fake-codex",
      agents: { earlierBootsContained: true, runtime: runner },
    });
    runnerStop = new AbortController();
    connecting = connection.run(runnerStop.signal);
    await withTimeout(
      Promise.race([
        catalogs.promise,
        connecting.then(() => {
          throw new Error("Runner closed before catalog commit");
        }),
      ]),
      15000,
      {
        timeoutError: () =>
          new Error(`Personal Runner did not commit a ready catalog: ${catalogState}`),
      },
    );
  }
  try {
    await startHost();
    await startRunner();
    const harness = (
      await host!.store.listHarnessInstances({ environmentIds: [environmentId] })
    ).find((row) => row.driverKind === "codex");
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
    const waitForInput = async (messageId: MessageId, signal: AbortSignal) => {
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
          if (inputRow.runId) {
            const run = await host!.store.database
              .selectFrom("runs")
              .select(["id", "status"])
              .where("id", "=", inputRow.runId)
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
      api,
      environmentId,
      harnessInstanceId: harness.id,
      sessionCookie: cookie,
      hostOrigin: origin,
      waitForInput,
      get host() {
        return host!;
      },
      async restartHost() {
        catalogs = Promise.withResolvers<void>();
        await host!.close();
        await startHost();
        await withTimeout(catalogs.promise, 15000, {
          timeoutError: () => new Error("Runner did not reattach after Host restart"),
        });
      },
      async restartRunner() {
        await stopRunner();
        await startRunner();
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await stopRunner();
        } finally {
          try {
            await host?.close();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    await stopRunner();
    await host?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
