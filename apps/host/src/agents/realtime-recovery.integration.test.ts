import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelSelectionSchema, createId, type ThreadId } from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { hostApiVersionHeader } from "@opensteer/protocol";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * A desktop app attached to a Deployment through a route — the Connect tunnel,
 * a direct endpoint — reaches its Host through the Desktop main process: the
 * renderer's socket is a proxy over IPC for a socket main owns. These journeys
 * run that whole path for real (Host and database, the shipped client, the
 * shipped renderer socket adapter, the shipped Desktop transport) and break it
 * the ways a person's app breaks it, then require the next reply to arrive with
 * nobody touching anything.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const evidenceDirectory =
  process.env.OPENSTEER_REALTIME_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-realtime-recovery");
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
const canonicalOrigin = "https://home.connect.opensteer.test";
const routeOrigin = "https://route.connect.opensteer.test";
/**
 * How long a broken socket may take to be replaced and its reply drawn. It is
 * far under the client's default silence threshold, so only the scenario that
 * shortens that threshold can pass by being probed.
 */
const recoveryBudgetMs = 6_000;
/** A silence threshold short enough that a quiet socket is questioned within the budget. */
const quickLiveness = { deadlineMs: 400, idleMs: 400 };

interface JourneyStep {
  readonly atMs: number;
  readonly step: string;
  readonly detail?: Record<string, unknown>;
}

interface SocketRecord {
  readonly path: string;
  readonly openedAtMs: number;
  closedAtMs: number | null;
  closeCode: number | null;
  closeReason: string | null;
  silenced: boolean;
  readonly socket: WebSocket;
  readonly events: { readonly message: (data: string | Uint8Array) => void };
}

interface ViewerClient {
  activateThread(threadId: string): void;
  dispose(): void;
  getSnapshot(): {
    readonly connection: string;
    readonly transcripts: Record<
      string,
      readonly { readonly kind: string; readonly messageKind?: string }[]
    >;
  };
  load(): Promise<void>;
  refresh(options?: { readonly retryConnection?: boolean }): Promise<void>;
}

interface DesktopTransport {
  openWebSocket(
    ownerId: number,
    input: unknown,
    onEvent: (event: { readonly connectionId: string; readonly type: string }) => void,
  ): Promise<{ readonly connectionId: string }>;
  sendWebSocket(ownerId: number, input: unknown): void;
  closeWebSocket(ownerId: number, input: unknown): void;
  request(input: unknown): Promise<unknown>;
  selection(): Promise<unknown>;
}

interface DesktopApp {
  readonly client: ViewerClient;
  readonly sockets: SocketRecord[];
  /** Moves this app's route to its other verified endpoint, as choosing a route does. */
  moveRoute(): Promise<void>;
  /** Loses the Deployment's route, as a directory sync that no longer lists it does. */
  loseRoute(): Promise<void>;
  /** Gives the route back, as the next directory sync that lists it again does. */
  restoreRoute(): Promise<void>;
  /** Delivers one frame the shipped client cannot read, as if the Host had sent it. */
  injectUnreadableFrame(): void;
  /**
   * Keeps the realtime socket open while nothing from the Host reaches the app,
   * and does the same to the next `replacements` sockets from the moment they open.
   */
  silenceRealtime(replacements?: number): void;
  realtimeOpens(): number;
}

interface Scenario {
  readonly name: string;
  /** Why each replaced realtime socket ended, in order: the mechanism that recovered it. */
  readonly closes: readonly string[];
  readonly liveness?: typeof quickLiveness;
  /** Breaks the app's channel once the first reply has been drawn. */
  readonly fault: (app: DesktopApp) => Promise<void>;
  /** Runs once the second reply is committed, before the app must draw it. */
  readonly repair?: (app: DesktopApp) => Promise<void>;
}

