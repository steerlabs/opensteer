import { IntegrationToolHandlers } from "./handlers/integrations.js";
import {
  IntegrationPlatformStore,
  type IntegrationRequester,
  type IntegrationDiscoveryRequester,
} from "@opensteer/database";
import { AppStore, TriggerStore } from "@opensteer/database";
import { TriggerService } from "../triggers/trigger-service.js";
import { TriggerToolHandlers } from "./handlers/triggers.js";
import { ThreadService } from "../threads/thread-service.js";
import { CommandService, KeyedAdmissionQueue, RealtimeHub } from "@opensteer/orchestration";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { agentTools, opensteerAgentSkillsFor } from "@opensteer/agent-tools";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import {
  createId,
  ModelSelectionSchema,
  ThreadIdSchema,
  MessageIdSchema,
  threadReachScope,
  type ThreadAccessMode,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { AgentConnectionStore, type OpensteerStore } from "@opensteer/database";
import {
  describeStore,
  testModelSelection,
  testReadyHarnessCatalog,
  pendingEvent,
} from "@opensteer/database/test-support/store";
import { createTestWorkspace } from "@opensteer/database/test-support/workspace";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, expect, vi } from "vitest";
import { AgentCallerResolver } from "./agent-caller.js";
import {
  ConnectionAuthenticator,
  connectionCredentialPrefix,
  credentialHash,
} from "./connections/connection-authenticator.js";
import { mcpResourceMetadataPath, mcpResourcePath } from "./connections/connection-oauth.js";
import { agentToolHandlers } from "./handlers/index.js";
import { ProductToolHandlers } from "./handlers/product.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import type { KnowledgeManager } from "../knowledge/knowledge-manager.js";
import { knowledgeForCaller } from "../knowledge/knowledge-eligibility.js";

const servers: Server[] = [];
const clients: Client[] = [];
const services: OpensteerMcpService[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await withTimeout(
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
      2000,
      { timeoutError: () => new Error("MCP test server did not close") },
    );
  }
});

