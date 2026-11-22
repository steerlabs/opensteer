import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import { parseHostConfig, parseRunnerConfig } from "@opensteer/config";
import {
  createId,
  HarnessIdSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  type RunId,
} from "@opensteer/core";
import {
  AppStore,
  findPersonalSettings,
  personalSettings,
  readThreadOutputImage,
  resolveThreadOutputImage,
} from "@opensteer/database";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { hostApiVersion, hostApiVersionHeader } from "@opensteer/deployment-authority";
import {
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
  type HarnessAdapter,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessSession,
} from "@opensteer/harness";
import { RunnerRegistry } from "@opensteer/orchestration";
import {
  RunnerBootIdSchema,
  RunnerDescriptorSchema,
  runEventsCapability,
} from "@opensteer/protocol";
import {
  AgentHomeManager,
  AttachmentCache,
  ExecutionContainment,
  FileRunnerIdentityStore,
  loadAgentSkillBundle,
  providerContinuationIdentityProjector,
  ReconnectingHostConnection,
  RunnerRuntime,
} from "@opensteer/runner";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { withTimeout } from "@opensteer/shared/withTimeout";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import { AppService } from "../apps/app-service.js";
import { loadOrCreateHostKeys } from "../identity/host-keys.js";
import { withFolderPluginPackage } from "../local-servers/folder-plugin-package.js";
import { exportPluginSource, pluginSourceFiles } from "../plugins/plugin-source.js";
import { createHostRuntime } from "../runtime/runtime.js";
import { HostOutputImageStore } from "./host-output-images.js";
import { closed, connectPrimary } from "../runtime/private-machine-host.test-support.js";
import { AgentHomeFiles } from "./agent-home-files.js";

function createImageEmittingDriver(imagePath: string, finishTurn: Promise<void>): HarnessDriver {
  const kind = HarnessIdSchema.parse("native");
  const modelId = ModelIdSchema.parse("test-model");
  const providerId = ModelProviderIdSchema.parse("native");
  const capabilities = {
    approvals: false,
    attachments: false,
    interruption: true,
    mcpImageContent: false,
    resume: false,
    steering: false,
    toolCalls: true,
    userInput: false,
  };
  const session = (): HarnessSession => {
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const events: AsyncIterable<HarnessEvent> = (async function* (): AsyncGenerator<HarnessEvent> {
      await started.promise;
      yield {
        data: { status: "running" },
        type: "run.started",
      };
      const callId = `call_${randomUUID()}`;
      yield {
        data: {
          arguments: { prompt: "green box" },
          callId,
          tool: { name: "image_generation", namespace: "native" },
        },
        type: "tool.started",
      };
      yield {
        data: {
          callId,
          isError: false,
          output: {
            images: [{ generated: true, mediaType: "image/png", path: imagePath }],
            text: "Generated image",
          },
        },
        type: "tool.completed",
      };
      yield {
        data: {
          content: [{ text: "Here is the generated image.", type: "text" }],
          messageId: createId("message"),
        },
        type: "assistant.message",
      };
      try {
        await finishTurn;
        yield { data: { status: "completed" }, type: "run.completed" };
      } finally {
        finished.resolve();
      }
    })();
    return {
      events,
      execute: async () => {
        started.resolve();
        await finished.promise;
      },
      interrupt: async () => {
        started.resolve();
        finished.resolve();
      },
      providerSessionReference: `ref_${randomUUID()}`,
      resolveRequest: async () => undefined,
      stop: async () => {
        started.resolve();
        finished.resolve();
      },
    } as unknown as HarnessSession;
  };
  return {
    accessModes: ["full-access"],
    capabilities,
    configSchema: z.object({}),
    create: async ({ instanceId }): Promise<HarnessAdapter> => ({
      capabilities,
      close: async () => undefined,
      instanceId,
      resumeSession: async () => session(),
      startSession: async () => session(),
    }),
    inspect: async () => ({
      models: [
        {
          displayName: "Test Model",
          isDefault: true,
          modelId,
          options: [],
          providerId,
        },
      ],
      status: "ready",
    }),
    kind,
    sources: [
      {
        fields: [],
        kind: "first-party",
        label: "Native",
        quota: "none",
        sourceId: "native",
        stateKinds: ["isolated"],
      },
    ],
  };
}

