import { z } from "zod";
import { gatherComputerAccess } from "../devices/computer-access.js";
import { DeviceToolHandlers } from "./handlers/devices.js";
import { IntegrationPlatformStore, type IntegrationRequester } from "@opensteer/database";
import { AppStore, TriggerStore } from "@opensteer/database";
import { TriggerService } from "../triggers/trigger-service.js";
import { TriggerToolHandlers } from "./handlers/triggers.js";
import { ThreadService } from "../threads/thread-service.js";
import { CommandService, KeyedAdmissionQueue, RealtimeHub } from "@opensteer/orchestration";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createId,
  ThreadIdSchema,
  type AgentGrant,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import { AgentConnectionStore, type OpensteerStore } from "@opensteer/database";
import { createStoreFixture, testModelSelection } from "@opensteer/database/test-support/store";
import { personalTestExecution } from "./personal-execution.test-support.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, expect } from "vitest";
import { AgentCallerResolver } from "./agent-caller.js";
import {
  ConnectionAuthenticator,
  connectionCredentialPrefix,
  credentialHash,
} from "./connections/connection-authenticator.js";
import { mcpResourcePath, type ConnectionOAuth } from "./connections/connection-oauth.js";
import {
  connectionCommandEffects,
  handleConnectionCommand,
  type ConnectionCommand,
} from "./connections/connection-routes.js";
import type { HostApiServerContext } from "@opensteer/protocol";
import { agentToolHandlers } from "./handlers/index.js";
import { ProductToolHandlers } from "./handlers/product.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";

const servers: Server[] = [];
export let lastService: OpensteerMcpService | undefined;
export const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
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
export async function serveMcp(
  fixture: Awaited<ReturnType<typeof createStoreFixture>>,
  options: {
    readonly connected?: () => boolean;
    readonly runScope?: import("../agents/run-tool-tokens.js").RunToolScope;
    readonly runScopes?: Readonly<
      Record<string, import("../agents/run-tool-tokens.js").RunToolScope>
    >;
    readonly notify?: { current?: () => void };
    readonly subscribed?: () => void;
    readonly unsubscribed?: () => void;
    /** The person's tab strip, as the task tools read it. */
    readonly tabs?: Pick<import("../tabs/ports.js").TabServicePort, "get">;
    /** The tab tools themselves, for direct work through agent sessions. */
    readonly tabHandlers?: import("./handlers/tabs.js").TabToolHandlers;
    readonly administration?: import("./handlers/administration.js").AdministrationToolHandlers;
    readonly browser?: import("./handlers/browser.js").BrowserToolHandlers;
    readonly sessionPerson?: import("./handlers/session-person.js").SessionPersonTools;
    readonly onToolError?: (error: unknown, tool: string) => void;
    /** The person's Macs and phones as the computer-use service reports them. */
    readonly computerApps?: {
      readonly computerUseInventory: (owner: UserId) => Promise<unknown>;
      readonly installedComputerApps?: (...args: never[]) => Promise<unknown>;
    };
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
  const { store } = fixture;
  const realtime = new RealtimeHub();
  const stopMutationHooks = fixture.observePersonalCommits((head, scopes) =>
    realtime.wake(head, scopes),
  );
  if (options.notify) options.notify.current = () => realtime.wake("0", new Set(["deployment"]));
  const observations = {
    observe: realtime.observe.bind(realtime),
    observeScopes: (...args: Parameters<RealtimeHub["observeScopes"]>) => {
      options.subscribed?.();
      const detach = realtime.observeScopes(...args);
      return () => {
        options.unsubscribed?.();
        return detach();
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
  });
  const settings = await store.database
    .selectFrom("personalSettings")
    .selectAll()
    .executeTakeFirstOrThrow();
  const environment = await store.database
    .selectFrom("executionEnvironments")
    .select("id")
    .where("runnerId", "=", settings.agentHomeComputerId)
    .executeTakeFirstOrThrow();
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
    execution: personalTestExecution(store, {
      userId: settings.ownerId,
      environmentId: environment.id,
      agentHome: { computerId: settings.agentHomeComputerId, path: settings.agentHomePath },
    }),
    deploymentId: (
      await store.database.selectFrom("deployments").select("id").executeTakeFirstOrThrow()
    ).id,
    store,
    threads,
    realtime: { ...observations, sendToUsers: realtime.sendToUsers.bind(realtime) },
    commands,
    browser: {
      readablePlaces: async (_owner: unknown, references: readonly unknown[]) => [...references],
    },
    isEnvironmentConnected: options.connected ?? (() => true),
    canRunHarness: () => true,
    ...(options.tabs ? { tabs: options.tabs } : {}),
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
  server.once("close", stopMutationHooks);
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
  const platform = {
    store: integrationStore,
    listCallableTools: (input: IntegrationRequester) => integrationStore.listCallableTools(input),
    computerToolEnabled: () => false,
    computerUseVersion: async () => undefined,
    computerAppApprovals: {
      computerUseInventory: async () => ({ machines: [], phones: [] }),
      computerAppHolders: () => new Map(),
      ...options.computerApps,
    },
  } as unknown as Parameters<typeof gatherComputerAccess>[0];
  const devices = new DeviceToolHandlers({
    devices: {
      ...platform,
      computerAccess: gatherComputerAccess.bind(undefined, platform),
    } as unknown as ConstructorParameters<typeof DeviceToolHandlers>[0]["devices"],
    access: {} as never,
  });
  service = lastService = new OpensteerMcpService({
    ...(options.onToolError ? { onToolError: options.onToolError } : {}),
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
      tabs: options.tabHandlers ?? ({} as never),
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.sessionPerson ? { sessionPerson: options.sessionPerson } : {}),
      administration:
        options.administration ??
        (new Proxy(
          {},
          {
            get: () => {
              throw new Error("Unexpected administration tool");
            },
          },
        ) as never),
      product,
      devices,
      triggers: new TriggerToolHandlers(
        new TriggerService({
          store: new TriggerStore(store.database),
          threads: store,
        } as unknown as ConstructorParameters<typeof TriggerService>[0]),
        store,
      ),
      apps: {
        list: async (actor: { readonly caller: { readonly userId: UserId } }) =>
          new AppStore(store.database).list(actor.caller.userId),
      } as never,
      teamRequestForRun: async () => null,
      personalContextForRun: async () => true,
    }),
    store,
    publicUrl: options.runScope || options.runScopes ? url : new URL("http://runtime.invalid"),
  });
  return url;
}