/** The real Host spine for connected agents: the store, resolver and MCP service. */
async function serveMcp(
  store: OpensteerStore,
  options: {
    readonly connected?: () => boolean;
    readonly runScope?: import("../agents/run-tool-tokens.js").RunToolScope;
    readonly runScopes?: Readonly<
      Record<string, import("../agents/run-tool-tokens.js").RunToolScope>
    >;
    readonly knowledge?: {
      readonly advertised: boolean;
      readonly owner: import("@opensteer/core").UserId;
      readonly sql: KnowledgeManager["sql"];
    };
    readonly notify?: { current?: () => void };
    readonly subscribed?: () => void;
    readonly unsubscribed?: () => void;
    readonly publish?: { current?: (event: import("@opensteer/core").AgentEvent) => void };
  } = {},
) {
  const unavailable = new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error("Unexpected tool");
      },
    },
  );
  const realtime = new RealtimeHub({ store });
  if (options.publish) options.publish.current = (event) => realtime.publish(event);
  if (options.notify)
    options.notify.current = () => realtime.broadcast({ type: "host.tasks-changed" });
  const observations = {
    observe: (wake: Parameters<RealtimeHub["observe"]>[0]) => {
      options.subscribed?.();
      const detach = realtime.observe(wake);
      return () => {
        detach();
        options.unsubscribed?.();
      };
    },
  };
  const commands = new CommandService({
    store,
    admission: new KeyedAdmissionQueue({
      maxInFlight: 8,
      maxQueuedBytes: 1024 * 1024,
      maxQueuedCommands: 100,
    }),
    onExecutionQueued: () => {},
    onWorkspaceEvent: (event) => realtime.publish(event),
  });
  const threads = new ThreadService({
    store,
    commands,
    runners: {
      canRunHarness: () => true,
      isAvailable: () => true,
      harnessAccessModes: () => undefined,
      identityForEnvironment: () => undefined,
      attachmentInputFailure: () => null,
    },
    placeContext: unavailable as never,
    browser: unavailable as never,
  });
  const product = new ProductToolHandlers({
    store,
    threads,
    realtime: observations,
    commands,
    browser: {
      readablePlaces: async (_owner: unknown, references: readonly unknown[]) => [...references],
    },
    isEnvironmentConnected: options.connected ?? (() => true),
    canRunHarness: () => true,
    harnessAccessModes: () => ThreadAccessModeSchema.options,
    environmentWorkspaceBackings: () => ["local-directory"],
  } as unknown as ConstructorParameters<typeof ProductToolHandlers>[0]);
  let service!: OpensteerMcpService;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const token = request.headers.authorization?.slice(7) ?? "";
      // As the Host route does once the connection routes accepted the credential.
      await service.handle(
        request,
        response,
        text ? JSON.parse(text) : undefined,
        token,
        token.startsWith(connectionCredentialPrefix) ? url.origin : undefined,
      );
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error("MCP test failed")),
    );
  });
  servers.push(server);
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    2000,
    { timeoutError: () => new Error("MCP test server did not listen") },
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP test did not listen");
  const url = new URL(`http://127.0.0.1:${address.port}${mcpResourcePath}`);
  const integrationStore = new IntegrationPlatformStore(store.database);
  const integrations = new IntegrationToolHandlers({
    definitions: [],
    getWorkspaceForOwner: store.getWorkspaceForOwner.bind(store),
    onWorkspaceEvent: (event) => realtime.publish(event),
    platform: {
      store: integrationStore,
      listDiscoveryInventory: (input: IntegrationDiscoveryRequester) =>
        integrationStore.listDiscoveryInventory({ ...input, providerAuthorizations: {} }),
      listCallableTools: (input: IntegrationRequester) =>
        integrationStore.listCallableTools({ ...input, providerAuthorizations: {} }),
      computerAppApprovals: { computerUseInventory: async () => ({ machines: [], phones: [] }) },
    } as unknown as ConstructorParameters<typeof IntegrationToolHandlers>[0]["platform"],
  });
  service = new OpensteerMcpService({
    realtime,
    callers: new AgentCallerResolver({
      store,
      runs: {
        authenticate: async (token) => {
          if (token === "test-run" && options.runScope) return options.runScope;
          const scope = options.runScopes?.[token];
          if (scope) return scope;
          throw new Error("Not a Run");
        },
      },
      connections: new ConnectionAuthenticator(new AgentConnectionStore(store.database)),
    }),
    handlers: agentToolHandlers({
      administration: new Proxy(
        {},
        {
          get: () => {
            throw new Error("Unexpected administration tool");
          },
        },
      ) as never,
      product,
      integrations,
      triggers: new TriggerToolHandlers(
        new TriggerService({
          store: new TriggerStore(store.database),
          threads: store,
        } as unknown as ConstructorParameters<typeof TriggerService>[0]),
      ),
      apps: {
        listForCaller: async (scope: {
          requestedBy: import("@opensteer/core").UserId;
          reach: import("@opensteer/core").ThreadReachScope;
        }) => ({
          apps: await new AppStore(store.database).listReachable({
            userId: scope.requestedBy,
            reach: scope.reach,
          }),
        }),
      } as never,
      pluginInstall: async () => {
        throw new Error("Unexpected install");
      },
      ...(options.knowledge ? { knowledge: { sql: options.knowledge.sql } } : {}),
    }),
    ...(options.knowledge
      ? {
          knowledgeFor: knowledgeForCaller({
            owner: async () => options.knowledge?.owner ?? null,
            agents: () => (options.knowledge?.advertised ? { knowledgeSkill: 1 } : {}),
          }),
        }
      : {}),
    store,
    publicUrl: options.runScope || options.runScopes ? url : new URL("http://runtime.invalid"),
  });
  services.push(service);
  return url;
}

