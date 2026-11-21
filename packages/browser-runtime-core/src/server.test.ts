import {
  standardCdpMaxPending,
  standardCdpMessageMaxBytes,
  type CdpEvent,
} from "@opensteer/browser-core";
import { committedBrowserTabs } from "./test-support/fakes.js";
import {
  BrowserRuntimeServerMessageSchema,
  BrowserSessionIdSchema,
  type BrowserAttachPublicKey,
  type BrowserRuntimeServerMessage,
} from "@opensteer/protocol";
import {
  allClosed,
  connectionRefused,
  holdHttpConnections,
  holdRefusedConnection,
  holdUpgradedConnection,
  observeClose,
  settleWithin,
  webSocketUpgradeRequest,
  writeTransportCloseReport,
} from "@opensteer/shared/test-support/httpServer";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { pageViewport, type EngineClipboardItem, type PageGeometry } from "./browser/backend.js";
import { gate } from "@opensteer/shared/test-support/observation";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { BrowserRuntime } from "./runtime.js";
import { BrowserRuntimeServer, standardCdpPath } from "./server.js";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeTicketVerifier,
  flushMicrotasks,
  testSessionFilesRoot,
  validClaims,
} from "./test-support/fakes.js";

describe("BrowserRuntimeServer", () => {
  it("waits for a disconnected relay's browser teardown before it confirms the drain", async () => {
    const teardown = Promise.withResolvers<void>();
    const close = vi.fn(() => teardown.promise);
    const bridgeToken = "local-browser-bridge-token-with-entropy";
    const publicKeyPem = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    const encodedKeys = Buffer.from(JSON.stringify([{ keyId: "host", publicKeyPem }])).toString(
      "base64url",
    );
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([new FakePage()]))),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    const attach = runtime.attach.bind(runtime);
    vi.spyOn(runtime, "attach").mockImplementation(async (...args) => {
      const attachment = await attach(...args);
      const closeAttachment = attachment.close.bind(attachment);
      vi.spyOn(attachment, "close").mockImplementation(async (confirmPages) => {
        await close();
        await closeAttachment(confirmPages);
      });
      return attachment;
    });
    const server = new BrowserRuntimeServer({
      port: 0,
      runtime,
      relayBridge: { token: bridgeToken, updateAttachKeys: () => {} },
    });
    let socket: WebSocket | undefined;
    try {
      const { host, port } = await server.start();
      socket = new WebSocket(`ws://${host}:${port}/v1/browser`, {
        headers: {
          authorization: "Bearer test",
          "x-opensteer-browser-bridge-token": bridgeToken,
          "x-opensteer-browser-attach-keys": encodedKeys,
        },
      });
      const attached = Promise.withResolvers<void>();
      socket.once("error", attached.reject);
      socket.on("message", (data) => {
        if (JSON.parse(String(data)).type === "browser.attached") attached.resolve();
      });
      await withTimeout(attached.promise, 2_000, {
        timeoutError: () => new Error("Relay did not attach."),
      });
      const disconnected = once(socket, "close");
      socket.close();
      await disconnected;
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

      const confirmed = vi.fn();
      const draining = server.drainRunnerAttachments().then(confirmed);
      await flushMicrotasks();
      expect(confirmed).not.toHaveBeenCalled();
      teardown.resolve();
      await draining;
      expect(confirmed).toHaveBeenCalledWith(true);
    } finally {
      teardown.resolve();
      socket?.terminate();
      await server.close();
    }
  });

  it.each([
    { count: 2, bytes: 0, code: 1007, admitted: 1, duplicate: true },
    { count: standardCdpMaxPending + 1, bytes: 0, code: 1013, admitted: standardCdpMaxPending },
    { count: 3, bytes: 6 * 1024 * 1024, code: 1013, admitted: 2 },
    { count: 1, bytes: standardCdpMessageMaxBytes, code: 1009, admitted: 0 },
    { count: 3, bytes: 6 * 1024 * 1024, code: 1013, admitted: 0, outbound: true },
  ])(
    "bounds raw CDP traffic ($count frames, $bytes payload bytes, outbound=$outbound)",
    async ({ count, bytes, code, admitted, outbound, duplicate }) => {
      const runtime = new BrowserRuntime({
        launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([new FakePage()]))),
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: new FakeTicketVerifier(),
      });
      const controller = new AbortController();
      const pending = Promise.withResolvers<unknown>();
      const send = vi.fn(async ({ method }: { method: string }) =>
        method === "Browser.getVersion" ? { product: "test" } : pending.promise,
      );
      const close = vi.fn(() => {
        controller.abort();
        pending.resolve({});
      });
      let emit: ((event: CdpEvent) => void) | undefined;
      vi.spyOn(runtime, "attachStandardCdp").mockResolvedValue({
        signal: controller.signal,
        settled: pending.promise.then(() => undefined),
        send,
        close,
        attachedTargetId: () => null,
        onEvent: (listener) => {
          emit = listener;
          return () => {
            emit = undefined;
          };
        },
      });
      const server = new BrowserRuntimeServer({ port: 0, runtime });
      let socket: WebSocket | undefined;
      try {
        const { host, port } = await server.start();
        socket = new WebSocket(`ws://${host}:${port}${standardCdpPath}`, {
          headers: { authorization: "Bearer test" },
        });
        await once(socket, "open");
        const response = once(socket, "message");
        socket.send(JSON.stringify({ id: 0, method: "Browser.getVersion" }));
        expect(JSON.parse(String((await response)[0]))).toEqual({
          id: 0,
          result: { product: "test" },
        });
        const closed = once(socket, "close");
        const expression = "x".repeat(bytes);
        if (outbound) {
          expect(emit).toBeDefined();
          for (let sequence = 1; sequence <= count; sequence++)
            emit?.({ sequence, method: "Runtime.consoleAPICalled", parameters: { expression } });
        } else {
          for (let id = 1; id <= count; id++)
            socket.send(
              JSON.stringify({
                id: duplicate ? 1 : id,
                method: "Runtime.evaluate",
                params: { expression },
              }),
            );
        }
        expect((await closed)[0]).toBe(code);
        expect(send).toHaveBeenCalledTimes(admitted + 1);
        expect(close).toHaveBeenCalledOnce();
      } finally {
        socket?.terminate();
        await server.close();
      }
    },
  );

  it("delivers paste parts queued during attachment before waiting for the paste", async () => {
    const ready = gate({ label: "browser attachment handoff", deadlineMs: 2_000 });
    const page = new FakePage();
    let pasted: readonly EngineClipboardItem[] | null = null;
    const browser = Object.assign(new FakeLaunchedBrowser(new FakeContext([page])), {
      clipboard: {
        open: async (_page: unknown, input: typeof pasted) => {
          pasted = input;
          return { close: async () => null };
        },
      },
    });
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(browser),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(validClaims({ editingVersion: 2, clipboard: true })),
    });
    const attach = runtime.attach.bind(runtime);
    const messages: BrowserRuntimeServerMessage[] = [];
    vi.spyOn(runtime, "attach").mockImplementation(async (ticket, sink, options) => {
      const attached = await attach(
        ticket,
        {
          sendFrame: (frame) => sink.sendFrame(frame),
          sendServer: (message) => {
            messages.push(message);
            return sink.sendServer(message);
          },
        },
        options,
      );
      await ready.enter();
      return attached;
    });
    const server = new BrowserRuntimeServer({ port: 0, runtime });
    let socket: WebSocket | undefined;
    try {
      const address = await server.start();
      socket = new WebSocket(`ws://${address.host}:${address.port}/v1/browser`, {
        headers: { authorization: "Bearer abc.def.ghi" },
      });
      await withTimeout(once(socket, "open"), 1_000, {
        timeoutError: () => new Error("Paste viewer never connected"),
      });
      await ready.entered;
      const surfaceId = committedBrowserTabs(messages).rows.keys().next().value;
      expect(surfaceId).toBeDefined();
      const operationId = randomUUID();
      const result = Promise.withResolvers<unknown>();
      socket.on("message", (raw, binary) => {
        if (binary) return;
        const message = BrowserRuntimeServerMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type === "clipboard.result" && message.operationId === operationId)
          result.resolve(message);
      });
      socket.send(
        JSON.stringify({
          type: "clipboard.paste-data",
          surfaceId,
          operationId,
          items: [{ type: "text/plain", size: 5 }],
        }),
      );
      socket.send(
        JSON.stringify({
          type: "clipboard.part",
          part: { operationId, index: 0, data: Buffer.from("paste").toString("base64") },
        }),
      );
      const queued = once(socket, "pong");
      socket.ping();
      await withTimeout(queued, 1_000, {
        timeoutError: () => new Error("Queued paste frames never reached the server"),
      });
      ready.release();
      await expect(
        withTimeout(result.promise, 1_000, {
          timeoutError: () => new Error("The queued paste never received its parts"),
        }),
      ).resolves.toMatchObject({ outcome: "pasted", operationId, surfaceId });
      expect(pasted).toEqual([{ type: "text/plain", bytes: Buffer.from("paste") }]);
    } finally {
      ready.release();
      socket?.terminate();
      await server.close();
    }
  });

  it("negotiates initial-page readiness through the authenticated bridge", async () => {
    const claims = validClaims({
      initialNavigation: { operationKey: "initial-test", url: "https://example.test/" },
    });
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(claims),
    });
    const bridgeToken = "b".repeat(64);
    const keys = generateKeyPairSync("ed25519");
    const server = new BrowserRuntimeServer({
      port: 0,
      runtime,
      relayBridge: { token: bridgeToken, updateAttachKeys: () => {} },
    });
    try {
      const address = await server.start();
      const socket = new WebSocket(`ws://${address.host}:${address.port}/v1/browser`, {
        headers: {
          authorization: "Bearer abc.def.ghi",
          "x-opensteer-browser-initial-navigation": "1",
          "x-opensteer-browser-bridge-token": bridgeToken,
          "x-opensteer-browser-attach-keys": Buffer.from(
            JSON.stringify([
              {
                keyId: "test-key",
                publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
              },
            ]),
          ).toString("base64url"),
        },
      });
      const result = await settleWithin(
        new Promise<unknown>((resolve, reject) => {
          socket.once("error", reject);
          socket.on("message", (raw, binary) => {
            if (binary) return;
            const message = JSON.parse(String(raw));
            if (message.type === "browser.attached") resolve(message);
          });
        }),
        2000,
      );
      expect(result).toMatchObject({
        settled: "fulfilled",
        value: {
          type: "browser.attached",
          initialPage: { operationKey: "initial-test", navigation: "submitted" },
        },
      });
      socket.terminate();
    } finally {
      await server.close();
    }
  });

  it("refuses listening and health until initialization succeeds, including failed initialization", async () => {
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    const { createServer } = await import("node:net");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    let rejectPrepare!: (error: Error) => void;
    vi.spyOn(runtime, "prepare").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrepare = reject;
        }),
    );
    const server = new BrowserRuntimeServer({ port: address.port, runtime });
    const starting = server.start();
    const failed = expect(starting).rejects.toThrow("initialization failed");
    try {
      expect(await connectionRefused(address.port)).toBe(true);
      await expect(fetch(`http://127.0.0.1:${address.port}/health`)).rejects.toThrow();
      rejectPrepare(new Error("initialization failed"));
      await failed;
      expect(await connectionRefused(address.port)).toBe(true);
    } finally {
      rejectPrepare(new Error("initialization failed"));
      await server.close();
    }
  });

  it("concurrent starts share readiness and immediate concurrent attaches receive snapshots", async () => {
    const verifier = new FakeTicketVerifier();
    verifier.setClaims(
      "second-ticket",
      validClaims({ sessionId: BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`) }),
    );
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });
    const prepare = runtime.prepare.bind(runtime);
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const preparing = vi.spyOn(runtime, "prepare").mockImplementation(async () => {
      await gate;
      await prepare();
    });
    const server = new BrowserRuntimeServer({ port: 0, runtime });
    const sockets: WebSocket[] = [];
    try {
      const first = server.start();
      expect(server.start()).toBe(first);
      expect(server.start()).toBe(first);
      expect(preparing).toHaveBeenCalledOnce();
      ready();
      const address = await first;
      await Promise.all(
        ["signed-ticket", "second-ticket"].map(async (token) => {
          const socket = new WebSocket(`ws://${address.host}:${address.port}/v1/browser`, {
            headers: { authorization: `Bearer ${token}` },
          });
          sockets.push(socket);
          const message = await new Promise<unknown>((resolve, reject) => {
            socket.once("error", reject);
            socket.on("message", (raw, binary) => {
              if (binary) return;
              const message = BrowserRuntimeServerMessageSchema.parse(JSON.parse(String(raw)));
              if (message.type === "browser.snapshot" || message.type === "browser.error")
                resolve(message);
            });
          });
          expect(message).toMatchObject({ type: "browser.snapshot" });
        }),
      );
    } finally {
      ready();
      for (const socket of sockets) socket.terminate();
      await server.close();
    }
  });

  it("serves health and rejects an upgrade without a Host ticket", async () => {
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    const server = new BrowserRuntimeServer({ port: 0, runtime });
    const address = await server.start();

    const response = await fetch(`http://${address.host}:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runtimeId: "runtime_test", state: "idle" });

    const status = await rejectedUpgrade(`ws://${address.host}:${address.port}/v1/browser`);
    expect(status).toBe(401);
    await server.close();
  });

  it("accepts rotating Host keys only through the authenticated relay bridge", async () => {
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    let acceptedKeys: readonly BrowserAttachPublicKey[] = [];
    const server = new BrowserRuntimeServer({
      relayBridge: {
        token: "local-browser-bridge-token-with-entropy",
        updateAttachKeys: (keys) => {
          acceptedKeys = keys;
        },
      },
      port: 0,
      runtime,
    });
    const address = await server.start();
    const publicKeyPem = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    const encodedKeys = Buffer.from(
      JSON.stringify([{ keyId: "host-v2", publicKeyPem }]),
      "utf8",
    ).toString("base64url");
    const baseHeaders = {
      authorization: "Bearer signed-ticket",
      "x-opensteer-browser-attach-keys": encodedKeys,
    };

    await expect(
      rejectedUpgrade(`ws://${address.host}:${address.port}/v1/browser`, {
        ...baseHeaders,
        "x-opensteer-browser-bridge-token": "wrong-browser-bridge-token-with-entropy",
      }),
    ).resolves.toBe(403);

    const websocket = new WebSocket(`ws://${address.host}:${address.port}/v1/browser`, {
      headers: {
        ...baseHeaders,
        "x-opensteer-browser-bridge-token": "local-browser-bridge-token-with-entropy",
      },
    });
    await once(websocket, "open");
    expect(acceptedKeys).toEqual([{ keyId: "host-v2", publicKeyPem }]);
    websocket.close();
    await once(websocket, "close");
    await server.close();
  });
});

