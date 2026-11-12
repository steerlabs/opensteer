import { expect, vi } from "vitest";
import { nodeDetailEventNodeId } from "../../packages/core/src/index.js";
import { testRpcData } from "../../apps/host/src/server/test-host-api-request.js";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  HttpHostClient,
  type WebSocketClient,
} from "../../packages/client/src/host/host-session-client.js";
import type {
  ClientLifecycle,
  ClientLifecycleSnapshot,
  ClientNetworkPath,
  ClientNetworkState,
} from "../../packages/client/src/host/lifecycle.js";
import { taskList } from "../../packages/client/src/host/task-list.js";
import { placeList } from "../../packages/client/src/host/places.js";
import { verifyAccessEndpoint } from "../../packages/client/src/connections/deployment-catalog.js";
import {
  startShapingProxy,
  type LinkProfile,
  type ProfileName,
  type RequestLine,
} from "./proxy.test-support.js";
import {
  seedPersonal,
  startMobileNetworkHost,
  type SeedName,
  type MobileNetworkHostFactory,
} from "./fixture.test-support.js";

export const scenarios = [
  "cold-attach",
  "open-task",
  "reconnect",
  "foreground-after-30s",
  "network-change",
  "open-subagent-parent",
  "open-subagent",
] as const;
export type Scenario = (typeof scenarios)[number];