integration("Realtime Workspace channel through the Desktop bridge", () => {
  let stack: VerticalStack | undefined;
  const apps: DesktopApp[] = [];

  beforeAll(async () => {
    const harnesses = new HarnessRegistry();
    harnesses.registerDriver(
      new CodexHarnessDriver({
        launch: {
          arguments: [fakeCodexAppServer, "--scenario=vertical", "--unique-threads"],
          executable: process.execPath,
        },
      }),
    );
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses,
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 15_000,
    });
  }, 120_000);

  afterAll(async () => {
    for (const app of apps.splice(0)) {
      app.client.dispose();
      for (const record of app.sockets) record.socket.terminate();
    }
    await stack?.close();
    stack = undefined;
  }, 60_000);

  it("delivers the next reply after the app's route moves under an open channel", async () => {
    await journey(stack!, apps, {
      closes: ["Deployment changed"],
      fault: (app) => app.moveRoute(),
      name: "route-moved",
    });
  }, 90_000);

  it("replays a reply committed while the app's route was gone, once it returns", async () => {
    await journey(stack!, apps, {
      closes: ["Deployment changed"],
      fault: (app) => app.loseRoute(),
      name: "route-lost-and-restored",
      repair: (app) => app.restoreRoute(),
    });
  }, 90_000);

  it("delivers the next reply after explicit repair of a refused protocol frame", async () => {
    await journey(stack!, apps, {
      closes: ["Invalid Host protocol frame"],
      fault: async (app) => app.injectUnreadableFrame(),
      repair: async (app) => {
        expect(app.client.getSnapshot().connection).toBe("offline");
        expect(app.realtimeOpens()).toBe(1);
        await app.client.refresh({ retryConnection: true });
      },
      name: "unreadable-frame",
    });
  }, 90_000);

  it("replays a reply committed while the open channel was silent", async () => {
    await journey(stack!, apps, {
      closes: ["Liveness probe unanswered"],
      fault: async (app) => app.silenceRealtime(),
      liveness: quickLiveness,
      name: "silent-channel",
    });
  }, 90_000);

  it("gives up on a replacement that opens but never synchronizes, and backs off to one that does", async () => {
    await journey(stack!, apps, {
      closes: ["Liveness probe unanswered", "Realtime channel silent"],
      fault: async (app) => app.silenceRealtime(1),
      liveness: quickLiveness,
      name: "silent-replacement",
    });
  }, 90_000);
});

/**
 * One app, one conversation: a reply proves the path works, the fault breaks
 * it, the next reply is committed while it is broken, and that reply must
 * reach the app within the recovery budget. The record of what happened is
 * written whether or not it does.
 */
async function journey(
  stack: VerticalStack,
  apps: DesktopApp[],
  scenario: Scenario,
): Promise<void> {
  const startedAt = Date.now();
  const steps: JourneyStep[] = [];
  const step = (name: string, detail?: Record<string, unknown>) =>
    steps.push({ atMs: Date.now() - startedAt, step: name, ...(detail ? { detail } : {}) });
  let outcome: "passed" | "failed" = "failed";
  let app: DesktopApp | undefined;
  try {
    const threadId = await stack.createThread({
      idempotencyKey: `realtime-${scenario.name}`,
      modelSelection,
      title: `Realtime ${scenario.name}`,
      workspaceId: stack.mainWorkspaceId,
    });
    app = await desktopApp(stack, startedAt, scenario.liveness);
    apps.push(app);
    const client = app.client;
    await client.load();
    client.activateThread(threadId);
    await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"), {
      timeout: 15_000,
    });
    step("synchronized", { realtimeOpens: app.realtimeOpens() });

    await stack.sendMessage({
      text: "First message, before anything breaks.",
      threadId,
      workspaceId: stack.mainWorkspaceId,
    });
    await vi.waitFor(() => expect(assistantReplies(client, threadId)).toBe(1), {
      timeout: 15_000,
    });
    step("first-reply-visible");

    await scenario.fault(app);
    step("fault-injected", { realtimeOpens: app.realtimeOpens() });

    await stack.sendMessage({
      text: "Second message, after the channel broke.",
      threadId,
      workspaceId: stack.mainWorkspaceId,
    });
    step("second-reply-persisted", { replies: assistantReplies(client, threadId) });
    if (scenario.repair) {
      await scenario.repair(app);
      step("repaired");
    }
    const persistedAt = Date.now();
    await vi.waitFor(() => expect(assistantReplies(client, threadId)).toBe(2), {
      interval: 50,
      timeout: recoveryBudgetMs,
    });
    step("second-reply-visible", {
      afterPersistOrRepairMs: Date.now() - persistedAt,
      realtimeOpens: app.realtimeOpens(),
    });
    const realtime = app.sockets.filter((record) => record.path === "/v1/realtime");
    expect(realtime.slice(0, -1).map((record) => record.closeReason)).toEqual(scenario.closes);
    expect(realtime.at(-1)?.closedAtMs).toBeNull();
    outcome = "passed";
  } finally {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      join(evidenceDirectory, `${scenario.name}.json`),
      `${JSON.stringify(
        {
          outcome,
          scenario: scenario.name,
          sockets: (app?.sockets ?? []).map(
            ({ events: _events, socket: _socket, ...record }) => record,
          ),
          steps,
        },
        null,
        2,
      )}\n`,
    );
  }
}

