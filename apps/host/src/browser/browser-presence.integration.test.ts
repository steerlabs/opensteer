import { randomUUID } from "node:crypto";
import { AgentControlResponseSchema, BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { resolvedInputParts } from "@opensteer/harness";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { liveWork, type HostSnapshot } from "@opensteer/client/host";
import { createId, zeroSequence, WorkspaceIdSchema, type WorkspaceId } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { decodeBrowserFrameEnvelope } from "@opensteer/protocol/browser";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { sql } from "kysely";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closed,
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  signUpUser,
  startMachineAccessHost,
  waitForMessage,
  type MachineAccessDatabase,
  type MachineAccessHost,
} from "../runtime/machine-access.test-support.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";

/*
 * A person and an agent share one browser through a real Host on PostgreSQL,
 * a Runner holding a real Run, and a relayed Browser Runtime. Every assertion
 * is on what the realtime sockets were sent:
 *
 * - a page changing its title or site reaches the browser's viewers as a
 *   `host.browser-presence` patch, never as a list change that makes every
 *   client reread its Workspace, and nobody who may not see the browser hears
 *   of it;
 * - "acting" turns on with the agent's CDP commands, off once 15 seconds pass
 *   without one, and off at once when the Run ends, and a command answering
 *   after the end does not turn it back on;
 * - a conversation is told when its visible browser usage changes, including
 *   a revisited page's labels, naming exactly the conversations credited;
 * - the shared client's Live overview lists a conversation's browser from the
 *   catalog alone, on a device that never opened that conversation;
 * - a page a person includes is credited with its message, and refused, with
 *   no message kept, where the conversation's agent could not use it;
 * - a page an agent reaches is answered even when its use cannot be recorded,
 *   and presence the store could not address is sent once it can.
 *
 * The artifacts record the messages each socket received and the timings.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const actingWindowMs = 15_000;

interface Listener {
  readonly messages: Record<string, unknown>[];
  close(): Promise<void>;
}

/** A realtime socket that keeps every message, following a Workspace when one is named. */
async function listen(
  host: MachineAccessHost,
  headers: Record<string, string>,
  workspaceId?: WorkspaceId,
): Promise<Listener> {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/v1/realtime`, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as Record<string, unknown> & {
      readonly events?: readonly { readonly sequence?: string }[];
    };
    messages.push(message);
    const latest = message.events?.at(-1);
    if (message.type === "host.events" && latest?.sequence && workspaceId) {
      socket.send(JSON.stringify({ sequence: latest.sequence, type: "client.ack", workspaceId }));
    }
  });
  if (workspaceId) {
    const synchronized = waitForMessage(socket, (message) => message.type === "host.synchronized");
    socket.send(
      JSON.stringify({
        afterSequence: zeroSequence,
        apiVersion: hostApiVersion,
        threadId: null,
        type: "client.subscribe",
        workspaceId,
      }),
    );
    await synchronized;
  }
  return {
    close: async () => {
      socket.close();
      await closed(socket);
    },
    messages,
  };
}

async function until<Value>(
  produce: () => Value | undefined | Promise<Value | undefined>,
  timeoutMs = 10_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for a realtime message");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

interface Reader {
  readonly sockets: WebSocket[];
  retainBrowserWatch(sessionId: string, surfaceId: string): () => void;
  browserWatchState(sessionId: string, surfaceId: string): { status: string; error: string | null };
  readonly requests: string[];
  activateWorkspace(workspaceId: string): void;
  dispose(): void;
  getSnapshot(): HostSnapshot;
}

/**
 * The shared client every app uses, signed in as the owner on another device.
 * It records the path of every request it makes.
 */
async function reader(host: MachineAccessHost, delayBootstrapMs = 0): Promise<Reader> {
  const { HttpHostClient } = (await import("@opensteer/client/host")) as unknown as {
    HttpHostClient: new (options: {
      readonly baseUrl: URL;
      readonly fetch: typeof globalThis.fetch;
      readonly reconnectBaseDelayMs: number;
      readonly reconnectMaxDelayMs: number;
      readonly refreshIntervalMs: number;
      readonly webSocketFactory: (url: string) => unknown;
    }) => Omit<Reader, "requests" | "sockets"> & { load(): Promise<void> };
  };
  const requests: string[] = [];
  const sockets: WebSocket[] = [];
  const origin = new URL(host.origin);
  const client = new HttpHostClient({
    baseUrl: origin,
    fetch: async (input, init) => {
      const request = new Request(
        input instanceof Request ? input : new URL(String(input), origin),
        init,
      );
      for (const [name, value] of Object.entries(host.ownerHeaders))
        request.headers.set(name, value);
      requests.push(new URL(request.url).pathname);
      const response = await fetch(request);
      if (request.url.includes("bootstrap.get") && delayBootstrapMs)
        await new Promise((resolve) => setTimeout(resolve, delayBootstrapMs));
      return response;
    },
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 100,
    refreshIntervalMs: 0,
    webSocketFactory: (url) => {
      const socket = new WebSocket(url, { headers: { ...host.ownerHeaders, origin: host.origin } });
      sockets.push(socket);
      return socket;
    },
  });
  await client.load();
  return {
    activateWorkspace: (workspaceId) => client.activateWorkspace(workspaceId),
    dispose: () => client.dispose(),
    getSnapshot: () => client.getSnapshot(),
    requests,
    sockets,
    retainBrowserWatch: (sessionId, surfaceId) => client.retainBrowserWatch(sessionId, surfaceId),
    browserWatchState: (sessionId, surfaceId) => client.browserWatchState(sessionId, surfaceId),
  };
}

const ofType = (listener: Listener, type: string, from = 0) =>
  listener.messages.slice(from).filter((message) => message.type === type);

function presenceOf(listener: Listener, from: number, sessionId: string) {
  return ofType(listener, "host.browser-presence", from).flatMap(
    (message) =>
      (message.sessions as { sessionId: string; acting: boolean; page: unknown }[]).filter(
        (session) => session.sessionId === sessionId,
      ) ?? [],
  );
}

integration("Browser presence and conversation usage", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  });

  it("cold-loads all 100 × 64 tab identities and 64 × 16 occupants after missing deferred notices", async () => {
    const database = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    cleanups.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Maximum catalog",
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "maximum-caller",
        name: "Maximum catalog",
      }),
    });
    cleanups.push(() => caller.close());
    const firstRun = await dispatchCallerRun(host, caller, {
      key: "maximum",
      title: "Maximum catalog",
    });
    const runtime = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "maximum-browser",
        name: "Maximum browser",
      }),
      { agentReady: true, targetedStreaming: true },
    );
    cleanups.push(() => runtime.close());
    await until(() => (host.runtime.browser.available ? true : undefined));
    const sessionIds = [];
    const surfaces = Array.from({ length: 64 }, (_, order) => ({
      id: `maximum-${order}`,
      active: order === 0,
      title: "界".repeat(256),
      url: `https://example.com/${order}`,
      order,
      documentId: `doc-${order}-` + "界".repeat(240),
      geometryRevision: 1,
      openerId: null,
    }));
    let producer = runtime;
    for (let index = 0; index < 100; index++) {
      if (index > 0 && index % 32 === 0) {
        producer = await startBrowserRuntime(
          host.hostPort,
          await enrollmentToken(host, {
            allowedModules: ["browser"],
            idempotencyKey: `maximum-browser-${index}`,
            name: `Maximum browser ${index}`,
          }),
          { agentReady: true, targetedStreaming: true },
        );
        const held = producer;
        cleanups.push(() => held.close());
      }
      const opened = await host.runtime.browser.start({
        ownerId: host.ownerId,
        workspaceId: firstRun.workspaceId,
        fresh: true,
        origin: "workspace",
        reuseExisting: false,
        placement: { kind: "runner", runnerId: producer.runnerId },
      });
      sessionIds.push(opened.session.id);
      producer.sendServer({ type: "browser.surfaces.changed", surfaces }, opened.session.id);
    }
    const sessionId = sessionIds[0]!;
    const source = (await host.store.getThreadForOwner(firstRun.threadId, host.ownerId))!;
    const threadIds = [firstRun.threadId];
    const runIds = [firstRun.runId];
    for (let index = 1; index < 16; index++) {
      const { thread } = await host.store.createThread({
        createdBy: host.ownerId,
        environmentId: source.environmentId,
        harnessInstanceId: source.harnessInstanceId,
        idempotencyKey: `maximum-thread-${index}`,
        modelSelection: source.modelSelection,
        title: `Occupant ${index}`,
        workspaceId: source.workspaceId,
      });
      const admitted = await host.store.enqueueThreadInput({
        requestedBy: host.ownerId,
        threadId: thread.id,
        content: [{ type: "text", text: "Hold this inventory" }],
        idempotencyKey: `maximum-input-${index}`,
        policy: "queue",
        source: { kind: "human" },
      });
      if (!admitted.run || !admitted.command) throw new Error("No maximum-inventory Run");
      await host.store.claimCommand(admitted.command.id, `maximum-dispatch-${index}`);
      await host.store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 120_000),
        continuationIdentity: {
          continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
          driverKind: (await host.store.getHarnessInstance(source.harnessInstanceId))!.driverKind,
        },
        harnessInstanceId: source.harnessInstanceId,
        leaseTokenHash: `maximum-${index}`,
        membershipGeneration: 1,
        runnerBootId: caller.primary.bootId,
        runnerId: caller.runnerId,
        runId: admitted.run.id,
        threadId: thread.id,
      });
      threadIds.push(thread.id);
      runIds.push(admitted.run.id);
    }
    // Seed the maximal durable holding projection, rather than requiring a tool to visit
    // 1,024 pages during the activity TTL. Every subject and Run is real PostgreSQL state.
    for (const [index, runId] of runIds.entries()) {
      await host.store.attachBrowserSession({
        agentBindingId: `run:${runId}`,
        ownerId: host.ownerId,
        sessionId,
        workspaceId: source.workspaceId,
      });
      await host.store.database
        .insertInto("browserSessionUses")
        .values(
          surfaces.map((surface) => ({
            id: randomUUID(),
            sessionId,
            threadId: threadIds[index]!,
            runId,
            tabId: surface.id,
            pageTitle: surface.title,
            pageSite: "https://example.com",
            firstUsedAt: new Date(),
            lastUsedAt: new Date(),
          })),
        )
        .execute();
    }
    const omitted = await host.runtime.browser.bootstrap(host.ownerId);
    expect(omitted.sessions).toHaveLength(100);
    expect(omitted.sessions.every((session) => session.tabCatalog === undefined)).toBe(true);
    // Let all coalesced notices go by before the cold client's realtime socket exists.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const client = await reader(host, 350);
    cleanups.push(async () => client.dispose());
    const loaded = client.getSnapshot().browserSessions;
    expect(loaded).toHaveLength(100);
    expect(loaded.every((session) => session.tabCatalog?.tabs.length === 64)).toBe(true);
    const occupied = loaded.find((session) => session.id === sessionId)!.tabCatalog!;
    expect(occupied.tabs.every((tab) => tab.occupants.length === 16)).toBe(true);
    expect(occupied.tabs.every((tab) => tab.occupants.every((occupant) => occupant.holding))).toBe(
      true,
    );
    expect(occupied.tabs.flatMap((tab) => tab.occupants)).toHaveLength(1024);
    const bytes = Buffer.byteLength(JSON.stringify(occupied));
    expect(bytes).toBeGreaterThan(128 * 1024);
    expect(client.requests.filter((request) => request.includes("browser.tabs.get"))).toHaveLength(
      100,
    );
    const outsider = await signUpUser(host, {
      email: "maximum-stranger@example.com",
      password: "maximum-stranger-password",
    });
    const refused = await testRpcRequest(
      host.origin,
      "browser.tabs.get",
      { sessionId },
      { headers: outsider.headers },
    );
    expect(refused.status).toBe(404);
    const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "maximum-cold-catalog.json"),
        JSON.stringify(
          {
            identities: loaded.map((session) => ({
              sessionId: session.id,
              tabIds: session.tabCatalog!.tabs.map((tab) => tab.id),
            })),
            occupied,
            bytes,
            requests: client.requests,
            delayBootstrapMs: 350,
            refreshIntervalMs: 0,
            outsiderStatus: refused.status,
          },
          null,
          2,
        ),
      );
    }
  }, 120_000);

  it("cold-loads revisioned tabs, attributes admitted activity, fences stop, and replays accepted auto sends", async () => {
    const database = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    cleanups.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Catalog caller",
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "catalog-caller",
        name: "Catalog caller",
      }),
    });
    cleanups.push(() => caller.close());
    const run = await dispatchCallerRun(host, caller, { key: "catalog", title: "Catalog task" });
    const runtime = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "catalog-browser",
        name: "Catalog browser",
      }),
      { agentReady: true, targetedStreaming: true, workspaceTabs: true },
    );
    cleanups.push(() => runtime.close());
    await until(() => (host.runtime.browser.available ? true : undefined));
    const owner = await listen(host, host.ownerHeaders);
    cleanups.push(() => owner.close());
    const stranger = await signUpUser(host, {
      email: "catalog-stranger@example.com",
      password: "catalog-stranger-password",
    });
    const outsider = await listen(host, stranger.headers);
    cleanups.push(() => outsider.close());
    const opened = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "browser.session.start",
        workspaceId: run.workspaceId,
        idempotencyKey: "catalog-session",
        input: { fresh: true },
      },
      { headers: host.ownerHeaders },
    );
    if (opened.type !== "browser.session.start") throw new Error("Unexpected command");
    const sessionId = opened.session.id;
    const surfaces = ["x", "y", "z"].map((id, order) => ({
      id: `page-${id}`,
      active: id === "x",
      title: id.toUpperCase(),
      url: `https://${id}.example/private?token=hidden`,
      order,
      documentId: `document-${id}`,
      geometryRevision: 1,
      openerId: null,
      ...(id === "x"
        ? {
            favicon:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=",
          }
        : {}),
    }));
    runtime.sendServer({ type: "browser.surfaces.changed", surfaces });
    runtime.sendServer({
      type: "browser.workspace-tabs",
      tabs: surfaces,
      closed: ["page-integration"],
    });
    let cold = await host.runtime.browser.bootstrap(host.ownerId);
    await until(() =>
      ofType(owner, "host.browser-tabs-changed").some(
        (message) => (message.catalog as { tabs: unknown[] }).tabs.length === 3,
      )
        ? true
        : undefined,
    );
    cold = await host.runtime.browser.bootstrap(host.ownerId);
    const initial = cold.sessions.find((session) => session.id === sessionId)?.tabCatalog;
    expect(initial?.tabs.map(({ id }) => id)).toEqual(["page-x", "page-y", "page-z"]);
    expect(
      initial?.tabs.every((tab) => tab.occupants.length === 0 && !tab.site.includes("private")),
    ).toBe(true);
    expect(runtime.receivedCommands().some((command) => command.type === "stream.subscribe")).toBe(
      false,
    );
    const iconRef = initial?.tabs.find((tab) => tab.id === "page-x")?.iconRef;
    expect(iconRef).toBeTruthy();
    const icon = await testRpcData(
      host.origin,
      "browser.tabIcon.get",
      { sessionId, iconRef: iconRef! },
      { headers: host.ownerHeaders },
    );
    expect(icon.favicon).toContain("data:image/png;base64,");
    const deniedIcon = await testRpcRequest(
      host.origin,
      "browser.tabIcon.get",
      { sessionId, iconRef: iconRef! },
      { headers: stranger.headers },
    );
    expect(deniedIcon.status).toBe(404);
    const consumers: {
      surfaceId: string;
      mode: "control" | "watch";
      socket: WebSocket;
      frames: ReturnType<typeof decodeBrowserFrameEnvelope>["header"][];
    }[] = [];
    for (const [surfaceId, mode] of [
      ["page-x", "control"],
      ["page-y", "watch"],
      ["page-z", "watch"],
    ] as const) {
      const socket = new WebSocket(
        `ws://127.0.0.1:${host.hostPort}/v1/browser-sessions/${sessionId}/connect?mode=${mode}`,
        { headers: { ...host.ownerHeaders, origin: host.origin } },
      );
      cleanups.push(async () => socket.terminate());
      const frames: ReturnType<typeof decodeBrowserFrameEnvelope>["header"][] = [];
      socket.on("message", (raw: WebSocket.RawData, binary: boolean) => {
        if (!binary) return;
        const envelope = decodeBrowserFrameEnvelope(rawDataBuffer(raw));
        frames.push(envelope.header);
        if (envelope.header.watchToken)
          socket.send(
            JSON.stringify({ type: "stream.ack", surfaceId, token: envelope.header.watchToken }),
          );
      });
      await waitForMessage(socket, (message) => message.type === "browser.snapshot");
      socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId }));
      expect(await runtime.nextCommand()).toMatchObject({ type: "stream.subscribe", surfaceId });
      consumers.push({ surfaceId, mode, socket, frames });
    }
    consumers[0]!.socket.send(
      JSON.stringify({ type: "clipboard.paste", surfaceId: "page-x", text: "editing X" }),
    );
    expect(await runtime.nextCommand()).toMatchObject({
      type: "clipboard.paste",
      surfaceId: "page-x",
      text: "editing X",
    });
    for (const [index, surface] of surfaces.entries()) {
      const header = Buffer.from(
        JSON.stringify({
          encoding: "png",
          frameId: index + 1,
          geometryRevision: 1,
          surfaceId: surface.id,
          viewportWidth: 800,
          viewportHeight: 600,
          rasterWidth: 1,
          rasterHeight: 1,
        }),
      );
      const size = Buffer.alloc(4);
      size.writeUInt32BE(header.byteLength);
      runtime.sendFrame(
        Buffer.concat([
          size,
          header,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=",
            "base64",
          ),
        ]),
      );
    }
    await until(() =>
      consumers.every((consumer) => consumer.frames.length === 1) ? true : undefined,
    ).catch((error: unknown) => {
      throw new Error(
        JSON.stringify({
          consumers: consumers.map(({ surfaceId, frames, socket }) => ({
            surfaceId,
            frames,
            readyState: socket.readyState,
          })),
          commands: runtime.receivedCommands(),
          protocolErrors: runtime.protocolErrors(),
        }),
        { cause: error },
      );
    });
    for (const consumer of consumers)
      expect(consumer.frames.map((frame) => frame.surfaceId)).toEqual([consumer.surfaceId]);
    expect(
      runtime
        .receivedCommands()
        .some((command) =>
          ["surface.activate", "viewport.follow", "viewport.set"].includes(String(command.type)),
        ),
    ).toBe(false);
    const liveClient = await reader(host);
    cleanups.push(async () => liveClient.dispose());
    liveClient.activateWorkspace(run.workspaceId);
    await until(() => (liveClient.getSnapshot().connection === "connected" ? true : undefined));
    const releaseWatch = liveClient.retainBrowserWatch(sessionId, "page-y");
    cleanups.push(async () => releaseWatch());
    await until(() =>
      liveClient.browserWatchState(sessionId, "page-y").status === "live" ? true : undefined,
    );
    runtime.sendServer({
      type: "browser.error",
      error: { code: "conflict", message: "The browser dialog changed.", retryable: false },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(liveClient.browserWatchState(sessionId, "page-y")).toMatchObject({
      status: "live",
      error: null,
    });
    const targetSocket = liveClient.sockets.findLast((socket) =>
      socket.url.includes("/browser-sessions/"),
    )!;
    targetSocket.terminate();
    await until(() =>
      liveClient.sockets.filter((socket) => socket.url.includes("/browser-sessions/")).length >= 2
        ? true
        : undefined,
    );
    await until(() =>
      liveClient.browserWatchState(sessionId, "page-y").status === "live" ? true : undefined,
    );
    const binding = `run:${run.runId}`;
    const cdp = await host.runtime.browser.attachCdpForAgent(
      { agentBindingId: binding, ownerId: host.ownerId, sessionId, workspaceId: run.workspaceId },
      () => undefined,
    );
    cleanups.push(async () => cdp.close());
    const warm = cdp.request({ method: "Target.getTargets" });
    const warmCommand = await runtime.nextCommand();
    runtime.sendServer({
      type: "cdp.result",
      requestId: warmCommand.requestId,
      result: { targetInfos: [] },
    });
    await warm;
    // Activity alone is not a durable holding. Retain the target through the
    // real attach-result contract before asserting the Run occupies its tab.
    const attach = cdp.request({
      method: "Target.attachToTarget",
      parameters: { targetId: "target-y", flatten: true },
    });
    const attachCommand = await runtime.nextCommand();
    runtime.sendServer({
      type: "cdp.result",
      requestId: attachCommand.requestId,
      result: { sessionId: "cdp-y", surfaceId: "page-y" },
    });
    await attach;
    await until(async () => {
      const catalogs = await host.runtime.browser.catalogsForViewers(sessionId);
      return [...catalogs.values()].some((catalog) =>
        catalog.tabs.some(
          (tab) => tab.id === "page-y" && tab.occupants.some((occupant) => occupant.holding),
        ),
      )
        ? true
        : undefined;
    });
    const acting = cdp.request({
      method: "Runtime.evaluate",
      parameters: { expression: "void 0" },
      sessionId: "cdp-y",
    });
    const command = await runtime.nextCommand();
    expect(command.type).toBe("cdp.command");
    expect(typeof command.actorToken).toBe("string");
    runtime.sendServer({
      type: "browser.activity",
      actorToken: command.actorToken,
      surfaceId: "page-y",
      seq: 1,
      geometryRevision: 1,
      pointer: { x: 0.25, y: 0.5 },
    });
    runtime.sendServer({ type: "cdp.result", requestId: command.requestId, result: {} });
    await acting;
    const activity = await until(() => ofType(owner, "host.place-activity")[0]);
    expect(activity).toMatchObject({
      activity: {
        threadId: run.threadId,
        runId: run.runId,
        place: { sessionId, surfaceId: "page-y" },
      },
    });
    expect(activity.activity).not.toHaveProperty("lineageThreadIds");
    expect(activity.activity).not.toHaveProperty("lineageWorkspaceIds");
    // The Thread's newest place names the Run that acted there, which is what
    // lets exactly that Run's reply draw it.
    expect(await until(() => ofType(owner, "host.thread-place-changed")[0])).toMatchObject({
      reference: {
        threadId: run.threadId,
        runId: run.runId,
        place: { kind: "browser", sessionId, surfaceId: "page-y" },
      },
    });
    const occupied = (await host.runtime.browser.bootstrap(host.ownerId)).sessions.find(
      (session) => session.id === sessionId,
    )?.tabCatalog;
    expect(occupied?.tabs.find((tab) => tab.id === "page-y")?.occupants).toEqual([
      expect.objectContaining({ threadId: run.threadId, holding: true, acting: true }),
    ]);
    const latestBeforeExpiry = await host.runtime.browser.latestPlaces(host.ownerId);
    expect(latestBeforeExpiry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: run.threadId, runId: run.runId }),
      ]),
    );
    await until(
      () =>
        ofType(owner, "host.browser-tabs-changed")
          .flatMap((message) =>
            (
              message.catalog as {
                tabs: { id: string; occupants: { holding: boolean; acting: boolean }[] }[];
              }
            ).tabs.filter((tab) => tab.id === "page-y"),
          )
          .at(-1)
          ?.occupants.some((occupant) => occupant.holding && !occupant.acting)
          ? true
          : undefined,
      actingWindowMs + 5_000,
    );
    expect(await host.runtime.browser.latestPlaces(host.ownerId)).toEqual(latestBeforeExpiry);
    host.runtime.browser.invalidatePlaceAuthority(run.workspaceId, [run.threadId]);
    const stillHolding = (await host.runtime.browser.bootstrap(host.ownerId)).sessions.find(
      (session) => session.id === sessionId,
    )?.tabCatalog;
    expect(stillHolding?.tabs.find((tab) => tab.id === "page-y")?.occupants).toEqual([
      expect.objectContaining({ threadId: run.threadId, holding: true, acting: false }),
    ]);

    const resumingFrom = owner.messages.length;
    runtime.sendServer({
      type: "browser.activity",
      actorToken: command.actorToken,
      surfaceId: "page-y",
      seq: 2,
      geometryRevision: 1,
      pointer: null,
    });
    await until(() =>
      ofType(owner, "host.browser-tabs-changed", resumingFrom).some((message) =>
        (
          message.catalog as {
            tabs: { id: string; occupants: { holding: boolean; acting: boolean }[] }[];
          }
        ).tabs.some(
          (tab) => tab.id === "page-y" && tab.occupants.some((occupant) => occupant.acting),
        ),
      )
        ? true
        : undefined,
    );
    expect(ofType(outsider, "host.browser-tabs-changed")).toHaveLength(0);
    expect(ofType(outsider, "host.place-activity")).toHaveLength(0);
    const page = {
      type: "browser-page" as const,
      sessionId,
      tabId: BrowserSurfaceIdSchema.parse("page-y"),
      title: "Y",
      url: "https://y.example/private",
      documentId: "document-y",
      auto: true,
    };
    const send = {
      type: "thread.sendMessage" as const,
      threadId: run.threadId,
      idempotencyKey: "auto-once",
      content: [{ type: "text" as const, text: "Use this page" }, page],
    };
    let releaseCommit!: () => void;
    let beforeCommit!: () => void;
    const reachedCommit = new Promise<void>((resolve) => {
      beforeCommit = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const enqueue = host.store.enqueueThreadInput.bind(host.store);
    const enqueueProbe = vi
      .spyOn(host.store, "enqueueThreadInput")
      .mockImplementation(async (input) => {
        if (input.idempotencyKey === send.idempotencyKey) {
          beforeCommit();
          await commitGate;
        }
        return enqueue(input);
      });
    const candidate = {
      sessionId,
      tabId: page.tabId,
      documentId: "new-document",
      title: "Sign in",
      url: page.url,
      eligibility: "blocked" as const,
      reason: "form" as const,
      checkedAt: new Date().toISOString(),
    };
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: surfaces.map((surface) =>
        surface.id === page.tabId ? { ...surface, documentId: candidate.documentId } : surface,
      ),
    });
    await until(async () =>
      (await host.runtime.browser.readTabCatalog(host.ownerId, sessionId)).tabs.some(
        (tab) => tab.id === page.tabId && tab.documentId === candidate.documentId,
      )
        ? true
        : undefined,
    );
    const pendingSignIn = await host.store.requests.openPasswordSignIn({
      callId: "auto-page-sign-in",
      kind: "browser.password-sign-in",
      mode: "durable",
      originatingRunId: run.runId,
      originatingThreadId: run.threadId,
      originatingWorkspaceId: run.workspaceId,
      requestedBy: host.ownerId,
      requiredActor: "requester",
      targetWorkspaceId: run.workspaceId,
      payload: {
        kind: "browser.password-sign-in",
        tabId: page.tabId,
        computerName: "Catalog browser",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        operationId: randomUUID(),
        reason: "Sign in to this page",
        runnerId: runtime.runnerId,
        sessionId,
        site: "https://y.example",
      },
      presentation: {
        kind: "external",
        detail: "Sign in to this page",
        subject: { kind: "browser-site", id: "https://y.example" },
        title: "Sign in",
      },
    });
    expect(pendingSignIn.request.status).toBe("pending");
    const normalizedCandidates = [];
    for (const eligibility of ["blocked", "unknown"] as const) {
      const reading = testRpcData(
        host.origin,
        "browser.contextCandidate.get",
        { sessionId, tabId: page.tabId },
        { headers: host.ownerHeaders },
      );
      const command = await runtime.nextCommand();
      expect(command).toMatchObject({
        type: "cdp.command",
        command: { method: "Opensteer.contextCandidate", parameters: { surfaceId: page.tabId } },
      });
      runtime.sendServer({
        type: "cdp.result",
        requestId: command.requestId,
        result: {
          ...candidate,
          eligibility,
          reason: eligibility === "blocked" ? "form" : "unavailable",
        },
      });
      const normalized = await reading;
      expect(normalized).toMatchObject({
        sessionId,
        tabId: page.tabId,
        documentId: candidate.documentId,
        title: candidate.title,
        url: candidate.url,
        eligibility: "eligible",
        reason: null,
        checkedAt: expect.any(String),
      });
      expect(Number.isFinite(Date.parse(normalized.checkedAt!))).toBe(true);
      normalizedCandidates.push({ runtimeEligibility: eligibility, candidate: normalized });
    }
    const contextReads = vi
      .spyOn(host.runtime.browser, "readContextCandidate")
      .mockResolvedValue(candidate);
    const commandsBeforeAdmission = runtime.receivedCommands().length;
    const first = testRpcData(host.origin, "commands.dispatch", send, {
      headers: host.ownerHeaders,
    });
    await Promise.race([reachedCommit, first]);
    let retrySettled = false;
    const second = testRpcData(host.origin, "commands.dispatch", send, {
      headers: host.ownerHeaders,
    }).finally(() => {
      retrySettled = true;
    });
    const original = (await host.store.getThreadForOwner(run.threadId, host.ownerId))!;
    const otherThread = await host.store.createThread({
      accessMode: original.accessMode,
      createdBy: host.ownerId,
      environmentId: original.environmentId,
      harnessInstanceId: original.harnessInstanceId,
      modelSelection: original.modelSelection,
      workspaceId: original.workspaceId,
      title: "Unrelated send",
      idempotencyKey: "admission-unrelated-thread",
    });
    const ordinary = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "thread.sendMessage",
        threadId: otherThread.thread.id,
        idempotencyKey: "while-commit-pending",
        content: [{ type: "text", text: "An unrelated send proceeds before A commits" }],
      },
      { headers: host.ownerHeaders },
    );
    expect(ordinary.type).toBe("thread.sendMessage");
    expect(retrySettled).toBe(false);
    expect(contextReads).not.toHaveBeenCalled();
    expect(runtime.receivedCommands().slice(commandsBeforeAdmission)).toEqual([]);
    expect(await host.store.hasAcceptedThreadInput(host.ownerId, send.idempotencyKey)).toBe(false);
    releaseCommit();
    const accepted = await Promise.all([first, second]);
    enqueueProbe.mockRestore();
    const runtimeCommandsDuringAdmission = runtime
      .receivedCommands()
      .slice(commandsBeforeAdmission);
    expect(runtimeCommandsDuringAdmission).toEqual([]);
    contextReads.mockRestore();
    expect(accepted[0]).toMatchObject({ type: "thread.sendMessage", wasDuplicate: false });
    expect(accepted[1]).toMatchObject({ type: "thread.sendMessage", wasDuplicate: true });
    if (accepted[0]?.type !== "thread.sendMessage" || accepted[1]?.type !== "thread.sendMessage")
      throw new Error("Send mismatch");
    expect(accepted[0].message.id).toBe(accepted[1].message.id);
    expect(accepted[0].message.content).toEqual(send.content);
    const messages = await host.store.database
      .selectFrom("messages")
      .select("id")
      .where("threadId", "=", run.threadId)
      .where(sql<boolean>`content->0->>'text' = 'Use this page'`)
      .execute();
    expect(messages).toEqual([{ id: accepted[0].message.id }]);
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: surfaces.map((surface) =>
        surface.id === "page-y"
          ? { ...surface, documentId: "new-document", title: "Sign in" }
          : surface,
      ),
    });
    const replayCommandsFrom = runtime.receivedCommands().length;
    const replay = await testRpcData(host.origin, "commands.dispatch", send, {
      headers: host.ownerHeaders,
    });
    expect(replay).toMatchObject({
      type: "thread.sendMessage",
      wasDuplicate: true,
      message: { id: accepted[0].message.id },
    });
    expect(runtime.receivedCommands().slice(replayCommandsFrom)).toEqual([]);
    expect(
      await host.store.database
        .selectFrom("messages")
        .select("id")
        .where("threadId", "=", run.threadId)
        .where(sql<boolean>`content->0->>'text' = 'Use this page'`)
        .execute(),
    ).toEqual(messages);
    const inFlight = cdp.request({
      method: "Runtime.evaluate",
      parameters: { expression: "void 0" },
      sessionId: "cdp-y",
    });
    const lateCommand = await runtime.nextCommand();
    expect(lateCommand.type).toBe("cdp.command");
    await run.complete();
    await until(() => ofType(owner, "host.place-activity-cleared")[0]);
    const beforeLate = ofType(owner, "host.place-activity").length;
    runtime.sendServer({
      type: "browser.activity",
      actorToken: lateCommand.actorToken,
      surfaceId: "page-y",
      seq: 99,
      geometryRevision: 1,
      pointer: { x: 0.9, y: 0.9 },
    });
    runtime.sendServer({ type: "cdp.result", requestId: lateCommand.requestId, result: {} });
    await inFlight;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ofType(owner, "host.place-activity")).toHaveLength(beforeLate);
    runtime.sendServer({ type: "browser.surfaces.changed", surfaces: [] });
    runtime.sendServer({
      type: "browser.workspace-tabs",
      tabs: [],
      closed: surfaces.map(({ id }) => id),
    });
    await until(async () =>
      (await host.runtime.browser.readTabCatalog(host.ownerId, sessionId)).tabs.length === 0
        ? true
        : undefined,
    );
    const historical = [];
    for (const state of ["tab-closed", "session-closed"] as const) {
      if (state === "session-closed") {
        const stopped = await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "browser.session.close",
            sessionId,
            idempotencyKey: "close-frozen-session",
          },
          { headers: host.ownerHeaders },
        );
        expect(stopped.type).toBe("browser.session.close");
        expect(await host.store.getBrowserSessionForOwner(sessionId, host.ownerId)).toMatchObject({
          state: "closed",
        });
      }
      const commandsFrom = runtime.receivedCommands().length;
      const sent = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          ...send,
          idempotencyKey: state,
        },
        { headers: host.ownerHeaders },
      );
      expect(sent).toMatchObject({ type: "thread.sendMessage", wasDuplicate: false });
      if (sent.type !== "thread.sendMessage") throw new Error("Historical send mismatch");
      expect(sent.message.content).toContainEqual(page);
      expect(runtime.receivedCommands().slice(commandsFrom)).toEqual([]);
      historical.push({ state, messageId: sent.message.id });
    }
    const main = await host.store.findMainWorkspaceForOwner(host.ownerId);
    if (!main) throw new Error("Main Workspace missing");
    const mainThread = await host.store.createThread({
      accessMode: original.accessMode,
      createdBy: host.ownerId,
      environmentId: original.environmentId,
      harnessInstanceId: original.harnessInstanceId,
      modelSelection: original.modelSelection,
      workspaceId: main.id,
      title: "Revoked browser reference",
      idempotencyKey: "revoked-reference-thread",
    });
    await host.store.database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: run.workspaceId,
        userId: stranger.userId,
        role: "owner",
        state: "active",
        generation: 1,
        invitedBy: host.ownerId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    await host.store.database
      .updateTable("workspaceMemberships")
      .set({
        state: "revoked",
        revokedAt: new Date(),
        revokedBy: stranger.userId,
        updatedAt: new Date(),
        generation: sql`${sql.ref("generation")} + 1`,
      })
      .where("workspaceId", "=", run.workspaceId)
      .where("userId", "=", host.ownerId)
      .execute();
    expect(await host.store.getBrowserSessionForOwner(sessionId, host.ownerId)).toBeNull();
    const commandsBeforeRefusal = runtime.receivedCommands().length;
    const visibilityRefusal = await testRpcRequest(
      host.origin,
      "commands.dispatch",
      {
        ...send,
        threadId: mainThread.thread.id,
        idempotencyKey: "revoked-browser-page",
      },
      { headers: host.ownerHeaders },
    );
    expect(visibilityRefusal.status).toBe(403);
    expect(runtime.receivedCommands().slice(commandsBeforeRefusal)).toEqual([]);
    expect(await visibilityRefusal.json()).toMatchObject({
      error: { code: "forbidden", message: expect.stringContaining("can no longer see") },
    });
    expect(
      await host.store.database
        .selectFrom("messages")
        .select("id")
        .where("threadId", "=", mainThread.thread.id)
        .execute(),
    ).toEqual([]);
    const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "catalog-attribution.json"),
        JSON.stringify(
          {
            sessionId,
            initial,
            occupied,
            activity,
            targetedReconnect: {
              sockets: liveClient.sockets.filter((socket) =>
                socket.url.includes("/browser-sessions/"),
              ).length,
              state: liveClient.browserWatchState(sessionId, "page-y"),
            },
            targetedConsumers: consumers.map(({ surfaceId, mode, frames }) => ({
              surfaceId,
              mode,
              frames,
            })),
            admission: {
              submitted: send,
              runtimeCommandsDuringAdmission,
              pendingSignInRequestId: pendingSignIn.request.id,
              normalizedCandidates,
              historical,
              visibilityRefusalStatus: visibilityRefusal.status,
              retryWaitedBeforeCommit: true,
              contextReadsDuringAdmission: 0,
              oneCommittedMessage: true,
              ordinaryCompletedBeforeCommit: ordinary.type === "thread.sendMessage",
              ordinaryMessageId:
                ordinary.type === "thread.sendMessage" ? ordinary.message.id : null,
              retryClassificationIfRechecked: "blocked/form",
              replayMessageId: replay.type === "thread.sendMessage" ? replay.message.id : null,
            },
            accepted: accepted.map((result) =>
              result.type === "thread.sendMessage"
                ? { messageId: result.message.id, duplicate: result.wasDuplicate }
                : null,
            ),
            owner: owner.messages.filter((message) =>
              [
                "host.browser-tabs-changed",
                "host.place-activity",
                "host.place-activity-cleared",
                "host.thread-place-changed",
              ].includes(String(message.type)),
            ),
            outsider: outsider.messages.filter(
              (message) =>
                String(message.type).includes("place") ||
                String(message.type).includes("browser-tabs"),
            ),
          },
          null,
          2,
        ),
      );
    }
  }, 60_000);

  it("announces a later Run acting in the same page as its Thread's newest place", async () => {
    const database = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    cleanups.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Same page caller",
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "same-page-caller",
        name: "Same page caller",
      }),
    });
    cleanups.push(() => caller.close());
    const first = await dispatchCallerRun(host, caller, { key: "same-page", title: "Same page" });
    const runtime = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "same-page-browser",
        name: "Same page browser",
      }),
      { agentReady: true, targetedStreaming: true },
    );
    cleanups.push(() => runtime.close());
    await until(() => (host.runtime.browser.available ? true : undefined));
    const owner = await listen(host, host.ownerHeaders);
    cleanups.push(() => owner.close());
    const opened = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "browser.session.start",
        workspaceId: first.workspaceId,
        idempotencyKey: "same-page-session",
        input: { fresh: true },
      },
      { headers: host.ownerHeaders },
    );
    if (opened.type !== "browser.session.start") throw new Error("Unexpected command");
    const sessionId = opened.session.id;
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        {
          id: "page-shared",
          active: true,
          title: "Shared",
          url: "https://shared.example/",
          order: 0,
          documentId: "document-shared",
          geometryRevision: 1,
          openerId: null,
        },
      ],
    });
    await until(async () =>
      (await host.runtime.browser.bootstrap(host.ownerId)).sessions
        .find((session) => session.id === sessionId)
        ?.tabCatalog?.tabs.some((tab) => tab.id === "page-shared")
        ? true
        : undefined,
    );
    // The Runtime also hears the Host's own housekeeping; each step answers only its own command.
    const nextCdp = async (method: string) => {
      for (;;) {
        const command = await runtime.nextCommand();
        if (
          command.type === "cdp.command" &&
          (command.command as { method?: string } | undefined)?.method === method
        )
          return command;
      }
    };
    const actIn = async (run: typeof first, cdpSession: string) => {
      const cdp = await host.runtime.browser.attachCdpForAgent(
        {
          agentBindingId: `run:${run.runId}`,
          ownerId: host.ownerId,
          sessionId,
          workspaceId: run.workspaceId,
        },
        () => undefined,
      );
      cleanups.push(async () => cdp.close());
      const warm = cdp.request({ method: "Target.getTargets" });
      const warmCommand = await nextCdp("Target.getTargets");
      runtime.sendServer({
        type: "cdp.result",
        requestId: warmCommand.requestId,
        result: { targetInfos: [] },
      });
      await warm;
      const attach = cdp.request({
        method: "Target.attachToTarget",
        parameters: { targetId: "target-shared", flatten: true },
      });
      const attachCommand = await nextCdp("Target.attachToTarget");
      runtime.sendServer({
        type: "cdp.result",
        requestId: attachCommand.requestId,
        result: { sessionId: cdpSession, surfaceId: "page-shared" },
      });
      await attach;
      // Acting is attributed once the Host has resolved this Run as the tab's holder.
      await until(async () =>
        [...(await host.runtime.browser.catalogsForViewers(sessionId)).values()].some((catalog) =>
          catalog.tabs.some(
            (tab) =>
              tab.id === "page-shared" &&
              tab.occupants.some(
                (occupant) => occupant.threadId === run.threadId && occupant.holding,
              ),
          ),
        )
          ? true
          : undefined,
      );
      const acting = cdp.request({
        method: "Runtime.evaluate",
        parameters: { expression: "void 0" },
        sessionId: cdpSession,
      });
      const command = await nextCdp("Runtime.evaluate");
      expect(typeof command.actorToken).toBe("string");
      runtime.sendServer({
        type: "browser.activity",
        actorToken: command.actorToken,
        surfaceId: "page-shared",
        seq: 1,
        geometryRevision: 1,
        pointer: null,
      });
      runtime.sendServer({ type: "cdp.result", requestId: command.requestId, result: {} });
      await acting;
    };
    const named = (runId: string) =>
      ofType(owner, "host.thread-place-changed").find(
        (message) => (message.reference as { runId?: string }).runId === runId,
      );

    await actIn(first, "cdp-first");
    expect(await until(() => named(first.runId))).toMatchObject({
      reference: { threadId: first.threadId, place: { surfaceId: "page-shared" }, title: "Shared" },
    });
    await first.complete();
    // The same Thread's next Run, in the same page, title and site as the first.
    const second = await dispatchCallerRun(host, caller, {
      key: "same-page-again",
      title: "Same page",
      threadId: first.threadId,
      workspaceId: first.workspaceId,
    });
    expect(second.runId).not.toBe(first.runId);
    await actIn(second, "cdp-second");
    expect(await until(() => named(second.runId))).toMatchObject({
      reference: { threadId: first.threadId, place: { surfaceId: "page-shared" }, title: "Shared" },
    });
    expect(
      (await host.runtime.browser.latestPlaces(host.ownerId)).find(
        (reference) => reference.threadId === first.threadId,
      ),
    ).toMatchObject({ runId: second.runId });
  }, 60_000);

  it("patches viewers with page and acting changes, never rereads, and names credited conversations", async () => {
    const database: MachineAccessDatabase = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    cleanups.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Caller computer",
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "caller",
        name: "Caller computer",
      }),
    });
    cleanups.push(() => caller.close());
    const run = await dispatchCallerRun(host, caller, { key: "browse", title: "Shop for shoes" });
    const browserComputer = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "browser",
        name: "Browser computer",
      }),
      { agentReady: true },
    );
    cleanups.push(() => browserComputer.close());
    await until(() => (host.runtime.browser.available ? true : undefined));

    const owner = await listen(host, host.ownerHeaders, run.workspaceId);
    cleanups.push(() => owner.close());
    // The same person on a socket that follows no Workspace: the catalog is theirs.
    const ownerElsewhere = await listen(host, host.ownerHeaders);
    cleanups.push(() => ownerElsewhere.close());
    const stranger = await signUpUser(host, {
      email: "stranger@example.com",
      password: "stranger-browser-password",
    });
    const strangerSocket = await listen(host, stranger.headers);
    cleanups.push(() => strangerSocket.close());

    // The person opens a browser from the conversation; it belongs to it at once.
    const opened = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-open",
        input: { fresh: true, threadId: run.threadId },
        type: "browser.session.start",
        workspaceId: run.workspaceId,
      },
      { headers: host.ownerHeaders },
    );
    if (opened.type !== "browser.session.start") throw new Error("Browser command mismatch.");
    const sessionId = opened.session.id;
    const openedUsage = await until(
      () => ofType(owner, "host.browser-usage-changed")[0] as Record<string, unknown> | undefined,
    );
    expect(openedUsage).toEqual({
      threadIds: [run.threadId],
      type: "host.browser-usage-changed",
      workspaceId: run.workspaceId,
    });

    await until(() => ofType(ownerElsewhere, "host.browser-sessions-changed")[0]);
    const device = await reader(host);
    cleanups.push(async () => device.dispose());
    // Its default socket follows Main, while this browser belongs to the specialist Workspace.

    // A. The page changes. Viewers are patched; nothing is reread.
    const beforeNavigation = owner.messages.length;
    const beforeNavigationElsewhere = ownerElsewhere.messages.length;
    browserComputer.sendServer({
      surfaces: [
        {
          active: true,
          id: "page-integration",
          title: "Running shoes",
          url: "https://shop.example/shoes?size=10",
        },
      ],
      type: "browser.surfaces.changed",
    });
    const navigated = await until(() => presenceOf(owner, beforeNavigation, sessionId)[0]);
    expect(navigated).toEqual({
      acting: false,
      page: { title: "Running shoes", url: "https://shop.example" },
      sessionId,
    });
    await until(() => presenceOf(ownerElsewhere, beforeNavigationElsewhere, sessionId)[0]);
    browserComputer.sendServer({
      surfaces: [
        {
          active: true,
          id: "page-integration",
          title: "Running shoes — size 10",
          url: "https://shop.example/shoes?size=10&color=blue",
        },
      ],
      type: "browser.surfaces.changed",
    });
    await until(() =>
      presenceOf(owner, beforeNavigation, sessionId).find(
        (presence) => (presence.page as { title: string }).title === "Running shoes — size 10",
      ),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    const navigationNotices = owner.messages.slice(beforeNavigation).map(({ type }) => type);
    expect(navigationNotices).not.toContain("host.browser-sessions-changed");
    expect(navigationNotices).not.toContain("host.browser-usage-changed");

    // B. The agent acts.
    const binding = `run:${run.runId}`;
    const beforeAgent = owner.messages.length;
    const cdp = await host.runtime.browser.attachCdpForAgent(
      { agentBindingId: binding, ownerId: host.ownerId, sessionId, workspaceId: run.workspaceId },
      () => undefined,
    );
    const answer = async (
      command: { readonly method: string; readonly parameters?: Record<string, unknown> },
      result: Record<string, unknown>,
    ) => {
      const sent = cdp.request({ parameters: {}, ...command });
      const relayed = await browserComputer.nextCommand();
      expect(relayed).toMatchObject({ command: { method: command.method }, type: "cdp.command" });
      browserComputer.sendServer({ requestId: relayed.requestId, result, type: "cdp.result" });
      return sent;
    };
    // The Run's first use of the session is news to its conversation.
    await until(() => ofType(owner, "host.browser-usage-changed", beforeAgent)[0]);
    const firstCommandAt = Date.now();
    await answer({ method: "Target.getTargets" }, { targetInfos: [] });
    const actingOn = await until(() =>
      presenceOf(owner, beforeAgent, sessionId).find((presence) => presence.acting),
    );
    const actingOnAfterMs = Date.now() - firstCommandAt;
    expect(actingOn).toMatchObject({ acting: true, sessionId });
    const beforePage = owner.messages.length;
    await answer(
      { method: "Target.attachToTarget", parameters: { flatten: true, targetId: "target-shoes" } },
      { sessionId: "cdp-shoes", surfaceId: "page-integration" },
    );
    const pageUsage = await until(() => ofType(owner, "host.browser-usage-changed", beforePage)[0]);
    expect(pageUsage).toMatchObject({ threadIds: [run.threadId] });
    // Using the same page again moves only when; nobody is told.
    const beforeRevisit = owner.messages.length;
    await answer(
      { method: "Target.attachToTarget", parameters: { flatten: true, targetId: "target-shoes" } },
      { sessionId: "cdp-shoes-2", surfaceId: "page-integration" },
    );
    let lastCommandAt = Date.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(ofType(owner, "host.browser-usage-changed", beforeRevisit)).toEqual([]);
    const agentNotices = owner.messages.slice(beforeAgent).map(({ type }) => type);
    // Holding the session is a change in who is attached; acting and pages are not.
    expect(agentNotices.filter((type) => type === "host.browser-sessions-changed")).toHaveLength(1);

    const bootstrap = await testRpcData(
      host.origin,
      "bootstrap.get",
      {},
      {
        headers: host.ownerHeaders,
      },
    );
    const listed = bootstrap.browser.sessions.find(
      (session: { id: string }) => session.id === sessionId,
    );
    expect(listed).toMatchObject({
      acting: true,
      attachedRunIds: [run.runId],
      page: { title: "Running shoes — size 10", url: "https://shop.example" },
    });
    const usage = await testRpcData(
      host.origin,
      "thread.browserUsage.get",
      { runIds: [run.runId], threadId: run.threadId },
      { headers: host.ownerHeaders },
    );
    expect(usage.uses).toEqual([
      expect.objectContaining({ runId: null, sessionId, tabId: null }),
      expect.objectContaining({
        pageSite: "https://shop.example",
        pageTitle: "Running shoes — size 10",
        runId: run.runId,
        sessionId,
        tabId: "page-integration",
      }),
    ]);

    // A later attach sees navigation's new title/site and invalidates cached usage.
    const beforeRenamed = owner.messages.length;
    browserComputer.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        {
          active: true,
          id: "page-integration",
          title: "Checkout",
          url: "https://checkout.example/cart",
        },
      ],
    });
    await until(() =>
      presenceOf(owner, beforeRenamed, sessionId).find(
        (presence) => (presence.page as { title: string } | null)?.title === "Checkout",
      ),
    );
    await answer(
      { method: "Target.attachToTarget", parameters: { flatten: true, targetId: "target-shoes" } },
      { sessionId: "cdp-checkout", surfaceId: "page-integration" },
    );
    const renamedUsageNotice = await until(
      () => ofType(owner, "host.browser-usage-changed", beforeRenamed)[0],
    );
    expect(renamedUsageNotice).toMatchObject({ threadIds: [run.threadId] });
    const renamedUsage = await testRpcData(
      host.origin,
      "thread.browserUsage.get",
      { runIds: [run.runId], threadId: run.threadId },
      { headers: host.ownerHeaders },
    );
    expect(renamedUsage.uses).toContainEqual(
      expect.objectContaining({
        tabId: "page-integration",
        pageTitle: "Checkout",
        pageSite: "https://checkout.example",
      }),
    );
    lastCommandAt = Date.now();

    // C. Fifteen seconds without a command: no longer acting.
    const beforeQuiet = owner.messages.length;
    const actingOff = await until(
      () => presenceOf(owner, beforeQuiet, sessionId).find((presence) => !presence.acting),
      actingWindowMs + 5_000,
    );
    const actingOffAfterMs = Date.now() - lastCommandAt;
    expect(actingOff).toMatchObject({ acting: false });
    expect(actingOffAfterMs).toBeGreaterThanOrEqual(actingWindowMs - 500);
    expect(actingOffAfterMs).toBeLessThan(actingWindowMs + 3_000);

    // D. Acting again, then the Run ends: off at once, not fifteen seconds later.
    const beforeAgain = owner.messages.length;
    await answer({ method: "Target.getTargets" }, { targetInfos: [] });
    await until(() =>
      presenceOf(owner, beforeAgain, sessionId).find((presence) => presence.acting),
    );
    const beforeEnd = owner.messages.length;
    const endedAt = Date.now();
    await run.complete();
    await until(() => presenceOf(owner, beforeEnd, sessionId).find((presence) => !presence.acting));
    const actingOffAfterRunEndMs = Date.now() - endedAt;
    expect(actingOffAfterRunEndMs).toBeLessThan(5_000);
    await until(() => ofType(owner, "host.browser-sessions-changed", beforeEnd)[0]);
    // A command of the ended Run that still answers neither acts nor holds the session.
    const beforeLate = owner.messages.length;
    await answer({ method: "Target.getTargets" }, { targetInfos: [] });
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(presenceOf(owner, beforeLate, sessionId).some((presence) => presence.acting)).toBe(
      false,
    );
    const afterEnd = await testRpcData(
      host.origin,
      "bootstrap.get",
      {},
      {
        headers: host.ownerHeaders,
      },
    );
    expect(
      afterEnd.browser.sessions.find((session: { id: string }) => session.id === sessionId),
    ).toMatchObject({ acting: false, attachedRunIds: [] });

    // E. Closing a browser while an agent acts clears every viewer, including a
    // client following only Main with bootstrap polling disabled.
    const mainWorkspace = device
      .getSnapshot()
      .workspaces.find((workspace) => workspace.kind === "main");
    if (!mainWorkspace) throw new Error("No Main Workspace");
    const beforeMainUse = ownerElsewhere.messages.length;
    const closingRun = await dispatchCallerRun(host, caller, {
      key: "closing",
      title: "Close this browser",
      workspaceId: WorkspaceIdSchema.parse(mainWorkspace.id),
    });
    const closingCdp = await host.runtime.browser.attachCdpForAgent(
      {
        agentBindingId: `run:${closingRun.runId}`,
        ownerId: host.ownerId,
        sessionId,
        workspaceId: WorkspaceIdSchema.parse(mainWorkspace.id),
      },
      () => undefined,
    );
    // Catalog invalidation names the conversation's Main Workspace, but its
    // audience comes from the specialist browser's session.
    await until(() =>
      ofType(ownerElsewhere, "host.browser-sessions-changed", beforeMainUse).find(
        (message) => message.workspaceId === mainWorkspace.id,
      ),
    );
    const sent = closingCdp.request({ method: "Target.getTargets", parameters: {} });
    const relayed = await browserComputer.nextCommand();
    browserComputer.sendServer({
      requestId: relayed.requestId,
      result: { targetInfos: [] },
      type: "cdp.result",
    });
    await sent;
    await until(() =>
      device.getSnapshot().browserSessions.find((session) => session.id === sessionId)?.acting
        ? true
        : undefined,
    );
    const beforeClose = ownerElsewhere.messages.length;
    await host.runtime.browser.stop(host.ownerId, sessionId);
    const terminalPresence = await until(() =>
      presenceOf(ownerElsewhere, beforeClose, sessionId).find((presence) => !presence.acting),
    );
    await until(() => ofType(ownerElsewhere, "host.browser-sessions-changed", beforeClose)[0]);
    await until(() =>
      device.getSnapshot().browserSessions.find((session) => session.id === sessionId)?.state ===
      "closed"
        ? true
        : undefined,
    );
    closingCdp.close();

    // Nobody who may not see the browser heard anything about it.
    const strangerBrowserMessages = strangerSocket.messages.filter((message) =>
      String(message.type).startsWith("host.browser"),
    );
    expect(strangerBrowserMessages).toEqual([]);
    cdp.close();

    const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "browser-presence-journey.json"),
        JSON.stringify(
          {
            sessionId,
            runId: run.runId,
            threadId: run.threadId,
            actingWindowMs,
            navigation: {
              presence: navigated,
              noticesOnNavigation: navigationNotices,
              rereadNoticesOnNavigation: navigationNotices.filter(
                (type) => type === "host.browser-sessions-changed",
              ).length,
            },
            agent: {
              noticesWhileActing: agentNotices,
              actingOnAfterMs,
              actingOffAfterQuietMs: actingOffAfterMs,
              actingOffAfterRunEndMs,
              lateCommandActing: false,
            },
            usage: {
              openedFromConversation: openedUsage,
              firstPageUse: pageUsage,
              renamedUsageNotice,
              renamedUsage: renamedUsage.uses,
              repeatedPageUseNotices: 0,
              conversation: usage.uses,
            },
            terminalPresence,
            pollingDisabledFinalSession: device
              .getSnapshot()
              .browserSessions.find((session) => session.id === sessionId),
            bootstrapWhileActing: listed,
            strangerBrowserMessages,
            ownerMessageTypes: owner.messages.map(({ type }) => type),
            ownerElsewhereMessageTypes: ownerElsewhere.messages.map(({ type }) => type),
          },
          null,
          2,
        ),
      );
    }
  }, 120_000);

  it("lists a conversation's browser for a reader who never opened it, and keeps a page with its message", async () => {
    const database: MachineAccessDatabase = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    cleanups.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Caller computer",
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "caller",
        name: "Caller computer",
      }),
    });
    cleanups.push(() => caller.close());
    const run = await dispatchCallerRun(host, caller, { key: "live", title: "Compare prices" });
    const browserComputer = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "browser",
        name: "Browser computer",
      }),
      { agentReady: true },
    );
    cleanups.push(() => browserComputer.close());
    await until(() => (host.runtime.browser.available ? true : undefined));
    const owner = await listen(host, host.ownerHeaders, run.workspaceId);
    cleanups.push(() => owner.close());

    // A browser the person opens in the Workspace, from no conversation.
    const opened = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "live-open",
        input: { fresh: true },
        type: "browser.session.start",
        workspaceId: run.workspaceId,
      },
      { headers: host.ownerHeaders },
    );
    if (opened.type !== "browser.session.start") throw new Error("Browser command mismatch.");
    const sessionId = opened.session.id;
    expect(opened.session.threadIds).toEqual([]);

    // 1. Another device shows the overview and never opens the conversation.
    const device = await reader(host);
    cleanups.push(async () => device.dispose());
    device.activateWorkspace(run.workspaceId);
    const groupOf = () =>
      liveWork(device.getSnapshot()).find((group) => group.threadId === run.threadId);
    const browserIn = (group: ReturnType<typeof groupOf>) =>
      group?.surfaces.find((item) => item.kind === "browser" && item.session.id === sessionId);
    const before = await until(() =>
      device.getSnapshot().browserSessions.some((session) => session.id === sessionId)
        ? groupOf()
        : undefined,
    );
    expect(browserIn(before)).toBeUndefined();

    // 2. The person includes the page in a message. Its tab id reads like the
    // membership row's old key, which must not matter.
    const page = {
      sessionId,
      tabId: "session",
      title: "Price list",
      type: "browser-page" as const,
      url: "https://shop.example/prices?q=boots",
    };
    const beforeSend = owner.messages.length;
    const sent = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        content: [{ text: "Compare these.", type: "text" }, page],
        idempotencyKey: "live-page",
        threadId: run.threadId,
        type: "thread.sendMessage",
      },
      { headers: host.ownerHeaders },
    );
    if (sent.type !== "thread.sendMessage") throw new Error("Send command mismatch.");
    expect(sent.message.content).toContainEqual(page);
    const priorPageCheck = host.runtime.browser.assertPagesUsable;
    let replayPageChecks = 0;
    host.runtime.browser.assertPagesUsable = async () => {
      replayPageChecks += 1;
      throw new Error("The page cannot be checked after its accepted send");
    };
    try {
      const acknowledged = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          content: [{ text: "Compare these.", type: "text" }, page],
          idempotencyKey: "live-page",
          threadId: run.threadId,
          type: "thread.sendMessage",
        },
        { headers: host.ownerHeaders },
      );
      expect(acknowledged).toMatchObject({ wasDuplicate: true, message: { id: sent.message.id } });
      expect(replayPageChecks).toBe(0);
    } finally {
      host.runtime.browser.assertPagesUsable = priorPageCheck;
    }

    // The conversation's first use of the browser changes the catalog; the
    // usage notice names the conversation.
    await until(() => ofType(owner, "host.browser-sessions-changed", beforeSend)[0]);
    const pageUsage = await until(
      () =>
        ofType(owner, "host.browser-usage-changed", beforeSend)[0] as
          Record<string, unknown> | undefined,
    );
    expect(pageUsage).toMatchObject({ threadIds: [run.threadId] });
    const after = await until(() => (browserIn(groupOf()) ? groupOf() : undefined));
    const noticesOnSend = owner.messages.slice(beforeSend).map(({ type }) => type);
    const usageReads = device.requests.filter((path) => path.endsWith("thread.browserUsage.get"));
    expect(usageReads).toEqual([]);
    const catalog = await testRpcData(
      host.origin,
      "bootstrap.get",
      {},
      { headers: host.ownerHeaders },
    );
    const listed = catalog.browser.sessions.find(
      (session: { id: string }) => session.id === sessionId,
    );
    expect(listed?.threadIds).toEqual([run.threadId]);
    const usage = await testRpcData(
      host.origin,
      "thread.browserUsage.get",
      { runIds: [], threadId: run.threadId },
      { headers: host.ownerHeaders },
    );
    expect(usage.uses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: null, sessionId, tabId: null }),
        expect.objectContaining({
          pageSite: "https://shop.example",
          pageTitle: "Price list",
          runId: null,
          sessionId,
          tabId: "session",
        }),
      ]),
    );

    // The agent forwards that structured reference through the production control route.
    const delegatedResponse = await host.runtime.app.inject({
      method: "POST",
      url: hostInternalRoutePaths.agentControl,
      headers: { authorization: `Bearer ${run.agentControlToken}` },
      payload: {
        type: "thread.delegate",
        requestId: randomUUID(),
        task: "Compare the included page",
        title: "Page comparison",
        workspaceId: run.workspaceId,
        places: [page],
      },
    });
    expect(delegatedResponse.statusCode, delegatedResponse.body).toBe(200);
    const delegated = AgentControlResponseSchema.parse(delegatedResponse.json());
    if (delegated.type !== "thread.delegate.result") throw new Error("Expected delegated page");
    expect(delegated.result.message.content).toContainEqual(page);
    const forwardedUsage = await testRpcData(
      host.origin,
      "thread.browserUsage.get",
      { runIds: [], threadId: delegated.result.thread.id },
      { headers: host.ownerHeaders },
    );
    expect(forwardedUsage.uses).toContainEqual(
      expect.objectContaining({ sessionId, tabId: page.tabId }),
    );
    const projected = resolvedInputParts(
      {
        author: delegated.result.message.author,
        content: delegated.result.message.content,
        kind: "input",
        createdAt: delegated.result.message.createdAt,
        messageId: delegated.result.message.id,
      },
      undefined,
    );
    expect(projected.body).toContain(page.tabId);
    const placeArtifactDirectory = process.env.OPENSTEER_PLACE_INPUT_ARTIFACT_DIR;
    if (placeArtifactDirectory) {
      await mkdir(placeArtifactDirectory, { recursive: true });
      await writeFile(
        join(placeArtifactDirectory, "browser-place-input.json"),
        JSON.stringify(
          { submitted: page, forwarded: delegated.result.message.content, projected },
          null,
          2,
        ),
      );
    }
    const unrelated = await host.runtime.app.inject({
      method: "POST",
      url: hostInternalRoutePaths.agentControl,
      headers: { authorization: `Bearer ${run.agentControlToken}` },
      payload: {
        type: "thread.delegate",
        requestId: randomUUID(),
        task: "Read unrelated browser",
        workspaceId: run.workspaceId,
        places: [{ ...page, sessionId: "bsn_00000000-0000-4000-8000-000000000001" }],
      },
    });
    expect(unrelated.statusCode, unrelated.body).toBe(403);

    // 3. A conversation in another Workspace, whose agent could not use this
    // browser, cannot take the page, and no message is kept.
    const elsewhere = await testRpcData(
      host.origin,
      "commands.dispatch",
      { idempotencyKey: "live-elsewhere", name: "Elsewhere", type: "workspace.create" },
      { headers: host.ownerHeaders },
    );
    if (elsewhere.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    const otherThread = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        environmentId: caller.environmentId,
        harnessInstanceId: caller.harnessInstanceId,
        idempotencyKey: "live-elsewhere-thread",
        modelSelection: {
          modelId: "gpt-5.6-sol",
          options: { effort: "low" },
          providerId: "openai",
        },
        title: "Elsewhere",
        type: "thread.create",
        workspaceId: elsewhere.workspace.id,
      },
      { headers: host.ownerHeaders },
    );
    if (otherThread.type !== "thread.create") throw new Error("Thread command mismatch.");
    const refusedResponse = await testRpcRequest(
      host.origin,
      "commands.dispatch",
      {
        content: [
          { text: "Look at this.", type: "text" },
          { ...page, auto: true, documentId: "frozen-prices" },
        ],
        idempotencyKey: "live-elsewhere-page",
        threadId: otherThread.thread.id,
        type: "thread.sendMessage",
      },
      { headers: host.ownerHeaders },
    );
    const refused = (await refusedResponse.json()) as {
      readonly error?: { readonly code: string; readonly message: string };
    };
    expect(refusedResponse.status).toBe(403);
    expect(refused.error?.message).toContain("can't use");
    const otherMessages = await testRpcData(
      host.origin,
      "thread.messages.list",
      { threadId: otherThread.thread.id },
      { headers: host.ownerHeaders },
    );
    expect(otherMessages.messages).toEqual([]);

    // 4. The agent reaches a page while its use cannot be recorded: it still
    // has its answer, and nothing is announced for that use.
    const binding = `run:${run.runId}`;
    const beforeConnect = owner.messages.length;
    const cdp = await host.runtime.browser.attachCdpForAgent(
      { agentBindingId: binding, ownerId: host.ownerId, sessionId, workspaceId: run.workspaceId },
      () => undefined,
    );
    // The Run's own use of the session is news; wait for it before the outage.
    await until(() => ofType(owner, "host.browser-usage-changed", beforeConnect)[0]);
    const beforeOutage = owner.messages.length;
    await sql`alter table browser_session_uses rename to browser_session_uses_unavailable`.execute(
      host.store.database,
    );
    let attachAnswer: unknown;
    try {
      const sentAttach = cdp.request({
        method: "Target.attachToTarget",
        parameters: { flatten: true, targetId: "target-prices" },
      });
      const relayed = await browserComputer.nextCommand();
      browserComputer.sendServer({
        requestId: relayed.requestId,
        result: { sessionId: "cdp-prices", surfaceId: "session" },
        type: "cdp.result",
      });
      attachAnswer = await sentAttach;
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    } finally {
      await sql`alter table browser_session_uses_unavailable rename to browser_session_uses`.execute(
        host.store.database,
      );
    }
    expect(attachAnswer).toEqual({ sessionId: "cdp-prices", surfaceId: "session" });
    expect(ofType(owner, "host.browser-usage-changed", beforeOutage)).toEqual([]);
    cdp.close();

    // 5. Presence that cannot be addressed while the store is unavailable is
    // sent once it is, though nothing about the page changes again.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    const beforePresenceOutage = owner.messages.length;
    await sql`alter table browser_profiles rename to browser_profiles_unavailable`.execute(
      host.store.database,
    );
    let restoredAt = 0;
    try {
      browserComputer.sendServer({
        surfaces: [
          {
            active: true,
            id: "session",
            title: "Price list — sorted",
            url: "https://shop.example/prices?q=boots&sort=price",
          },
        ],
        type: "browser.surfaces.changed",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      expect(
        presenceOf(owner, beforePresenceOutage, sessionId).some(
          (presence) =>
            (presence.page as { title: string } | null)?.title === "Price list — sorted",
        ),
      ).toBe(false);
    } finally {
      await sql`alter table browser_profiles_unavailable rename to browser_profiles`.execute(
        host.store.database,
      );
      restoredAt = Date.now();
    }
    const resent = await until(() =>
      presenceOf(owner, beforePresenceOutage, sessionId).find(
        (presence) => (presence.page as { title: string } | null)?.title === "Price list — sorted",
      ),
    );
    const presenceAfterRestoreMs = Date.now() - restoredAt;
    expect(presenceAfterRestoreMs).toBeLessThan(5_000);

    const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "live-overview-journey.json"),
        JSON.stringify(
          {
            sessionId,
            threadId: run.threadId,
            readerNeverOpenedConversation: {
              liveGroupBeforePage: { state: before?.state, surfaces: before?.surfaces.length },
              liveGroupAfterPage: {
                state: after?.state,
                statusLine: after?.statusLine,
                surfaces: after?.surfaces.map((item) => item.key),
              },
              usageReads: usageReads.length,
              requests: device.requests,
            },
            pageMessage: {
              messageId: sent.message.id,
              noticesOnSend,
              usageNotice: pageUsage,
              catalogThreadIds: listed?.threadIds,
              conversationUses: usage.uses,
            },
            otherWorkspacePage: {
              status: refusedResponse.status,
              error: refused.error,
              messagesKept: otherMessages.messages.length,
            },
            attachWhileUsageUnrecordable: {
              answer: attachAnswer,
              usageNotices: ofType(owner, "host.browser-usage-changed", beforeOutage).length,
            },
            presenceAfterStoreOutage: {
              presence: resent,
              deliveredAfterRestoreMs: presenceAfterRestoreMs,
            },
          },
          null,
          2,
        ),
      );
    }
  }, 120_000);
});