export class FakeMobileLifecycle implements ClientLifecycle {
  #snapshot: ClientLifecycleSnapshot = { visibility: "foreground", network: "online" };
  #background = new Set<() => void>();
  #foreground = new Set<() => void>();
  #network = new Set<(state: ClientNetworkState, path: ClientNetworkPath) => void>();
  getSnapshot = () => this.#snapshot;
  onBackground = (listener: () => void) => {
    this.#background.add(listener);
    return () => {
      this.#background.delete(listener);
    };
  };
  onForeground = (listener: () => void) => {
    this.#foreground.add(listener);
    return () => {
      this.#foreground.delete(listener);
    };
  };
  onNetworkChange = (listener: (state: ClientNetworkState, path: ClientNetworkPath) => void) => {
    this.#network.add(listener);
    return () => {
      this.#network.delete(listener);
    };
  };
  background() {
    this.#snapshot = { ...this.#snapshot, visibility: "background" };
    for (const listener of this.#background) listener();
  }
  foreground() {
    this.#snapshot = { ...this.#snapshot, visibility: "foreground" };
    for (const listener of this.#foreground) listener();
  }
  networkChange() {
    for (const listener of this.#network) listener("online", "changed");
  }
}

interface RpcRecord {
  readonly method: string;
  readonly path: string;
  readonly name: string;
  readonly startedAtMs: number;
  completedAtMs: number | null;
  responseBytes: number;
  status: number | null;
}
interface WsRecord {
  readonly atMs: number;
  readonly direction: "up" | "down";
  readonly type: string;
  readonly bytes: number;
  readonly afterSequence?: string;
  readonly eventCount?: number;
}
export interface ScenarioResult {
  readonly toolOutputHistoryBytes: { readonly whole: number; readonly preview: number };
  readonly seed: SeedName;
  readonly profile: ProfileName;
  readonly run: number;
  readonly scenario: Scenario;
  readonly milestonesMs: Record<string, number>;
  readonly elapsedMs: number;
  readonly backgroundWaitMs: number;
  readonly nodeDetailEvents: number;
  readonly nodeDetailBytes: number;
  readonly bytesDown: number;
  readonly bytesUp: number;
  readonly tcpConnections: number;
  readonly modeledTcpHandshakeMs: number;
  readonly modeledTls13AdditionalMs: number;
  readonly connections: {
    readonly id: number;
    readonly bytesDown: number;
    readonly bytesUp: number;
    readonly openedInScenario: boolean;
  }[];
  readonly requestChain: ReturnType<typeof requestWaves>;
  readonly httpRequestLines: RequestLine[];
  readonly requests: RpcRecord[];
  readonly rpc: Record<string, { count: number; responseBytes: number }>;
  readonly websocket: WsRecord[];
  readonly wsByType: Record<string, { count: number; bytes: number }>;
  readonly resume: {
    readonly cursor: string | null;
    readonly snapshots: number;
    readonly eventBatches: number;
    readonly events: number;
  };
}

/** Non-overlapping request waves show serialization; overlapping requests share a wave.
 * This is an observed timeline, not a claim that every preceding request caused the next. */
export function requestWaves(requests: readonly RpcRecord[]) {
  const waves: { startedAtMs: number; completedAtMs: number; requests: string[] }[] = [];
  for (const request of [...requests].sort((a, b) => a.startedAtMs - b.startedAtMs)) {
    const prior = waves.at(-1);
    const end = request.completedAtMs ?? request.startedAtMs;
    if (prior && request.startedAtMs < prior.completedAtMs) {
      prior.completedAtMs = Math.max(prior.completedAtMs, end);
      prior.requests.push(request.name);
    } else
      waves.push({
        startedAtMs: request.startedAtMs,
        completedAtMs: end,
        requests: [request.name],
      });
  }
  return waves;
}

export async function runMobileNetworkSample(options: {
  readonly databaseUrl: string;
  readonly startPersonal?: MobileNetworkHostFactory;
  readonly seed: SeedName;
  readonly profile: ProfileName;
  readonly link: LinkProfile;
  readonly run: number;
  readonly scenarios: readonly Scenario[];
  readonly signal: AbortSignal;
  /** Receives each measurement as it completes, so a later failure keeps it. */
  readonly onManifest?: (manifest: Awaited<ReturnType<typeof seedPersonal>>["manifest"]) => void;
  readonly onResult?: (result: ScenarioResult) => void;
}) {
  const cleanup: (() => Promise<unknown>)[] = [];
  const errors: unknown[] = [];
  let outcome:
    | { manifest: Awaited<ReturnType<typeof seedPersonal>>["manifest"]; results: ScenarioResult[] }
    | undefined;
  try {
    const host = await (options.startPersonal ?? startMobileNetworkHost)(options.databaseUrl);
    cleanup.push(() => host.close());
    console.info(`Seeding ${options.seed}/${options.profile} run ${options.run}`);
    const fixture = await seedPersonal(host, options.seed, cleanup);
    const wholePage = await testRpcData(
      host.origin,
      "thread.events.list",
      { threadId: fixture.historyThreadId, turns: 10 },
      { headers: host.ownerHeaders },
    );
    const previewPage = await testRpcData(
      host.origin,
      "thread.events.list",
      { threadId: fixture.historyThreadId, turns: 10, toolOutputs: "preview" },
      { headers: host.ownerHeaders },
    );
    const toolOutputHistoryBytes = {
      whole: Buffer.byteLength(JSON.stringify(wholePage)),
      preview: Buffer.byteLength(JSON.stringify(previewPage)),
    };
    for (const event of previewPage.events)
      if (event.type === "tool.completed") {
        expect(event.data.outputPreview).toBeDefined();
        expect(event.data.output.text).not.toContain(
          "Build log: checked workspace and synchronized dependency.\n".repeat(440),
        );
      }
    console.info("Tool output history bytes", toolOutputHistoryBytes);
    options.onManifest?.(fixture.manifest);
    console.info(
      `Seeded ${fixture.manifest.tasks} tasks, ${fixture.manifest.historyMessages} history messages, ${fixture.manifest.tabs} tabs`,
    );
    const proxy = await startShapingProxy(new URL(host.origin), options.link);
    cleanup.push(() => proxy.close());
    const lifecycle = new FakeMobileLifecycle();
    const requests: RpcRecord[] = [];
    const messages: WsRecord[] = [];
    const sockets = new Set<WebSocket>();
    cleanup.push(async () => {
      for (const socket of sockets) socket.terminate();
    });
    let nodeDetailEvents = 0;
    let nodeDetailBytes = 0;
    const inspectPayload = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (
        "type" in value &&
        typeof value.type === "string" &&
        "data" in value &&
        nodeDetailEventNodeId({ type: value.type, data: value.data })
      ) {
        nodeDetailEvents++;
        nodeDetailBytes += Buffer.byteLength(JSON.stringify(value));
        return;
      }
      for (const child of Object.values(value)) inspectPayload(child);
    };
    let inFlight = 0;
    let lastActivity = performance.now();
    let synchronized = 0;
    const measuredFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      // An already-held real Host session; login/setup traffic is outside the measurement.
      const path = new URL(request.url).pathname;
      if (path !== "/.well-known/opensteer")
        for (const [name, value] of Object.entries(host.ownerHeaders))
          request.headers.set(name, value);
      const record: RpcRecord = {
        method: request.method,
        path,
        name: path.replace("/v1/rpc/", ""),
        startedAtMs: performance.now(),
        completedAtMs: null,
        status: null,
        responseBytes: 0,
      };
      requests.push(record);
      inFlight++;
      lastActivity = performance.now();
      try {
        const response = await fetch(request);
        const body = await response.arrayBuffer();
        if (response.headers.get("content-type")?.includes("application/json"))
          inspectPayload(JSON.parse(Buffer.from(body).toString("utf8")));
        record.responseBytes = body.byteLength;
        record.status = response.status;
        return new Response(body, { status: response.status, headers: response.headers });
      } finally {
        record.completedAtMs = performance.now();
        inFlight--;
        lastActivity = performance.now();
      }
    };
    const constructionStarted = performance.now();
    let started = constructionStarted;
    let milestones: Record<string, number> = {};
    const mark = (key: string) => {
      milestones[key] ??= performance.now() - started;
    };
    const client = new HttpHostClient({
      baseUrl: proxy.origin,
      fetch: measuredFetch,
      lifecycle,
      random: () => 0.5,
      capabilities: async () => {
        const verified = await verifyAccessEndpoint({
          kind: "direct",
          origin: proxy.origin,
          fetch: measuredFetch,
        });
        mark("discoveryVerified");
        return verified.capabilities;
      },
      webSocketFactory: (url) => {
        const socket = new WebSocket(url, { headers: host.ownerHeaders });
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        const record = (raw: string, direction: "up" | "down") => {
          const data = JSON.parse(raw) as {
            type: string;
            afterSequence?: string;
            cursor?: { afterSequence: string };
            events?: unknown[];
          };
          if (direction === "down") inspectPayload(data);
          const position = data.cursor?.afterSequence ?? data.afterSequence;
          messages.push({
            atMs: performance.now(),
            direction,
            type: data.type,
            bytes: Buffer.byteLength(raw),
            ...(position === undefined ? {} : { afterSequence: position }),
            ...(data.events ? { eventCount: data.events.length } : {}),
          });
          if (data.type === "host.synchronized") synchronized++;
          lastActivity = performance.now();
        };
        socket.on("message", (raw) => record(raw.toString(), "down"));
        const adapter = {
          get readyState() {
            return socket.readyState;
          },
          binaryType: "arraybuffer",
          addEventListener: (socket as unknown as WebSocketClient).addEventListener.bind(socket),
          close: (code, reason) => socket.close(code, reason),
          send: (data) => {
            record(String(data), "up");
            socket.send(data);
          },
        } satisfies WebSocketClient;
        return adapter;
      },
    });
    cleanup.push(async () => client.dispose());
    const inspect = () => {
      const snapshot = client.getSnapshot();
      if (snapshot.session === "authenticated") mark("authenticated");
      if (snapshot.connection === "connected") mark("synchronized");
      const tasks = taskList(snapshot);
      if (tasks.working.length + tasks.ready.length + tasks.done.length > 0)
        mark("taskListRenderable");
      if (
        snapshot.transcriptWindows[fixture.historyThreadId] &&
        (snapshot.transcripts[fixture.historyThreadId]?.length ?? 0) > 0
      )
        mark("historyFirstPage");
      if (placeList(snapshot).length === fixture.manifest.tabs) mark("tabsLoaded");
    };
    const unsubscribe = client.subscribe(inspect);
    cleanup.push(async () => unsubscribe());
    const wait = async (name: string, condition: () => boolean) => {
      await vi.waitFor(
        () => {
          options.signal.throwIfAborted();
          if (!condition())
            throw new Error(`${name} not ready (${options.seed}/${options.profile})`);
        },
        { timeout: 120_000, interval: 10 },
      );
    };
    const settle = () =>
      wait(
        "traffic quiescence",
        () =>
          inFlight === 0 &&
          performance.now() - lastActivity >
            Math.max(150, options.link.latencyDownMs + options.link.latencyUpMs + 25),
      );
    const results: ScenarioResult[] = [];
    // oxlint-disable-next-line opensteer/no-polling-loop-in-tests -- The foreground scenario measures a fixed background interval; readiness uses vi.waitFor.
    for (const scenario of scenarios) {
      const selected = options.scenarios.includes(scenario);
      // Warm scenarios all need the same real attach; run only the prerequisites they use.
      const parentPrerequisite =
        scenario === "open-subagent-parent" && options.scenarios.includes("open-subagent");
      if (!selected && scenario !== "cold-attach" && !parentPrerequisite) continue;
      if (scenario.startsWith("open-subagent") && !fixture.busySubagents)
        throw new Error("Subagent scenarios require --seed busy-subagents");
      let backgroundWaitMs = 0;
      if (scenario === "foreground-after-30s") {
        lifecycle.background();
        const before = performance.now();
        await delay(30_000, undefined, { signal: options.signal });
        backgroundWaitMs = performance.now() - before;
      }
      if (scenario !== "cold-attach") await settle();
      const priorConnections = proxy.connections.map((connection) => ({ ...connection }));
      const requestIndex = requests.length,
        messageIndex = messages.length,
        lineIndex = proxy.requests.length;
      const proxyStart = proxy.now();
      started = scenario === "cold-attach" ? constructionStarted : performance.now();
      milestones = {};
      const priorDetailEvents = nodeDetailEvents;
      const priorDetailBytes = nodeDetailBytes;
      const priorSync = synchronized;
      if (scenario === "cold-attach") {
        const loading = client.load();
        await loading;
        await wait("cold attach milestones", () =>
          [
            "discoveryVerified",
            "authenticated",
            "synchronized",
            "taskListRenderable",
            "tabsLoaded",
          ].every((key) => milestones[key] !== undefined),
        );
      } else if (scenario === "open-subagent-parent") {
        const busy = fixture.busySubagents!;
        client.activateThread(busy.threadId);
        await wait(
          "three subagent cards",
          () =>
            (client.getSnapshot().transcripts[busy.threadId] ?? []).filter(
              (entry) => entry.kind === "node",
            ).length === 3,
        );
        mark("parentFirstPage");
      } else if (scenario === "open-subagent") {
        const busy = fixture.busySubagents!;
        const detail = client.watchNode(busy.threadId, busy.nodeIds[0]!);
        cleanup.push(async () => detail.release());
        const ready = () => {
          const snapshot = detail.getSnapshot();
          if (snapshot.status === "error") throw new Error(snapshot.error ?? "Node detail failed");
          return snapshot.status === "ready";
        };
        await wait("subagent first page", ready);
        mark("nodeFirstPage");
        for (let page = 0; detail.getSnapshot().hasMore && page < 10; page++) {
          await detail.loadOlder();
          expect(detail.getSnapshot().error).toBeNull();
        }
        expect(detail.getSnapshot().hasMore).toBe(false);
        const before = detail.getSnapshot().entries;
        expect(before.filter((entry) => entry.kind === "tool")).toHaveLength(busy.toolCalls[0]!);
        expect(before.filter((entry) => entry.kind === "node-message")).toHaveLength(4);
        expect(before.filter((entry) => entry.kind === "reasoning")).toHaveLength(3);
        expect(new Set(before.map((entry) => entry.id)).size).toBe(before.length);
        mark("nodeFullHistory");
        proxy.dropConnections();
        await wait(
          "subagent reconnect",
          () =>
            synchronized > priorSync && client.getSnapshot().connection === "connected" && ready(),
        );
        expect(detail.getSnapshot().entries).toEqual(before);
        expect(new Set(detail.getSnapshot().entries.map((entry) => entry.id)).size).toBe(
          before.length,
        );
        mark("nodeReconnected");
      } else if (scenario === "open-task") {
        const threadId = fixture.historyThreadId;
        client.activateThread(threadId);
        await wait(
          "Task history",
          () =>
            client.getSnapshot().threadLookups[threadId] === undefined &&
            (client.getSnapshot().transcripts[threadId]?.length ?? 0) > 0,
        );
        mark("taskFirstPage");
      } else {
        if (scenario === "reconnect") {
          proxy.dropConnections();
          // Commit one real event while the cursor is retained but the socket is gone.
          await testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "thread.rename",
              threadId: fixture.taskIds.at(-1)!,
              title: "Updated while disconnected",
              idempotencyKey: "reconnect-gap-rename",
            },
            { headers: host.ownerHeaders },
          );
        }
        if (scenario === "foreground-after-30s") lifecycle.foreground();
        if (scenario === "network-change") lifecycle.networkChange();
        await wait(
          "recovery",
          () => synchronized > priorSync && client.getSnapshot().connection === "connected",
        );
        mark("resynchronized");
        inspect();
      }
      const elapsedMs = performance.now() - started;
      await settle();
      if (scenario === "open-subagent-parent") {
        expect(nodeDetailEvents - priorDetailEvents).toBe(0);
        expect(nodeDetailBytes - priorDetailBytes).toBe(0);
      }
      const connections = proxy.connections.map((connection, index) => ({
        id: connection.id,
        bytesDown: connection.bytesDown - (priorConnections[index]?.bytesDown ?? 0),
        bytesUp: connection.bytesUp - (priorConnections[index]?.bytesUp ?? 0),
        openedInScenario: index >= priorConnections.length,
      }));
      const rpcRecords = requests.slice(requestIndex).map((record) => ({
        ...record,
        startedAtMs: record.startedAtMs - started,
        completedAtMs: record.completedAtMs === null ? null : record.completedAtMs - started,
      }));
      const websocket = messages
        .slice(messageIndex)
        .map((message) => ({ ...message, atMs: message.atMs - started }));
      const rpc: ScenarioResult["rpc"] = {};
      for (const record of rpcRecords.filter((record) => record.path.startsWith("/v1/rpc/"))) {
        const stat = (rpc[record.name] ??= { count: 0, responseBytes: 0 });
        stat.count++;
        stat.responseBytes += record.responseBytes;
      }
      const wsByType: ScenarioResult["wsByType"] = {};
      for (const message of websocket) {
        const stat = (wsByType[`${message.direction}:${message.type}`] ??= { count: 0, bytes: 0 });
        stat.count++;
        stat.bytes += message.bytes;
      }
      const tcpConnections = connections.filter((connection) => connection.openedInScenario).length;
      const rtt = options.link.latencyUpMs + options.link.latencyDownMs;
      const result = {
        toolOutputHistoryBytes,
        seed: options.seed,
        profile: options.profile,
        run: options.run,
        scenario,
        milestonesMs: milestones,
        elapsedMs,
        backgroundWaitMs,
        nodeDetailEvents: nodeDetailEvents - priorDetailEvents,
        nodeDetailBytes: nodeDetailBytes - priorDetailBytes,
        bytesDown: connections.reduce((total, connection) => total + connection.bytesDown, 0),
        bytesUp: connections.reduce((total, connection) => total + connection.bytesUp, 0),
        tcpConnections,
        modeledTcpHandshakeMs: tcpConnections * rtt,
        modeledTls13AdditionalMs: tcpConnections * rtt,
        connections,
        requests: rpcRecords,
        requestChain: requestWaves(rpcRecords),
        rpc,
        websocket,
        wsByType,
        httpRequestLines: proxy.requests
          .slice(lineIndex)
          .map((line) => ({ ...line, atMs: line.atMs - proxyStart })),
        resume: {
          cursor:
            websocket.find((message) => message.type === "client.subscribe")?.afterSequence ?? null,
          snapshots: websocket.filter((message) => message.type === "host.snapshot").length,
          eventBatches: websocket.filter((message) => message.type === "host.events").length,
          events: websocket.reduce((total, message) => total + (message.eventCount ?? 0), 0),
        },
      };
      if (selected) {
        results.push(result);
        options.onResult?.(result);
      }
    }
    outcome = { manifest: fixture.manifest, results };
  } catch (error) {
    errors.push(error);
  } finally {
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Benchmark sample failed", { cause: errors[0] });
  if (!outcome) throw new Error("Benchmark produced no result");
  return outcome;
}