/*
 * An agent's page size crosses the same wire as every other answer, and the
 * Runner and Host parse each frame after it was serialized. On either engine:
 * - the answer to Emulation.setDeviceMetricsOverride or
 *   Emulation.clearDeviceMetricsOverride can be valid only in memory, so the
 *   receiver refuses it and the session ends; pages that apply geometry
 *   themselves, as the desktop's Electron pages do, answer nothing;
 * - a repeated write that changes nothing can answer differently;
 * - the page can miss the agent's size, or keep it after the agent cleared it;
 * - the person's view can miss that an agent sized the page, or that it no
 *   longer does, and so offer Fit wrongly;
 * - a command answered with something other than a CDP result can end the
 *   session instead of failing alone.
 */
describe("BrowserRuntimeServer agent page sizes", () => {
  const transcripts: Record<string, unknown>[] = [];

  afterAll(async () => {
    const directory =
      process.env.OPENSTEER_AGENT_PAGE_SIZE_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-agent-page-size");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "browser-runtime-server.json"),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), transcripts }, null, 2)}\n`,
    );
  });

  it.each([
    ["applies geometry itself, as Electron's pages do", () => new GeometryPage()],
    ["takes device metrics over CDP, as Chromium's pages do", () => new FakePage()],
  ])("answers an agent's size writes as CDP does on a page that %s", async (engine, createPage) => {
    const page = createPage();
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([page]))),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    const server = new BrowserRuntimeServer({ port: 0, runtime });
    const address = await server.start();
    const websocket = new WebSocket(`ws://${address.host}:${address.port}/v1/browser`, {
      headers: { authorization: "Bearer signed-ticket" },
    });
    const frames: Record<string, unknown>[] = [];
    const refused: unknown[] = [];
    const steps: Record<string, unknown>[] = [];
    websocket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      frames.push(frame);
      const parsed = BrowserRuntimeServerMessageSchema.safeParse(frame);
      if (!parsed.success) refused.push({ frame, issues: parsed.error.issues });
    });
    const command = async (
      step: string,
      method: string,
      parameters?: object,
      sessionId?: string,
    ) => {
      const requestId = randomUUID();
      websocket.send(
        JSON.stringify({
          command: {
            method,
            ...(parameters ? { parameters } : {}),
            ...(sessionId ? { sessionId } : {}),
          },
          requestId,
          type: "cdp.command",
        }),
      );
      await waitFor(() => frames.some((frame) => frame.requestId === requestId));
      const answer = frames.find((frame) => frame.requestId === requestId)!;
      steps.push({ answer, method, step });
      return answer;
    };
    const sizedByAgent = () =>
      committedBrowserTabs(frames.map((frame) => BrowserRuntimeServerMessageSchema.parse(frame)))
        .rows.values()
        .next().value?.sizedByAgent;
    const shownWidth = () => {
      if (page instanceof GeometryPage) {
        const geometry = page.geometries.at(-1);
        return geometry ? pageViewport(geometry).width : null;
      }
      return page.cdpSession.sent
        .filter(({ method }) => method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters?.width;
    };
    const answered = (answer: Record<string, unknown>) => ({
      requestId: answer.requestId,
      result: {},
      type: "cdp.result",
    });
    try {
      await once(websocket, "open");
      await waitFor(() => frames.some((frame) => frame.type === "browser.snapshot"));
      const targets = await command("list", "Target.getTargets");
      const { rootTargetId } = targets.result as { rootTargetId: string };
      const attached = await command("attach", "Target.attachToTarget", {
        flatten: true,
        targetId: rootTargetId,
      });
      const { sessionId } = attached.result as { sessionId: string };
      const personWidth = shownWidth();
      const stillAnswers = async (step: string) =>
        expect((await command(step, "Page.getNavigationHistory", undefined, sessionId)).type).toBe(
          "cdp.result",
        );
      const agentSize = { deviceScaleFactor: 0, height: 900, mobile: false, width: 1_280 };

      for (const step of ["size", "size again"]) {
        const sized = await command(
          step,
          "Emulation.setDeviceMetricsOverride",
          agentSize,
          sessionId,
        );
        expect(sized).toEqual(answered(sized));
        await waitFor(() => sizedByAgent() === true);
        expect(shownWidth()).toBe(1_280);
        await stillAnswers(`after ${step}`);
      }
      for (const step of ["clear", "clear again"]) {
        const cleared = await command(
          step,
          "Emulation.clearDeviceMetricsOverride",
          undefined,
          sessionId,
        );
        expect(cleared).toEqual(answered(cleared));
        await waitFor(() => sizedByAgent() === false);
        expect(shownWidth()).toBe(personWidth);
        await stillAnswers(`after ${step}`);
      }

      page.cdpSession.responses.set("Page.getNavigationHistory", null);
      const malformed = await command(
        "answer that is not a CDP result",
        "Page.getNavigationHistory",
        undefined,
        sessionId,
      );
      page.cdpSession.responses.delete("Page.getNavigationHistory");
      expect(malformed).toMatchObject({ requestId: malformed.requestId, type: "cdp.error" });
      await stillAnswers("after an answer that is not a CDP result");

      expect(personWidth).not.toBe(1_280);
      expect(refused).toEqual([]);
      expect(websocket.readyState).toBe(WebSocket.OPEN);
    } finally {
      transcripts.push({ engine, frameTypes: frames.map((frame) => frame.type), refused, steps });
      const socketClosed = once(websocket, "close");
      await server.close();
      await socketClosed;
    }
  });
});