function assistantReplies(client: ViewerClient, threadId: ThreadId): number {
  return (client.getSnapshot().transcripts[threadId] ?? []).filter(
    (entry) => entry.kind === "message" && entry.messageKind === "assistant",
  ).length;
}

/**
 * The shipped client, renderer adapter and Desktop transport, joined by an
 * in-process IPC that keeps Electron's shape: invocations resolve or reject
 * asynchronously, and main's socket events reach the renderer in order on a
 * later turn. The network is the one stand-in — a tunnel that carries both of
 * the app's origins to the stack's Host — and it is where a socket is
 * silenced.
 */
async function desktopApp(
  stack: VerticalStack,
  startedAt: number,
  liveness: typeof quickLiveness | undefined,
): Promise<DesktopApp> {
  // Host's project cannot statically import Desktop's or Web's source trees.
  // Vitest resolves the production modules at runtime while Host typechecks
  // remain scoped.
  const desktopTransportPath = "../../../desktop/src/connections/host-transport.js";
  const desktopProjectionPath = "../../../desktop/src/connections/access-projection.js";
  const webTransportPath = "../../../web/src/desktop/desktop-host-transport.js";
  const connectionsPath = "@opensteer/client/connections";
  const testSupportPath = "@opensteer/client/test-support";
  const hostClientPath = "@opensteer/client/host";
  const [
    { DesktopHostTransport },
    { DesktopAccessProjection },
    web,
    connections,
    { testDiscoveryEnvelope },
    { HttpHostClient },
  ] = (await Promise.all([
    import(desktopTransportPath),
    import(desktopProjectionPath),
    import(webTransportPath),
    import(connectionsPath),
    import(testSupportPath),
    import(hostClientPath),
  ])) as [
    { DesktopHostTransport: new (options: unknown) => DesktopTransport },
    { DesktopAccessProjection: new (options: unknown) => unknown },
    {
      createDesktopHostFetch: (
        bridge: OpensteerDesktopBridge,
        canonicalOrigin: string,
      ) => typeof globalThis.fetch;
      createDesktopHostWebSocketFactory: (
        bridge: OpensteerDesktopBridge,
        canonicalOrigin: string,
      ) => (url: string) => unknown;
    },
    {
      DeploymentCatalogSchema: { parse(value: unknown): unknown };
      DeploymentConnectionSchema: { parse(value: unknown): Record<string, unknown> };
      HostTransportError: new (...args: never[]) => Error & { readonly code: string };
    },
    { testDiscoveryEnvelope: (input: unknown) => unknown },
    { HttpHostClient: new (options: Record<string, unknown>) => ViewerClient },
  ];

  const now = new Date(startedAt).toISOString();
  const deploymentId = createId("deployment");
  const connection = connections.DeploymentConnectionSchema.parse({
    authority: testDiscoveryEnvelope({
      canonicalOrigin,
      deploymentId,
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
    }),
    bootstrapMethods: ["password"],
    createdAt: now,
    endpoints: [
      { kind: "canonical", origin: canonicalOrigin, verifiedAt: now },
      { kind: "direct", origin: routeOrigin, verifiedAt: now },
    ],
    kind: "self-hosted",
    lastUsedAt: null,
    name: "Home",
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: now,
  });
  let catalog = connections.DeploymentCatalogSchema.parse({
    deployments: [connection],
    revision: 1,
    schemaVersion: 4,
    selectedDeploymentId: deploymentId,
    updatedAt: now,
  }) as { readonly revision: number; readonly deployments: readonly Record<string, unknown>[] };
  const replaceCatalog = (deployments: readonly Record<string, unknown>[]) => {
    catalog = connections.DeploymentCatalogSchema.parse({
      deployments,
      revision: catalog.revision + 1,
      schemaVersion: 4,
      selectedDeploymentId: deployments.length > 0 ? deploymentId : null,
      updatedAt: now,
    }) as typeof catalog;
  };
  const catalogStore = {
    load: async () => catalog,
    select: async () => catalog,
    setPreferredEndpoint: async (input: { readonly origin: string | null }) => {
      catalog = connections.DeploymentCatalogSchema.parse({
        ...catalog,
        deployments: [
          connections.DeploymentConnectionSchema.parse({
            ...catalog.deployments[0],
            preferredEndpointOrigin: input.origin,
          }),
        ],
        revision: catalog.revision + 1,
      }) as typeof catalog;
      return catalog;
    },
    subscribe: () => () => undefined,
  };

  const sockets: SocketRecord[] = [];
  let silenceReplacements = 0;
  const tunnel = (url: string) => {
    const target = new URL(url);
    return new URL(`${target.pathname}${target.search}`, stack.hostOrigin);
  };
  const network = {
    request: async (input: {
      readonly url: string;
      readonly signal: AbortSignal;
      readonly request: {
        readonly body?: string | Blob;
        readonly method: string;
        readonly headers: {
          readonly accept?: string;
          readonly apiVersion?: string;
          readonly contentType?: string;
          readonly idempotencyKey?: string;
        };
      };
    }) => {
      const headers = new Headers({
        accept: input.request.headers.accept ?? "application/json",
        cookie: stack.sessionCookie,
        origin: stack.hostOrigin.origin,
      });
      if (input.request.headers.apiVersion)
        headers.set(hostApiVersionHeader, input.request.headers.apiVersion);
      if (input.request.headers.contentType)
        headers.set("content-type", input.request.headers.contentType);
      if (input.request.headers.idempotencyKey)
        headers.set("idempotency-key", input.request.headers.idempotencyKey);
      return fetch(tunnel(input.url), {
        ...(input.request.body === undefined ? {} : { body: input.request.body }),
        headers,
        method: input.request.method,
        redirect: "error",
        signal: input.signal,
      });
    },
    openWebSocket: (
      input: { readonly url: string },
      events: {
        readonly close: (code: number, reason: string) => void;
        readonly error: (message: string) => void;
        readonly message: (data: string | Uint8Array) => void;
        readonly open: () => void;
      },
    ) => {
      const target = tunnel(input.url);
      target.protocol = "ws:";
      const socket = new WebSocket(target, {
        headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
      });
      const record: SocketRecord = {
        closeCode: null,
        closeReason: null,
        closedAtMs: null,
        openedAtMs: Date.now() - startedAt,
        path: target.pathname,
        events,
        silenced: target.pathname === "/v1/realtime" && silenceReplacements > 0,
        socket,
      };
      sockets.push(record);
      if (record.silenced) silenceReplacements -= 1;
      socket.on("open", () => events.open());
      socket.on("message", (data, isBinary) => {
        // A silenced socket still answers the Host's protocol pings, as a
        // stalled path that keeps its connection does.
        if (record.silenced) return;
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        events.message(isBinary ? new Uint8Array(bytes) : bytes.toString("utf8"));
      });
      socket.on("error", (error) => events.error(error.message));
      socket.on("close", (code, reason) => {
        record.closedAtMs = Date.now() - startedAt;
        record.closeCode = code;
        record.closeReason = reason.toString("utf8");
        events.close(code, reason.toString("utf8"));
      });
      return {
        close: (code?: number, reason?: string) => socket.close(code, reason),
        send: (data: string | Uint8Array) => socket.send(data),
      };
    },
  };

  const localRuntime = { current: async () => null };
  const transport = new DesktopHostTransport({
    catalog: catalogStore,
    localRuntime,
    network,
    projection: new DesktopAccessProjection({
      catalog: catalogStore,
      localRuntime,
      supervisedDeploymentId: async () => null,
    }),
  });

  const ownerId = 1;
  const listeners = new Set<(event: unknown) => void>();
  const toRenderer = (event: unknown) => {
    const copy = structuredClone(event);
    setImmediate(() => {
      for (const listener of listeners) listener(copy);
    });
  };
  const invoke = async <Result>(operation: () => Result | Promise<Result>): Promise<Result> => {
    // Electron answers an invocation on a later turn, never synchronously.
    await new Promise((resolve) => setImmediate(resolve));
    return structuredClone(await operation());
  };
  const bridge = {
    closeHostWebSocket: (input: unknown) => invoke(() => transport.closeWebSocket(ownerId, input)),
    hostRequest: (input: unknown) =>
      invoke(async () => {
        try {
          return { data: await transport.request(input), ok: true };
        } catch (error) {
          if (!(error instanceof connections.HostTransportError)) throw error;
          return { error: { code: error.code }, ok: false };
        }
      }),
    onHostWebSocketEvent: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openHostWebSocket: (input: { readonly path: string }) =>
      invoke(() => transport.openWebSocket(ownerId, input, toRenderer)),
    sendHostWebSocket: (input: unknown) => invoke(() => transport.sendWebSocket(ownerId, input)),
  } as unknown as OpensteerDesktopBridge;

  const client = new HttpHostClient({
    baseUrl: new URL(canonicalOrigin),
    fetch: web.createDesktopHostFetch(bridge, canonicalOrigin),
    ...(liveness ? { realtimeLiveness: liveness } : {}),
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 200,
    // The person's app polls; the poll must not be what repairs a channel.
    refreshIntervalMs: 60_000,
    webSocketFactory: web.createDesktopHostWebSocketFactory(bridge, canonicalOrigin),
  });

  const realtimeSockets = () => sockets.filter((record) => record.path === "/v1/realtime");
  let restoreDeployments: readonly Record<string, unknown>[] | null = null;
  return {
    client,
    injectUnreadableFrame: () => {
      const current = realtimeSockets().at(-1);
      if (!current) throw new Error("No realtime socket is open.");
      current.events.message("{ not a Host frame");
    },
    loseRoute: async () => {
      const held = catalog.deployments;
      replaceCatalog([]);
      await transport.selection();
      restoreDeployments = held;
    },
    moveRoute: async () => {
      await catalogStore.setPreferredEndpoint({ origin: routeOrigin });
      await transport.selection();
    },
    restoreRoute: async () => {
      if (!restoreDeployments) throw new Error("No route was lost.");
      replaceCatalog(restoreDeployments);
      restoreDeployments = null;
      await transport.selection();
    },
    realtimeOpens: () => realtimeSockets().length,
    silenceRealtime: (replacements = 0) => {
      const current = realtimeSockets().at(-1);
      if (!current) throw new Error("No realtime socket is open.");
      current.silenced = true;
      silenceReplacements = replacements;
    },
    sockets,
  };
}