async function connection(
  store: OpensteerStore,
  url: URL,
  input: {
    readonly userId: Parameters<AgentConnectionStore["create"]>[0]["userId"];
    readonly accessMode: ThreadAccessMode;
    readonly reach: Parameters<AgentConnectionStore["create"]>[0]["reach"];
  },
) {
  const connections = new AgentConnectionStore(store.database);
  const record = await connections.create({
    ...input,
    label: "Test agent",
    clientName: "Test agent",
    resource: url.href,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
  });
  const token = `${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`;
  expect(await connections.activate(record.id, credentialHash(token))).toBe(true);
  const client = new Client({ name: "connected-agent", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
    { timeout: 5000 },
  );
  return {
    client,
    token,
    id: record.id,
    revoke: () => connections.revoke(input.userId, record.id),
  };
}

function errorText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBe(true);
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

describeStore("connected agents on the Opensteer MCP", (it) => {
  it("lists only connection tools and refuses a revoked connection on its open session", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-tools");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "user" },
    });
    const listed = (await agent.client.listTools()).tools.map(({ name }) => name);
    expect(listed).toEqual(
      agentTools.filter((tool) => tool.callers.includes("connection")).map(({ name }) => name),
    );
    expect(listed).toContain("thread_update");

    const read = await agent.client.callTool({
      name: "thread_read",
      arguments: { threadId: f.thread.id },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ thread: { id: f.thread.id } });

    await agent.revoke();
    // The open session's next request is refused before any tool runs.
    await expect(
      agent.client.callTool({ name: "thread_read", arguments: { threadId: f.thread.id } }),
    ).rejects.toThrow("Agent tools authorization is invalid or expired");
  });

  it("keeps a Workspace connection inside it and an approval-required one out of full-access changes", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-reach");
    const { thread: fullAccess } = await storeFixture.store.createThread({
      accessMode: "full-access",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "connection-full-access",
      modelSelection: testModelSelection,
      title: "Full access",
      workspaceId: f.workspace.id,
    });
    const project = await createTestWorkspace(storeFixture.store, {
      createdBy: f.userId,
      name: "Client",
      kind: "project",
      idempotencyKey: "connection-project",
      status: "ready",
      backing: {
        kind: "local-directory",
        ownerEnvironmentId: f.environmentId,
        storageAuthorityId: createId("storageAuthority"),
        bindingId: createId("workspaceBinding"),
        generation: 1,
      },
    });
    const url = await serveMcp(storeFixture.store);

    const scoped = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "workspace", workspaceId: project.id },
    });
    expect(
      errorText(
        await scoped.client.callTool({
          name: "thread_read",
          arguments: { threadId: f.thread.id },
        }),
      ),
    ).toBe("Target Thread is outside the caller's reach");
    const listed = await scoped.client.callTool({ name: "thread_list", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.structuredContent)).not.toContain(f.thread.id);
    expect(
      errorText(
        await scoped.client.callTool({
          name: "thread_list",
          arguments: { workspaceId: f.workspace.id },
        }),
      ),
    ).toBe("Caller can list Threads only in its Workspace");

    const cautious = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      reach: { kind: "user" },
    });
    expect(
      errorText(
        await cautious.client.callTool({
          name: "thread_interrupt",
          arguments: { threadId: fullAccess.id },
        }),
      ),
    ).toContain("stronger access mode");
    expect(
      errorText(
        await cautious.client.callTool({ name: "project_create", arguments: { name: "Sneaky" } }),
      ),
    ).toContain("not found");
    expect((await storeFixture.store.getThreadForOwner(fullAccess.id, f.userId))?.title).toBe(
      "Full access",
    );
  });

  it("delegates independent connection work within its approved Workspace and preserves connection authorship", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-delegate");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      reach: { kind: "workspace", workspaceId: f.workspace.id },
    });
    const result = await agent.client.callTool({
      name: "delegate_task",
      arguments: {
        workspaceId: f.workspace.id,

        harnessInstanceId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        title: "External work",
        task: "Inspect the project",
        operationKey: "external-create",
      },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      assignmentId: null,
      parentThreadId: null,
      workspaceId: f.workspace.id,
      status: "open",
    });
    const threadId = ThreadIdSchema.parse(
      (result.structuredContent as { threadId: string }).threadId,
    );
    expect(
      await storeFixture.database
        .selectFrom("threadInputs")
        .select("authoritySource")
        .where("threadId", "=", threadId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ authoritySource: { kind: "connection", connectionId: agent.id } });
    expect(
      await storeFixture.database
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", threadId)
        .execute(),
    ).toEqual([]);
    expect(
      (await storeFixture.database.introspection.getTables()).map((t) => t.name),
    ).not.toContain("agent_tool_operations");
    const replay = await agent.client.callTool({
      name: "delegate_task",
      arguments: {
        workspaceId: f.workspace.id,

        harnessInstanceId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        title: "External work",
        task: "Inspect the project",
        operationKey: "external-create",
      },
    });
    expect(replay.structuredContent).toEqual(result.structuredContent);
    const conflicting = await agent.client.callTool({
      name: "delegate_task",
      arguments: {
        workspaceId: f.workspace.id,

        harnessInstanceId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        title: "External work",
        task: "Different",
        operationKey: "external-create",
      },
    });
    expect(errorText(conflicting)).toMatch(/idempotency|different input/i);
    const message = await agent.client.callTool({
      name: "thread_send",
      arguments: {
        threadId,
        delivery: "report",
        message: "A connection report",
        operationKey: "report-retry",
      },
    });
    expect(message.isError).not.toBe(true);
    const messageId = (message.structuredContent as { messageId: string }).messageId;
    expect(
      await storeFixture.database
        .selectFrom("messages")
        .select("author")
        .where("id", "=", MessageIdSchema.parse(messageId))
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ author: { kind: "connection", connectionId: agent.id } });
    const messageReplay = await agent.client.callTool({
      name: "thread_send",
      arguments: {
        threadId,
        delivery: "report",
        message: "A connection report",
        operationKey: "report-retry",
      },
    });
    expect(messageReplay.structuredContent).toEqual(message.structuredContent);
    const messageConflict = await agent.client.callTool({
      name: "thread_send",
      arguments: { threadId, delivery: "report", message: "Changed", operationKey: "report-retry" },
    });
    expect(errorText(messageConflict)).toMatch(/idempotency|different input/i);
    expect(
      await storeFixture.database
        .selectFrom("messages")
        .select("id")
        .where("threadId", "=", threadId)
        .execute(),
    ).toHaveLength(2);
    const stopped = await agent.client.callTool({
      name: "thread_interrupt",
      arguments: { threadId, operationKey: "stop-independent" },
    });
    expect(stopped.isError, JSON.stringify(stopped.content)).not.toBe(true);
    expect(stopped.structuredContent).toMatchObject({
      interruptedRunId: (result.structuredContent as { runId: string }).runId,
    });
    const stopReplay = await agent.client.callTool({
      name: "thread_interrupt",
      arguments: { threadId, operationKey: "stop-independent" },
    });
    expect(stopReplay.structuredContent).toEqual(stopped.structuredContent);
    const other = await createTestWorkspace(storeFixture.store, {
      createdBy: f.userId,
      name: "Outside",
      kind: "project",
      status: "ready",
      idempotencyKey: "outside-connection",
      backing: {
        kind: "local-directory",
        ownerEnvironmentId: f.environmentId,
        storageAuthorityId: createId("storageAuthority"),
        bindingId: createId("workspaceBinding"),
        generation: 1,
      },
    });
    expect(
      errorText(
        await agent.client.callTool({
          name: "delegate_task",
          arguments: {
            workspaceId: other.id,
            task: "Escalate",

            harnessInstanceId: f.harnessInstance.id,
            model: { ...testModelSelection, options: {} },
          },
        }),
      ),
    ).toContain("outside the caller's reach");
  });

  it("offers knowledge to a connected agent's task exactly where it offers Main's memory", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("knowledge-reach");
    const { store } = storeFixture;
    const delegateUrl = await serveMcp(store);
    const start = async (reach: "user" | "workspace") => {
      const agent = await connection(store, delegateUrl, {
        userId: f.userId,
        accessMode: "full-access",
        reach:
          reach === "user" ? { kind: "user" } : { kind: "workspace", workspaceId: f.workspace.id },
      });
      const delegated = await agent.client.callTool({
        name: "delegate_task",
        arguments: {
          workspaceId: f.workspace.id,

          harnessInstanceId: f.harnessInstance.id,
          model: { ...testModelSelection, options: {} },
          title: `Connected work with ${reach} reach`,
          task: "Work in Main",
          operationKey: `knowledge-reach-${reach}`,
        },
      });
      expect(delegated.isError, JSON.stringify(delegated.content)).not.toBe(true);
      return ThreadIdSchema.parse((delegated.structuredContent as { threadId: string }).threadId);
    };
    const wide = await start("user");
    const narrow = await start("workspace");

    const scope = (threadId: string) => ({
      aud: "opensteer-run-tools" as const,
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
      iss: "opensteer-host" as const,
      jti: `knowledge-${threadId}`,
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      membershipGeneration: 1,
      requestedBy: f.userId,
      runId: f.run.id,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      threadId: ThreadIdSchema.parse(threadId),
      workspaceId: f.workspace.id,
    });
    const sql = vi.fn(async () => ({ source: { kind: "knowledge", trust: "data" } }) as never);
    const threads = [f.thread.id, wide, narrow];
    const runScopes = Object.fromEntries(threads.map((threadId) => [threadId, scope(threadId)]));
    const sees = async (url: URL, threadId: string) => {
      const client = new Client({ name: `run-${threadId}`, version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${threadId}` } },
        }) as unknown as Transport,
        { timeout: 5000 },
      );
      const listed = (await client.listTools()).tools.some(({ name }) => name === "sql");
      sql.mockClear();
      const called = await client.callTool({ name: "sql", arguments: {} });
      return { listed, dispatched: sql.mock.calls.length === 1, refused: called.isError === true };
    };
    const memory = async (threadId: typeof wide) => {
      const thread = await store.getThreadForOwner(threadId, f.userId);
      return opensteerAgentSkillsFor(threadReachScope(thread!).kind).includes("opensteer:memory");
    };
    expect([await memory(wide), await memory(narrow)]).toEqual([true, false]);
    const served = await serveMcp(store, {
      runScopes,
      knowledge: { advertised: true, owner: f.userId, sql },
    });
    for (const threadId of threads) {
      const offered = await memory(threadId);
      expect(await sees(served, threadId), threadId).toEqual({
        listed: offered,
        dispatched: offered,
        refused: !offered,
      });
    }
    for (const knowledge of [
      { advertised: false, owner: f.userId, sql },
      { advertised: true, owner: createId("user"), sql },
    ]) {
      const refusing = await serveMcp(store, { runScopes, knowledge });
      expect(await sees(refusing, wide)).toEqual({
        listed: false,
        dispatched: false,
        refused: true,
      });
    }
  });

  it("returns a connection's original task on retry after the person's defaults change", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-delegate-defaults");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      reach: { kind: "workspace", workspaceId: f.workspace.id },
    });
    const catalog = testReadyHarnessCatalog(f.harnessInstance.id);
    await storeFixture.store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          ...catalog,
          models: [
            ...(catalog.status === "ready" ? catalog.models : []),
            {
              displayName: "GPT-6 Sol",
              isDefault: false,
              modelId: "gpt-6-sol",
              options: [],
              providerId: testModelSelection.providerId,
            },
          ],
        }),
      ],
      environmentId: f.environmentId,
      expectedRevisions: new Map([[f.harnessInstance.id, f.harnessInstance.runtimeRevision]]),
    });
    const remember = (modelId: string) =>
      storeFixture.store.rememberExecutionChoice(f.userId, {
        selection: {
          environmentId: f.environmentId,
          harnessInstanceId: f.harnessInstance.id,
          modelSelection: ModelSelectionSchema.parse({
            ...testModelSelection,
            modelId,
            options: {},
          }),
        },
      });
    await remember("gpt-5.6-sol");
    // The model is left to the person's remembered choice.
    const call = (title: string) =>
      agent.client.callTool({
        name: "delegate_task",
        arguments: {
          workspaceId: f.workspace.id,

          harnessInstanceId: f.harnessInstance.id,
          title,
          task: "Inspect the project",
          operationKey: "defaults-retry",
        },
      });
    const first = await call("External work");
    expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
    await remember("gpt-6-sol");
    const retry = await call("External work");
    expect(retry.isError, JSON.stringify(retry.content)).not.toBe(true);
    expect(retry.structuredContent).toEqual(first.structuredContent);
    expect(errorText(await call("Renamed work"))).toMatch(/idempotency|different input/i);
  });

  it("starts a task named by no account or history only on an account the person left on", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-delegate-excluded");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      reach: { kind: "workspace", workspaceId: f.workspace.id },
    });
    const second = await storeFixture.store.createHarnessInstance({
      config: {},
      driverKind: f.harnessInstance.driverKind,
      environmentId: f.environmentId,
      name: "Second account",
      stateKind: "isolated",
    });
    await storeFixture.store.recordHarnessCatalogs({
      catalogs: [testReadyHarnessCatalog(f.harnessInstance.id), testReadyHarnessCatalog(second.id)],
      environmentId: f.environmentId,
      expectedRevisions: new Map([
        [f.harnessInstance.id, f.harnessInstance.runtimeRevision],
        [second.id, second.runtimeRevision],
      ]),
    });
    const exclude = (...excludedAccounts: (typeof second.id)[]) =>
      storeFixture.store.setAutomaticModelConfig(f.userId, { roles: {}, excludedAccounts });
    const call = (operationKey: string) =>
      agent.client.callTool({
        name: "delegate_task",
        arguments: {
          workspaceId: f.workspace.id,

          title: "Automatic work",
          task: "Inspect the project",
          operationKey,
        },
      });
    expect(f.harnessInstance.isDefault).toBe(true);
    await exclude(f.harnessInstance.id, second.id);
    expect(errorText(await call("all-excluded"))).toContain(
      "Choose harnessInstanceId for the new task",
    );
    await exclude(f.harnessInstance.id);
    const started = await call("default-excluded");
    expect(started.isError, JSON.stringify(started.content)).not.toBe(true);
    const threadId = ThreadIdSchema.parse(
      (started.structuredContent as { threadId: string }).threadId,
    );
    expect(await storeFixture.store.getThreadForOwner(threadId, f.userId)).toMatchObject({
      harnessInstanceId: second.id,
    });
  });

  it("refuses Workspace connection activation of Main queues inside the transaction", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("queue-consent");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "workspace", workspaceId: f.workspace.id },
    });
    const authority = {
      kind: "connection" as const,
      connectionId: agent.id,
      userId: f.userId,
      accessMode: "full-access" as const,
      reach: { kind: "workspace" as const, workspaceId: f.workspace.id },
    };
    const queued = await storeFixture.store.enqueueThreadInput({
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "human-queued",
      source: { kind: "human" },
      policy: "queue",
      content: [{ type: "text", text: "Human work" }],
    });
    await expect(
      storeFixture.store.steerThreadInput({
        authority,
        threadId: f.thread.id,
        requestedBy: f.userId,
        idempotencyKey: "scoped-steer",
        messageId: queued.message.id,
        expectedRunId: f.run.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      storeFixture.store.resumeThreadInputQueue({
        authority,
        threadId: f.thread.id,
        requestedBy: f.userId,
        idempotencyKey: "scoped-resume",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (
        await storeFixture.store.getThreadInputQueue({
          threadId: f.thread.id,
          requestedBy: f.userId,
        })
      ).items,
    ).toHaveLength(1);
  });

  it("lets a connection inspect and update a Thread through shared domain commands", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-read-write");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "user" },
    });
    for (const name of [
      "environment_list",
      "pending_request",
      "trigger_read",
      "app_list",
      "integration_search",
    ]) {
      const result = await agent.client.callTool({
        name,
        arguments:
          name === "trigger_read"
            ? { action: "list" }
            : name === "integration_search"
              ? { query: "anything" }
              : {},
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    }
    const described = await agent.client.callTool({
      name: "integration_describe",
      arguments: { operation: "missing.operation" },
    });
    expect(errorText(described)).toBe("Integration operation is no longer available; search again");
    for (const arguments_ of [
      { action: "rename", title: "Renamed" },
      { action: "done" },
      { action: "reopen" },
    ]) {
      const result = await agent.client.callTool({
        name: "thread_update",
        arguments: { threadId: f.thread.id, ...arguments_ },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    }
    expect(await storeFixture.store.getThreadForOwner(f.thread.id, f.userId)).toMatchObject({
      title: "Renamed",
      doneAt: null,
    });
  });

  it("uses the client's model error and enforces the connection ceiling for configure and interrupt", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.createRunFixture("configure-connection");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "user" },
    });
    const unavailableModel = { providerId: "openai", modelId: "not-offered", options: {} };
    const result = await agent.client.callTool({
      name: "thread_configure",
      arguments: { threadId: f.thread.id, modelSelection: unavailableModel },
    });
    expect(errorText(result)).toBe(
      "The selected model is not available in this AI engine on this Runner",
    );
    const read = await agent.client.callTool({
      name: "thread_read",
      arguments: { threadId: f.thread.id },
    });
    expect(read.structuredContent).toMatchObject({
      thread: {
        id: f.thread.id,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        modelSelection: testModelSelection,
      },
    });
    const changed = await agent.client.callTool({
      name: "thread_configure",
      arguments: {
        threadId: f.thread.id,
        modelSelection: { ...testModelSelection, options: {} },
      },
    });
    expect(changed.isError, JSON.stringify(changed.content)).not.toBe(true);
    expect(changed.structuredContent).toMatchObject({
      modelSelection: { ...testModelSelection, options: {} },
    });
    expect((await storeFixture.store.getThreadForOwner(f.thread.id, f.userId))?.accessMode).toBe(
      f.thread.accessMode,
    );
    await storeFixture.store.updateThreadAccessMode({
      threadId: f.thread.id,
      requestedBy: f.userId,
      accessMode: "full-access",
    });
    const cautious = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      reach: { kind: "user" },
    });
    for (const name of ["thread_configure", "thread_interrupt"]) {
      expect(
        errorText(
          await cautious.client.callTool({
            name,
            arguments: {
              threadId: f.thread.id,

              ...(name === "thread_configure" ? { modelSelection: testModelSelection } : {}),
            },
          }),
        ),
      ).toContain("stronger access mode");
    }
  });

  it("cancels, reorders, promotes and resumes the same durable queue through MCP", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-queue");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "user" },
    });
    const send = async (message: string) => {
      const result = await agent.client.callTool({
        name: "thread_send",
        arguments: { threadId: f.thread.id, delivery: "queue", message },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return (result.structuredContent as { messageId: string }).messageId;
    };
    const first = await send("First");
    const second = await send("Second");
    const other = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "user" },
    });
    expect(
      errorText(
        await other.client.callTool({
          name: "thread_queue",
          arguments: { threadId: f.thread.id, action: "cancel", messageId: first },
        }),
      ),
    ).toBe("Only your own queued messages can be cancelled");
    const queue = async (action: string, args = {}) => {
      const result = await agent.client.callTool({
        name: "thread_queue",
        arguments: { threadId: f.thread.id, action, ...args },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result.structuredContent;
    };
    expect(await queue("move", { messageId: second, beforeMessageId: first })).toMatchObject({
      items: [
        {
          messageId: second,
          preview: "Second",
          truncated: false,
          author: { kind: "connection", connectionId: agent.id },
        },
        { messageId: first },
      ],
    });
    expect(await queue("cancel", { messageId: first })).toMatchObject({
      items: [{ messageId: second }],
    });
    expect(await queue("steer", { messageId: second, expectedRunId: f.run.id })).toMatchObject({
      items: [],
    });
    const long = await send("x".repeat(1000));
    expect(await queue("list")).toMatchObject({
      items: [{ messageId: long, preview: "x".repeat(500), truncated: true }],
    });
    await queue("cancel", { messageId: long });
    const stopped = await agent.client.callTool({
      name: "thread_interrupt",
      arguments: { threadId: f.thread.id, operationKey: "stop-queue" },
    });
    expect(stopped.isError, JSON.stringify(stopped.content)).not.toBe(true);
    expect(stopped.structuredContent).toMatchObject({ interruptedRunId: f.run.id });
    expect(await queue("list")).toMatchObject({ paused: true });
    expect(await queue("resume")).toMatchObject({ paused: false });
  });

  it("waits on committed completion events, reports offline, times out, and releases disconnected waits", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-wait");
    const subscribed = vi.fn();
    const unsubscribed = vi.fn();
    let connected = true;
    const publish: { current?: (event: import("@opensteer/core").AgentEvent) => void } = {};
    const url = await serveMcp(storeFixture.store, {
      subscribed,
      unsubscribed,
      connected: () => connected,
      publish,
    });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      reach: { kind: "user" },
    });
    const timed = await agent.client.callTool({
      name: "thread_wait",
      arguments: { threadId: f.thread.id, timeoutMs: 10 },
    });
    expect(timed.isError, JSON.stringify(timed.content)).not.toBe(true);
    expect(timed.structuredContent).toMatchObject({ status: "timed_out", items: [] });
    connected = false;
    expect(
      (await agent.client.callTool({ name: "thread_wait", arguments: { threadId: f.thread.id } }))
        .structuredContent,
    ).toMatchObject({ status: "offline" });
    connected = true;
    const controller = new AbortController();
    const disconnected = fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${agent.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": "detached-wait",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 81,
        method: "tools/call",
        params: { name: "thread_wait", arguments: { threadId: f.thread.id } },
      }),
    });
    const rejected = expect(disconnected).rejects.toThrow();
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledTimes(3), { timeout: 2000 });
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(
      (
        await storeFixture.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", f.run.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("running");
    const waiting = agent.client.callTool({
      name: "thread_wait",
      arguments: { threadId: f.thread.id },
    });
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledTimes(4), { timeout: 2000 });
    const terminal = await storeFixture.store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: { status: "completed" },
        environmentId: f.environmentId,
        ordinal: 1,
        runId: f.run.id,
        threadId: f.thread.id,
        type: "run.completed",
        workspaceId: f.workspace.id,
      }),
    });
    if (terminal.event) publish.current?.(terminal.event);
    for (const event of terminal.compensatingEvents) publish.current?.(event);
    expect((await waiting).structuredContent).toMatchObject({
      status: "settled",
      run: { id: f.run.id, status: "completed" },
    });
    expect(unsubscribed).toHaveBeenCalledTimes(4);
  });

  it("returns a pending Request without granting approval authority", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("connection-wait-request");
    const project = await storeFixture.createProjectWorkspace(f.userId, "wait-request-target");
    const subscribed = vi.fn();
    const publish: { current?: (event: import("@opensteer/core").AgentEvent) => void } = {};
    const url = await serveMcp(storeFixture.store, { subscribed, publish });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      reach: { kind: "user" },
    });
    const waiting = agent.client.callTool({
      name: "thread_wait",
      arguments: { threadId: f.thread.id },
    });
    const observed = waiting.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(
      () =>
        expect(
          subscribed,
          "Thread wait never subscribed for the pending Request",
        ).toHaveBeenCalledOnce(),
      { timeout: 1000 },
    );
    const created = await storeFixture.store.requests.create({
      callId: "pending-wait",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: f.run.id,
      originatingThreadId: f.thread.id,
      originatingWorkspaceId: f.workspace.id,
      targetWorkspaceId: project.id,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Choose a browser",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Browser access",
        subject: { kind: "workspace", id: project.id },
      },
    });
    for (const event of created.events) publish.current?.(event);
    const result = await withTimeout(observed, 5000, {
      timeoutError: () => new Error("Pending Request never ended its Thread wait"),
    });
    if ("error" in result) throw result.error;
    expect(result.value.structuredContent).toMatchObject({
      pendingRequest: { id: created.request.id, kind: "browser.access" },
    });
    expect((await agent.client.listTools()).tools.map((t) => t.name)).not.toContain(
      "request_resolve",
    );
    expect((await storeFixture.store.requests.get(created.request.id))?.status).toBe("pending");
  });

  it("returns only newly published messages after the requested message", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-wait-message");
    const subscribed = vi.fn();
    const url = await serveMcp(storeFixture.store, { subscribed });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "user" },
    });
    const send = (message: string) =>
      agent.client.callTool({
        name: "thread_send",
        arguments: { threadId: f.thread.id, delivery: "report", message },
      });
    const anchor = await send("Already seen");
    const afterMessageId = (anchor.structuredContent as { messageId: string }).messageId;
    const waiting = agent.client.callTool({
      name: "thread_wait",
      arguments: { threadId: f.thread.id, afterMessageId },
    });
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce(), { timeout: 2000 });
    const next = await send("New context");
    const result = await waiting;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "running",
      items: [
        {
          itemId: (next.structuredContent as { messageId: string }).messageId,
          author: { kind: "connection", connectionId: agent.id },
        },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(afterMessageId);
  });

  it("commits a self-interrupt command before announcing grant revocation and returns it over MCP", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("self-interrupt");
    const url = await serveMcp(storeFixture.store, {
      runScope: {
        aud: "opensteer-run-tools",
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        iss: "opensteer-host",
        jti: "self-interrupt",
        bindingGeneration: f.bindingGeneration,
        environmentId: f.environmentId,
        membershipGeneration: 1,
        requestedBy: f.userId,
        runId: f.run.id,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
        threadId: f.thread.id,
        workspaceId: f.workspace.id,
      },
    });
    const client = new Client({ name: "self", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer test-run" } },
      }) as unknown as Transport,
      { timeout: 5000 },
    );
    let detach = () => {};
    const revoked = new Promise<unknown>((resolve, reject) => {
      detach = storeFixture.store.onRunGrantsRevoked(() => {
        void storeFixture.database
          .selectFrom("commands")
          .select("payload")
          .where("threadId", "=", f.thread.id)
          .where("type", "=", "run.interrupt")
          .executeTakeFirstOrThrow()
          .then((row) => resolve(row.payload), reject);
      });
    });
    try {
      const result = await client.callTool({
        name: "thread_interrupt",
        arguments: { operationKey: "self-stop" },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ interruptedRunId: f.run.id });
      expect(
        await withTimeout(revoked, 2000, {
          timeoutError: () => new Error("Self interrupt never revoked its grant"),
        }),
      ).toMatchObject({ runId: f.run.id, threadId: f.thread.id });
    } finally {
      detach();
    }
  });

  it("ends a revoked connection's pending wait without stopping its Run", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-revoke-wait");
    const subscribed = vi.fn();
    const unsubscribed = vi.fn();
    const notify: { current?: () => void } = {};
    const url = await serveMcp(storeFixture.store, { subscribed, unsubscribed, notify });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "user" },
    });
    const waiting = agent.client.callTool({
      name: "thread_wait",
      arguments: { threadId: f.thread.id },
    });
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce(), { timeout: 2000 });
    await new AgentConnectionStore(storeFixture.database).revoke(createId("user"), agent.id);
    expect(unsubscribed).not.toHaveBeenCalled();
    // Revocation closes the session, unless a Thread change wakes the wait first:
    // its recheck then answers with an error. Either way the wait fails.
    const ended = waiting.then(
      (result) => expect(result.isError).toBe(true),
      (error: unknown) => expect(error).toBeInstanceOf(Error),
    );
    await agent.revoke();
    notify.current?.();
    await ended;
    await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(
      (
        await storeFixture.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", f.run.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("running");
  });

  it("challenges an unauthenticated connection with its resource metadata", async ({
    storeFixture,
  }) => {
    const url = await serveMcp(storeFixture.store);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${connectionCredentialPrefix}${"x".repeat(43)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${url.origin}${mcpResourceMetadataPath}"`,
    );
  });
});