export async function connection(
  store: OpensteerStore,
  url: URL,
  input: {
    readonly userId: Parameters<AgentConnectionStore["create"]>[0]["userId"];
    readonly accessMode: ThreadAccessMode;
    readonly grant?: AgentGrant;
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

export function errorText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBe(true);
  const [first] = result.content as { type: string; text: string }[];
  return z
    .object({
      error: z.object({ code: z.string(), message: z.string(), next: z.string().nullable() }),
    })
    .parse(result.structuredContent ?? JSON.parse(first!.text)).error.message;
}

export async function createTask(
  agent: Awaited<ReturnType<typeof connection>>,
  f: Awaited<ReturnType<Awaited<ReturnType<typeof createStoreFixture>>["startRunFixture"]>>,
  key: string,
) {
  const result = await agent.client.callTool({
    name: "opensteer_task_create",
    arguments: {
      aiAccountId: f.harnessInstance.id,
      model: { ...testModelSelection, options: {} },
      title: `Lineage ${key}`,
      message: "Work on it",
      operationKey: key,
    },
  });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return ThreadIdSchema.parse((result.structuredContent as { taskId: string }).taskId);
}
export async function queuedRun(
  storeFixture: Awaited<ReturnType<typeof createStoreFixture>>,
  threadId: import("@opensteer/core").ThreadId,
) {
  return storeFixture.database
    .selectFrom("runs")
    .select(["id", "status", "connectionId", "accessMode"])
    .where("threadId", "=", threadId)
    .orderBy("createdAt", "desc")
    .executeTakeFirstOrThrow();
}

/** The runtime's own command path: the connection routes' handler and its effects. */
export function commands(
  storeFixture: Awaited<ReturnType<typeof createStoreFixture>>,
  userId: UserId,
  options: {
    readonly afterStop?: Parameters<typeof connectionCommandEffects>[0]["afterStop"];
    readonly stopper?: Parameters<typeof connectionCommandEffects>[0]["stopper"];
  } = {},
) {
  const store = new AgentConnectionStore(storeFixture.database);
  const failures: unknown[] = [];
  const effects = connectionCommandEffects({
    store: storeFixture.store,
    closeLineage: (connectionId, revision) => lastService!.closeLineage(connectionId, revision),
    ...(options.stopper ? { stopper: options.stopper } : {}),
    onFailure: (error) => failures.push(error),
    ...(options.afterStop ? { afterStop: options.afterStop } : {}),
  });
  const context = {
    session: { id: createId("authSession"), user: { id: userId, disabledAt: null } },
  } as unknown as HostApiServerContext;
  const run = (command: ConnectionCommand) =>
    handleConnectionCommand({ store } as unknown as ConnectionOAuth, command, context, effects);
  return {
    failures,
    effects,
    revoke: (connectionId: string) =>
      run({ type: "connection.revoke", connectionId, idempotencyKey: randomUUID() }),
    update: (
      connectionId: string,
      change: Partial<Extract<ConnectionCommand, { type: "connection.update" }>>,
    ) =>
      run({
        type: "connection.update",
        connectionId,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        ...change,
      }),
    remove: (connectionId: string) =>
      run({ type: "connection.remove", connectionId, idempotencyKey: randomUUID() }),
    acknowledge: (connectionId: string) =>
      run({
        type: "connection.uncertain.acknowledge",
        connectionId,
        idempotencyKey: randomUUID(),
      }),
    list: () => store.list(userId, { includeRevoked: true }),
  };
}
export async function ownerTask(
  storeFixture: Awaited<ReturnType<typeof createStoreFixture>>,
  f: Awaited<ReturnType<Awaited<ReturnType<typeof createStoreFixture>>["startRunFixture"]>>,
  key: string,
) {
  return (
    await storeFixture.store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      modelSelection: testModelSelection,
      idempotencyKey: `owner-task:${key}`,
      title: `Owner ${key}`,
    })
  ).thread.id;
}
export const send = (agent: Awaited<ReturnType<typeof connection>>, taskId: string, key: string) =>
  agent.client.callTool({
    name: "opensteer_task_send",
    arguments: { taskId, message: "More work", delivery: "queue", operationKey: key },
  });