async function waitUntil<T>(
  check: () => Promise<T | undefined | null>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  return vi.waitFor(
    async () => {
      const value = await check();
      if (value === undefined || value === null) throw new Error(`Waiting for ${label}`);
      return value;
    },
    { interval: 25, timeout: timeoutMs },
  );
}

it("serves Agent home files, published output images, folder plugins, static apps and exports strictly over the Host-Runner wire", async () => {
  const database = await cloneTestDatabase("host");
  const root = await realpath(await mkdtemp(join(tmpdir(), "home-files-wire-")));
  const hostDataDir = join(root, "host-data");
  const runnerDataDir = join(root, "runner-data");
  const realParent = join(root, "real-parent");
  const symlinkParent = join(root, "symlink-parent");
  await mkdir(realParent, { recursive: true });
  await symlink(realParent, symlinkParent);
  const configuredAgentHome = join(symlinkParent, "agent-home");
  const expectedCanonicalAgentHome = join(realParent, "agent-home");
  const generatedSourcePath = join(root, "generated-source.png");
  const generatedPng = await sharp({
    create: { background: "green", channels: 3, height: 12, width: 16 },
  })
    .png()
    .toBuffer();
  await writeFile(generatedSourcePath, generatedPng);

  let host: Awaited<ReturnType<typeof createHostRuntime>> | undefined;
  let runner: RunnerRuntime | undefined;
  const runnerStop = new AbortController();
  const finishTurn = Promise.withResolvers<void>();
  const publishRequested = Promise.withResolvers<void>();
  const answerPublish = Promise.withResolvers<void>();
  const hasImage = HostOutputImageStore.prototype.has;
  const publicationRequest = vi
    .spyOn(HostOutputImageStore.prototype, "has")
    .mockImplementation(async function (this: HostOutputImageStore, ...args) {
      publishRequested.resolve();
      await answerPublish.promise;
      return hasImage.apply(this, args);
    });
  const finishPublishing = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const storeImage = HostOutputImageStore.prototype.store;
  const publication = vi
    .spyOn(HostOutputImageStore.prototype, "store")
    .mockImplementation(async function (this: HostOutputImageStore, input) {
      await finishPublishing.promise;
      await storeImage.call(this, input);
      published.resolve();
    });
  const homeReported = Promise.withResolvers<void>();
  const handleRunnerMessage = RunnerRegistry.prototype.handle;
  const reporting = vi.spyOn(RunnerRegistry.prototype, "handle").mockImplementation(async function (
    this: RunnerRegistry,
    peer,
    message,
  ) {
    await handleRunnerMessage.call(this, peer, message);
    if (message.type === "runner.agent-home.report") homeReported.resolve();
  });
  let runnerTask: Promise<void> | undefined;
  try {
    const port = await freePort();
    const origin = new URL(`http://127.0.0.1:${port}`);
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const claim = randomBytes(32).toString("base64url");

    const hostConfig = parseHostConfig({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_DATABASE_URL: database.url,
      OPENSTEER_AUTH_SECRET: randomBytes(48).toString("base64url"),
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: claim,
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      OPENSTEER_HOST_DATA_DIR: hostDataDir,
      OPENSTEER_RUNNER_DATA_DIR: join(root, "nonexistent-runner-data-host-cannot-read"),
      OPENSTEER_PORT: String(port),
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_CANONICAL_ORIGIN: origin.origin,
      OPENSTEER_HOSTING_ENVIRONMENT_ID: environmentId,
      OPENSTEER_AGENT_HOME: configuredAgentHome,
    });

    const owned = await ownTestDatabaseProducer(database.url, async () => {
      const created = await createHostRuntime(hostConfig);
      return { runtime: created, close: () => created.close() };
    });
    host = owned.runtime;
    if (host.kind !== "personal") throw new Error("Expected personal Host");
    const personalHost = host;
    await personalHost.app.listen({ host: "127.0.0.1", port });

    // Host must NEVER create Agent home itself.
    expect(existsSync(expectedCanonicalAgentHome)).toBe(false);

    // Claim personal owner session.
    const claimed = await personalHost.app.inject({
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        origin: origin.origin,
      },
      method: "POST",
      payload: { kind: "local-machine-owner", token: claim },
      url: "/v1/rpc/auth.setup.claim",
    });
    expect(claimed.statusCode).toBe(200);
    const setCookie = claimed.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
    const api = createHttpHostApiClient({
      baseUrl: origin,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            cookie,
            origin: origin.origin,
          },
        }),
      onAuthenticationRequired: () => undefined,
    });

    const bootstrap = await personalHost.app.inject({
      headers: { authorization: `Bearer ${claim}` },
      method: "GET",
      url: "/v1/local-bootstrap",
    });
    const enrollmentToken = bootstrap.json<{ runnerEnrollmentToken: string }>()
      .runnerEnrollmentToken;

    // Still does not exist before the Runner connects!
    expect(existsSync(expectedCanonicalAgentHome)).toBe(false);

    const runnerConfig = parseRunnerConfig({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_HOST_URL: origin.origin,
      OPENSTEER_ENVIRONMENT_ID: environmentId,
      OPENSTEER_RUNNER_ID: runnerId,
      OPENSTEER_RUNNER_DATA_DIR: runnerDataDir,
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: enrollmentToken,
      OPENSTEER_RUNNER_MODULES: "agents",
      OPENSTEER_MAX_CONCURRENT_RUNS: "1",
    });
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    const keys = await loadOrCreateHostKeys({ dataDirectory: hostDataDir });
    const harnesses = new HarnessRegistry();
    harnesses.registerDriver(createImageEmittingDriver(generatedSourcePath, finishTurn.promise));
    const containment = new ExecutionContainment({ bootId, dataDirectory: runnerDataDir });
    const earlierBoots = await containment.reapEarlierBoots();
    const helperBinary = resolve("apps/runner/native-fs-helper/opensteer-native-fs-test");
    runner = new RunnerRuntime({
      agentHome: new AgentHomeManager(runnerId),
      agentSkills: await loadAgentSkillBundle(resolve("apps/runner/agent-skills")),
      attachmentCache: new AttachmentCache({
        root: join(root, "attachments"),
        transport: { hostOrigin: origin, mode: "development" },
      }),
      bootId,
      browserHarnessExecutable: resolve("apps/runner/browser-harness/browser-harness.mjs"),
      containment,
      dataDirectory: runnerDataDir,
      deploymentShape: { kind: "personal" },
      environmentId,
      harnesses,
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      mode: "development",
      nativeFsHelperBinary: helperBinary,
      nodeExecutable: process.execPath,
      plugins: async () => ({
        cleanup: async () => undefined,
        digest: "none",
        directories: [],
        skills: [],
      }),
      privateStateDirectory: join(runnerDataDir, "private", "harness-state"),
      projectContinuationIdentity: providerContinuationIdentityProjector(keys.privateKey),
    });
    const identityStore = new FileRunnerIdentityStore({
      dataDirectory: runnerDataDir,
      environmentId,
      runnerId,
    });
    const identity = await identityStore.loadOrCreate();
    const connection = new ReconnectingHostConnection({
      agents: {
        earlierBootsContained: earlierBoots === "proven",
        runFileOptions: { dataDirectory: runnerDataDir, helperBinary },
        runtime: runner,
      },
      bootId,
      config: runnerConfig,
      identity,
      identityStore,
      logger: { error: () => undefined, info: () => undefined },
      runtimeVersion: "integration-home-files",
    });
    runnerTask = connection.run(runnerStop.signal);

    // 1. Runner creates + canonicalizes Agent home and reports it; Host persists the canonical path.
    await homeReported.promise;
    const savedSettings = await findPersonalSettings(personalHost.store.database);
    expect(savedSettings?.agentHome).toEqual({
      computerId: runnerId,
      path: expectedCanonicalAgentHome,
    });
    expect(existsSync(expectedCanonicalAgentHome)).toBe(true);

    // Build an AgentHomeFiles proxy whose Host-side path points to a NON-EXISTENT directory to
    // prove no direct Host disk read can succeed — only Runner-proxied reads work!
    const hostFiles = (await personalHost.localServers.options.files()) as AgentHomeFiles;
    const unreachablePathFiles = new AgentHomeFiles({
      agentHome: async () => ({
        computerId: runnerId,
        path: join(root, "nonexistent-host-view-of-agent-home"),
      }),
      transport: hostFiles.options.transport,
    });

    // 2. List + preview + download of Agent-home files over the real Host+Runner wire.
    await writeFile(join(expectedCanonicalAgentHome, "hello.txt"), "wire-hello-world");
    await mkdir(join(expectedCanonicalAgentHome, "sub"), { recursive: true });
    const bigBody = Buffer.alloc(600 * 1024, 65);
    await writeFile(join(expectedCanonicalAgentHome, "sub/large.txt"), bigBody);

    const page = await unreachablePathFiles.list({ parentKey: "", limit: 50 });
    const helloEntry = page.entries.find((entry) => entry.name === "hello.txt");
    expect(helloEntry).toMatchObject({ kind: "file", name: "hello.txt", sizeBytes: 16 });
    const preview = await unreachablePathFiles.preview(helloEntry!.key);
    expect(preview.bytes.toString("utf8")).toBe("wire-hello-world");
    expect(preview.metadata.truncated).toBe(false);
    if (!helloEntry?.revision) throw new Error("Listing did not include a file revision");
    const listed = await unreachablePathFiles.download(
      helloEntry.key,
      undefined,
      undefined,
      helloEntry.revision,
    );
    expect(await listed.text()).toBe("wire-hello-world");
    await rename(join(expectedCanonicalAgentHome, "hello.txt"), join(root, "original-hello.txt"));
    await writeFile(join(expectedCanonicalAgentHome, "hello.txt"), "wire-replacement");
    await expect(
      unreachablePathFiles.download(helloEntry.key, undefined, undefined, helloEntry.revision),
    ).rejects.toMatchObject({ reason: "revision-mismatch" });

    const largeKey = Buffer.from("sub\0large.txt").toString("base64url");
    const largePreview = await unreachablePathFiles.preview(largeKey);
    expect(largePreview.bytes.byteLength).toBe(512 * 1024);
    expect(largePreview.metadata.truncated).toBe(true);
    const largeDownload = await unreachablePathFiles.download(largeKey);
    expect(Buffer.from(await largeDownload.arrayBuffer())).toEqual(bigBody);

    // 3. Folder-plugin import over the real Host+Runner wire.
    await mkdir(join(expectedCanonicalAgentHome, "my-plugin/src"), { recursive: true });
    await writeFile(
      join(expectedCanonicalAgentHome, "my-plugin/plugin.json"),
      JSON.stringify({ name: "my-plugin" }),
    );
    await writeFile(
      join(expectedCanonicalAgentHome, "my-plugin/src/index.ts"),
      "export const loaded = true;\n",
    );
    const imported = await withFolderPluginPackage({
      directory: "my-plugin",
      files: unreachablePathFiles,
      install: pluginSourceFiles,
    });
    expect(imported.kind).toBe("files");
    expect(imported.files.map((file) => file.path).sort()).toEqual(["plugin.json", "src/index.ts"]);

    // 4. Plugin source export over the real Host+Runner wire.
    await exportPluginSource(
      unreachablePathFiles,
      "exported-plugin",
      [
        { content: "export const exported = 42;\n", path: "index.ts" },
        {
          content: Buffer.from([1, 2, 3, 4]).toString("base64"),
          encoding: "base64",
          path: "data/bin.dat",
        },
      ],
      async () => undefined,
    );
    expect(
      await readFile(join(expectedCanonicalAgentHome, "exported-plugin/index.ts"), "utf8"),
    ).toBe("export const exported = 42;\n");
    expect([
      ...(await readFile(join(expectedCanonicalAgentHome, "exported-plugin/data/bin.dat"))),
    ]).toEqual([1, 2, 3, 4]);
    await expect(
      exportPluginSource(
        unreachablePathFiles,
        "exported-plugin",
        [{ content: "dup", path: "index.ts" }],
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    await writeFile(
      join(expectedCanonicalAgentHome, "AGENTS.md"),
      "Memory: off at the person's request\n",
    );

    // 5. Run with generated output image -> Runner publishes to Host-owned storage.
    const harness = await waitUntil(async () => {
      const instances = await personalHost.store.listHarnessInstances({
        environmentIds: [environmentId],
      });
      return instances.find((row) => row.driverKind === "native") ?? null;
    }, "auto-seeded native harness instance");
    const settings = await personalSettings(personalHost.store.database);
    await waitUntil(async () => {
      const catalog = await personalHost.store.getHarnessCatalog(environmentId, harness.id);
      return catalog?.status === "ready" ? catalog : null;
    }, "native harness catalog ready");
    const { thread } = await personalHost.store.createThread({
      createdBy: settings.ownerId,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "wire-app-thread",
      modelSelection: {
        modelId: ModelIdSchema.parse("test-model"),
        options: {},
        providerId: ModelProviderIdSchema.parse("native"),
      },
      title: "Wire App",
    });
    const turn = await api["commands.dispatch"]({
      content: [{ text: "Generate image", type: "text" }],
      delivery: "queue",
      idempotencyKey: randomUUID(),
      threadId: thread.id,
      type: "thread.sendMessage",
    });
    if (!turn.ok || turn.data.type !== "thread.sendMessage") {
      throw new Error("Failed to enqueue image turn");
    }
    await mkdir(join(expectedCanonicalAgentHome, "apps"), { recursive: true });
    await writeFile(
      join(expectedCanonicalAgentHome, "apps/hello.html"),
      "<!doctype html><html><body><h1>Wire App</h1></body></html>",
    );
    const grantRow = await waitUntil(
      async () =>
        personalHost.store.database
          .selectFrom("grants")
          .innerJoin("runs", "runs.id", "grants.runId")
          .select(["grants.id", "grants.bindingGeneration", "grants.runnerBootId", "grants.runId"])
          .where("runs.threadId", "=", thread.id)
          .where("runs.status", "=", "running")
          .where("grants.status", "=", "active")
          .executeTakeFirst(),
      "active Run grant",
    );
    const appScope: RunToolScope = {
      aud: "opensteer-run-tools",
      bindingGeneration: grantRow.bindingGeneration,
      environmentId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      grantId: grantRow.id,
      iat: Math.floor(Date.now() / 1000),
      iss: "opensteer-host",
      jti: randomUUID(),
      requestedBy: settings.ownerId,
      runId: grantRow.runId,
      runnerBootId: grantRow.runnerBootId,
      runnerId,
      threadId: thread.id,
    };
    const appService = new AppService({
      agentHome: async () => ({
        computerId: runnerId,
        path: join(root, "nonexistent-host-view-of-agent-home"),
      }),
      apps: new AppStore(personalHost.store.database),
      changed: () => undefined,
      dataDirectory: hostDataDir,
      files: unreachablePathFiles,
      tabs: { removeTabs: async () => [] },
      tokens: { reauthorize: async (claims) => claims },
      tunnels: {
        accept: () => undefined,
        close: () => undefined,
        connect: async () => {
          throw new Error("unused");
        },
        connection: () => undefined,
        start: async () => {
          throw new Error("unused");
        },
        stop: async () => undefined,
        sync: async () => {
          throw new Error("unused");
        },
      },
    });
    const publishedApp = await appService.publish(appScope, "publish-hello-html", {
      name: "Wire Hello",
      path: "apps/hello.html",
    });
    await rm(join(expectedCanonicalAgentHome, "apps/hello.html"));
    const viewed = await appService.view(settings.ownerId, publishedApp.appId, "light");
    const token = viewed.path.split("/").at(-2)!;
    const renderedHtml = await appService.content(publishedApp.appId, token, "light");
    expect(renderedHtml).toContain("Wire App");

    finishTurn.resolve();
    const runRow = await waitUntil(async () => {
      const row = await personalHost.store.database
        .selectFrom("runs")
        .select(["id", "status", "failure"])
        .where("threadId", "=", thread.id)
        .executeTakeFirst();
      if (row?.status === "failed") {
        throw new Error(`Image-generating Run failed: ${JSON.stringify(row.failure)}`);
      }
      return row?.status === "completed" ? row : null;
    }, "image-generating Run completion");
    const runId: RunId = runRow.id;
    const memoryPasses = await waitUntil(async () => {
      const rows = await personalHost.store.database
        .selectFrom("triggers")
        .select(["systemRole", "pauseReason"])
        .where("systemRole", "in", ["memory-light", "memory-nightly"])
        .orderBy("systemRole")
        .execute();
      return rows.length === 2 ? rows : null;
    }, "memory pass provisioning");
    expect(memoryPasses).toEqual([
      { systemRole: "memory-light", pauseReason: "Memory is off at your request." },
      { systemRole: "memory-nightly", pauseReason: "Memory is off at your request." },
    ]);

    // An unanswered publish cannot block the Run or the reads of its image.
    await publishRequested.promise;
    const publishedImageRow = await personalHost.store.database
      .selectFrom("toolOutputImages")
      .selectAll()
      .where("threadId", "=", thread.id)
      .executeTakeFirstOrThrow();
    const publishedSha = createHash("sha256").update(generatedPng).digest("hex");
    expect(publishedImageRow.path).toContain(`${publishedSha}.png`);
    const imageScope = { ownerId: settings.ownerId, threadId: thread.id };
    await expect(
      readThreadOutputImage(personalHost.store.database, {
        ...imageScope,
        imageId: publishedImageRow.id,
      }),
    ).resolves.toMatchObject({ runnerId });
    await expect(
      resolveThreadOutputImage(personalHost.store.database, {
        ...imageScope,
        path: publishedImageRow.path,
      }),
    ).resolves.toMatchObject({ runnerId });
    const openedPublished = await api["file.open"]({
      source: { imageId: publishedImageRow.id, kind: "transcript-image" },
      threadId: thread.id,
    });
    expect(openedPublished.ok).toBe(true);
    if (!openedPublished.ok) throw new Error("file.open failed");
    expect(openedPublished.data).toMatchObject({
      mediaType: "image/png",
      preview: { image: { status: "ok" }, kind: "image" },
      resource: { imageId: publishedImageRow.id, kind: "output-image" },
      status: "ok",
    });
    if (openedPublished.data.status !== "ok") throw new Error("Expected ok");
    const whilePublishing = await api["file.content"]({
      resource: openedPublished.data.resource,
      threadId: thread.id,
    });
    expect(whilePublishing.ok && Buffer.from(whilePublishing.data.bytes)).toEqual(generatedPng);

    answerPublish.resolve();
    finishPublishing.resolve();
    await published.promise;
    await rm(publishedImageRow.path, { force: true });
    expect(existsSync(publishedImageRow.path)).toBe(false);

    const contentPublished = await api["file.content"]({
      resource: openedPublished.data.resource,
      threadId: thread.id,
    });
    expect(contentPublished.ok).toBe(true);
    if (!contentPublished.ok) throw new Error("file.content failed");
    expect(Buffer.from(contentPublished.data.bytes)).toEqual(generatedPng);

    // 6b. Legacy output image present ONLY on Runner disk opens via Host-Runner wire!
    const legacyPng = await sharp({
      create: { background: "red", channels: 3, height: 10, width: 10 },
    })
      .png()
      .toBuffer();
    const legacySha = createHash("sha256").update(legacyPng).digest("hex");
    const legacyPath = join(runnerDataDir, "images", `${legacySha}.png`);
    await mkdir(join(runnerDataDir, "images"), { recursive: true });
    await writeFile(legacyPath, legacyPng);
    const legacyToolCallId = `call:legacy-${randomUUID()}`;
    const legacyImageId = `${legacyToolCallId}:0`;
    await personalHost.store.database.transaction().execute(async (tx) => {
      await tx
        .insertInto("toolCalls")
        .values({
          argumentDigest: null,
          arguments: null,
          attemptId: null,
          bindingGeneration: null,
          callId: "legacy-img",
          completedAt: new Date(),
          completionOrder: "99",
          id: legacyToolCallId,
          integration: null,
          isError: false,
          nodeId: null,
          origin: "host-computer",
          output: {
            images: [{ generated: true, mediaType: "image/png", path: legacyPath }],
            text: "legacy",
          },
          runId,
          startedAt: null,
          status: "completed",
          threadId: thread.id,
          tool: null,
        })
        .execute();
      await tx
        .insertInto("toolOutputImages")
        .values({
          completionOrder: "99",
          generated: true,
          id: legacyImageId,
          imageIndex: 0,
          mediaType: "image/png",
          nodeId: null,
          path: legacyPath,
          pathHash: createHash("sha256").update(legacyPath).digest(),
          threadId: thread.id,
          toolCallId: legacyToolCallId,
        })
        .execute();
    });
    const openedLegacy = await api["file.open"]({
      source: { imageId: legacyImageId, kind: "transcript-image" },
      threadId: thread.id,
    });
    expect(openedLegacy.ok).toBe(true);
    if (!openedLegacy.ok || openedLegacy.data.status !== "ok")
      throw new Error("Expected legacy output image to open over wire");
    const legacyContent = await api["file.content"]({
      resource: openedLegacy.data.resource,
      threadId: thread.id,
    });
    expect(legacyContent.ok).toBe(true);
    if (!legacyContent.ok) throw new Error("Expected legacy content");
    expect(Buffer.from(legacyContent.data.bytes)).toEqual(legacyPng);

    runnerStop.abort();
    await runnerTask;
    const oldMain = await connectPrimary(
      port,
      RunnerDescriptorSchema.parse({
        runnerId,
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [runEventsCapability, "agent-home-settings-v1"],
        name: "Older hosting Device",
        runnerKind: "main",
        runtimeVersion: "integration",
        modules: {
          agents: {
            environmentIds: [environmentId],
            harnessDrivers: [],
            maxConcurrentRuns: 1,
            providerStateModes: ["isolated"],
          },
        },
      }),
      { privateKey: identity.privateKey },
    );
    try {
      const update = {
        ok: false,
        error: { message: expect.stringContaining("Update the hosting computer") },
      };
      await expect(
        api["file.open"]({
          source: { kind: "path", path: join(expectedCanonicalAgentHome, "hello.txt") },
          threadId: thread.id,
        }),
      ).resolves.toMatchObject(update);
      await expect(
        api["file.open"]({
          source: { kind: "transcript-image", imageId: legacyImageId },
          threadId: thread.id,
        }),
      ).resolves.toMatchObject(update);
      await expect(
        api["asset.urls"]({
          assets: [
            { source: { kind: "transcript-image", imageId: legacyImageId }, variant: "preview" },
            {
              source: { kind: "transcript-image", imageId: publishedImageRow.id },
              variant: "preview",
            },
          ],
          threadId: thread.id,
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: {
          assets: [
            { status: "unavailable", reason: "unsupported", updateRequired: true },
            { status: "ok" },
          ],
        },
      });
      await expect(hostFiles.download(helloEntry!.key)).rejects.toMatchObject({
        reason: "unsupported-runner",
      });
      await expect(
        exportPluginSource(hostFiles, "legacy-export", [], async () => undefined),
      ).rejects.toMatchObject({ reason: "unsupported-runner" });
      await expect(
        withFolderPluginPackage({ directory: "my-plugin", files: hostFiles, install: vi.fn() }),
      ).rejects.toMatchObject({ reason: "unsupported-runner" });
    } finally {
      oldMain.socket.close();
      await closed(oldMain.socket);
    }

    unreachablePathFiles.close();
  } finally {
    answerPublish.resolve();
    finishPublishing.resolve();
    publicationRequest.mockRestore();
    publication.mockRestore();
    reporting.mockRestore();
    finishTurn.resolve();
    runnerStop.abort(new Error("test done"));
    if (runnerTask) {
      await withTimeout(runnerTask, 5_000, {
        timeoutError: () => new Error("Runner did not stop in time"),
      }).catch(() => undefined);
    }
    await runner?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await database.drop();
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