/** A page that applies its own geometry and answers nothing, as Electron's pages do. */
class GeometryPage extends FakePage {
  readonly geometries: PageGeometry[] = [];

  async applyGeometry(geometry: PageGeometry): Promise<void> {
    this.geometries.push(geometry);
  }
}

/*
 * Ways a stopping Browser Runtime can be kept from stopping, or stop too soon:
 * - a connection that sent nothing, half its headers or half its body keeps
 *   the listener's close waiting;
 * - a viewer that never answers a WebSocket close keeps it waiting too;
 * - a refused upgrade is answered and left for its peer to end, and a peer
 *   that never does keeps the close waiting;
 * - a viewer is cut off without being told the runtime is shutting down;
 * - the listener's close is awaited before the WebSockets are ended, so it
 *   waits on itself;
 * - a profile save fails after the transport is gone, so a retry cannot reach
 *   the sessions or report health;
 * - a later close returns before the first one has finished;
 * - a close while the server is still starting leaves it listening.
 */
describe("BrowserRuntimeServer shutdown", () => {
  const cases: Record<string, unknown>[] = [];

  afterAll(async () => {
    await writeTransportCloseReport("browser-runtime-server", cases);
  });

  it("closes every browser and connection and stops listening", async () => {
    const ticketVerifier = new FakeTicketVerifier();
    ticketVerifier.setClaims(
      "viewer-ticket",
      validClaims({
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
      }),
    );
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier,
    });
    const server = new BrowserRuntimeServer({ port: 0, runtime });
    const address = await server.start();
    const held = await holdHttpConnections(address.port, "/health");
    const silent = await holdUpgradedConnection(address.port, "/v1/browser", {
      authorization: "Bearer signed-ticket",
    });
    const viewer = new WebSocket(`ws://${address.host}:${address.port}/v1/browser`, {
      headers: { authorization: "Bearer viewer-ticket" },
    });
    await once(viewer, "open");
    await waitFor(() => runtime.health().sessionCount === 2);
    const viewerClosed = new Promise<{ code: number; reason: string }>((resolve) =>
      viewer.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );

    const closing = server.close();
    const repeated = server.close();
    const observed = await observeClose(closing);
    const connections = [...held, silent];
    const everyConnectionClosed = await allClosed(connections);
    const viewerCode = await observeClose(viewerClosed).then(() => viewerClosed);
    const listenerRefused = await connectionRefused(address.port);
    cases.push({
      name: "profiles saved, then every transport ended",
      close: observed,
      repeatedCloseJoinsFirst: repeated === closing,
      runtimeState: runtime.health().state,
      connections: connections.map((connection) => connection.report()),
      viewerClose: viewerCode,
      listenerRefused,
    });

    expect(observed.settled).toBe("closed");
    expect(repeated).toBe(closing);
    expect(runtime.health().state).toBe("closed");
    expect(everyConnectionClosed).toBe(true);
    expect(viewerCode).toEqual({ code: 1001, reason: "runtime shutting down" });
    expect(listenerRefused).toBe(true);
  }, 30_000);

  it("refuses an upgrade it will not serve without waiting on the peer that sent it", async () => {
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    const server = new BrowserRuntimeServer({
      relayBridge: {
        token: "local-browser-bridge-token-with-entropy",
        updateAttachKeys: () => undefined,
      },
      port: 0,
      runtime,
    });
    const { port } = await server.start();
    const ticket = { authorization: "Bearer signed-ticket" };
    const refused = await Promise.all(
      [
        { name: "unknown path", request: webSocketUpgradeRequest(port, "/v1/other", ticket) },
        { name: "no ticket", request: webSocketUpgradeRequest(port, "/v1/browser") },
        {
          name: "wrong bridge token",
          request: webSocketUpgradeRequest(port, "/v1/browser", {
            ...ticket,
            "x-opensteer-browser-attach-keys": "W10",
            "x-opensteer-browser-bridge-token": "wrong-browser-bridge-token-with-entropy",
          }),
        },
        {
          name: "malformed handshake",
          request: webSocketUpgradeRequest(port, "/v1/browser", ticket, { key: false }),
        },
      ].map(async ({ name, request }) => ({
        name,
        ...(await holdRefusedConnection(port, request)),
      })),
    );
    try {
      const closed = await observeClose(server.close());
      const peersStillHolding = refused.every(({ connection }) => !connection.isClosed());
      cases.push({
        name: "refused upgrades whose peers never end the connection",
        refusals: refused.map(({ connection, name, status }) => ({
          name,
          status,
          ...connection.report(),
        })),
        close: closed,
        peersStillHolding,
      });

      expect(refused.map(({ status }) => status)).toEqual([
        "HTTP/1.1 404 Not Found",
        "HTTP/1.1 401 Unauthorized",
        "HTTP/1.1 403 Forbidden",
        "HTTP/1.1 400 Bad Request",
      ]);
      expect(closed.settled).toBe("closed");
      expect(peersStillHolding).toBe(true);
    } finally {
      for (const { connection } of refused) connection.destroy();
    }
  }, 30_000);

  it("closes every connection despite failed owned-resource cleanup", async () => {
    const launcher = new FakeLauncher();
    const close = launcher.browser.close.bind(launcher.browser);
    vi.spyOn(launcher.browser, "close").mockImplementationOnce(async () => {
      await close();
      throw new Error("Owned-resource cleanup failed");
    });
    const runtime = new BrowserRuntime({
      launcher,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    const server = new BrowserRuntimeServer({ port: 0, runtime });
    const address = await server.start();
    const held = await holdHttpConnections(address.port, "/health");
    const silent = await holdUpgradedConnection(address.port, "/v1/browser", {
      authorization: "Bearer signed-ticket",
    });
    await waitFor(() => runtime.health().sessionCount === 1);
    const connections = [...held, silent];

    const failed = await observeClose(server.close());
    const closedAfterFailure = await allClosed(connections);
    const refusedAfterFailure = await connectionRefused(address.port);
    const retried = await observeClose(server.close());
    const everyConnectionClosed = await allClosed(connections);
    const listenerRefused = await connectionRefused(address.port);
    cases.push({
      name: "failed resource cleanup still releases transport",
      failedClose: failed,
      closedAfterFailure,
      refusedAfterFailure,
      retriedClose: retried,
      closeAttempts: launcher.browser.closeCount,
      connections: connections.map((connection) => connection.report()),
      listenerRefused,
    });

    expect(failed.settled).toBe("rejected");
    expect(closedAfterFailure).toBe(true);
    expect(refusedAfterFailure).toBe(true);
    expect(retried.settled).toBe("closed");
    expect(launcher.browser.closeCount).toBe(1);
    expect(everyConnectionClosed).toBe(true);
    expect(listenerRefused).toBe(true);
  }, 30_000);

  it("never starts listening once a close began during startup", async () => {
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    const server = new BrowserRuntimeServer({ port: 0, runtime });
    const starting = settleWithin(server.start());
    const closing = observeClose(server.close());
    const [started, observed] = await Promise.all([starting, closing]);
    const listenerRefused =
      started.settled !== "fulfilled" || (await connectionRefused(started.value.port));
    cases.push({ name: "close during startup", started, close: observed, listenerRefused });

    expect(started.settled).not.toBe("still waiting");
    expect(observed.settled).toBe("closed");
    expect(listenerRefused).toBe(true);
  }, 30_000);
});

async function rejectedUpgrade(
  url: string,
  headers?: Readonly<Record<string, string>>,
): Promise<number> {
  const websocket = new WebSocket(url, { headers });
  return new Promise<number>((resolve, reject) => {
    websocket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    websocket.once("error", (error) => reject(error));
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for browser runtime test state.");
    await flushMicrotasks();
  }
}
